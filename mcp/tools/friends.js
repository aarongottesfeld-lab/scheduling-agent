// mcp/tools/friends.js — get_friends, search_users, send_friend_request,
//   get_friend_requests, respond_to_friend_request
'use strict';

const { z } = require('zod');
const { dispatchNotification } = require('../utils/notificationDispatch');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function registerTools(server, supabase, _config, userId) {

  // ── get_friends ─────────────────────────────────────────────────────────
  server.tool(
    'get_friends',
    'List the user\'s accepted friends, optionally filtered by search query',
    { search: z.string().optional().describe('Filter friends by name or username') },
    async ({ search }) => {
      const { data: rows, error } = await supabase
        .from('friendships')
        .select('friend_id')
        .eq('user_id', userId)
        .eq('status', 'accepted');

      if (error) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not load friends.' }) }] };

      const friendIds = (rows || []).map(r => r.friend_id);
      if (friendIds.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ friends: [] }) }] };

      let query = supabase
        .from('profiles')
        .select('id, full_name, username, location, avatar_url')
        .in('id', friendIds);

      if (search && search.trim()) {
        const safe = search.replace(/[()%,]/g, '').trim();
        if (safe.length >= 1) {
          query = query.or(`username.ilike.%${safe}%,full_name.ilike.%${safe}%`);
        }
      }

      const { data: profiles } = await query;
      const friends = (profiles || []).map(p => ({
        id: p.id,
        name: p.full_name,
        username: p.username,
        location: p.location,
        avatar_url: p.avatar_url,
      }));

      return { content: [{ type: 'text', text: JSON.stringify({ friends }) }] };
    }
  );

  // ── search_users ────────────────────────────────────────────────────────
  server.tool(
    'search_users',
    'Search for Rendezvous users by username or email to find someone to add as a friend.',
    {
      query: z.string().min(1).max(100).describe('Username or email to search for'),
    },
    async ({ query }) => {
      const safe = query.replace(/[()%,]/g, '').trim();
      if (safe.length < 1) {
        return { content: [{ type: 'text', text: JSON.stringify({ users: [] }) }] };
      }

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, username, location, avatar_url')
        .or(`username.ilike.%${safe}%,email.ilike.%${safe}%`)
        .neq('id', userId)
        .limit(10);

      if (!profiles || profiles.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ users: [] }) }] };
      }

      // Check relationship status for each result
      const resultIds = profiles.map(p => p.id);
      const { data: outgoing } = await supabase
        .from('friendships')
        .select('friend_id, status')
        .eq('user_id', userId)
        .in('friend_id', resultIds);
      const { data: incoming } = await supabase
        .from('friendships')
        .select('user_id, status')
        .eq('friend_id', userId)
        .in('user_id', resultIds);

      const outMap = Object.fromEntries((outgoing || []).map(r => [r.friend_id, r.status]));
      const inMap = Object.fromEntries((incoming || []).map(r => [r.user_id, r.status]));

      const users = profiles.map(p => {
        let relationship_status = 'none';
        if (outMap[p.id] === 'accepted' || inMap[p.id] === 'accepted') {
          relationship_status = 'friends';
        } else if (outMap[p.id] === 'pending') {
          relationship_status = 'pending_sent';
        } else if (inMap[p.id] === 'pending') {
          relationship_status = 'pending_received';
        }
        return {
          id: p.id,
          full_name: p.full_name,
          username: p.username,
          location: p.location,
          relationship_status,
        };
      });

      return { content: [{ type: 'text', text: JSON.stringify({ users }) }] };
    }
  );

  // ── send_friend_request ─────────────────────────────────────────────────
  server.tool(
    'send_friend_request',
    'Send a friend request to another Rendezvous user.',
    {
      user_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
    },
    async ({ user_id }) => {
      if (user_id === userId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Cannot add yourself.' }) }] };
      }

      // Check for existing friendship or pending request
      const { data: existing } = await supabase
        .from('friendships')
        .select('id, status')
        .eq('user_id', userId)
        .eq('friend_id', user_id)
        .maybeSingle();

      if (existing) {
        const msg = existing.status === 'accepted' ? 'Already friends.' : 'Request already sent.';
        return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }] };
      }

      // Daily rate limit: 50 outgoing requests per UTC day
      const todayUTC = new Date().toISOString().split('T')[0];
      const { count, error: countErr } = await supabase
        .from('friendships')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'pending')
        .gte('created_at', `${todayUTC}T00:00:00.000Z`);

      if (!countErr && count >= 50) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Too many friend requests today. Try again tomorrow.' }) }] };
      }

      // Insert friendship row
      const { error: insertErr } = await supabase
        .from('friendships')
        .insert({ user_id: userId, friend_id: user_id, status: 'pending' });

      if (insertErr) {
        console.error('[mcp/friends] send_friend_request insert error:', insertErr.message);
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not send request.' }) }] };
      }

      // Notify target user
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', userId)
        .single();

      await dispatchNotification(supabase, {
        userId: user_id,
        type: 'friend_request',
        title: 'New friend request',
        body: `${profile?.full_name || 'Someone'} sent you a friend request.`,
        actionUrl: '/friends',
        refId: userId,
      });

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    }
  );

  // ── get_friend_requests ─────────────────────────────────────────────────
  server.tool(
    'get_friend_requests',
    'List incoming pending friend requests.',
    {},
    async () => {
      const { data: rows, error } = await supabase
        .from('friendships')
        .select('id, user_id, created_at')
        .eq('friend_id', userId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not load requests.' }) }] };
      }

      if (!rows || rows.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ requests: [] }) }] };
      }

      const senderIds = rows.map(r => r.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, username')
        .in('id', senderIds);

      const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

      const requests = rows.map(r => ({
        id: r.id,
        from_id: r.user_id,
        from_name: profileMap[r.user_id]?.full_name || 'Unknown',
        from_username: profileMap[r.user_id]?.username || '',
        created_at: r.created_at,
      }));

      return { content: [{ type: 'text', text: JSON.stringify({ requests }) }] };
    }
  );

  // ── respond_to_friend_request ───────────────────────────────────────────
  server.tool(
    'respond_to_friend_request',
    'Accept or decline an incoming friend request.',
    {
      request_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
      response: z.enum(['accepted', 'declined']),
    },
    async ({ request_id, response }) => {
      // Fetch the pending request — scoped to friend_id = userId
      const { data: request } = await supabase
        .from('friendships')
        .select('id, user_id, friend_id, status')
        .eq('id', request_id)
        .eq('friend_id', userId)
        .eq('status', 'pending')
        .maybeSingle();

      if (!request) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Friend request not found.' }) }] };
      }

      if (response === 'declined') {
        await supabase.from('friendships').delete().eq('id', request_id).eq('friend_id', userId);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'declined' }) }] };
      }

      // Accept: update the original row + upsert reverse row
      await Promise.all([
        supabase.from('friendships')
          .update({ status: 'accepted' })
          .eq('id', request_id)
          .eq('friend_id', userId),
        supabase.from('friendships').upsert(
          { user_id: userId, friend_id: request.user_id, status: 'accepted' },
          { onConflict: 'user_id,friend_id' }
        ),
      ]);

      // Notify the original sender
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', userId)
        .single();

      await dispatchNotification(supabase, {
        userId: request.user_id,
        type: 'friend_request_accepted',
        title: 'Friend request accepted',
        body: `${profile?.full_name || 'Someone'} accepted your friend request.`,
        actionUrl: `/friends/${userId}`,
        refId: userId,
      });

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'accepted' }) }] };
    }
  );
}

module.exports = { registerTools };

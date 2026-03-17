// mcp/tools/groups.js — get_groups, get_group_itineraries, get_group_itinerary,
//   create_group_itinerary_request, vote_on_group_itinerary, counter_propose_group_itinerary
'use strict';

const { z } = require('zod');
const { dispatchNotification } = require('../utils/notificationDispatch');
const { UUID_RE, sanitizePromptInput } = require('../../server/utils/validation');

function registerTools(server, supabase, config, userId) {

  // ── get_groups ────────────────────────────────────────────────────────
  server.tool(
    'get_groups',
    'List the user\'s groups',
    {},
    async () => {
      const { data: memberships } = await supabase
        .from('group_members')
        .select('group_id, role')
        .eq('user_id', userId)
        .eq('status', 'active');

      if (!memberships || memberships.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ groups: [] }) }] };
      }

      const groupIds = memberships.map(m => m.group_id);
      const [groupsRes, countsRes] = await Promise.all([
        supabase.from('groups')
          .select('id, name, description, created_at')
          .in('id', groupIds)
          .order('created_at', { ascending: false }),
        supabase.from('group_members')
          .select('group_id')
          .in('group_id', groupIds)
          .in('status', ['active', 'pending']),
      ]);

      const countMap = {};
      (countsRes.data || []).forEach(m => {
        countMap[m.group_id] = (countMap[m.group_id] || 0) + 1;
      });

      const groups = (groupsRes.data || []).map(g => ({
        id: g.id,
        name: g.name,
        member_count: countMap[g.id] || 1,
        created_at: g.created_at,
      }));

      return { content: [{ type: 'text', text: JSON.stringify({ groups }) }] };
    }
  );

  // ── get_group_itineraries ─────────────────────────────────────────────
  server.tool(
    'get_group_itineraries',
    'List itineraries for a specific group',
    {
      group_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
    },
    async ({ group_id }) => {
      // Verify membership
      const { data: membership } = await supabase
        .from('group_members')
        .select('status')
        .eq('group_id', group_id)
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle();

      if (!membership) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not a member of this group.' }) }] };
      }

      const { data: itins } = await supabase
        .from('group_itineraries')
        .select('id, event_title, itinerary_status, locked_at, created_at, organizer_id, attendee_statuses, selected_suggestion_id')
        .eq('group_id', group_id)
        .order('created_at', { ascending: false });

      // Filter: attendees should not see organizer_draft
      const visible = (itins || []).filter(r => {
        if (r.organizer_id === userId) return true;
        return r.itinerary_status !== 'organizer_draft';
      });

      return { content: [{ type: 'text', text: JSON.stringify({ itineraries: visible }) }] };
    }
  );

  // ── get_group_itinerary ───────────────────────────────────────────────
  server.tool(
    'get_group_itinerary',
    'Get full details of a group itinerary including suggestions and vote status',
    {
      group_itinerary_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
    },
    async ({ group_itinerary_id }) => {
      const { data: itin, error } = await supabase
        .from('group_itineraries')
        .select('*')
        .eq('id', group_itinerary_id)
        .single();

      if (error || !itin) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Group itinerary not found.' }) }] };
      }

      // Auth: must be organizer or attendee
      const isOrganizer = itin.organizer_id === userId;
      const isAttendee = userId in (itin.attendee_statuses || {});
      if (!isOrganizer && !isAttendee) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not authorized.' }) }] };
      }

      // Fetch member profiles
      const memberIds = [itin.organizer_id, ...Object.keys(itin.attendee_statuses || {})];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', memberIds);

      const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...itin,
            is_organizer: isOrganizer,
            my_vote: isAttendee ? (itin.attendee_statuses[userId] || 'pending') : null,
            members: memberIds.map(id => ({
              ...profileMap[id],
              is_organizer: id === itin.organizer_id,
              vote: itin.attendee_statuses?.[id] || (id === itin.organizer_id ? 'organizer' : 'unknown'),
            })),
          }),
        }],
      };
    }
  );

  // ── create_group_itinerary_request ────────────────────────────────────
  server.tool(
    'create_group_itinerary_request',
    'Create a new group itinerary request. Generation is async — poll get_itinerary_job for results.',
    {
      group_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
      date_range_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
      date_range_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
      time_of_day: z.enum(['morning', 'afternoon', 'evening', 'any']).optional().default('any'),
      context_prompt: z.string().max(500).optional(),
    },
    async ({ group_id, date_range_start, date_range_end, time_of_day, context_prompt }) => {
      // Verify the user is an active member of this group
      const { data: membership } = await supabase
        .from('group_members')
        .select('role, status')
        .eq('group_id', group_id)
        .eq('user_id', userId)
        .maybeSingle();

      if (!membership || membership.status !== 'active') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not an active member of this group.' }) }] };
      }

      // Get all active group members (excluding organizer) for attendee_statuses
      const { data: members } = await supabase
        .from('group_members')
        .select('user_id')
        .eq('group_id', group_id)
        .eq('status', 'active')
        .neq('user_id', userId);

      const attendeeStatuses = Object.fromEntries(
        (members || []).map(m => [m.user_id, 'pending'])
      );
      const attendeeCount = Object.keys(attendeeStatuses).length;
      const quorumThreshold = Math.ceil(attendeeCount / 2);

      const { data: itin, error } = await supabase
        .from('group_itineraries')
        .insert({
          group_id,
          organizer_id: userId,
          attendee_statuses: attendeeStatuses,
          quorum_threshold: quorumThreshold,
          itinerary_status: 'organizer_draft',
          date_range_start,
          date_range_end,
          time_of_day: time_of_day || 'any',
          context_prompt: sanitizePromptInput(context_prompt),
          suggestions: [],
          changelog: [],
          reroll_count: 0,
        })
        .select('id')
        .single();

      if (error) {
        console.error('[mcp/groups] create group itinerary error:', error.message);
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not create group itinerary.' }) }] };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ job_id: itin.id, status: 'generating' }),
        }],
      };
    }
  );

  // ── vote_on_group_itinerary ───────────────────────────────────────────
  server.tool(
    'vote_on_group_itinerary',
    'Vote on a group itinerary suggestion (accept, decline, or abstain)',
    {
      group_itinerary_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
      suggestion_id: z.string().describe('ID of the suggestion to vote on'),
      vote: z.enum(['accepted', 'declined', 'abstained']),
    },
    async ({ group_itinerary_id, suggestion_id, vote }) => {
      const { data: itin } = await supabase
        .from('group_itineraries')
        .select('organizer_id, itinerary_status, attendee_statuses, suggestions')
        .eq('id', group_itinerary_id)
        .single();

      if (!itin) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Group itinerary not found.' }) }] };
      }
      if (itin.itinerary_status !== 'awaiting_responses') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Voting is not open.' }) }] };
      }
      if (!(userId in (itin.attendee_statuses || {}))) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not authorized to vote.' }) }] };
      }

      // Validate suggestion_id
      const validIds = (itin.suggestions || []).map(s => s.id);
      if (!validIds.includes(suggestion_id)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid suggestion_id.' }) }] };
      }

      // Use the atomic merge_attendee_vote RPC
      const { error: voteError } = await supabase.rpc('merge_attendee_vote', {
        p_itinerary_id: group_itinerary_id,
        p_user_id: userId,
        p_vote: vote,
      });

      if (voteError) {
        console.error('[mcp/groups] vote RPC error:', voteError.message);
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Vote could not be recorded.' }) }] };
      }

      // Update suggestion map
      const { data: freshItin } = await supabase
        .from('group_itineraries')
        .select('attendee_suggestion_map, itinerary_status, locked_at')
        .eq('id', group_itinerary_id)
        .single();

      const updatedMap = { ...(freshItin?.attendee_suggestion_map || {}), [userId]: suggestion_id };
      await supabase.from('group_itineraries')
        .update({ attendee_suggestion_map: updatedMap })
        .eq('id', group_itinerary_id);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            itinerary_status: freshItin?.itinerary_status,
            locked_at: freshItin?.locked_at,
          }),
        }],
      };
    }
  );

  // ── counter_propose_group_itinerary ───────────────────────────────────
  server.tool(
    'counter_propose_group_itinerary',
    'Request a reroll of group itinerary suggestions with specific feedback. Async — poll get_itinerary_job.',
    {
      group_itinerary_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
      feedback: z.string().min(1).max(500),
    },
    async ({ group_itinerary_id, feedback }) => {
      const { data: itin } = await supabase
        .from('group_itineraries')
        .select('organizer_id, itinerary_status, attendee_statuses, locked_at')
        .eq('id', group_itinerary_id)
        .single();

      if (!itin) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Group itinerary not found.' }) }] };
      }
      if (itin.locked_at) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Cannot counter-propose a locked itinerary.' }) }] };
      }

      const isOrganizer = itin.organizer_id === userId;
      const isAttendee = userId in (itin.attendee_statuses || {});
      if (!isOrganizer && !isAttendee) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not authorized.' }) }] };
      }

      // Notify organizer about counter-proposal
      if (!isOrganizer) {
        const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', userId).single();
        await dispatchNotification(supabase, {
          userId: itin.organizer_id,
          type: 'group_event_counter_proposal',
          tier: 2,
          title: `${profile?.full_name || 'Someone'} wants different plans`,
          body: `Feedback: "${sanitizePromptInput(feedback, 100)}"`,
          data: { group_itinerary_id },
          actionUrl: `/group-itineraries/${group_itinerary_id}`,
        });
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ job_id: group_itinerary_id, status: 'generating' }),
        }],
      };
    }
  );

  // ── create_group ──────────────────────────────────────────────────────
  server.tool(
    'create_group',
    'Create a new group and become its admin',
    {
      name: z.string().min(1).max(100),
      description: z.string().max(1000).optional(),
    },
    async ({ name, description }) => {
      const cleanName = name.trim();
      if (!cleanName) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'name is required.' }) }] };
      }

      const cleanDesc = typeof description === 'string' ? description.trim().slice(0, 1000) : null;

      const { data: group, error: groupErr } = await supabase
        .from('groups')
        .insert({ name: cleanName.slice(0, 100), description: cleanDesc, created_by: userId })
        .select('id, name, description, created_by, created_at')
        .single();

      if (groupErr) {
        console.error('[mcp/groups] create group error:', groupErr.message);
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not create group.' }) }] };
      }

      const { error: memberErr } = await supabase
        .from('group_members')
        .insert({
          group_id: group.id,
          user_id: userId,
          role: 'admin',
          status: 'active',
          joined_at: new Date().toISOString(),
        });

      if (memberErr) {
        console.error('[mcp/groups] creator member insert error:', memberErr.message);
        await supabase.from('groups').delete().eq('id', group.id);
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not create group.' }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ group }) }] };
    }
  );

  // ── get_group_members ─────────────────────────────────────────────────
  server.tool(
    'get_group_members',
    'Get the member list for a group',
    {
      group_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
    },
    async ({ group_id }) => {
      const { data: myMembership } = await supabase
        .from('group_members')
        .select('role, status')
        .eq('group_id', group_id)
        .eq('user_id', userId)
        .maybeSingle();

      if (!myMembership || !['active', 'pending'].includes(myMembership.status)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not authorized.' }) }] };
      }

      const { data: members } = await supabase
        .from('group_members')
        .select('user_id, role, status, joined_at')
        .eq('group_id', group_id)
        .in('status', ['active', 'pending'])
        .order('created_at', { ascending: true });

      const memberUserIds = (members || []).map(m => m.user_id);

      const { data: profiles } = memberUserIds.length
        ? await supabase
            .from('profiles')
            .select('id, full_name, avatar_url')
            .in('id', memberUserIds)
        : { data: [] };

      const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            members: (members || []).map(m => ({
              user_id: m.user_id,
              role: m.role,
              status: m.status,
              joined_at: m.joined_at,
              profile: profileMap[m.user_id]
                ? { id: profileMap[m.user_id].id, full_name: profileMap[m.user_id].full_name, avatar_url: profileMap[m.user_id].avatar_url }
                : null,
            })),
            my_role: myMembership.role,
          }),
        }],
      };
    }
  );

  // ── invite_member ─────────────────────────────────────────────────────
  server.tool(
    'invite_member',
    'Invite a user to a group (admin only)',
    {
      group_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
      user_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
    },
    async ({ group_id, user_id: inviteeId }) => {
      if (inviteeId === userId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Cannot invite yourself.' }) }] };
      }

      const { data: adminCheck } = await supabase
        .from('group_members')
        .select('role, status')
        .eq('group_id', group_id)
        .eq('user_id', userId)
        .maybeSingle();

      if (!adminCheck || adminCheck.role !== 'admin' || adminCheck.status !== 'active') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Only group admins can invite members.' }) }] };
      }

      const { count: currentCount } = await supabase
        .from('group_members')
        .select('*', { count: 'exact', head: true })
        .eq('group_id', group_id)
        .in('status', ['active', 'pending']);

      if (currentCount >= 15) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Groups support a maximum of 15 members.' }) }] };
      }

      const { data: inviteeProfile } = await supabase
        .from('profiles')
        .select('id, full_name, allow_non_friend_group_invites')
        .eq('id', inviteeId)
        .maybeSingle();

      if (!inviteeProfile) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'User not found.' }) }] };
      }

      const { data: outFriend } = await supabase
        .from('friendships')
        .select('status')
        .eq('user_id', userId)
        .eq('friend_id', inviteeId)
        .eq('status', 'accepted')
        .maybeSingle();
      const { data: inFriend } = !outFriend ? await supabase
        .from('friendships')
        .select('status')
        .eq('user_id', inviteeId)
        .eq('friend_id', userId)
        .eq('status', 'accepted')
        .maybeSingle() : { data: null };
      const areFriends = !!(outFriend || inFriend);

      if (!areFriends) {
        if (inviteeProfile.allow_non_friend_group_invites === false) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'This user only accepts group invites from friends.' }) }] };
        }
      }

      const { data: existing } = await supabase
        .from('group_members')
        .select('status')
        .eq('group_id', group_id)
        .eq('user_id', inviteeId)
        .maybeSingle();

      if (existing && ['active', 'pending'].includes(existing.status)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'User is already a member or has a pending invitation.' }) }] };
      }

      const { error: upsertErr } = await supabase
        .from('group_members')
        .upsert({
          group_id,
          user_id: inviteeId,
          role: 'member',
          status: 'pending',
          invited_by: userId,
          joined_at: null,
          left_at: null,
          created_at: new Date().toISOString(),
        }, { onConflict: 'group_id,user_id' });

      if (upsertErr) {
        console.error('[mcp/groups] invite member error:', upsertErr.message);
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not send invitation.' }) }] };
      }

      const { data: group } = await supabase.from('groups').select('name').eq('id', group_id).single();
      await dispatchNotification(supabase, {
        userId: inviteeId,
        type: 'group_invite',
        tier: 1,
        title: `You've been invited to ${group?.name || 'a group'}`,
        body: `You've been invited to join ${group?.name || 'a group'}. Tap to accept or decline.`,
        data: { group_id },
      });

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message: 'Invitation sent.' }) }] };
    }
  );

  // ── remove_member ─────────────────────────────────────────────────────
  server.tool(
    'remove_member',
    'Remove a member from a group (admin only)',
    {
      group_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
      user_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
    },
    async ({ group_id, user_id: targetId }) => {
      const { data: adminCheck } = await supabase
        .from('group_members')
        .select('role, status')
        .eq('group_id', group_id)
        .eq('user_id', userId)
        .maybeSingle();

      if (!adminCheck || adminCheck.role !== 'admin' || adminCheck.status !== 'active') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Only group admins can remove members.' }) }] };
      }

      if (targetId === userId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Use the leave group action to remove yourself.' }) }] };
      }

      const { error: deleteErr } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', group_id)
        .eq('user_id', targetId);

      if (deleteErr) {
        console.error('[mcp/groups] remove member error:', deleteErr.message);
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not remove member.' }) }] };
      }

      // Best-effort ghost-vote cleanup
      try {
        const { data: activeItins } = await supabase
          .from('group_itineraries')
          .select('id, attendee_statuses')
          .eq('group_id', group_id)
          .eq('itinerary_status', 'awaiting_responses');
        if (activeItins?.length) {
          for (const itin of activeItins) {
            const updated = { ...itin.attendee_statuses };
            delete updated[targetId];
            await supabase
              .from('group_itineraries')
              .update({ attendee_statuses: updated })
              .eq('id', itin.id);
          }
        }
      } catch (ghostErr) {
        console.warn('[mcp/groups] ghost-vote cleanup failed:', ghostErr.message);
      }

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message: 'Member removed.' }) }] };
    }
  );

  // ── leave_group ───────────────────────────────────────────────────────
  server.tool(
    'leave_group',
    'Leave a group you are an active member of',
    {
      group_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
    },
    async ({ group_id }) => {
      const { data: membership } = await supabase
        .from('group_members')
        .select('status')
        .eq('group_id', group_id)
        .eq('user_id', userId)
        .maybeSingle();

      if (!membership) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Membership not found.' }) }] };
      }

      if (membership.status !== 'active') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Can only leave a group you are an active member of.' }) }] };
      }

      const { error: updateErr } = await supabase
        .from('group_members')
        .update({ status: 'left', left_at: new Date().toISOString() })
        .eq('group_id', group_id)
        .eq('user_id', userId);

      if (updateErr) {
        console.error('[mcp/groups] leave group error:', updateErr.message);
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not leave group.' }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message: 'You have left the group.' }) }] };
    }
  );

  // ── update_group ──────────────────────────────────────────────────────
  server.tool(
    'update_group',
    'Update group name or description (admin only)',
    {
      group_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(1000).optional(),
    },
    async ({ group_id, name, description }) => {
      const { data: adminCheck } = await supabase
        .from('group_members')
        .select('role, status')
        .eq('group_id', group_id)
        .eq('user_id', userId)
        .maybeSingle();

      if (!adminCheck || adminCheck.role !== 'admin' || adminCheck.status !== 'active') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Only group admins can edit group details.' }) }] };
      }

      const updates = {};

      if (name !== undefined) {
        const cleanName = String(name).trim().slice(0, 100);
        if (!cleanName) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'name cannot be empty.' }) }] };
        }
        updates.name = cleanName;
      }

      if (description !== undefined) {
        updates.description = typeof description === 'string'
          ? description.trim().slice(0, 1000)
          : null;
      }

      if (Object.keys(updates).length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'No updatable fields provided.' }) }] };
      }

      const { data: updated, error: updateErr } = await supabase
        .from('groups')
        .update(updates)
        .eq('id', group_id)
        .select('id, name, description, created_by, created_at, updated_at')
        .single();

      if (updateErr) {
        console.error('[mcp/groups] update group error:', updateErr.message);
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not update group.' }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ group: updated }) }] };
    }
  );
}

module.exports = { registerTools };

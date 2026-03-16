// mcp/tools/friends.js — get_friends tool
'use strict';

const { z } = require('zod');

function registerTools(server, supabase, _config, userId) {

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
}

module.exports = { registerTools };

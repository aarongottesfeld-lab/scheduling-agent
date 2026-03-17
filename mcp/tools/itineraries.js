// mcp/tools/itineraries.js — get_itineraries, get_itinerary
'use strict';

const { z } = require('zod');
const { UUID_RE } = require('../../server/utils/validation');

function registerTools(server, supabase, _config, userId) {

  server.tool(
    'get_itineraries',
    'List the user\'s itineraries (1-on-1 plans)',
    {
      status: z.enum(['pending', 'locked', 'awaiting_me', 'all']).optional().default('all'),
    },
    async ({ status }) => {
      const { data: asOrg } = await supabase
        .from('itineraries')
        .select('id, event_title, organizer_id, attendee_id, organizer_status, attendee_status, locked_at, date_range_start, date_range_end, created_at')
        .eq('organizer_id', userId)
        .order('created_at', { ascending: false });

      const { data: asAtt } = await supabase
        .from('itineraries')
        .select('id, event_title, organizer_id, attendee_id, organizer_status, attendee_status, locked_at, date_range_start, date_range_end, created_at')
        .eq('attendee_id', userId)
        .order('created_at', { ascending: false });

      let all = [...(asOrg || [])];
      for (const row of (asAtt || [])) {
        if (!all.find(r => r.id === row.id)) all.push(row);
      }

      if (status === 'locked') {
        all = all.filter(r => r.locked_at);
      } else if (status === 'pending') {
        all = all.filter(r => !r.locked_at);
      } else if (status === 'awaiting_me') {
        all = all.filter(r => {
          if (!r.locked_at) {
            const isOrganizer = r.organizer_id === userId;
            const myStatus = isOrganizer ? r.organizer_status : r.attendee_status;
            return myStatus === 'pending';
          }
          return false;
        });
      }

      const userIds = [...new Set(all.flatMap(r => [r.organizer_id, r.attendee_id]))];
      const { data: profiles } = userIds.length
        ? await supabase.from('profiles').select('id, full_name').in('id', userIds)
        : { data: [] };
      const nameMap = Object.fromEntries((profiles || []).map(p => [p.id, p.full_name]));

      const itineraries = all.map(r => ({
        id: r.id,
        title: r.event_title || null,
        status: r.locked_at ? 'locked' : 'pending',
        other_person_name: nameMap[r.organizer_id === userId ? r.attendee_id : r.organizer_id] || 'Unknown',
        date_range_start: r.date_range_start,
        date_range_end: r.date_range_end,
        created_at: r.created_at,
        is_organizer: r.organizer_id === userId,
        organizer_status: r.organizer_status,
        attendee_status: r.attendee_status,
      }));

      return { content: [{ type: 'text', text: JSON.stringify({ itineraries }) }] };
    }
  );

  server.tool(
    'get_itinerary',
    'Get full details of a specific itinerary including suggestions',
    {
      itinerary_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
    },
    async ({ itinerary_id }) => {
      const { data: itin, error } = await supabase
        .from('itineraries')
        .select('*')
        .eq('id', itinerary_id)
        .single();

      if (error || !itin) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Itinerary not found.' }) }] };
      }

      if (itin.organizer_id !== userId && itin.attendee_id !== userId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not authorized.' }) }] };
      }

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, location, avatar_url')
        .in('id', [itin.organizer_id, itin.attendee_id]);

      const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...itin,
            organizer: profileMap[itin.organizer_id] || null,
            attendee: profileMap[itin.attendee_id] || null,
            is_organizer: itin.organizer_id === userId,
          }),
        }],
      };
    }
  );
}

module.exports = { registerTools };

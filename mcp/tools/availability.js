// mcp/tools/availability.js — get_availability tool
'use strict';

const { z } = require('zod');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function registerTools(server, supabase, config, userId) {
  const fetchBusyAggregated = require('../shared/fetchBusyAggregated');

  server.tool(
    'get_availability',
    'Find overlapping free time windows between the user and a friend',
    {
      friend_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
      date_range_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
      date_range_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
      time_of_day: z.enum(['morning', 'afternoon', 'evening', 'any']).optional().default('any'),
    },
    async ({ friend_id, date_range_start, date_range_end, time_of_day }) => {
      // Verify friendship
      const { data: friendship } = await supabase
        .from('friendships')
        .select('status')
        .eq('user_id', userId)
        .eq('friend_id', friend_id)
        .eq('status', 'accepted')
        .maybeSingle();

      if (!friendship) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not friends with this user.' }) }] };
      }

      const startISO = new Date(date_range_start + 'T00:00:00Z').toISOString();
      const endISO = new Date(date_range_end + 'T23:59:59Z').toISOString();

      // Fetch sessions for both users to get calendar tokens
      const getSession = config.getSessionBySupabaseId;
      const [userSession, friendSession] = await Promise.all([
        getSession ? getSession(userId) : null,
        getSession ? getSession(friend_id) : null,
      ]);

      // Fetch busy slots for both users
      async function fetchBusy(session, uid) {
        if (session?.tokens?.access_token) {
          try {
            return await fetchBusyAggregated(supabase, uid, session.tokens, startISO, endISO);
          } catch (e) {
            console.warn(`[mcp/availability] fetchBusy failed for ${uid}:`, e.message);
            return [];
          }
        }
        // Mock fallback for test users
        try {
          const { data } = await supabase
            .from('profiles')
            .select('mock_busy_slots')
            .eq('id', uid)
            .single();
          const slots = data?.mock_busy_slots || [];
          const start = new Date(startISO);
          const end = new Date(endISO);
          return slots
            .filter(s => new Date(s.end) > start && new Date(s.start) < end)
            .map(s => ({ start: s.start, end: s.end }));
        } catch { return []; }
      }

      const [userBusy, friendBusy] = await Promise.all([
        fetchBusy(userSession, userId),
        fetchBusy(friendSession, friend_id),
      ]);

      // Compute free windows (2-hour slots)
      const todHours = { morning: [8, 12], afternoon: [12, 17], evening: [17, 23], any: [8, 23] };
      const [startH, endH] = todHours[time_of_day] || [8, 23];
      const durationMs = 2 * 60 * 60 * 1000;

      const allBusy = [...userBusy, ...friendBusy];
      const freeWindows = [];
      const [sy, sm, sd] = date_range_start.split('-').map(Number);
      const [ey, em, ed] = date_range_end.split('-').map(Number);
      const cur = new Date(Date.UTC(sy, sm - 1, sd));
      const endDate = new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59));

      while (cur <= endDate && freeWindows.length < 20) {
        for (let h = startH; h + 2 <= endH; h++) {
          const wStart = new Date(cur);
          wStart.setUTCHours(h, 0, 0, 0);
          const wEnd = new Date(wStart.getTime() + durationMs);

          const overlaps = allBusy.some(s => {
            const sStart = new Date(s.start);
            const sEnd = new Date(s.end);
            return sStart < wEnd && sEnd > wStart;
          });

          if (!overlaps) {
            freeWindows.push({
              start: wStart.toISOString(),
              end: wEnd.toISOString(),
              duration_minutes: 120,
            });
            if (freeWindows.length >= 20) break;
          }
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      return { content: [{ type: 'text', text: JSON.stringify({ free_windows: freeWindows }) }] };
    }
  );
}

module.exports = { registerTools };

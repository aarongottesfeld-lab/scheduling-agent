'use strict';

const { google } = require('googleapis');
const { createOAuth2Client } = require('./calendarUtils');
const { fetchAppleBusy } = require('./appleCalendarUtils');
const getCalendarConnectionsForUser = require('./getCalendarConnectionsForUser');

/**
 * Fetch and merge busy slots across all calendar_connections for a user.
 *
 * Backward-compat path (no calendar_connections rows):
 *   Falls back to a single freebusy call on the session's primary calendar —
 *   identical to pre-Phase-3 behavior. Existing users with no connected
 *   secondary calendars see no change.
 *
 * Aggregated path (connections exist):
 *   Fires one freebusy call per connection concurrently via Promise.allSettled.
 *   Each connection uses its own stored tokens (the `tokens` jsonb column).
 *   calendar_ids is used as the items array when non-empty; defaults to
 *   [{ id: 'primary' }] when empty or null.
 *   A failed call for any single connection is logged and skipped — it never
 *   throws or prevents the remaining connections from being queried.
 *
 * The returned array is a flat list of { start, end } busy periods ready for
 * findFreeWindows / findFreeWindowsForGroup — same shape as before.
 *
 * Security: tokens are consumed internally only. They are never logged,
 * returned in a response, or passed to any client-facing code path.
 *
 * @param {object} supabase       - Supabase service-role client
 * @param {string} userId         - Supabase UUID of the user whose busy slots to fetch
 * @param {object} sessionTokens  - OAuth tokens from the user's active session (fallback path)
 * @param {string} startISO       - range start (ISO 8601)
 * @param {string} endISO         - range end (ISO 8601)
 * @returns {Promise<Array<{start:string, end:string}>>}
 */
async function fetchBusyAggregated(supabase, userId, sessionTokens, startISO, endISO) {
  const connections = await getCalendarConnectionsForUser(supabase, userId);

  // ── Backward-compat fallback: no connected calendars ──────────────────────
  // Matches the original single-primary-calendar behavior exactly.
  if (connections.length === 0) {
    if (!sessionTokens?.access_token) return [];
    const auth     = createOAuth2Client(sessionTokens);
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.freebusy.query({
      requestBody: { timeMin: startISO, timeMax: endISO, items: [{ id: 'primary' }] },
    });
    return res.data.calendars?.primary?.busy || [];
  }

  // ── Aggregated path: one freebusy call per connection ─────────────────────
  // Branch on provider: Google uses the googleapis freebusy API; Apple uses
  // CalDAV via fetchAppleBusy. Unknown providers are logged and skipped.
  const calls = connections.map(conn => {
    if (conn.provider === 'apple') {
      // fetchAppleBusy never throws — returns [] on any error
      return fetchAppleBusy(
        conn.tokens.email,
        conn.tokens.password,
        conn.calendar_ids,
        startISO,
        endISO
      );
    }

    if (conn.provider === 'google' || !conn.provider) {
      const items = (conn.calendar_ids && conn.calendar_ids.length > 0)
        ? conn.calendar_ids.map(id => ({ id }))
        : [{ id: 'primary' }];
      const auth     = createOAuth2Client(conn.tokens);
      const calendar = google.calendar({ version: 'v3', auth });
      return calendar.freebusy.query({
        requestBody: { timeMin: startISO, timeMax: endISO, items },
      });
    }

    console.warn(`[fetchBusyAggregated] unknown provider "${conn.provider}" for connection ${conn.id} — skipping`);
    return Promise.resolve(null);
  });

  const results = await Promise.allSettled(calls);

  const busy = [];
  results.forEach((result, i) => {
    const conn = connections[i];

    if (result.status === 'rejected') {
      console.warn(
        `[fetchBusyAggregated] freebusy call failed for connection ${conn.id}:`,
        result.reason?.message
      );
      return;
    }

    const value = result.value;
    if (!value) return; // skipped (unknown provider)

    if (conn.provider === 'apple') {
      // fetchAppleBusy already returns a flat { start, end }[] array
      if (Array.isArray(value)) busy.push(...value);
      return;
    }

    // Google: extract from freebusy API response structure
    const cals = value.data?.calendars || {};
    for (const calData of Object.values(cals)) {
      if (Array.isArray(calData.busy)) {
        busy.push(...calData.busy.map(b => ({ start: b.start, end: b.end })));
      }
    }
  });

  return busy;
}

module.exports = fetchBusyAggregated;

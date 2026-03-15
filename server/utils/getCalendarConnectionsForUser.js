'use strict';

/**
 * Fetch all calendar_connections rows for a given user.
 *
 * Returns only the columns needed by fetchBusyAggregated (id, tokens, calendar_ids).
 * Never throws — returns an empty array on any DB or runtime error so that a
 * missing/broken connections row never crashes the scheduling engine.
 *
 * @param {object} supabase - Supabase service-role client
 * @param {string} userId   - Supabase UUID of the user
 * @returns {Promise<Array<{id: string, tokens: object, calendar_ids: string[]}>>}
 */
async function getCalendarConnectionsForUser(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('calendar_connections')
      .select('id, tokens, calendar_ids')
      .eq('user_id', userId);
    if (error) {
      console.warn('[getCalendarConnectionsForUser] query failed:', error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.warn('[getCalendarConnectionsForUser] unexpected error:', e.message);
    return [];
  }
}

module.exports = getCalendarConnectionsForUser;

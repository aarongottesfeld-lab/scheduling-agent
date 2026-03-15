'use strict';

/**
 * Returns the connection info to use for a calendar write for a given user.
 *
 * Lookup order:
 *   1. calendar_connections row where user_id = userId AND is_primary = true
 *      (the user has explicitly designated a primary calendar account)
 *   2. Fallback — the tokens from the user's active session, provider 'google'
 *      (backward-compat path: users with no calendar_connections rows)
 *
 * Never throws — returns { tokens: sessionTokens, provider: 'google' } on any
 * DB or runtime error so that a broken connection lookup never drops a write.
 *
 * Security: tokens are returned only for internal use. They must never be
 * logged, returned in a response, or passed to any client-facing code path.
 *
 * @param {object} supabase       - Supabase service-role client
 * @param {string} userId         - Supabase UUID of the user
 * @param {object} sessionTokens  - OAuth tokens from the user's active session (fallback)
 * @returns {Promise<{tokens: object, provider: string}>}
 */
async function getPrimaryCalendarTokens(supabase, userId, sessionTokens) {
  try {
    const { data, error } = await supabase
      .from('calendar_connections')
      .select('tokens, provider')
      .eq('user_id', userId)
      .eq('is_primary', true)
      .maybeSingle();
    if (error) {
      console.warn(`[getPrimaryCalendarTokens] DB error for user ${userId}:`, error.message);
      return { tokens: sessionTokens, provider: 'google' };
    }
    if (data?.tokens?.access_token || data?.tokens?.email) {
      return { tokens: data.tokens, provider: data.provider || 'google' };
    }
    return { tokens: sessionTokens, provider: 'google' };
  } catch (e) {
    console.warn(`[getPrimaryCalendarTokens] unexpected error for user ${userId}:`, e.message);
    return { tokens: sessionTokens, provider: 'google' };
  }
}

module.exports = getPrimaryCalendarTokens;

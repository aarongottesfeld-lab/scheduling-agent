// mcp/utils/notificationDispatch.js — MCP-safe wrapper around the server's notification dispatch
//
// The server's pushNotifications.js crashes at import time if FCM_SERVICE_ACCOUNT_JSON
// is missing. The MCP server may not have Firebase configured, so this wrapper
// catches the import failure and falls back to in-product notifications only
// (with settings checks — A5-029).

'use strict';

let _dispatchNotification;

try {
  _dispatchNotification = require('../shared/notificationDispatch').dispatchNotification;
} catch (err) {
  console.warn('[mcp/notificationDispatch] Could not load server notification dispatch:', err.message);
  console.warn('[mcp/notificationDispatch] Push notifications will be skipped; in-product notifications will still be inserted.');

  // Fallback: insert in-product notification directly, skip push.
  // Respects the recipient's notification_settings (fail-open on error).
  _dispatchNotification = async function dispatchNotificationFallback(supabase, { userId, type, title, body, actionUrl, refId, tier, data }) {
    // 1. Fetch recipient settings — default to {} on error so notifications are never dropped.
    let settings = {};
    try {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('notification_settings')
        .eq('id', userId)
        .single();
      if (!error && profile) {
        settings = profile.notification_settings || {};
      }
    } catch {
      // Fail open — deliver if we can't read settings.
    }

    // 2. Check per-type channel preference (default true = opt-out model).
    const typeSetting = settings[type] || {};
    const inProductEnabled = typeSetting.in_product !== false;

    // 3. Insert in-product notification only if enabled.
    if (inProductEnabled) {
      try {
        const row = {
          user_id: userId,
          type,
          title,
          body,
          data: data || null,
          action_url: actionUrl || null,
          ref_id: refId || null,
          read: false,
        };
        if (tier != null) row.tier = tier;

        const { error: insertErr } = await supabase.from('notifications').insert(row);
        if (insertErr) {
          console.warn('[mcp/notificationDispatch] in-product insert failed:', insertErr.message);
        }
      } catch (e) {
        console.warn('[mcp/notificationDispatch] in-product insert threw:', e.message);
      }
    }

    // Push notifications are skipped in this fallback (no Firebase available).
  };
}

module.exports = { dispatchNotification: _dispatchNotification };

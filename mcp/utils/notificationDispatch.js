// mcp/utils/notificationDispatch.js — MCP-safe wrapper around the server's notification dispatch
//
// The server's pushNotifications.js crashes at import time if FCM_SERVICE_ACCOUNT_JSON
// is missing. The MCP server may not have Firebase configured, so this wrapper
// catches the import failure and falls back to in-product notifications only.

'use strict';

let _dispatchNotification;

try {
  _dispatchNotification = require('../shared/notificationDispatch').dispatchNotification;
} catch (err) {
  console.warn('[mcp/notificationDispatch] Could not load server notification dispatch:', err.message);
  console.warn('[mcp/notificationDispatch] Push notifications will be skipped; in-product notifications will still be inserted.');

  // Fallback: insert in-product notification directly, skip push.
  _dispatchNotification = async function dispatchNotificationFallback(supabase, { userId, type, title, body, actionUrl, refId, tier, data }) {
    try {
      await supabase.from('notifications').insert({
        user_id: userId,
        type,
        tier: tier || null,
        title,
        body,
        data: data || null,
        action_url: actionUrl || null,
        ref_id: refId || null,
        read: false,
      });
    } catch (e) {
      console.warn('[mcp/notificationDispatch] in-product insert failed:', e.message);
    }
  };
}

module.exports = { dispatchNotification: _dispatchNotification };

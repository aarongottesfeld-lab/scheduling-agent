// utils/notificationDispatch.js — centralized notification dispatch
// Checks the recipient's notification_settings before inserting an in-product
// notification or firing a push alert. Default behavior (missing key) = both enabled.
'use strict';

const { sendPush } = require('./pushNotifications');

/**
 * Dispatch a notification to a single user, respecting their settings.
 *
 * @param {object} supabase  - Supabase client
 * @param {object} opts
 * @param {string} opts.userId    - recipient UUID
 * @param {string} opts.type      - notification type key (must match Settings.js toggles)
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} [opts.actionUrl]
 * @param {string} [opts.refId]
 * @param {number} [opts.tier]    - notification tier (1 = action required, 2 = info)
 * @param {object} [opts.data]    - extra JSON data stored on the notification row
 */
async function dispatchNotification(supabase, { userId, type, title, body, actionUrl, refId, tier, data }) {
  // 1. Fetch recipient settings — default to {} on any error so notifications are never dropped.
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
    // Fail open — deliver both channels if we can't read settings.
  }

  // 2. Determine per-type channel preferences (default true = opt-out model).
  const typeSetting = settings[type] || {};
  const inProductEnabled = typeSetting.in_product !== false;
  const pushEnabled      = typeSetting.push !== false;

  // 3. Insert in-product notification if enabled.
  if (inProductEnabled) {
    try {
      const row = {
        user_id:    userId,
        type,
        title,
        body,
        data:       data || null,
        action_url: actionUrl || null,
        ref_id:     refId || null,
        read:       false,
      };
      // Only include tier if explicitly provided — the DB column is NOT NULL
      // with DEFAULT 1, so omitting it lets Postgres use the default.
      if (tier != null) row.tier = tier;

      const { error: insertErr } = await supabase.from('notifications').insert(row);
      if (insertErr) {
        console.warn('[notificationDispatch] in-product insert failed:', insertErr.message);
      }
    } catch (e) {
      console.warn('[notificationDispatch] in-product insert threw:', e.message);
    }
  }

  // 4. Send push notification if enabled (sendPush already never throws).
  if (pushEnabled) {
    sendPush(supabase, userId, { title, body, actionUrl: actionUrl || '/' });
  }
}

module.exports = { dispatchNotification };

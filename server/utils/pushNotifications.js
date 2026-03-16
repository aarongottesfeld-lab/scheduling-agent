'use strict';
const admin = require('firebase-admin');

// Initialize once — guard against re-initialization in hot-reload environments.
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

/**
 * Send a push notification to ALL devices registered for a user.
 * Best-effort: never throws — logs and returns false on any failure.
 *
 * @param {object} supabase   - Supabase client (to look up the user's FCM tokens)
 * @param {string} userId     - UUID of the recipient
 * @param {object} payload    - { title, body, actionUrl }
 * @returns {Promise<boolean>} true if at least one device was sent successfully
 */
async function sendPush(supabase, userId, { title, body, actionUrl = '/' }) {
  try {
    const { data: rows, error } = await supabase
      .from('push_subscriptions')
      .select('id, token')
      .eq('user_id', userId);

    if (error || !rows || rows.length === 0) return false;

    let anySuccess = false;

    await Promise.all(rows.map(async (row) => {
      if (!row.token) return;
      try {
        // Data-only message — no `notification` key. This prevents FCM from
        // auto-displaying a notification (which would duplicate the one shown by
        // our service worker's onBackgroundMessage or the app's onMessage handler).
        const message = {
          token: row.token,
          data: { title, body, actionUrl },
          webpush: {
            fcm_options: { link: actionUrl },
          },
        };

        await admin.messaging().send(message);
        anySuccess = true;
      } catch (err) {
        console.warn(`[push] sendPush failed for user ${userId} (sub ${row.id}):`, err.message);

        // If FCM returned a registration-not-found error, clean up the stale token.
        if (err.code === 'messaging/registration-token-not-registered') {
          try {
            await supabase.from('push_subscriptions').delete().eq('id', row.id);
            console.warn(`[push] stale token removed for user ${userId} (sub ${row.id})`);
          } catch { /* best-effort cleanup */ }
        }
      }
    }));

    return anySuccess;
  } catch (err) {
    console.warn(`[push] sendPush failed for user ${userId}:`, err.message);
    return false;
  }
}

module.exports = { sendPush };

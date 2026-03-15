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
 * Send a push notification to a single user.
 * Best-effort: never throws — logs and returns false on any failure.
 *
 * @param {object} supabase   - Supabase client (to look up the user's FCM token)
 * @param {string} userId     - UUID of the recipient
 * @param {object} payload    - { title, body, actionUrl }
 * @returns {Promise<boolean>} true if sent successfully, false otherwise
 */
async function sendPush(supabase, userId, { title, body, actionUrl = '/' }) {
  try {
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('token')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data?.token) return false; // no token registered — silent skip

    const message = {
      token: data.token,
      notification: { title, body },
      data: { actionUrl },
      webpush: {
        notification: {
          icon: '/logo192.png',
          badge: '/logo192.png',
          click_action: actionUrl,
        },
        fcm_options: { link: actionUrl },
      },
    };

    await admin.messaging().send(message);
    return true;
  } catch (err) {
    // Token may be stale (user cleared site data, revoked permission).
    // Log at warn level — not an error, expected to happen occasionally.
    console.warn(`[push] sendPush failed for user ${userId}:`, err.message);

    // If FCM returned a registration-not-found error, clean up the stale token.
    if (err.code === 'messaging/registration-token-not-registered') {
      try {
        await supabase.from('push_subscriptions').delete().eq('user_id', userId);
        console.warn(`[push] stale token removed for user ${userId}`);
      } catch { /* best-effort cleanup */ }
    }
    return false;
  }
}

module.exports = { sendPush };

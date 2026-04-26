// services/founderFriend.js — sends a welcome friend request from the founder
// to new users. See docs/superpowers/specs/2026-04-26-founder-default-friend-design.md
'use strict';

const { dispatchNotification } = require('../utils/notificationDispatch');

const FOUNDER_NAME      = 'Aaron';
const NOTIFICATION_TYPE = 'friend_request';
const NOTIFICATION_BODY = `${FOUNDER_NAME} (founder of Rendezvous) sent you a friend request.`;

/**
 * Send a pending welcome friend request from the founder to `targetUserId`.
 * Idempotent and decline-respecting via profiles.welcome_friend_request_sent_at.
 *
 * @param {object} supabase     - Supabase client (service role)
 * @param {string} targetUserId - recipient profile UUID
 * @returns {Promise<{status: 'sent'|'skipped'|'failed', reason?: string, error?: string}>}
 */
async function sendFounderFriendRequest(supabase, targetUserId) {
  const founderId = process.env.FOUNDER_USER_ID;
  if (!founderId) return { status: 'skipped', reason: 'no_founder_configured' };
  if (targetUserId === founderId) return { status: 'skipped', reason: 'target_is_founder' };

  // Idempotency: skip if we already sent (even if the friendship row was later deleted by a decline).
  const profileRes = await supabase
    .from('profiles')
    .select('welcome_friend_request_sent_at')
    .eq('id', targetUserId)
    .maybeSingle();
  if (profileRes.data?.welcome_friend_request_sent_at) {
    return { status: 'skipped', reason: 'already_sent' };
  }

  // Existing friendship in either direction (any status) blocks the send.
  // Mirrors the two-call pattern in routes/friends.js:210-216.
  const aRes = await supabase.from('friendships').select('id')
    .eq('user_id', founderId).eq('friend_id', targetUserId).maybeSingle();
  if (aRes.data) return { status: 'skipped', reason: 'friendship_exists' };

  const bRes = await supabase.from('friendships').select('id')
    .eq('user_id', targetUserId).eq('friend_id', founderId).maybeSingle();
  if (bRes.data) return { status: 'skipped', reason: 'friendship_exists' };

  // Insert pending friendship and stamp the idempotency timestamp in parallel.
  // Pattern mirrors the parallel write in routes/friends.js:124-127.
  const sentAt = new Date().toISOString();
  const [insertRes] = await Promise.all([
    supabase.from('friendships').insert({
      user_id: founderId,
      friend_id: targetUserId,
      status: 'pending',
    }),
    supabase.from('profiles')
      .update({ welcome_friend_request_sent_at: sentAt })
      .eq('id', targetUserId),
  ]);

  if (insertRes.error) {
    return { status: 'failed', error: insertRes.error.message || 'insert failed' };
  }

  // Notification is best-effort — wrap so a throw or rejection cannot roll back the friendship.
  try {
    await dispatchNotification(supabase, {
      userId: targetUserId,
      type: NOTIFICATION_TYPE,
      title: 'New friend request',
      body: NOTIFICATION_BODY,
      actionUrl: '/friends',
      refId: founderId,
    });
  } catch (err) {
    console.warn('[founderFriend] notification dispatch failed:', err.message);
  }

  return { status: 'sent' };
}

module.exports = { sendFounderFriendRequest };

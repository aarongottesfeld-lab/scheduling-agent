-- 20260426000001_add_welcome_friend_request_sent_at.sql
-- Tracks when the founder's automatic welcome friend request was sent to a user.
-- Used to make sendFounderFriendRequest and backfillFounderRequests idempotent
-- and to respect users who declined the request (decline deletes the friendships row,
-- so a row-existence check alone would re-ask them on every backfill).

ALTER TABLE profiles
  ADD COLUMN welcome_friend_request_sent_at timestamptz;

COMMENT ON COLUMN profiles.welcome_friend_request_sent_at IS
  'Timestamp the founder welcome friend request was sent. NULL means never sent. Set once and never cleared.';

-- Add user settings columns to profiles for notification preferences and privacy controls.
-- notification_settings: jsonb keyed by notification type, each value has optional
--   { in_product: bool, push: bool } — missing key = both default true (opt-out model).
-- allow_non_friend_group_invites: when false, only friends can add this user to groups.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notification_settings jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allow_non_friend_group_invites boolean NOT NULL DEFAULT true;

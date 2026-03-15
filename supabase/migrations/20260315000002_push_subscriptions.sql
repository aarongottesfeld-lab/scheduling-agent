-- Ensure push_subscriptions has all required columns and a unique constraint on user_id.
-- Safe to run multiple times (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS).

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS token text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now(),
  DROP CONSTRAINT IF EXISTS push_subscriptions_user_id_key;

ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_user_id_key UNIQUE (user_id);

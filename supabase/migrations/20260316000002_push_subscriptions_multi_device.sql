-- Support multiple devices per user for push notifications.
-- Legacy Web Push columns (endpoint, p256dh, auth) made nullable — FCM only uses token.
-- Unique constraint changed from (user_id) to (user_id, token) so each device
-- registers independently while preventing duplicate token rows.

ALTER TABLE push_subscriptions ALTER COLUMN endpoint DROP NOT NULL;
ALTER TABLE push_subscriptions ALTER COLUMN p256dh DROP NOT NULL;
ALTER TABLE push_subscriptions ALTER COLUMN auth DROP NOT NULL;

ALTER TABLE push_subscriptions DROP CONSTRAINT push_subscriptions_user_id_key;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_user_token_key UNIQUE (user_id, token);

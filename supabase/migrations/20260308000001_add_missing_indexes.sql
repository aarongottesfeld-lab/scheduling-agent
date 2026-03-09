-- =============================================================
-- Migration: add missing indexes on foreign key columns
-- Prevents full table scans on the most frequently joined paths.
-- =============================================================

-- friendships: queried by both user_id (already indexed as PK source)
-- and friend_id (previously unindexed — causes seq scan on every
-- "get friends of user" query from the attendee side).
CREATE INDEX IF NOT EXISTS idx_friendships_friend_id
  ON friendships (friend_id);

-- itineraries: every list query ORs on organizer_id / attendee_id.
-- Without indexes both columns force a full table scan.
CREATE INDEX IF NOT EXISTS idx_itineraries_organizer_id
  ON itineraries (organizer_id);

CREATE INDEX IF NOT EXISTS idx_itineraries_attendee_id
  ON itineraries (attendee_id);

-- nudges: filtered by user_id + status + expires_at on every dashboard load.
CREATE INDEX IF NOT EXISTS idx_nudges_user_id
  ON nudges (user_id);

CREATE INDEX IF NOT EXISTS idx_nudges_friend_id
  ON nudges (friend_id);

-- friend_annotations: always queried by (user_id, friend_id); user_id
-- is the primary lookup key, friend_id is the join side.
CREATE INDEX IF NOT EXISTS idx_friend_annotations_friend_id
  ON friend_annotations (friend_id);

-- notifications: queried by user_id on every poll + badge count.
-- Add composite to support the common (user_id, read) filter.
CREATE INDEX IF NOT EXISTS idx_notifications_user_id_read
  ON notifications (user_id, read);

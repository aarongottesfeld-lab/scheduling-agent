-- Manual busy blocks: organizer-set date exclusions injected into the AI prompt as
-- EXCLUDED WINDOWS so Claude avoids suggesting plans on blocked dates.
--
-- attendee_busy_notes: free-text from the attendee at decline time, shown to the
-- organizer so they know which dates/times to avoid when rerolling.
--
-- For group_itineraries, attendee_busy_notes is keyed by user_id (jsonb) since
-- multiple attendees may each decline with their own notes.

ALTER TABLE itineraries
  ADD COLUMN IF NOT EXISTS manual_busy_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS attendee_busy_notes text;

ALTER TABLE group_itineraries
  ADD COLUMN IF NOT EXISTS manual_busy_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS attendee_busy_notes jsonb NOT NULL DEFAULT '{}'::jsonb;

-- =================================================================
-- Migration: 20260418000001_unified_itineraries.sql
-- Unified itineraries table — merges itineraries + group_itineraries
-- =================================================================
--
-- Combines the 1:1 `itineraries` and group `group_itineraries` tables
-- into a single `itineraries` table with a `mode` column ('pair'|'group').
--
-- Strategy:
--   1. Rename old tables to _v1_backup (preserves data for rollback)
--   2. Create new unified `itineraries` table
--   3. Migrate data from both backup tables
--   4. Update FK references (nudges, group_comments)
--   5. Recreate indexes, RLS policies, and triggers
--
-- Rollback: rename backups back, restore FKs. Backups are preserved
-- until a separate cleanup migration drops them.
--
-- NOTE: This app uses the SERVICE ROLE key for all server-side DB
-- writes, which bypasses RLS entirely. RLS policies here are
-- defense-in-depth.
-- =================================================================


-- ═══════════════════════════════════════════════════════════════════
-- 1. RENAME OLD TABLES TO BACKUPS
-- ═══════════════════════════════════════════════════════════════════

-- Drop existing policies and triggers before rename to avoid conflicts
DROP POLICY IF EXISTS "itineraries_select" ON itineraries;
DROP POLICY IF EXISTS "itineraries_insert" ON itineraries;
DROP POLICY IF EXISTS "itineraries_update" ON itineraries;

DROP TRIGGER IF EXISTS group_itineraries_lock_check ON group_itineraries;
DROP TRIGGER IF EXISTS group_itineraries_updated_at ON group_itineraries;
DROP POLICY IF EXISTS "group_itineraries_select" ON group_itineraries;
DROP POLICY IF EXISTS "group_itineraries_insert" ON group_itineraries;
DROP POLICY IF EXISTS "group_itineraries_update" ON group_itineraries;
DROP POLICY IF EXISTS "group_itineraries_delete" ON group_itineraries;

-- Drop group_comments FK before rename so it doesn't break
ALTER TABLE group_comments DROP CONSTRAINT IF EXISTS group_comments_itinerary_id_fkey;

-- Drop nudges FKs before rename
ALTER TABLE nudges DROP CONSTRAINT IF EXISTS nudges_itinerary_id_fkey;
ALTER TABLE nudges DROP CONSTRAINT IF EXISTS nudges_group_itinerary_id_fkey;
ALTER TABLE nudges DROP CONSTRAINT IF EXISTS nudges_single_itinerary_type;

ALTER TABLE itineraries RENAME TO itineraries_v1_backup;
ALTER TABLE group_itineraries RENAME TO group_itineraries_v1_backup;


-- ═══════════════════════════════════════════════════════════════════
-- 2. CREATE UNIFIED ITINERARIES TABLE
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE itineraries (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Mode ─────────────────────────────────────────────────────────────
  mode                       text        NOT NULL,

  -- Participants ─────────────────────────────────────────────────────
  organizer_id               uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  attendee_id                uuid                 REFERENCES profiles(id) ON DELETE CASCADE,  -- pair only
  group_id                   uuid                 REFERENCES groups(id) ON DELETE CASCADE,    -- group only

  -- Pair-mode negotiation ────────────────────────────────────────────
  organizer_status           text        DEFAULT 'pending',
  attendee_status            text        DEFAULT 'pending',

  -- Group-mode voting ────────────────────────────────────────────────
  attendee_statuses          jsonb       DEFAULT '{}',
  quorum_threshold           int,
  tie_behavior               text        DEFAULT 'schedule',

  -- State machine (both modes) ───────────────────────────────────────
  itinerary_status           text        NOT NULL DEFAULT 'organizer_draft',

  -- Scheduling inputs ────────────────────────────────────────────────
  date_range_start           date        NOT NULL,
  date_range_end             date        NOT NULL,
  time_of_day                text,
  max_travel_minutes         int,
  context_prompt             text,

  -- AI output ────────────────────────────────────────────────────────
  suggestions                jsonb       NOT NULL DEFAULT '[]',
  selected_suggestion_id     text,
  selected_suggestion_index  int,          -- legacy 1:1 column
  event_title                text,
  calendar_event_id          text,
  calendar_event_url         text,

  -- History / audit ──────────────────────────────────────────────────
  changelog                  jsonb       NOT NULL DEFAULT '[]',
  edit_history               jsonb       NOT NULL DEFAULT '[]',  -- 1:1 only
  reroll_count               int         NOT NULL DEFAULT 0,
  suggestion_telemetry       jsonb,

  -- Travel mode ──────────────────────────────────────────────────────
  travel_mode                text        NOT NULL DEFAULT 'local',
  location_preference        text        NOT NULL DEFAULT 'system_choice',
  destination                text,
  trip_duration_days          int         NOT NULL DEFAULT 1,

  -- Manual busy blocks ───────────────────────────────────────────────
  manual_busy_blocks         jsonb       NOT NULL DEFAULT '[]',
  attendee_busy_notes        jsonb       DEFAULT '{}',  -- text for pair (wrapped), jsonb map for group

  -- Group-specific ───────────────────────────────────────────────────
  attendee_suggestion_map    jsonb       DEFAULT '{}',  -- group voting map
  organizer_recommendation_id text,                     -- group organizer pick

  -- Nudge config ─────────────────────────────────────────────────────
  nudge_after_hours          int         NOT NULL DEFAULT 48,

  -- Lifecycle ────────────────────────────────────────────────────────
  locked_at                  timestamptz,
  archived_at                timestamptz,
  created_at                 timestamptz DEFAULT now(),
  updated_at                 timestamptz DEFAULT now(),

  -- Constraints ──────────────────────────────────────────────────────
  CONSTRAINT itineraries_mode_check              CHECK (mode IN ('pair', 'group')),
  CONSTRAINT itineraries_status_check            CHECK (itinerary_status IN ('organizer_draft', 'awaiting_responses', 'locked', 'cancelled')),
  CONSTRAINT itineraries_travel_mode_check       CHECK (travel_mode IN ('local', 'travel', 'remote')),
  CONSTRAINT itineraries_location_pref_check     CHECK (location_preference IN ('closer_to_organizer', 'closer_to_attendee', 'system_choice', 'destination')),
  CONSTRAINT itineraries_tie_behavior_check      CHECK (tie_behavior IS NULL OR tie_behavior IN ('schedule', 'decline')),
  CONSTRAINT itineraries_organizer_status_check  CHECK (organizer_status IS NULL OR organizer_status IN ('pending', 'accepted', 'declined')),
  CONSTRAINT itineraries_attendee_status_check   CHECK (attendee_status IS NULL OR attendee_status IN ('pending', 'accepted', 'declined')),
  -- No CHECK on time_of_day: 1:1 uses plain text ('morning','evening','any'),
  -- group uses JSON objects ({"type":"evening"}, {"type":"custom","time":"9:30 PM"}).
  -- Server code handles both formats.

  -- Mode-specific integrity: pair requires attendee_id, group requires quorum
  CONSTRAINT itineraries_pair_requires_attendee  CHECK (mode <> 'pair'  OR attendee_id IS NOT NULL),
  CONSTRAINT itineraries_group_requires_quorum   CHECK (mode <> 'group' OR quorum_threshold IS NOT NULL)
);


-- ═══════════════════════════════════════════════════════════════════
-- 3. MIGRATE DATA
-- ═══════════════════════════════════════════════════════════════════

-- 3a. Migrate 1:1 itineraries → mode='pair'
-- Map itinerary_status from organizer_status/attendee_status/locked_at
INSERT INTO itineraries (
  id, mode, organizer_id, attendee_id,
  organizer_status, attendee_status,
  itinerary_status,
  date_range_start, date_range_end, time_of_day, max_travel_minutes, context_prompt,
  suggestions, selected_suggestion_id, selected_suggestion_index,
  event_title, calendar_event_id, calendar_event_url,
  changelog, edit_history, reroll_count, suggestion_telemetry,
  travel_mode, location_preference, destination, trip_duration_days,
  manual_busy_blocks, attendee_busy_notes,
  nudge_after_hours, locked_at, archived_at, created_at, updated_at
)
SELECT
  id, 'pair', organizer_id, attendee_id,
  organizer_status, attendee_status,
  -- Derive itinerary_status from existing columns
  CASE
    WHEN locked_at IS NOT NULL THEN 'locked'
    WHEN organizer_status = 'declined' OR attendee_status = 'declined' THEN 'cancelled'
    WHEN organizer_status = 'pending' AND attendee_status = 'pending' THEN 'organizer_draft'
    ELSE 'awaiting_responses'
  END,
  date_range_start, date_range_end, time_of_day, max_travel_minutes, context_prompt,
  suggestions, selected_suggestion_id, selected_suggestion_index,
  event_title, calendar_event_id, calendar_event_url,
  changelog, edit_history, reroll_count, suggestion_telemetry,
  travel_mode, location_preference, destination, trip_duration_days,
  manual_busy_blocks,
  -- Convert text attendee_busy_notes to jsonb (wrap as string or empty object)
  CASE
    WHEN attendee_busy_notes IS NOT NULL AND attendee_busy_notes <> ''
    THEN jsonb_build_object(attendee_id::text, attendee_busy_notes)
    ELSE '{}'::jsonb
  END,
  nudge_after_hours, locked_at, archived_at, created_at, updated_at
FROM itineraries_v1_backup;

-- 3b. Migrate group itineraries → mode='group'
INSERT INTO itineraries (
  id, mode, organizer_id, group_id,
  attendee_statuses, quorum_threshold, tie_behavior,
  itinerary_status,
  date_range_start, date_range_end, time_of_day, max_travel_minutes, context_prompt,
  suggestions, selected_suggestion_id,
  event_title, calendar_event_id, calendar_event_url,
  changelog, reroll_count, suggestion_telemetry,
  travel_mode, location_preference, destination, trip_duration_days,
  manual_busy_blocks, attendee_busy_notes,
  attendee_suggestion_map, organizer_recommendation_id,
  nudge_after_hours, locked_at, archived_at, created_at, updated_at
)
SELECT
  id, 'group', organizer_id, group_id,
  attendee_statuses, quorum_threshold, tie_behavior,
  itinerary_status,
  date_range_start, date_range_end, time_of_day, max_travel_minutes, context_prompt,
  suggestions, selected_suggestion_id,
  event_title, calendar_event_id, calendar_event_url,
  changelog, reroll_count, suggestion_telemetry,
  travel_mode, location_preference, destination, trip_duration_days,
  manual_busy_blocks, attendee_busy_notes,
  attendee_suggestion_map, organizer_recommendation_id,
  nudge_after_hours, locked_at, archived_at, created_at, updated_at
FROM group_itineraries_v1_backup;


-- ═══════════════════════════════════════════════════════════════════
-- 4. UPDATE FK REFERENCES
-- ═══════════════════════════════════════════════════════════════════

-- 4a. Nudges — consolidate itinerary_id + group_itinerary_id into single itinerary_id
-- First, copy group_itinerary_id values into itinerary_id where itinerary_id is null
UPDATE nudges
SET itinerary_id = group_itinerary_id
WHERE itinerary_id IS NULL AND group_itinerary_id IS NOT NULL;

-- Drop the group-specific column
ALTER TABLE nudges DROP COLUMN IF EXISTS group_itinerary_id;

-- Add FK to unified table
ALTER TABLE nudges
  ADD CONSTRAINT nudges_itinerary_id_fkey
  FOREIGN KEY (itinerary_id) REFERENCES itineraries(id) ON DELETE SET NULL;

-- 4b. Group comments — FK now points to unified itineraries table
-- IDs were preserved so no data remapping needed
ALTER TABLE group_comments
  ADD CONSTRAINT group_comments_itinerary_id_fkey
  FOREIGN KEY (itinerary_id) REFERENCES itineraries(id) ON DELETE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- 5. INDEXES
-- ═══════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_itineraries_mode
  ON itineraries (mode);

CREATE INDEX IF NOT EXISTS idx_itineraries_organizer_id
  ON itineraries (organizer_id);

CREATE INDEX IF NOT EXISTS idx_itineraries_attendee_id
  ON itineraries (attendee_id)
  WHERE attendee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_itineraries_group_id
  ON itineraries (group_id)
  WHERE group_id IS NOT NULL;

-- GIN index on attendee_statuses for JSONB ? operator (group mode RLS + queries)
CREATE INDEX IF NOT EXISTS idx_itineraries_attendee_statuses
  ON itineraries USING GIN (attendee_statuses)
  WHERE mode = 'group';

-- Composite index for home screen queries
CREATE INDEX IF NOT EXISTS idx_itineraries_organizer_status
  ON itineraries (organizer_id, itinerary_status);


-- ═══════════════════════════════════════════════════════════════════
-- 6. TRIGGER FUNCTIONS + TRIGGERS
-- ═══════════════════════════════════════════════════════════════════

-- Attach set_updated_at (already exists from prior migration)
DROP TRIGGER IF EXISTS itineraries_updated_at ON itineraries;
CREATE TRIGGER itineraries_updated_at
  BEFORE UPDATE ON itineraries
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Unified lock check — only evaluates group mode quorum logic.
-- Pair-mode locking stays in application code (schedule.js confirm route)
-- because the ping-pong negotiation is too stateful for a trigger.
CREATE OR REPLACE FUNCTION public.itineraries_lock_check_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_accepted_count int;
  v_declined_count int;
  v_pending_count  int;
  v_total_members  int;
BEGIN
  -- Only evaluate group mode
  IF NEW.mode <> 'group' THEN
    RETURN NEW;
  END IF;

  -- Only evaluate when awaiting responses
  IF NEW.itinerary_status <> 'awaiting_responses' THEN
    RETURN NEW;
  END IF;

  -- Tally votes from the attendee_statuses JSONB map
  SELECT
    count(*) FILTER (WHERE value = 'accepted'),
    count(*) FILTER (WHERE value = 'declined'),
    count(*) FILTER (WHERE value = 'pending'),
    count(*)
  INTO
    v_accepted_count,
    v_declined_count,
    v_pending_count,
    v_total_members
  FROM jsonb_each_text(NEW.attendee_statuses);

  -- Lock path: quorum met
  IF v_accepted_count >= NEW.quorum_threshold THEN
    -- Tie check: perfect 50/50 split
    IF v_pending_count = 0
       AND v_total_members > 0
       AND v_accepted_count = v_declined_count
       AND v_accepted_count * 2 = v_total_members
    THEN
      IF NEW.tie_behavior = 'decline' THEN
        NEW.itinerary_status := 'cancelled';
        RETURN NEW;
      END IF;
    END IF;

    NEW.locked_at        := now();
    NEW.itinerary_status := 'locked';
    RETURN NEW;
  END IF;

  -- Cancel path: all votes in but quorum not met
  IF v_pending_count = 0 AND v_accepted_count < NEW.quorum_threshold THEN
    NEW.itinerary_status := 'cancelled';
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS itineraries_lock_check ON itineraries;
CREATE TRIGGER itineraries_lock_check
  BEFORE UPDATE ON itineraries
  FOR EACH ROW
  WHEN (OLD.attendee_statuses IS DISTINCT FROM NEW.attendee_statuses)
  EXECUTE FUNCTION itineraries_lock_check_fn();

-- Drop the old trigger function (no longer attached to any table)
DROP FUNCTION IF EXISTS public.group_itineraries_lock_check_fn();


-- ═══════════════════════════════════════════════════════════════════
-- 7. RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE itineraries ENABLE ROW LEVEL SECURITY;

-- SELECT: organizer, attendee (pair), or anyone in attendee_statuses (group)
DROP POLICY IF EXISTS "itineraries_select" ON itineraries;
CREATE POLICY "itineraries_select" ON itineraries
  FOR SELECT
  USING (
    (select auth.uid()) = organizer_id
    OR (mode = 'pair'  AND (select auth.uid()) = attendee_id)
    OR (mode = 'group' AND attendee_statuses ? ((select auth.uid())::text))
  );

-- INSERT: organizer only
DROP POLICY IF EXISTS "itineraries_insert" ON itineraries;
CREATE POLICY "itineraries_insert" ON itineraries
  FOR INSERT
  WITH CHECK ((select auth.uid()) = organizer_id);

-- UPDATE: organizer or attendee (pair), organizer when unlocked (group)
-- NOTE: group member voting is done via service role (bypasses RLS)
DROP POLICY IF EXISTS "itineraries_update" ON itineraries;
CREATE POLICY "itineraries_update" ON itineraries
  FOR UPDATE
  USING (
    (mode = 'pair'  AND ((select auth.uid()) = organizer_id OR (select auth.uid()) = attendee_id))
    OR (mode = 'group' AND (select auth.uid()) = organizer_id AND locked_at IS NULL)
  );

-- DELETE: organizer, unlocked only
DROP POLICY IF EXISTS "itineraries_delete" ON itineraries;
CREATE POLICY "itineraries_delete" ON itineraries
  FOR DELETE
  USING (
    (select auth.uid()) = organizer_id AND locked_at IS NULL
  );

-- Update group_comments RLS to reference unified table
-- (column name is still itinerary_id, table it points to changed)
DROP POLICY IF EXISTS "group_comments_select" ON group_comments;
CREATE POLICY "group_comments_select" ON group_comments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM   itineraries i
      WHERE  i.id = group_comments.itinerary_id
        AND  i.mode = 'group'
        AND  (
          i.organizer_id = (select auth.uid()) OR
          i.attendee_statuses ? ((select auth.uid())::text)
        )
    )
  );

DROP POLICY IF EXISTS "group_comments_insert" ON group_comments;
CREATE POLICY "group_comments_insert" ON group_comments
  FOR INSERT
  WITH CHECK (
    user_id = (select auth.uid()) AND
    EXISTS (
      SELECT 1
      FROM   itineraries i
      WHERE  i.id = group_comments.itinerary_id
        AND  i.mode = 'group'
        AND  (
          i.organizer_id = (select auth.uid()) OR
          i.attendee_statuses ? ((select auth.uid())::text)
        )
    )
  );

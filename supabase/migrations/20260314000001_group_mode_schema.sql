-- =================================================================
-- Migration: 20260314000001_group_mode_schema.sql
-- Group mode — full schema
-- =================================================================
--
-- Covers:
--   CREATE: groups, group_members, group_itineraries, group_comments,
--           push_subscriptions
--   ALTER:  itineraries, nudges, notifications, profiles
--   FUNCTIONS: set_updated_at, is_group_member (SECURITY DEFINER),
--              group_itineraries_lock_check_fn, notifications_read_sync_fn
--   TRIGGERS: groups_updated_at, group_itineraries_updated_at,
--             group_itineraries_lock_check, notifications_read_sync
--   INDEXES:  standard FK indexes + GIN on attendee_statuses
--   RLS:      groups, group_members, group_itineraries,
--             group_comments, push_subscriptions
--
-- All changes are additive — no existing 1:1 functionality is broken.
-- Altered tables use IF NOT EXISTS / DROP ... IF EXISTS guards and safe
-- defaults throughout.
--
-- NOTE: This app uses the SERVICE ROLE key for all server-side DB
-- writes, which bypasses RLS entirely. RLS policies here are
-- defense-in-depth for direct DB access and any future move toward
-- Supabase Auth or the anon key.
--
-- KNOWN DESIGN NOTE — circular RLS dependency:
--   The groups SELECT policy checks group_members, and the group_members
--   SELECT policy checks group_members (self-referential). Both are
--   broken by routing through is_group_member(), a SECURITY DEFINER
--   function that runs with definer privileges and therefore bypasses
--   the RLS policies on group_members during its own evaluation.
-- =================================================================


-- ═══════════════════════════════════════════════════════════════════
-- 1. SHARED FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════

-- ── set_updated_at ────────────────────────────────────────────────
-- Shared BEFORE UPDATE trigger function used by groups and
-- group_itineraries. Sets NEW.updated_at = now().
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ── is_group_member ───────────────────────────────────────────────
-- SECURITY DEFINER helper called by RLS SELECT policies on both
-- groups and group_members. Running with definer privileges means it
-- bypasses RLS on group_members during evaluation, breaking the
-- circular dependency that would arise if the policies queried each
-- other's table directly.
--
-- Returns true if p_user_id is an active OR pending member of p_group_id.
-- Pending members are included so invited users can read group name /
-- description before deciding whether to accept the invitation.
CREATE OR REPLACE FUNCTION is_group_member(p_group_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   group_members
    WHERE  group_id = p_group_id
      AND  user_id  = p_user_id
      AND  status   IN ('active', 'pending')
  );
$$;


-- ═══════════════════════════════════════════════════════════════════
-- 2. NEW TABLES
-- ═══════════════════════════════════════════════════════════════════

-- ── groups ────────────────────────────────────────────────────────
-- A saved group that can be reused across multiple scheduling events.
-- description is the primary AI context signal for group itinerary
-- generation — the group equivalent of context_prompt on 1:1
-- itineraries, but persistent across all events for this group.
CREATE TABLE IF NOT EXISTS groups (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  created_by  uuid        NOT NULL REFERENCES profiles(id),
  description text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- ── group_members ─────────────────────────────────────────────────
-- Membership roster. Composite PK (group_id, user_id) guarantees one
-- row per user per group.
--
-- role:      'admin' (can invite/remove members) | 'member'
--            NOTE: 'admin' ≠ event organizer. Event organizer is tracked
--            by group_itineraries.organizer_id. Admin is a group management
--            role — promotable, distinct from who created the event.
-- status:    'pending' (invited, not yet responded) | 'active' |
--            'declined' | 'left'
-- invited_by: NULL for the group creator's own first membership row.
CREATE TABLE IF NOT EXISTS group_members (
  group_id    uuid        NOT NULL REFERENCES groups(id)   ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role        text        NOT NULL DEFAULT 'member',
  status      text        NOT NULL DEFAULT 'pending',
  invited_by  uuid                 REFERENCES profiles(id),
  joined_at   timestamptz,
  left_at     timestamptz,
  created_at  timestamptz DEFAULT now(),
  PRIMARY KEY (group_id, user_id),
  CONSTRAINT group_members_role_check   CHECK (role   IN ('admin', 'member')),
  CONSTRAINT group_members_status_check CHECK (status IN ('pending', 'active', 'declined', 'left'))
);

-- ── group_itineraries ─────────────────────────────────────────────
-- Scheduling events for groups. Mirrors the itineraries table but uses
-- an N-member JSONB voting map (attendee_statuses) instead of the
-- 2-actor organizer_status / attendee_status columns.
--
-- attendee_statuses shape:
--   { "<user-uuid>": "pending" | "accepted" | "declined" | "abstained" }
--
-- selected_suggestion_id: text — matches Claude's 'id' field ('s1','s2','s3').
--   Intentionally NOT an integer index, which is fragile if suggestions are
--   reordered across rerolls. Mirrors itineraries.selected_suggestion_id.
--
-- quorum_threshold: INTENTIONALLY has NO DEFAULT.
--   Cannot be computed at DDL time (depends on group size at event creation).
--   Every INSERT must supply this value. Silent failure if omitted —
--   server-side code must validate before insert.
--
-- group_id is nullable: supports ad-hoc group events that are not
--   associated with a saved named group.
CREATE TABLE IF NOT EXISTS group_itineraries (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id               uuid                 REFERENCES groups(id),  -- nullable: ad-hoc events ok
  organizer_id           uuid        NOT NULL REFERENCES profiles(id),

  -- Voting / quorum ─────────────────────────────────────────────────
  attendee_statuses      jsonb       NOT NULL DEFAULT '{}',
  quorum_threshold       int         NOT NULL,  -- NO DEFAULT — server must supply on every INSERT
  tie_behavior           text        NOT NULL DEFAULT 'schedule',
  -- 'schedule' → lock on 50/50 tie  |  'decline' → cancel on 50/50 tie

  -- State machine ───────────────────────────────────────────────────
  itinerary_status       text        NOT NULL DEFAULT 'organizer_draft',
  -- 'organizer_draft' | 'awaiting_responses' | 'locked' | 'cancelled'
  -- Transitioned by: organizer send action, group_itineraries_lock_check trigger

  -- Scheduling inputs (mirrors itineraries) ─────────────────────────
  date_range_start       date        NOT NULL,
  date_range_end         date        NOT NULL,
  time_of_day            text,
  max_travel_minutes     int,
  context_prompt         text,

  -- AI output ───────────────────────────────────────────────────────
  suggestions            jsonb       NOT NULL DEFAULT '[]',
  selected_suggestion_id text,        -- text, not int — matches itineraries convention
  event_title            text,        -- injected into Claude prompt as EVENT NAME:
  calendar_event_id      text,

  -- History / audit (mirrors itineraries: changelog only, no edit_history) ─
  changelog              jsonb       NOT NULL DEFAULT '[]',
  reroll_count           int         NOT NULL DEFAULT 0,
  suggestion_telemetry   jsonb,

  -- Travel mode (mirrors itineraries + same CHECK constraints) ──────
  travel_mode            text        NOT NULL DEFAULT 'local',
  location_preference    text        NOT NULL DEFAULT 'system_choice',
  destination            text,
  trip_duration_days     int         NOT NULL DEFAULT 1,

  -- Nudge config ────────────────────────────────────────────────────
  nudge_after_hours      int         NOT NULL DEFAULT 48,

  -- Lifecycle ───────────────────────────────────────────────────────
  locked_at              timestamptz,
  archived_at            timestamptz,
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now(),

  CONSTRAINT group_itineraries_tie_behavior_check   CHECK (tie_behavior        IN ('schedule', 'decline')),
  CONSTRAINT group_itineraries_status_check         CHECK (itinerary_status    IN ('organizer_draft', 'awaiting_responses', 'locked', 'cancelled')),
  CONSTRAINT group_itineraries_quorum_check         CHECK (quorum_threshold    >= 1),
  CONSTRAINT group_itineraries_travel_mode_check    CHECK (travel_mode         IN ('local', 'travel')),
  CONSTRAINT group_itineraries_location_pref_check  CHECK (location_preference IN ('closer_to_organizer', 'closer_to_attendee', 'system_choice', 'destination'))
);

-- ── group_comments ────────────────────────────────────────────────
-- Per-suggestion comments within a group itinerary.
--
-- suggestion_id: text ('s1','s2','s3') — matches Claude's suggestion id
--   field and the itineraries.selected_suggestion_id convention.
--   NOT an integer index, which would become stale if suggestions are
--   reordered during a partial reroll.
--
-- body: capped at 2000 chars at the DB layer.
-- Comments are immutable after submission (no UPDATE or DELETE policies).
-- Hard-deletes happen only via ON DELETE CASCADE when the parent
-- group_itineraries row is deleted.
CREATE TABLE IF NOT EXISTS group_comments (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  itinerary_id  uuid        NOT NULL REFERENCES group_itineraries(id) ON DELETE CASCADE,
  suggestion_id text        NOT NULL,
  user_id       uuid        NOT NULL REFERENCES profiles(id),
  body          text        NOT NULL CHECK (char_length(body) <= 2000),
  created_at    timestamptz DEFAULT now()
);

-- ── push_subscriptions ────────────────────────────────────────────
-- Web Push API subscriptions. One row per (user_id, endpoint) pair.
-- endpoint is browser-issued and uniquely identifies the subscription.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint   text        NOT NULL,
  p256dh     text        NOT NULL,
  auth       text        NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, endpoint)
);


-- ═══════════════════════════════════════════════════════════════════
-- 3. EXISTING TABLE ALTERATIONS
-- ═══════════════════════════════════════════════════════════════════

-- ── itineraries ───────────────────────────────────────────────────
-- archived_at: soft-delete timestamp. Preserves rows for the
--   fetchAcceptedPairHistory AI context signal after the event date
--   passes (instead of the existing hard-delete cleanup job removing them).
-- nudge_after_hours: hours of silence before a nudge fires. Mirrors
--   the same column on group_itineraries. Default 48 backfills all
--   existing rows safely.
ALTER TABLE itineraries
  ADD COLUMN IF NOT EXISTS archived_at       timestamptz,
  ADD COLUMN IF NOT EXISTS nudge_after_hours int NOT NULL DEFAULT 48;

-- ── nudges ────────────────────────────────────────────────────────
-- Wire nudges to both 1:1 and group itinerary types.
-- Columns are nullable — not all nudges are linked to a specific event.
-- ON DELETE SET NULL is REQUIRED: the itinerary cleanup job in
--   GET /schedule/itineraries hard-deletes unlocked past itineraries.
--   Without ON DELETE SET NULL those deletes would raise FK violations.
-- Mutual-exclusion CHECK: a row may reference at most one itinerary type.
--   Both NULL is allowed for legacy rows that predate this migration.
ALTER TABLE nudges
  ADD COLUMN IF NOT EXISTS itinerary_id       uuid REFERENCES itineraries(id)       ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS group_itinerary_id uuid REFERENCES group_itineraries(id)  ON DELETE SET NULL;

ALTER TABLE nudges
  DROP CONSTRAINT IF EXISTS nudges_single_itinerary_type;
ALTER TABLE nudges
  ADD CONSTRAINT nudges_single_itinerary_type CHECK (
    NOT (itinerary_id IS NOT NULL AND group_itinerary_id IS NOT NULL)
  );

-- ── notifications ─────────────────────────────────────────────────
-- Additive only — existing columns (type, title, body, ref_id, read)
-- are preserved unchanged for backward compat with all existing query
-- paths and the idx_notifications_user_id_read index on (user_id, read).
--
-- tier:    1 = action required (web push + in-app)
--          2 = informational (in-app only)
-- data:    flexible JSONB payload that supplements ref_id. Allows
--          attaching structured context (group_id, suggestion_id, etc.)
--          without changing the existing ref_id (single UUID) column.
-- read_at: canonical read timestamp. Setting read_at fires the
--          notifications_read_sync trigger which auto-sets read = true,
--          keeping the existing boolean and its index valid.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS tier    int  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS data    jsonb,
  ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- ── profiles ──────────────────────────────────────────────────────
-- Onboarding state timestamps. Nullable — existing users have NULL,
-- interpreted by the UI as "not yet completed / not yet seen."
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS group_onboarding_seen_at timestamptz;


-- ═══════════════════════════════════════════════════════════════════
-- 4. INDEXES
-- ═══════════════════════════════════════════════════════════════════
-- Follows the pattern from 20260308000001_add_missing_indexes.sql:
-- index every FK column that will be queried from the "many" side.

-- group_members: queried by user_id ("which groups does this user belong to")
-- and by invited_by (audit / referral queries).
CREATE INDEX IF NOT EXISTS idx_group_members_user_id
  ON group_members (user_id);

CREATE INDEX IF NOT EXISTS idx_group_members_invited_by
  ON group_members (invited_by);

-- group_itineraries: queried by group_id (list events for a group)
-- and by organizer_id (list events created by this user).
CREATE INDEX IF NOT EXISTS idx_group_itineraries_group_id
  ON group_itineraries (group_id);

CREATE INDEX IF NOT EXISTS idx_group_itineraries_organizer_id
  ON group_itineraries (organizer_id);

-- group_comments: queried by itinerary_id (load comments for a plan)
-- and by user_id (moderation / user activity queries).
CREATE INDEX IF NOT EXISTS idx_group_comments_itinerary_id
  ON group_comments (itinerary_id);

CREATE INDEX IF NOT EXISTS idx_group_comments_user_id
  ON group_comments (user_id);

-- push_subscriptions: queried by user_id on every notification send.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id
  ON push_subscriptions (user_id);

-- GIN index on attendee_statuses — required for the JSONB ? operator.
-- Enables efficient key-existence queries:
--   "all group itineraries this user participated in"
--   → WHERE attendee_statuses ? user_uuid::text
-- Without this index those queries are full table seq scans.
-- Also supports the group_itineraries_select RLS policy evaluation.
CREATE INDEX IF NOT EXISTS idx_group_itineraries_attendee_statuses
  ON group_itineraries USING GIN (attendee_statuses);


-- ═══════════════════════════════════════════════════════════════════
-- 5. TRIGGER FUNCTIONS + TRIGGERS
-- ═══════════════════════════════════════════════════════════════════

-- ── groups_updated_at ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS groups_updated_at ON groups;
CREATE TRIGGER groups_updated_at
  BEFORE UPDATE ON groups
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ── group_itineraries_updated_at ──────────────────────────────────
DROP TRIGGER IF EXISTS group_itineraries_updated_at ON group_itineraries;
CREATE TRIGGER group_itineraries_updated_at
  BEFORE UPDATE ON group_itineraries
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ── group_itineraries_lock_check ──────────────────────────────────
-- Evaluates quorum after each vote is recorded in attendee_statuses.
-- Only fires when attendee_statuses actually changes (WHEN clause).
-- Only evaluates lock/cancel logic when itinerary_status = 'awaiting_responses'
-- — the guard inside the function prevents premature action on drafts.
--
-- Lock path:   accepted_count >= quorum_threshold → locked_at + 'locked'
--   Tie case:  if also a perfect 50/50 split and tie_behavior='decline'
--              → 'cancelled' instead of locked
-- Cancel path: all votes cast + accepted_count < quorum_threshold
--              → 'cancelled' (quorum mathematically unreachable)

CREATE OR REPLACE FUNCTION group_itineraries_lock_check_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_accepted_count int;
  v_declined_count int;
  v_pending_count  int;
  v_total_members  int;
BEGIN
  -- Guard: only evaluate when the organizer has sent the itinerary.
  -- Returning early on organizer_draft, locked, or cancelled prevents
  -- premature state transitions if attendee_statuses is pre-populated.
  IF NEW.itinerary_status <> 'awaiting_responses' THEN
    RETURN NEW;
  END IF;

  -- Tally votes from the attendee_statuses JSONB map.
  -- 'abstained' votes are counted in v_total_members but not pending/accepted/declined,
  -- so they do not block the cancel path and do not count toward quorum.
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

  -- ── Lock path ──────────────────────────────────────────────────
  -- Quorum is met when accepted_count reaches the organizer-set threshold.
  IF v_accepted_count >= NEW.quorum_threshold THEN

    -- Tie check: perfect 50/50 split where accepted = declined = total / 2.
    -- Requires all members to have voted (pending = 0) and the group to be
    -- even-numbered. Uses integer arithmetic — an odd total can never tie.
    -- Only applies at the exact threshold boundary, not above it.
    IF v_pending_count = 0
       AND v_total_members > 0
       AND v_accepted_count = v_declined_count
       AND v_accepted_count * 2 = v_total_members
    THEN
      IF NEW.tie_behavior = 'decline' THEN
        -- Tie + organizer chose 'decline' behavior → cancel.
        NEW.itinerary_status := 'cancelled';
        RETURN NEW;
      END IF;
      -- Tie + organizer chose 'schedule' behavior → fall through and lock.
    END IF;

    -- Clear quorum met (or tie with schedule behavior) → lock.
    NEW.locked_at        := now();
    NEW.itinerary_status := 'locked';
    RETURN NEW;
  END IF;

  -- ── Cancel path ────────────────────────────────────────────────
  -- All votes are in (pending = 0) but accepted count fell short of quorum.
  -- No further votes can arrive — quorum is mathematically unreachable.
  -- Cancel to prevent the itinerary from being stuck in awaiting_responses.
  IF v_pending_count = 0 AND v_accepted_count < NEW.quorum_threshold THEN
    NEW.itinerary_status := 'cancelled';
    RETURN NEW;
  END IF;

  -- Votes still outstanding — no state change yet.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_itineraries_lock_check ON group_itineraries;
CREATE TRIGGER group_itineraries_lock_check
  BEFORE UPDATE ON group_itineraries
  FOR EACH ROW
  WHEN (OLD.attendee_statuses IS DISTINCT FROM NEW.attendee_statuses)
  EXECUTE FUNCTION group_itineraries_lock_check_fn();

-- ── notifications_read_sync ───────────────────────────────────────
-- When read_at is newly set, auto-set read = true.
-- Keeps the existing read boolean and its index (idx_notifications_user_id_read
-- on (user_id, read)) valid so existing badge-count queries don't need
-- to change. The read boolean remains the query target; read_at is the
-- canonical timestamp for when the notification was actually dismissed.

CREATE OR REPLACE FUNCTION notifications_read_sync_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only sync when read_at transitions from NULL → a timestamp.
  -- Avoids re-setting read=true on every subsequent UPDATE to the row.
  IF NEW.read_at IS NOT NULL AND OLD.read_at IS NULL THEN
    NEW.read := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notifications_read_sync ON notifications;
CREATE TRIGGER notifications_read_sync
  BEFORE UPDATE ON notifications
  FOR EACH ROW
  EXECUTE FUNCTION notifications_read_sync_fn();


-- ═══════════════════════════════════════════════════════════════════
-- 6. RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════
--
-- Convention (from 20260308000002_fix_rls_policies.sql):
--   - Always (select auth.uid()), never raw auth.uid() — evaluated once
--     per statement, not once per row.
--   - DROP POLICY IF EXISTS before every CREATE POLICY (idempotent).
--   - Policy names in double quotes.

-- ── groups ────────────────────────────────────────────────────────
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;

-- SELECT: user is an active or pending member of the group.
-- Pending members need to read group name/description to decide whether
-- to accept the invitation — hence status IN ('active', 'pending').
-- Uses is_group_member() (SECURITY DEFINER) to avoid the circular
-- RLS dependency with group_members. See function definition above.
DROP POLICY IF EXISTS "groups_select" ON groups;
CREATE POLICY "groups_select" ON groups
  FOR SELECT
  USING (is_group_member(id, (select auth.uid())));

-- INSERT: any authenticated user may create a group.
DROP POLICY IF EXISTS "groups_insert" ON groups;
CREATE POLICY "groups_insert" ON groups
  FOR INSERT
  WITH CHECK ((select auth.uid()) IS NOT NULL);

-- UPDATE / DELETE: only the original creator of the group.
DROP POLICY IF EXISTS "groups_update" ON groups;
CREATE POLICY "groups_update" ON groups
  FOR UPDATE
  USING ((select auth.uid()) = created_by);

DROP POLICY IF EXISTS "groups_delete" ON groups;
CREATE POLICY "groups_delete" ON groups
  FOR DELETE
  USING ((select auth.uid()) = created_by);

-- ── group_members ─────────────────────────────────────────────────
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;

-- SELECT: the auth user is a member (active or pending) of the same group.
-- Uses is_group_member() (SECURITY DEFINER) to avoid a self-referential
-- recursive policy (a group_members SELECT that queries group_members).
DROP POLICY IF EXISTS "group_members_select" ON group_members;
CREATE POLICY "group_members_select" ON group_members
  FOR SELECT
  USING (is_group_member(group_id, (select auth.uid())));

-- INSERT: only active group admins may invite new members.
-- NOTE: The EXISTS subquery here queries group_members from within a
-- group_members INSERT policy. In practice this is never evaluated since
-- all writes go through the service role. Documented for clarity.
DROP POLICY IF EXISTS "group_members_insert" ON group_members;
CREATE POLICY "group_members_insert" ON group_members
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM   group_members AS admin_check
      WHERE  admin_check.group_id = group_members.group_id
        AND  admin_check.user_id  = (select auth.uid())
        AND  admin_check.role     = 'admin'
        AND  admin_check.status   = 'active'
    )
  );

-- UPDATE: members may only update their own row
-- (e.g., accepting an invitation, leaving a group).
DROP POLICY IF EXISTS "group_members_update" ON group_members;
CREATE POLICY "group_members_update" ON group_members
  FOR UPDATE
  USING ((select auth.uid()) = user_id);

-- DELETE: only active group admins may remove members.
DROP POLICY IF EXISTS "group_members_delete" ON group_members;
CREATE POLICY "group_members_delete" ON group_members
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM   group_members AS admin_check
      WHERE  admin_check.group_id = group_members.group_id
        AND  admin_check.user_id  = (select auth.uid())
        AND  admin_check.role     = 'admin'
        AND  admin_check.status   = 'active'
    )
  );

-- ── group_itineraries ─────────────────────────────────────────────
ALTER TABLE group_itineraries ENABLE ROW LEVEL SECURITY;

-- SELECT: organizer, or any member whose UUID appears as a key in
-- attendee_statuses. Uses the JSONB ? operator (covered by the GIN index).
DROP POLICY IF EXISTS "group_itineraries_select" ON group_itineraries;
CREATE POLICY "group_itineraries_select" ON group_itineraries
  FOR SELECT
  USING (
    (select auth.uid()) = organizer_id OR
    attendee_statuses ? ((select auth.uid())::text)
  );

-- INSERT: organizer only.
DROP POLICY IF EXISTS "group_itineraries_insert" ON group_itineraries;
CREATE POLICY "group_itineraries_insert" ON group_itineraries
  FOR INSERT
  WITH CHECK ((select auth.uid()) = organizer_id);

-- UPDATE: organizer only, and only before the itinerary is locked.
-- NOTE: Members also need to update attendee_statuses to record votes.
-- In practice all writes go through the service role (bypasses RLS).
-- Application-layer logic enforces that members can only write their
-- own key in attendee_statuses. Documented here for future direct-client work.
DROP POLICY IF EXISTS "group_itineraries_update" ON group_itineraries;
CREATE POLICY "group_itineraries_update" ON group_itineraries
  FOR UPDATE
  USING (
    (select auth.uid()) = organizer_id AND
    locked_at IS NULL
  );

-- DELETE: organizer only, before lock.
DROP POLICY IF EXISTS "group_itineraries_delete" ON group_itineraries;
CREATE POLICY "group_itineraries_delete" ON group_itineraries
  FOR DELETE
  USING (
    (select auth.uid()) = organizer_id AND
    locked_at IS NULL
  );

-- ── group_comments ────────────────────────────────────────────────
ALTER TABLE group_comments ENABLE ROW LEVEL SECURITY;

-- SELECT: the auth user is organizer or a listed member of the linked itinerary.
DROP POLICY IF EXISTS "group_comments_select" ON group_comments;
CREATE POLICY "group_comments_select" ON group_comments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM   group_itineraries gi
      WHERE  gi.id = group_comments.itinerary_id
        AND  (
          gi.organizer_id = (select auth.uid()) OR
          gi.attendee_statuses ? ((select auth.uid())::text)
        )
    )
  );

-- INSERT: same membership check + user_id must equal auth user.
DROP POLICY IF EXISTS "group_comments_insert" ON group_comments;
CREATE POLICY "group_comments_insert" ON group_comments
  FOR INSERT
  WITH CHECK (
    user_id = (select auth.uid()) AND
    EXISTS (
      SELECT 1
      FROM   group_itineraries gi
      WHERE  gi.id = group_comments.itinerary_id
        AND  (
          gi.organizer_id = (select auth.uid()) OR
          gi.attendee_statuses ? ((select auth.uid())::text)
        )
    )
  );

-- No UPDATE or DELETE policies: comments are immutable after submission.
-- Hard-deletes happen only via ON DELETE CASCADE from group_itineraries.

-- ── push_subscriptions ────────────────────────────────────────────
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "push_subscriptions_select" ON push_subscriptions;
CREATE POLICY "push_subscriptions_select" ON push_subscriptions
  FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "push_subscriptions_insert" ON push_subscriptions;
CREATE POLICY "push_subscriptions_insert" ON push_subscriptions
  FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "push_subscriptions_update" ON push_subscriptions;
CREATE POLICY "push_subscriptions_update" ON push_subscriptions
  FOR UPDATE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "push_subscriptions_delete" ON push_subscriptions;
CREATE POLICY "push_subscriptions_delete" ON push_subscriptions
  FOR DELETE
  USING ((select auth.uid()) = user_id);

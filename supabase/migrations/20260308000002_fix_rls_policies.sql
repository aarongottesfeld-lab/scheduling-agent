-- =============================================================
-- Migration: fix RLS policies
-- 1. Wrap every auth.uid() reference in (select auth.uid()) so
--    Postgres evaluates the expression once per statement instead
--    of once per row — eliminates per-row re-planning overhead.
-- 2. Merge the two overlapping SELECT policies on `profiles` into
--    a single "any authenticated user may read any profile" policy
--    (required for search and scheduling to work).
--
-- NOTE: this app uses the SERVICE ROLE key on the server, which
-- bypasses RLS entirely.  These policies are correct-by-default
-- defensive coverage for direct DB access, migrations, and any
-- future move toward the anon key or Supabase Auth.
-- =============================================================

-- ── profiles ──────────────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Drop both overlapping SELECT policies and replace with one.
DROP POLICY IF EXISTS "Users can read own profile"                    ON profiles;
DROP POLICY IF EXISTS "Users can view other profiles for scheduling"  ON profiles;
DROP POLICY IF EXISTS "profiles_select"                               ON profiles;

-- Any authenticated session may read any profile (needed for
-- user search and scheduling).  Using (select auth.uid()) means
-- the uid lookup is planned once, not once per row.
CREATE POLICY "profiles_select" ON profiles
  FOR SELECT
  USING ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
DROP POLICY IF EXISTS "profiles_insert"              ON profiles;
CREATE POLICY "profiles_insert" ON profiles
  FOR INSERT
  WITH CHECK ((select auth.uid()) = id);

DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "profiles_update"              ON profiles;
CREATE POLICY "profiles_update" ON profiles
  FOR UPDATE
  USING ((select auth.uid()) = id);

-- ── google_tokens (future table — policies created defensively) ─
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'google_tokens'
  ) THEN
    EXECUTE 'ALTER TABLE google_tokens ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "Users can access own tokens" ON google_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "google_tokens_select"        ON google_tokens';
    EXECUTE $p$
      CREATE POLICY "google_tokens_select" ON google_tokens
        FOR SELECT USING ((select auth.uid()) = user_id)
    $p$;

    EXECUTE 'DROP POLICY IF EXISTS "google_tokens_insert" ON google_tokens';
    EXECUTE $p$
      CREATE POLICY "google_tokens_insert" ON google_tokens
        FOR INSERT WITH CHECK ((select auth.uid()) = user_id)
    $p$;

    EXECUTE 'DROP POLICY IF EXISTS "google_tokens_update" ON google_tokens';
    EXECUTE $p$
      CREATE POLICY "google_tokens_update" ON google_tokens
        FOR UPDATE USING ((select auth.uid()) = user_id)
    $p$;

    EXECUTE 'DROP POLICY IF EXISTS "google_tokens_delete" ON google_tokens';
    EXECUTE $p$
      CREATE POLICY "google_tokens_delete" ON google_tokens
        FOR DELETE USING ((select auth.uid()) = user_id)
    $p$;
  END IF;
END $$;

-- ── friendships ───────────────────────────────────────────────
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can see own friendships"       ON friendships;
DROP POLICY IF EXISTS "friendships_select"                  ON friendships;
CREATE POLICY "friendships_select" ON friendships
  FOR SELECT
  USING (
    (select auth.uid()) = user_id OR
    (select auth.uid()) = friend_id
  );

DROP POLICY IF EXISTS "Users can create friendship requests" ON friendships;
DROP POLICY IF EXISTS "friendships_insert"                   ON friendships;
CREATE POLICY "friendships_insert" ON friendships
  FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own friendships" ON friendships;
DROP POLICY IF EXISTS "friendships_update"               ON friendships;
CREATE POLICY "friendships_update" ON friendships
  FOR UPDATE
  USING (
    (select auth.uid()) = user_id OR
    (select auth.uid()) = friend_id
  );

DROP POLICY IF EXISTS "Users can delete own friendships" ON friendships;
DROP POLICY IF EXISTS "friendships_delete"               ON friendships;
CREATE POLICY "friendships_delete" ON friendships
  FOR DELETE
  USING (
    (select auth.uid()) = user_id OR
    (select auth.uid()) = friend_id
  );

-- ── friend_annotations ────────────────────────────────────────
ALTER TABLE friend_annotations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own annotations" ON friend_annotations;
DROP POLICY IF EXISTS "friend_annotations_all"           ON friend_annotations;
-- Single policy covers SELECT, INSERT, UPDATE, DELETE.
CREATE POLICY "friend_annotations_all" ON friend_annotations
  USING     ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ── itineraries ───────────────────────────────────────────────
ALTER TABLE itineraries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can see own itineraries"    ON itineraries;
DROP POLICY IF EXISTS "itineraries_select"               ON itineraries;
CREATE POLICY "itineraries_select" ON itineraries
  FOR SELECT
  USING (
    (select auth.uid()) = organizer_id OR
    (select auth.uid()) = attendee_id
  );

DROP POLICY IF EXISTS "Users can create itineraries" ON itineraries;
DROP POLICY IF EXISTS "itineraries_insert"           ON itineraries;
CREATE POLICY "itineraries_insert" ON itineraries
  FOR INSERT
  WITH CHECK ((select auth.uid()) = organizer_id);

DROP POLICY IF EXISTS "Users can update own itineraries" ON itineraries;
DROP POLICY IF EXISTS "itineraries_update"               ON itineraries;
CREATE POLICY "itineraries_update" ON itineraries
  FOR UPDATE
  USING (
    (select auth.uid()) = organizer_id OR
    (select auth.uid()) = attendee_id
  );

-- ── activity_clusters (future / optional table) ───────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'activity_clusters'
  ) THEN
    EXECUTE 'ALTER TABLE activity_clusters ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "activity_clusters_select" ON activity_clusters';
    EXECUTE $p$
      CREATE POLICY "activity_clusters_select" ON activity_clusters
        FOR SELECT USING ((select auth.uid()) IS NOT NULL)
    $p$;
  END IF;
END $$;

-- ── nudges ────────────────────────────────────────────────────
ALTER TABLE nudges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can see own nudges" ON nudges;
DROP POLICY IF EXISTS "nudges_select"            ON nudges;
CREATE POLICY "nudges_select" ON nudges
  FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "nudges_insert" ON nudges;
CREATE POLICY "nudges_insert" ON nudges
  FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "nudges_update" ON nudges;
CREATE POLICY "nudges_update" ON nudges
  FOR UPDATE
  USING ((select auth.uid()) = user_id);

-- ── scheduling_requests (future / optional table) ─────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'scheduling_requests'
  ) THEN
    EXECUTE 'ALTER TABLE scheduling_requests ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "scheduling_requests_select" ON scheduling_requests';
    EXECUTE $p$
      CREATE POLICY "scheduling_requests_select" ON scheduling_requests
        FOR SELECT USING (
          (select auth.uid()) = requester_id OR
          (select auth.uid()) = target_id
        )
    $p$;
    EXECUTE 'DROP POLICY IF EXISTS "scheduling_requests_insert" ON scheduling_requests';
    EXECUTE $p$
      CREATE POLICY "scheduling_requests_insert" ON scheduling_requests
        FOR INSERT WITH CHECK ((select auth.uid()) = requester_id)
    $p$;
  END IF;
END $$;

-- ── notifications ─────────────────────────────────────────────
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notifications_select" ON notifications;
CREATE POLICY "notifications_select" ON notifications
  FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "notifications_update" ON notifications;
CREATE POLICY "notifications_update" ON notifications
  FOR UPDATE
  USING ((select auth.uid()) = user_id);

-- Server inserts notifications on behalf of any user, so no INSERT
-- policy is defined here — the service role bypasses RLS for inserts.

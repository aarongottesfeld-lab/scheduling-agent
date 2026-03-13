-- =================================================================
-- Migration: 20260314000002_fix_function_search_paths.sql
-- Fix function_search_path_mutable security warnings on all 4
-- functions created in the group mode migration.
--
-- Without SET search_path = '', a superuser could place a malicious
-- object in an earlier schema and cause the function to resolve to it
-- instead of the intended table. This is especially critical for
-- is_group_member, which is SECURITY DEFINER.
--
-- All table references are fully qualified (public.<table>) as
-- required when search_path = '' to prevent implicit schema lookup.
-- =================================================================


-- ── set_updated_at ────────────────────────────────────────────────
-- No table references — only operates on NEW (trigger row).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


-- ── is_group_member ───────────────────────────────────────────────
-- SECURITY DEFINER — fixing search_path is most critical here.
-- Table reference qualified: group_members → public.group_members.
CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.group_members
    WHERE  group_id = p_group_id
      AND  user_id  = p_user_id
      AND  status   IN ('active', 'pending')
  );
$$;


-- ── group_itineraries_lock_check_fn ───────────────────────────────
-- Operates on NEW/OLD trigger rows only — no direct table references.
-- jsonb_each_text is a built-in, not schema-dependent.
CREATE OR REPLACE FUNCTION public.group_itineraries_lock_check_fn()
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
  IF NEW.itinerary_status <> 'awaiting_responses' THEN
    RETURN NEW;
  END IF;

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

  IF v_accepted_count >= NEW.quorum_threshold THEN
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

  IF v_pending_count = 0 AND v_accepted_count < NEW.quorum_threshold THEN
    NEW.itinerary_status := 'cancelled';
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;


-- ── notifications_read_sync_fn ────────────────────────────────────
-- Operates on NEW/OLD trigger rows only — no direct table references.
CREATE OR REPLACE FUNCTION public.notifications_read_sync_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.read_at IS NOT NULL AND OLD.read_at IS NULL THEN
    NEW.read := true;
  END IF;
  RETURN NEW;
END;
$$;

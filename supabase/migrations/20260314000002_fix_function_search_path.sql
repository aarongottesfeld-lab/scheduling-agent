-- Migration: fix_function_search_path
-- Date: March 14, 2026
-- Reason: Security advisor flagged function_search_path_mutable on 4 functions.
-- Fix: Add SET search_path = '' to all four and qualify table refs with public.
-- is_group_member is highest priority as it is SECURITY DEFINER.

-- 1. set_updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 2. is_group_member (SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.group_members
    WHERE group_id = p_group_id
      AND user_id  = p_user_id
      AND status   = 'active'
  );
$$;

-- 3. group_itineraries_lock_check_fn
CREATE OR REPLACE FUNCTION public.group_itineraries_lock_check_fn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  accepted_count int;
  declined_count int;
  pending_count  int;
  total_count    int;
BEGIN
  IF NEW.itinerary_status <> 'awaiting_responses' THEN
    RETURN NEW;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE value::text = '"accepted"'),
    COUNT(*) FILTER (WHERE value::text = '"declined"'),
    COUNT(*) FILTER (WHERE value::text = '"pending"'),
    COUNT(*)
  INTO accepted_count, declined_count, pending_count, total_count
  FROM jsonb_each(NEW.attendee_statuses);

  IF accepted_count >= NEW.quorum_threshold THEN
    IF total_count > 0
       AND accepted_count = declined_count
       AND (accepted_count + declined_count) = total_count
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

  IF pending_count = 0 AND accepted_count < NEW.quorum_threshold THEN
    NEW.itinerary_status := 'cancelled';
  END IF;

  RETURN NEW;
END;
$$;

-- 4. notifications_read_sync_fn
CREATE OR REPLACE FUNCTION public.notifications_read_sync_fn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.read_at IS NOT NULL AND OLD.read_at IS NULL THEN
    NEW.read := true;
  END IF;
  RETURN NEW;
END;
$$;

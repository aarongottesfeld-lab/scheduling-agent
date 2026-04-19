-- =================================================================
-- Migration: 20260419000001_fix_group_voting.sql
-- Fix group voting to count quorum per-card, not total accepted
-- =================================================================
--
-- Bug: The lock trigger counted ALL accepted votes in attendee_statuses
-- regardless of which suggestion card each person voted for. Three
-- attendees voting for three different cards hit quorum=2 because
-- 3 accepted > 2.
--
-- Fix: Cross-reference attendee_statuses with attendee_suggestion_map
-- to count accepted votes PER CARD. Lock only when a single card
-- reaches quorum.
--
-- Also updates merge_attendee_vote RPC to atomically update both
-- attendee_statuses and attendee_suggestion_map in one UPDATE, so
-- the trigger sees consistent data.
-- =================================================================


-- ── Updated lock trigger ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.itineraries_lock_check_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_pending_count  int;
  v_total_members  int;
  v_max_card_accepts int;
  v_winning_card   text;
  v_declined_count int;
BEGIN
  -- Only evaluate group mode
  IF NEW.mode <> 'group' THEN
    RETURN NEW;
  END IF;

  -- Only evaluate when awaiting responses
  IF NEW.itinerary_status <> 'awaiting_responses' THEN
    RETURN NEW;
  END IF;

  -- Count pending and total from attendee_statuses
  SELECT
    count(*) FILTER (WHERE value = 'pending'),
    count(*)
  INTO v_pending_count, v_total_members
  FROM jsonb_each_text(NEW.attendee_statuses);

  -- Count accepted votes PER CARD by cross-referencing attendee_statuses
  -- with attendee_suggestion_map. Find the card with the most accepts.
  SELECT sub.winning_card, sub.winning_count
  INTO v_winning_card, v_max_card_accepts
  FROM (
    SELECT
      m.val AS winning_card,
      count(*) AS winning_count
    FROM jsonb_each_text(NEW.attendee_statuses) AS s(uid, vote)
    CROSS JOIN LATERAL (
      SELECT val FROM jsonb_each_text(NEW.attendee_suggestion_map) AS x(uid, val)
      WHERE x.uid = s.uid
    ) AS m
    WHERE s.vote = 'accepted'
    GROUP BY m.val
    ORDER BY count(*) DESC
    LIMIT 1
  ) sub;

  -- Lock path: best card meets quorum
  IF v_max_card_accepts IS NOT NULL AND v_max_card_accepts >= NEW.quorum_threshold THEN

    -- Tie check: all votes in, accepted = declined, even group
    IF v_pending_count = 0 AND v_total_members > 0 THEN
      SELECT count(*) INTO v_declined_count
      FROM jsonb_each_text(NEW.attendee_statuses)
      WHERE value = 'declined';

      IF v_max_card_accepts = v_declined_count
         AND v_max_card_accepts * 2 = v_total_members
         AND NEW.tie_behavior = 'decline'
      THEN
        NEW.itinerary_status := 'cancelled';
        RETURN NEW;
      END IF;
    END IF;

    -- Lock with the winning card
    NEW.locked_at              := now();
    NEW.itinerary_status       := 'locked';
    NEW.selected_suggestion_id := v_winning_card;
    RETURN NEW;
  END IF;

  -- Cancel path: all votes in but no card reached quorum
  IF v_pending_count = 0
     AND (v_max_card_accepts IS NULL OR v_max_card_accepts < NEW.quorum_threshold)
  THEN
    NEW.itinerary_status := 'cancelled';
    RETURN NEW;
  END IF;

  -- Still awaiting responses
  RETURN NEW;
END;
$$;

-- Update trigger WHEN clause to also fire on attendee_suggestion_map changes
DROP TRIGGER IF EXISTS itineraries_lock_check ON itineraries;
CREATE TRIGGER itineraries_lock_check
  BEFORE UPDATE ON itineraries
  FOR EACH ROW
  WHEN (
    OLD.attendee_statuses IS DISTINCT FROM NEW.attendee_statuses
    OR OLD.attendee_suggestion_map IS DISTINCT FROM NEW.attendee_suggestion_map
  )
  EXECUTE FUNCTION itineraries_lock_check_fn();


-- ── Updated merge_attendee_vote RPC ──────────────────────────────
-- Now also updates attendee_suggestion_map atomically so the trigger
-- sees both the vote and the card pick in the same row state.
CREATE OR REPLACE FUNCTION public.merge_attendee_vote(
  p_itinerary_id  uuid,
  p_user_id       text,
  p_vote          text,
  p_suggestion_id text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.itineraries
  SET attendee_statuses = attendee_statuses || jsonb_build_object(p_user_id, p_vote),
      attendee_suggestion_map = CASE
        WHEN p_suggestion_id IS NOT NULL
        THEN attendee_suggestion_map || jsonb_build_object(p_user_id, p_suggestion_id)
        ELSE attendee_suggestion_map
      END
  WHERE id = p_itinerary_id;
$$;

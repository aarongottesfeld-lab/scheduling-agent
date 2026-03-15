-- A4-003: Add merge_attendee_vote RPC function for atomic attendee vote recording.
-- Replaces the read-modify-write pattern in PATCH /group-itineraries/:id/vote
-- where two concurrent votes could overwrite each other (lost-update race condition).
--
-- The JSONB || operator merges the new key into attendee_statuses atomically:
-- if two attendees call this simultaneously, both writes are applied correctly
-- because each UPDATE targets only one key in the JSONB object.
--
-- p_user_id is text (not uuid) because attendee_statuses keys are stored as
-- Supabase UUID strings (the JSONB key type is always text in Postgres).

CREATE OR REPLACE FUNCTION public.merge_attendee_vote(
  p_itinerary_id uuid,
  p_user_id      text,
  p_vote         text
)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.group_itineraries
  SET    attendee_statuses = attendee_statuses || jsonb_build_object(p_user_id, p_vote)
  WHERE  id = p_itinerary_id;
$$;

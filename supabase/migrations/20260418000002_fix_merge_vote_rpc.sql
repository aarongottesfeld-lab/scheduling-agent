-- Fix merge_attendee_vote RPC to reference unified itineraries table
-- (was pointing to group_itineraries which is now group_itineraries_v1_backup)

CREATE OR REPLACE FUNCTION public.merge_attendee_vote(
  p_itinerary_id uuid,
  p_user_id      text,
  p_vote         text
)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.itineraries
  SET    attendee_statuses = attendee_statuses || jsonb_build_object(p_user_id, p_vote)
  WHERE  id = p_itinerary_id;
$$;

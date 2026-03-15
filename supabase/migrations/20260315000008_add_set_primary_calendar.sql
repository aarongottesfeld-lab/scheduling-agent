-- A4-013: Add set_primary_calendar_connection RPC function.
-- Replaces the two-step UPDATE sequence in PATCH /calendar/connections/:id
-- (clear all is_primary, then set on target) with a single atomic operation.
-- A crash between the two prior UPDATEs would leave the user with no primary
-- calendar, silently causing createCalendarEventForUser to fall back to session tokens.
--
-- Usage: SELECT set_primary_calendar_connection(p_connection_id, p_user_id);
-- Returns void. Caller is responsible for verifying ownership before calling.

CREATE OR REPLACE FUNCTION public.set_primary_calendar_connection(
  p_connection_id uuid,
  p_user_id       uuid
)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.calendar_connections
  SET    is_primary = (id = p_connection_id)
  WHERE  user_id = p_user_id;
$$;

-- A4-004: Recreate update_calendar_connections_updated_at() with SET search_path = ''
-- to eliminate the function_search_path_mutable security advisory.
-- The calendar_connections migration (20260315000003) created this function without
-- the SET search_path guard that was established by 20260314000002 for all other
-- trigger functions. This migration applies that same fix.
-- The trigger itself does not need to be recreated — only the function body changes.

CREATE OR REPLACE FUNCTION public.update_calendar_connections_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

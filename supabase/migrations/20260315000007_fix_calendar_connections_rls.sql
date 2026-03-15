-- A4-012: Fix calendar_connections RLS policies to use (SELECT auth.uid()) instead of
-- raw auth.uid(). The project convention (established in 20260308000002_fix_rls_policies.sql)
-- uses (SELECT auth.uid()) to prevent per-row re-evaluation overhead.
-- The original calendar_connections migration used the raw form and must be corrected.

DROP POLICY IF EXISTS "Users can view own calendar connections"   ON public.calendar_connections;
DROP POLICY IF EXISTS "Users can insert own calendar connections" ON public.calendar_connections;
DROP POLICY IF EXISTS "Users can update own calendar connections" ON public.calendar_connections;
DROP POLICY IF EXISTS "Users can delete own calendar connections" ON public.calendar_connections;

CREATE POLICY "Users can view own calendar connections"
  ON public.calendar_connections FOR SELECT
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert own calendar connections"
  ON public.calendar_connections FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can update own calendar connections"
  ON public.calendar_connections FOR UPDATE
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can delete own calendar connections"
  ON public.calendar_connections FOR DELETE
  USING (user_id = (SELECT auth.uid()));

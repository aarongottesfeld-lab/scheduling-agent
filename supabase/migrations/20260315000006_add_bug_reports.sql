-- A4-010: Create bug_reports table.
-- Referenced in server/routes/bugReport.js but absent from all prior migrations.
-- Without this migration, any environment reset or Supabase branch creation will
-- cause the bug report route to fail with "relation does not exist".

CREATE TABLE IF NOT EXISTS public.bug_reports (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category   text        NOT NULL,
  message    text        NOT NULL,
  page_url   text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_user_id
  ON public.bug_reports (user_id);

ALTER TABLE public.bug_reports ENABLE ROW LEVEL SECURITY;

-- Users can insert their own reports; no SELECT policy (admin reviews via service role).
CREATE POLICY "Users can insert their own bug reports"
  ON public.bug_reports FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Service role has full access for admin review.
CREATE POLICY "Service role full access to bug_reports"
  ON public.bug_reports
  TO service_role
  USING (true)
  WITH CHECK (true);

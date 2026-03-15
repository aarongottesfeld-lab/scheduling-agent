-- A4-009: Add default_activities column to groups table.
-- This column is referenced in the application code (POST /groups, GET /groups,
-- PATCH /groups, and the group suggest prompt builder) but was absent from the
-- original groups table migration (20260314000001_group_mode_schema.sql).
-- Any environment reset or Supabase branch creation would fail at runtime without this.

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS default_activities text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.groups.default_activities IS
  'Organizer-supplied activity preferences used as context in the group AI suggest prompt.';

-- Migration: add suggestion_telemetry column to itineraries
--
-- Stores structured telemetry about each suggestion generation run as JSONB.
-- Captured fields (see server/routes/schedule.js for the full schema):
--   context_prompt_present           boolean  — was a context prompt supplied?
--   intent_class                     text     — 'home_likely' | 'activity_specific' | 'ambiguous'
--   home_suggestion_count            integer  — how many suggestions are home-based
--   retry_attempted                  boolean  — did the theme-match short-circuit trigger a retry?
--   retry_succeeded                  boolean  — did the retry produce usable suggestions?
--   venue_enrichment_verified_count  integer  — venues confirmed via Google Places
--   venue_enrichment_failed_count    integer  — venues that couldn't be confirmed
--   suggestion_count                 integer  — final suggestion count after window-filter
--   past_history_count               integer  — accepted pair history items injected as context
--   reroll_count                     integer  — (reroll rows only) which reroll number this was
--
-- Nullable: old rows without telemetry are valid; new rows always populate it.
-- IF NOT EXISTS: safe to re-run.

ALTER TABLE itineraries
  ADD COLUMN IF NOT EXISTS suggestion_telemetry jsonb;

COMMENT ON COLUMN itineraries.suggestion_telemetry IS
  'Structured telemetry from the Claude suggestion pipeline (intent class, retry flags, venue enrichment counts, etc.). Populated on insert (suggest) and overwritten on update (reroll). Nullable for rows created before this migration.';

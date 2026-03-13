-- Migration: add location / travel mode columns to itineraries
--
-- Supports the Location & Travel Mode sprint (steps 1–4: local mode only).
-- Steps 5–6 (multi-day, "Somewhere new" destination flow) ship in a follow-on sprint.
--
-- New columns:
--   travel_mode          — 'local' | 'travel'. Default 'local'. Steps 5–6 will expose
--                          the 'travel' option; this sprint only wires the local mode UI.
--   location_preference  — 'closer_to_organizer' | 'closer_to_attendee' |
--                          'system_choice' | 'destination'. Default 'system_choice'.
--                          Drives the LOCATION ANCHORING block in buildSuggestPrompt.
--   destination          — nullable free text; populated in step 6 ("Somewhere new") only.
--   trip_duration_days   — integer, default 1. Multi-day support ships in step 5.
--
-- All columns use IF NOT EXISTS — safe to re-run without error.
-- CHECK constraints enforce the allowed enum values at the DB layer.
-- Existing rows without these columns get the DEFAULT values automatically,
-- which map to the pre-existing behavior (system choice, local, 1 day).
-- No RLS changes needed — new columns inherit existing row-level policies.

ALTER TABLE itineraries
  ADD COLUMN IF NOT EXISTS travel_mode text NOT NULL DEFAULT 'local'
    CHECK (travel_mode IN ('local', 'travel')),
  ADD COLUMN IF NOT EXISTS location_preference text NOT NULL DEFAULT 'system_choice'
    CHECK (location_preference IN ('closer_to_organizer', 'closer_to_attendee', 'system_choice', 'destination')),
  ADD COLUMN IF NOT EXISTS destination text,
  ADD COLUMN IF NOT EXISTS trip_duration_days int NOT NULL DEFAULT 1;

COMMENT ON COLUMN itineraries.travel_mode IS
  'Local vs. travel mode. Default local. Travel mode (multi-day, destination planning) ships in sprint 2 of the location feature.';

COMMENT ON COLUMN itineraries.location_preference IS
  'Where to anchor venue suggestions: closer_to_organizer | closer_to_attendee | system_choice | destination. Default system_choice (equidistant / best fit). Drives the LOCATION ANCHORING block injected into the Claude prompt.';

COMMENT ON COLUMN itineraries.destination IS
  'Destination city/region for travel mode. Nullable — only populated when location_preference = destination (step 6).';

COMMENT ON COLUMN itineraries.trip_duration_days IS
  'Number of days for multi-day trips. Default 1. Multi-day support (structured day grouping in suggestions JSONB) ships in sprint 2.';

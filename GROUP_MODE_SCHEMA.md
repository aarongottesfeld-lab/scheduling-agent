# Group Mode — Proposed Database Schema
Last updated: March 14, 2026

This document defines the full database schema for group mode. It is a PROPOSAL — Claude Code
should evaluate it against the existing codebase before writing any migrations. See the
prompt at the bottom of this file for review instructions.

For the full product spec, decision log, and architectural reasoning behind each decision,
see SPRINT_SPECS.md (Group mode sections).

---

## New tables to CREATE

### groups
```sql
CREATE TABLE groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  created_by   uuid NOT NULL REFERENCES profiles(id),
  description  text,  -- group context / primary AI signal for itinerary generation
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
```

### group_members
```sql
CREATE TABLE group_members (
  group_id    uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member',   -- 'admin' | 'member'
  status      text NOT NULL DEFAULT 'pending',  -- 'pending' | 'active' | 'declined' | 'left'
  invited_by  uuid REFERENCES profiles(id),
  joined_at   timestamptz,
  left_at     timestamptz,
  created_at  timestamptz DEFAULT now(),
  PRIMARY KEY (group_id, user_id),
  CONSTRAINT group_members_role_check   CHECK (role   IN ('admin', 'member')),
  CONSTRAINT group_members_status_check CHECK (status IN ('pending', 'active', 'declined', 'left'))
);
```

### group_itineraries
```sql
CREATE TABLE group_itineraries (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id                  uuid REFERENCES groups(id),  -- nullable: ad-hoc events have no saved group
  organizer_id              uuid NOT NULL REFERENCES profiles(id),

  -- voting / quorum
  attendee_statuses         jsonb NOT NULL DEFAULT '{}',
  -- shape: { "user-uuid": "pending" | "accepted" | "declined" | "abstained" }
  quorum_threshold          int NOT NULL,  -- minimum accepts required to lock
  tie_behavior              text NOT NULL DEFAULT 'schedule',  -- 'schedule' | 'decline'

  -- state machine
  itinerary_status          text NOT NULL DEFAULT 'organizer_draft',
  -- 'organizer_draft' | 'awaiting_responses' | 'locked' | 'cancelled'

  -- scheduling inputs (mirrors itineraries table)
  date_range_start          date NOT NULL,
  date_range_end            date NOT NULL,
  time_of_day               text,
  max_travel_minutes        int,
  context_prompt            text,

  -- AI output
  suggestions               jsonb NOT NULL DEFAULT '[]',
  selected_suggestion_index int,
  calendar_event_id         text,

  -- history / audit
  changelog                 jsonb NOT NULL DEFAULT '[]',
  reroll_count              int NOT NULL DEFAULT 0,
  edit_history              jsonb NOT NULL DEFAULT '[]',
  suggestion_telemetry      jsonb,

  -- travel mode (mirrors itineraries table)
  travel_mode               text NOT NULL DEFAULT 'local',
  location_preference       text NOT NULL DEFAULT 'system_choice',
  destination               text,
  trip_duration_days        int NOT NULL DEFAULT 1,

  -- nudge config
  nudge_after_hours         int NOT NULL DEFAULT 48,

  -- lifecycle
  locked_at                 timestamptz,
  archived_at               timestamptz,
  created_at                timestamptz DEFAULT now(),
  updated_at                timestamptz DEFAULT now(),

  CONSTRAINT group_itineraries_tie_behavior_check CHECK (tie_behavior IN ('schedule', 'decline')),
  CONSTRAINT group_itineraries_status_check       CHECK (itinerary_status IN ('organizer_draft', 'awaiting_responses', 'locked', 'cancelled')),
  CONSTRAINT group_itineraries_quorum_check       CHECK (quorum_threshold >= 1)
);
```

### group_comments
```sql
CREATE TABLE group_comments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  itinerary_id     uuid NOT NULL REFERENCES group_itineraries(id) ON DELETE CASCADE,
  suggestion_index int NOT NULL,
  user_id          uuid NOT NULL REFERENCES profiles(id),
  body             text NOT NULL,
  created_at       timestamptz DEFAULT now()
);
```

### push_subscriptions
```sql
CREATE TABLE push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint   text NOT NULL,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, endpoint)
);
```

---

## Existing tables to ALTER

### itineraries — add soft archive + nudge config
```sql
ALTER TABLE itineraries
  ADD COLUMN IF NOT EXISTS archived_at       timestamptz,
  ADD COLUMN IF NOT EXISTS nudge_after_hours int NOT NULL DEFAULT 48;
```

### nudges — wire to both itinerary types
```sql
ALTER TABLE nudges
  ADD COLUMN IF NOT EXISTS itinerary_id       uuid REFERENCES itineraries(id),
  ADD COLUMN IF NOT EXISTS group_itinerary_id uuid REFERENCES group_itineraries(id);
-- Exactly one of itinerary_id or group_itinerary_id should be set per row (not both).
-- Consider adding a CHECK constraint to enforce this after review.
```

### notifications — additive migration (preserve existing columns for backward compat)
```sql
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS tier    int NOT NULL DEFAULT 1,
  -- 1 = action required (web push + in-app), 2 = informational (in-app only)
  ADD COLUMN IF NOT EXISTS data    jsonb,
  -- flexible payload: { itinerary_id, group_id, suggestion_index, etc. }
  -- supplements existing ref_id (single UUID) — both columns preserved
  ADD COLUMN IF NOT EXISTS read_at timestamptz;
  -- new canonical read field; existing `read` boolean kept for backward compat
  -- trigger: when read_at is set, auto-set read = true
```

### profiles — onboarding state
```sql
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS group_onboarding_seen_at  timestamptz;
```

---

## Triggers required

### groups_updated_at
Auto-update `updated_at` on groups. Same pattern as existing `profiles_updated_at`.

### group_itineraries_updated_at
Auto-update `updated_at` on group_itineraries.

### group_itineraries_lock_check
When `attendee_statuses` is updated:
- Count entries where value = 'accepted'
- If count >= quorum_threshold → set locked_at, set itinerary_status = 'locked'
- For exact 50/50 splits on even-numbered groups: check tie_behavior
  - 'schedule' → lock
  - 'decline'  → do not lock

### notifications_read_sync
When `read_at` is set on a notifications row → auto-set `read = true`.
Keeps the existing `read` boolean in sync without requiring code changes.

---

## RLS policies required (all new tables)

### groups
- SELECT: user is a member of the group (exists in group_members with status = 'active')
- INSERT: any authenticated user
- UPDATE: created_by = auth user only
- DELETE: created_by = auth user only

### group_members
- SELECT: user is in the same group (group_id matches any group the user belongs to)
- INSERT: group admin only (role = 'admin' in group_members for that group_id)
- UPDATE: own row only (user_id = auth user — for leaving a group)
- DELETE: group admin only

### group_itineraries
- SELECT: organizer_id = auth user OR auth user's UUID appears as a key in attendee_statuses
- INSERT: organizer_id = auth user
- UPDATE: organizer_id = auth user AND locked_at IS NULL (no edits after lock)
- DELETE: organizer_id = auth user AND locked_at IS NULL

### group_comments
- SELECT: auth user is organizer or in attendee_statuses of the linked itinerary
- INSERT: same membership check as SELECT; user_id must = auth user
- UPDATE: none (comments are immutable after submit)
- DELETE: none (comments are immutable; hard-deleted only on itinerary cascade)

### push_subscriptions
- All operations: user_id = auth user only

---

## Key design decisions (summary)

| Decision | Choice | Reason |
|---|---|---|
| Separate table vs extend itineraries | Separate `group_itineraries` | 1:1 schema has two-actor assumptions throughout; clean separation avoids drift |
| Status columns | JSONB map per member | N members can't fit two columns; JSONB map scales to 15 |
| group_id nullable | Yes | Supports ad-hoc group events without requiring a saved group |
| Quorum logic | Configurable threshold, stored as int | Unanimous fails too often for 4+ members |
| Tie-breaking | Organizer-set toggle per event | Even-numbered groups need deterministic resolution |
| Re-roll ownership | Organizer only | Prevents any member from resetting all votes |
| notifications columns | Additive (keep read boolean) | Avoids breaking existing unread count / bell logic |
| Event data retention | Soft archive (archived_at) | Preserves fetchAcceptedPairHistory signal for AI |
| Group size cap | 15 members | Bounds freebusy call budget and notification volume |

---

## Claude Code review prompt

```
You are reviewing a proposed database schema for group mode in the Rendezvous scheduling app.

Before writing any migrations, please do the following:

1. Read GROUP_MODE_SCHEMA.md in full — this is the proposed schema.

2. Read SPRINT_SPECS.md — specifically the Group mode sections — to understand the
   product requirements and architectural decisions behind each table.

3. Read the existing codebase, focusing on:
   - server/routes/schedule.js — the core suggest, reroll, and confirm routes
   - server/index.js — auth, session handling, and route registration
   - All existing Supabase table references in the codebase
   - Any existing RLS policies or triggers you can infer from usage

4. Evaluate the proposed schema and provide a written report covering:
   a. Fields that are missing from the proposal but exist in the core codebase and
      would be needed for group mode to work correctly
   b. Fields in the proposal that conflict with or duplicate existing columns
   c. Any naming inconsistencies with the existing schema conventions
      (e.g., column naming patterns, FK naming, status value strings)
   d. Any RLS policy gaps or trigger logic that looks incomplete or incorrect
   e. Any migrations that could break existing 1:1 functionality if applied
   f. Your recommended changes to the schema before migrations are written

5. Do NOT write any migrations yet. Return only your evaluation report.
   Once the report is reviewed and approved, you will be asked to proceed with migrations.
```

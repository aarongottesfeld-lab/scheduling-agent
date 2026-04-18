# Unified Itinerary Table Refactor — Progress

Branch: `refactor/unified-itineraries`
Plan file: `/Users/aarongottesfeld/.claude/plans/validated-yawning-sun.md`
Started: 2026-04-18

---

## Status

- [x] **Phase 1: Database migration** — DONE (commit 53e717c)
  - Unified `itineraries` table created with `mode` column ('pair'|'group')
  - 25 pair + 17 group rows migrated successfully
  - Old tables preserved as `itineraries_v1_backup` and `group_itineraries_v1_backup`
  - Nudges FK consolidated (dropped `group_itinerary_id`, unified into `itinerary_id`)
  - Group comments FK updated to point at unified table
  - RLS policies: mode-aware SELECT/INSERT/UPDATE/DELETE
  - Quorum lock trigger: `itineraries_lock_check_fn()` — only fires for group mode
  - Migration file: `supabase/migrations/20260418000001_unified_itineraries.sql`
  - Migration applied to Supabase (project: bgeqxnrwrphbzenfrbdb)

- [ ] **Phase 2: Server route consolidation** — IN PROGRESS
  - [x] Extract `server/utils/availability.js` — DONE (commit 970739c)
    - Exports: timeOfDayHours, findFreeWindows, findFreeWindowsForGroup, fmtWindowDate, formatTime12h, splitMidnightBlocks, fetchBusy, inferDurationMinutes
  - [x] Fix merge_attendee_vote RPC → unified itineraries table — DONE (commit 970739c)
  - [x] Extract `server/utils/promptBuilder.js` — DONE (commit e43691b)
    - Should export: RENDEZVOUS_SYSTEM_PROMPT, CLAUDE_MODEL, THEME_FILLER, themeMatchesContextPrompt, classifyIntent, extractVenueName, buildVenueSubstitutionBlock, buildExcludedWindowsBlock, buildAttendeeNotesBlock, deriveGeoContext, buildSuggestPrompt, buildGroupSuggestPrompt, getProfileName, fetchAcceptedPairHistory, and group-specific helpers (fetchGroupHistory, buildGroupAttendeeNotesBlock)
  - [x] Update schedule.js to import from extracted utils — DONE (commit 4253e9f)
    - Removed 767 lines of inline functions, added imports from availability.js and promptBuilder.js
    - Added mode='pair' to INSERT, itinerary_status transitions to send/decline/lock routes
    - attendee_busy_notes now writes as jsonb map
  - [x] Update group-itineraries.js — DONE (commit e43691b + 4253e9f)
    - All 21 table references changed from group_itineraries to itineraries
    - mode='group' added to INSERT
    - Removed 383 lines of inline functions, imports from extracted utils
  - [x] Update groups.js ghost-vote cleanup to use unified table — DONE (commit 4253e9f)
  - [ ] Merge group route handlers into schedule.js — REMAINING
    - group-itineraries.js has ~1428 lines remaining (route handlers + fetchGroupHistory)
    - Move all app.post/get/patch/delete handlers into schedule.js's scheduleRouter function
    - Keep route paths as-is for now (client still uses /group-itineraries/* URLs)
    - OR add new /schedule/* equivalents and keep old paths as aliases during transition
  - [ ] Delete group-itineraries.js, update server/index.js

- [x] **Phase 3: MCP tools update** — DONE (commit c0404e3)
  - `mcp/tools/groups.js` — 12 table refs updated, mode='group' on INSERT
  - `mcp/tools/generate.js` — mode='pair' and itinerary_status on INSERT
  - `mcp/tools/itineraries.js` — already referenced unified table (no changes needed)

- [ ] **Phase 4: Client consolidation**
  - Merge `ItineraryView.js` (1275 lines) + `GroupItineraryView.js` (1408 lines)
  - Merge `NewEvent.js` (673 lines) + `NewGroupEvent.js` (952 lines)
  - Simplify `Home.js` — single API call, unified tab derivation
  - Update `App.js` routes, `GroupDetail.js` links

- [ ] **Phase 5: Cleanup & validation**
  - Full QA pass, drop backup tables after stable period

---

## Key Schema Decisions

- `mode` column: 'pair' | 'group'
- Pair mode uses `attendee_id`, `organizer_status`, `attendee_status` columns
- Group mode uses `attendee_statuses` JSONB, `quorum_threshold`, `tie_behavior`
- Both modes share `itinerary_status` ('organizer_draft'|'awaiting_responses'|'locked'|'cancelled')
- `time_of_day` has no CHECK constraint (1:1 uses plain text, group uses JSON objects)
- `attendee_busy_notes` is jsonb for both (1:1 values migrated from text to jsonb map)
- Pair locking stays in application code; group locking via DB trigger

## Key Files to Modify (Phase 2)

| File | Action |
|------|--------|
| `server/routes/schedule.js` | Major rewrite — absorb group logic |
| `server/routes/group-itineraries.js` | Delete after merge |
| `server/utils/promptBuilder.js` | New — extracted from both route files |
| `server/utils/availability.js` | New — extracted from both route files |
| `server/index.js` | Remove group-itineraries route registration |

## Unified Endpoint Mapping (Phase 2)

| Unified Route | Replaces |
|---------------|----------|
| POST /schedule/suggest | POST /schedule/suggest + POST /group-itineraries |
| GET /schedule/itineraries | GET /schedule/itineraries + GET /group-itineraries |
| GET /schedule/itinerary/:id | GET /schedule/itinerary/:id + GET /group-itineraries/:id |
| POST /schedule/confirm | POST /schedule/confirm + PATCH /group-itineraries/:id/vote |
| POST /schedule/itinerary/:id/send | both send routes |
| POST /schedule/itinerary/:id/reroll | both reroll routes |
| PATCH /schedule/itinerary/:id/title | both title routes |
| DELETE /schedule/itinerary/:id | both delete routes |

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
  - Merge `server/routes/schedule.js` (2814 lines) and `server/routes/group-itineraries.js` (1810 lines)
  - Extract `server/utils/promptBuilder.js` (buildSuggestPrompt, RENDEZVOUS_SYSTEM_PROMPT, classifyIntent, deriveGeoContext, etc.)
  - Extract `server/utils/availability.js` (findFreeWindows, findFreeWindowsForGroup, timeOfDayHours, etc.)
  - Unified endpoints under `/schedule/*` — all `/group-itineraries/*` routes removed
  - Delete `group-itineraries.js`, update `server/index.js`
  - Key: route handlers branch on `mode` for participant logic, availability, and prompt building

- [ ] **Phase 3: MCP tools update**
  - `mcp/tools/itineraries.js` — query unified table, add mode filter
  - `mcp/tools/groups.js` — query itineraries WHERE mode='group'
  - `mcp/tools/generate.js` — INSERT with mode column

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

# Rendezvous — Product Roadmap
Last updated: March 14, 2026 — reconciled against GCal save states and STATUS.md backfill

Full product roadmap: audit schedule, release gating, and the complete feature backlog
in priority order. For detailed design specs on each sprint (architecture, data model,
prompt changes, UI), see SPRINT_SPECS.md.

For monetization thinking (kept intentionally separate from the build), see MONETIZATION.md.
For competitive positioning and long-term moat, see competitive/MOAT.md.

---

## Audit schedule
Run a full codebase audit at each of these milestones — not on a calendar cadence,
but triggered by meaningful changes in scope or trust boundary.

**Audit 2 — Before deploying to Vercel**
Trigger: immediately after session persistence + OAuth cookie fix are complete, before
flipping the switch on Vercel. Scope is narrower than Audit 1 — focus on the new
sessions table (RLS, token expiry, entropy), cookie config correctness, and anything
the auth rewrite touched in index.js. The session rewrite is the most security-sensitive
change in the codebase and should be reviewed before it goes live.

**Audit 3 — Before sharing with real users**
Trigger: after output quality, location/travel mode, and group planning are all done.
This is the highest-stakes audit. By this point significant new surface area will have
accumulated: new DB columns, new prompt logic with health data flowing through it, new
UI flows, and the group planning state machine. Full audit — security, privacy, disaster
recovery, consistency — before real people's data is in play.

Audit 3 scope includes a dedicated recommendation engine review. In addition to the
standard security/privacy/DR categories, Claude Code should evaluate:
- Intent classification accuracy: does classifyIntent() correctly bucket edge cases?
  (e.g. "watch the Knicks at my place" vs "watch the Knicks at MSG", ambiguous prompts)
- Home vs. venue split fidelity: are home-based agendas generating correctly for
  home_likely intents, and are venue suggestions being suppressed appropriately?
- Prompt instruction hierarchy: is contextPrompt actually treated as the primary
  constraint in practice, or do profile preferences override it in edge cases?
- Exact-match reroll behavior: does a specific venue name or activity in a reroll
  prompt produce a matching suggestion, or does Claude drift to something adjacent?
- Venue substitution quality: when a named venue is unavailable, is the fallback
  genuinely similar (vibe, price, neighborhood) or generic?
- Dietary/mobility hard constraint enforcement: are NEVER constraints actually
  honored across all suggestion types including home-based plans?
- Duplicate venue detection: do any suggestion sets contain the same venue
  across multiple cards?
- Tags field: evaluate whether tags are wired to any client-side filtering or
  display — if not, remove from schema to reduce hallucination surface area and
  token waste (see AUDIT-NOTE comment in buildSuggestPrompt)
- Geo context accuracy: does deriveGeoContext() produce sensible output for
  users in different cities, same city, or with missing location data?
- System prompt drift: does the persona instruction ("sharp, well-connected
  activity planner") hold across rerolls and edge-case prompts, or does Claude
  revert to generic Yelp-list tone?
- schedule.js file split: the file has grown to 1,400+ lines. Evaluate splitting
  into focused submodules before it becomes harder to maintain:
    - server/routes/schedule.js — route handlers only (suggest, reroll, confirm, etc.)
    - server/lib/promptBuilder.js — buildSuggestPrompt, classifyIntent, extractVenueName,
      buildVenueSubstitutionBlock, deriveGeoContext, RENDEZVOUS_SYSTEM_PROMPT
    - server/lib/availability.js — findFreeWindows, inferDurationMinutes, fetchBusy,
      timeOfDayHours, fmtWindowDate
    - server/lib/calendarSync.js — createCalendarEventForUser, createOAuth2Client
    - server/lib/events.js — fetchLocalEvents (Ticketmaster + Eventbrite, when built)
  Claude Code should propose the split, verify no circular dependencies, and confirm
  all existing tests pass before committing. Do not merge partial splits.
- Performance & latency audit: the suggestion pipeline has grown with multiple sequential
  operations (calendar freebusy, friend_annotations fetch, past history fetch, Claude call,
  short-circuit retry, venue enrichment). Before real users, audit end-to-end latency and
  identify parallelization opportunities. Priority order: quality and security first, then
  speed. Specific questions to answer:
    - Which fetches can run concurrently? (e.g. freebusy + friend_annotations + past history
      could all be Promise.all'd instead of sequential awaits)
    - What is the p50/p95 latency of the suggest route in production? (check Vercel runtime logs)
    - Does the short-circuit retry add meaningful latency in practice, or does it rarely fire?
    - If venue enrichment (Places API) is added, does it block the response or can it run
      async and be written to the DB in the background?
    - Are there any N+1 query patterns in the suggest or reroll routes?
- Analytics instrumentation review: PostHog should be wired before real users arrive so
  session data is captured from day one. Audit 3 should verify:
    - PostHog SDK installed in client/ and initialized with project API key (env var, not
      hardcoded — store as REACT_APP_POSTHOG_KEY)
    - Key events captured: suggestion_generated, suggestion_accepted, reroll_triggered,
      itinerary_locked, friend_added, onboarding_completed, notification_permission_granted
    - User identity: posthog.identify() called after OAuth with supabaseId as the distinct_id
      (no PII — no email or name sent to PostHog unless explicitly opted in)
    - No sensitive data in event properties: dietary/mobility restrictions, location
      coordinates, and calendar data must never appear in PostHog event payloads
    - Privacy policy updated to disclose PostHog usage before first real user is onboarded
    - Competitive analysis for alternative tools (Mixpanel, Amplitude, etc.) deferred to
      post-launch — PostHog free tier is sufficient for early signal gathering

**Audit 4 — Before wider rollout (>20–30 users)**
Trigger: after multi-calendar support (phases 1-6) is complete and verified. By this point the core PWA feature set is essentially complete — 1:1, group, remote, travel, push notifications, and multi-calendar. This is a full-spectrum audit before pushing harder on user growth.

**Parity & consistency**
- Enumerate every user-facing feature across 1:1 (ItineraryView / schedule.js), group (GroupItineraryView / group-itineraries.js), and remote mode
- For each feature, verify behavior is consistent: same UX patterns, same inline confirmation flows, same error handling, same telemetry events
- Known parity surface area to check at minimum: delete draft button, reroll UX, send flow, status banners, PostHog events, travel/location mode options, manual busy blocks, micro-adjustment reroll
- Flag any feature that exists in one mode but is absent or degraded in another — each gap should be a deliberate decision, not an oversight
- Review CLAUDE_CODE_PROMPTS.md to confirm all saved prompts include parity instructions
- Verify buildSuggestPrompt (schedule.js) and buildGroupSuggestPrompt (group-itineraries.js) are structurally in sync — new prompt features should exist in both or have an explicit documented reason for asymmetry

**Security**
- calendar_connections trust boundary: verify the secondary Google OAuth connect flow cannot be used to associate another user's tokens with the wrong user_id. The stateData.userId in the connect callback must be verified against req.userId — confirm this check exists and cannot be bypassed.
- Re-audit all routes added since Audit 3 for missing requireAuth, missing UUID validation, and missing input sanitization: calendar_connections routes, push notification routes, manual busy blocks, attendee_busy_notes, classifyRerollIntent
- Confirm INJECTION_RE multiline flag fix (Audit 3 WARN item) has been applied
- Confirm RATE_LIMIT_EXEMPT has been moved to env var (Audit 3 WARN item)
- Verify FCM service account JSON is never logged, printed, or returned in any response
- Confirm push_subscriptions token is never returned to the client in any /calendar/connections or /users/me response
- Re-check RLS on all tables added since Audit 3: calendar_connections, push_subscriptions (updated schema)
- Verify sessions table tokens column is never exposed in any API response

**Privacy**
- Confirm no user PII (email, name, location, dietary/mobility restrictions) flows into PostHog event properties
- Verify calendar_connections tokens jsonb is excluded from all client-facing API responses
- Confirm attendee_busy_notes is never surfaced to the attendee — only the organizer can see it
- Check that the Apple CalDAV app-specific password (when built) is stored encrypted and never returned after initial save
- Audit all Claude prompt injections for PII: dietary restrictions, mobility restrictions, attendee_busy_notes, location strings — confirm none of this ends up in server logs
- Verify google_tokens empty table can be safely dropped without any remaining references

**Efficiency & performance**
- Audit the suggestion pipeline end-to-end for parallelization opportunities: freebusy fetches, friend_annotations, past history, activity venues, local events — identify which are currently sequential and could be Promise.all'd
- Check p50/p95 latency of /schedule/suggest and /group-itineraries/:id/suggest in Vercel runtime logs — flag anything over 8 seconds
- Audit calendar_connections freebusy aggregation for N+1 patterns — each connection should not fire a separate HTTP round trip if the same Google account has multiple calendar_ids (use the freebusy API's multi-calendar items[] array instead)
- Evaluate schedule.js file split (Audit 3 WARN item): 2000+ lines — propose split into promptBuilder.js, availability.js, calendarUtils.js before adding more features
- Check module-scoped caches in venueEnrichment.js and activityVenues.js for memory leak risk on long-running Vercel instances

**Disaster recovery**
- Verify that a failed calendar_connections INSERT during the OAuth connect callback does not leave a partial OAuth token set that can't be cleaned up
- Confirm that deleting a calendar_connections row does not break freebusy for in-progress itineraries that were generated using that connection — check whether any itinerary row references a calendar_connection_id
- Verify the sessions token fallback (when calendar_connections has no rows for a user) works correctly and doesn't silently return empty availability
- Check that revoked or expired FCM tokens are cleaned up correctly and don't accumulate in push_subscriptions
- Confirm that the google_tokens table (0 rows, unused) can be hard-dropped without FK violations or code references — document the cleanup migration

**Best practices & code quality**
- Audit all new error handling added since Audit 3 — confirm no routes silently swallow errors without logging
- Verify all new DB migrations have been applied to production (check supabase/migrations against what's live)
- Confirm firebase-admin is initialized only once (guard against re-initialization in hot-reload) — verify the admin.apps.length check in pushNotifications.js holds under Vercel's serverless model
- Check that calendar_connections updated_at trigger fires correctly on partial updates (PATCH operations)
- Review all TODO and FIXME comments added since Audit 3 — categorize as: fix now, log as known issue, or remove if stale
- Confirm tags field audit-note (Audit 3 scope, deferred) has been resolved: either wired to UI filtering or removed from Claude schema

**Audit 5 — Before App Store submission**
Trigger: when React Native migration is complete and App Store submission is being
prepared. Scope shifts to include Apple's data privacy requirements, privacy nutrition
label accuracy, ATT (App Tracking Transparency) if applicable, deep link security, and
native permission prompts. More compliance-focused than a pure security audit.

**Pattern: audit at every major trust boundary**
Deploy → real users → public distribution. Individual high-risk features (e.g. group
planning DB work, travel mode with destination data) should get a targeted review when
complete, but don't need a full audit.

---

## Release gating decision
Output quality, location/travel mode, and group planning must all be solid before sharing
with real users. First impressions with friends are hard to recover — a functional but generic
app will be mentally filed as "not ready" and re-engagement is difficult.

Revised sequence:
  1. ✅ Session persistence + OAuth fixes → DONE (March 12)
  2. ✅ Audit 2 security/privacy fixes → DONE (March 12)
  3. ✅ Vercel deploy → DONE (March 12)
  4. ✅ Output quality → DONE (March 13)
  5. ✅ Location & Travel Mode → DONE (March 13)
  6. ✅ Group planning backend ← DONE (March 14) — migrations applied, routes complete
  7. ✅ Group planning frontend ← DONE (March 14) — Groups tab, voting UI, draft→send flow, deployed
  7a. ✅ Automated QA pass ← DONE (March 14) — 14/14 tests passing, classifyIntent bug fixed
  8. ✅ PostHog setup ← DONE (March 14) — SDK wired, identify() on auth, 4 core events instrumented
  9. ✅ Audit 3 ← DONE (March 14) — 2 HIGH fixed (prompt injection), 1 WARN fixed (ghost votes)
     Remaining WARN items (non-blocking, address post-launch):
     - RATE_LIMIT_EXEMPT email: move to env var (RATE_LIMIT_EXEMPT_EMAILS) so it's not hardcoded in source
     - INJECTION_RE: add multiline flag + newline-based injection pattern coverage
     - tags field: unused by client — remove from Claude schema or wire to UI filtering
     - Promise.all: parallelize freebusy + friend_annotations + past history fetches (~200–400ms savings)
     - schedule.js: 2000+ lines — split into promptBuilder.js, availability.js, calendarSync.js before adding more features
  10. ✅ New-user onboarding flow ← DONE (March 14) — 3-step flow (profile, location, notifications)
  11. Share with real users ← YOU ARE HERE
  11. React Native / App Store → after feature set is proven on live users

### Step 7 — PostHog setup (do before Audit 3, not after)
PostHog must be wired before real users arrive so session and funnel data is captured from
day one. Setting it up after the fact means losing early signal that can't be reconstructed.

**Tool decision: PostHog (confirmed)**
PostHog cloud free tier covers all early-stage needs: event capture, funnels, session replay,
feature flags. No sales cycle, self-serve setup, free up to 1M events/month. Amplitude
(your current employer) is more powerful for advanced analysis but heavier to set up and
overkill for this stage. Migration to Amplitude is straightforward later if needed — the
event schema we're building is compatible.

**Setup steps (a few hours, not a sprint):**
1. Create PostHog account at posthog.com (cloud, no self-hosting needed)
2. Add `REACT_APP_POSTHOG_KEY` and `REACT_APP_POSTHOG_HOST` to client/.env and Vercel env vars
3. Install `posthog-js` in client/: `npm install posthog-js`
4. Initialize in client/src/index.js — call `posthog.init()` on app load
5. Call `posthog.identify(supabaseId)` after OAuth login completes — no PII, UUID only
6. Wire the 5 core key events first: `suggestion_generated`, `itinerary_locked`,
   `friend_added`, `onboarding_completed`, `reroll_triggered`
7. Add onboarding step telemetry per the spec in SPRINT_SPECS.md
8. Verify zero PII in event payloads before going live (Audit 3 will check this)

**Privacy constraints (non-negotiable):**
- `distinct_id` = supabaseId (UUID) only — never email or name
- No dietary, mobility, location coordinates, or calendar data in any event property
- Update privacy policy to disclose PostHog usage before first real user is onboarded

---

## 🔴 Next Up (current beta phase)

- [x] **Session persistence** — DONE March 12.
- [x] **Switch OAuth handoff** — HTTP-only cookie. DONE March 12.
- [x] **friends.js:186** — privacy fix. DONE March 12 (Audit 2).
- [x] **Vercel deployment** — DONE March 12.
- [x] **Tighten RLS** — notifications_service_role_all fixed. DONE March 12 (Audit 2).
- [ ] **HTTP referrer restriction** on Maps API key — still outstanding. Requires splitting into two keys (server-side key stays unrestricted; new browser key gets referrer lock). Full spec in Maps JS section of beta backlog below.
- [ ] **Active bugs — see "Active bugs — confirmed by 56-item audit" section in Testing Needed below for the full prioritized list.**

---

## 🟡 Feature Backlog (prioritized)

### Group Planning
> ✅ DONE — March 14, 2026. Implemented using a separate `group_itineraries` table (not the `itinerary_participants` approach originally specced — see GROUP_MODE_SCHEMA.md for the final schema and rationale). Groups tab, GroupDetail, NewGroupEvent, GroupItineraryView, voting UI, draft→send flow, comment threads, quorum logic, tie-breaking, ghost vote cleanup all shipped. 14/14 automated QA tests passing.
>
> Known UX gaps logged below in "Group mode — UX gaps" section.

### Output Quality & Suggestion Depth
> Full spec in SPRINT_SPECS.md. Suggestion and route quality are the primary retention driver — a technically working app with mediocre plans gets abandoned. Target: user reads the first suggestion on the first try and thinks "yeah, that actually sounds like us."

**Prompt engineering (do first — no new infrastructure)**
- [x] Audit `buildSuggestPrompt` in `schedule.js` — move `contextPrompt` earlier in the prompt, add explicit instruction that it overrides preference defaults. DONE.
- [x] Add emphasis framing: "MOST IMPORTANT — treat this as the primary constraint, above activity preferences and neighborhood defaults: {contextPrompt}". DONE.
- [x] Inject `friend_annotations.shared_interests` explicitly into system prompt as a high-signal input. DONE.
- [x] Add persona instruction via `RENDEZVOUS_SYSTEM_PROMPT` constant — "a well-connected local friend who knows the city, not a Yelp list". DONE.
- [x] Hard-constraint dietary and mobility restrictions with "never suggest X" framing, not soft hints. DONE.
- [x] Remove all hardcoded NYC assumptions — make city context fully dynamic from user profile locations via `deriveGeoContext()`. DONE.
- [x] Reroll: ensure `singleCardNote` and `contextPrompt` are treated as highest-priority carry-forward. DONE — single-card reroll treated as near-literal instruction via exactMatchBlock.
- [x] Home-based itinerary support — `classifyIntent()` routes home_likely / activity_specific / ambiguous. Home split: 2 home + 1 venue for home_likely. 🏠 badge on home cards. DONE.
- [x] Venue substitution — `buildVenueSubstitutionBlock()` instructs Claude to find closest match when named venue unavailable, with honest note field. DONE.
- [x] No duplicate venues rule added to buildSuggestPrompt. **NOTE: 56-item audit (March 14) confirmed this is NOT present in either prompt builder. STATUS.md was wrong. Fix is in the active bugs list above.**
- [x] **Feed past accepted itineraries as context** — `fetchAcceptedPairHistory()` queries locked itineraries for the pair (both directions), injects top 3 as "WHAT HAS WORKED FOR THIS PAIR BEFORE" block in prompt. Used as taste signal only — explicit instruction to not repeat venues or plans. Called in both suggest and reroll routes. DONE.
- [x] **Short-circuit validation** — `themeMatchesContextPrompt()` checks keyword match against title+narrative+tags. If `activity_specific` intent and no match, retries once with a hard RETRY instruction block. Applies to both suggest and reroll routes. Reroll uses stored `context_prompt` as fallback match target. Comment fences mark retry points for telemetry wiring. DONE.
- [ ] **Haiku vs Sonnet QA pass** — test a set of real prompts (empty, vague, specific, home-based, named venue) in both dev (Haiku) and prod (Sonnet) and document quality delta.
- [ ] **Structured telemetry** — log `context_prompt_present`, `intent_class`, `home_suggestion_count`, `retry_count` as JSONB on the itinerary row for Audit 3 QA pass.

**Venue quality filtering (use as soft signals, not hard filters)**
> IMPORTANT ARCHITECTURE NOTE: Claude currently generates venue names entirely from its training data — no Places API is called during suggestion generation. This means venues can be closed, renamed, or hallucinated. The venue quality sprint must address this before soft signals make sense.
>
> Chosen approach: enrich-after-generation. Claude generates suggestions with venue names as it does now, then the server validates and enriches each venue via Places API (Text Search by name + location). Real address, rating, review count, price_level, editorial_summary, and open status are attached to the suggestion before it's saved and returned to the client.
>
> This is lower complexity than a two-pass Claude architecture and doesn't require restructuring the prompt. If Places API can't find a venue, the suggestion is flagged with `venue_verified: false` so the client can optionally surface a disclaimer.
- [x] Build `enrichVenues(suggestions, cityContext)` in `server/utils/venueEnrichment.js`. Places API Text Search per non-home venue, concurrent per suggestion via Promise.allSettled, sequential across suggestions. Attaches `place_id`, `formatted_address`, `rating`, `user_ratings_total`, `price_level`, `venue_verified`. 60-min module-scoped cache by venue name + city. Fully wrapped in try/catch — returns suggestions unmodified on any failure. DONE.
- [x] `extractCityFromGeoContext(geoContext)` helper — parses deriveGeoContext() output into Places-friendly city string. CITY_ALIASES table covers common inputs (nyc, brooklyn, manhattan, la, sf, dc). Falls back to raw string. DONE.
- [x] Wired into suggest route (after short-circuit retry, before DB save) and reroll route (newly generated cards only — preserved cards keep original enrichment). DONE.
- [x] Surface `venue_verified` in ItineraryView — `✓ Verified` badge (green) on verified venues, subtle `· unverified` tag (gray) on unverified non-home venues. Home venues suppressed — never sent to Places API by design, showing "unverified" there would be misleading. DONE.
- [x] ⓘ tooltip in ItineraryView — scoped per card via `tooltipOpen` state so cards don't interfere with each other. Appears only on first verified venue per card (IIFE for `firstVerifiedIdx`). Accessible via hover, tap (toggle), and keyboard (Enter/Space). Renders inline beneath venue row using CSS variables for light/dark theme. Copy: "Venue verified means we confirmed this location exists via Google Places. It does not guarantee current hours, availability, or quality." DONE.
- [x] `v.formatted_address || v.address` — enriched address wins, Claude's address is fallback. Google Maps link uses richer address. DONE.
- [x] Privacy: Places API key stays server-side only. No user data sent to Places API — only venue name + city. Enforced in venueEnrichment.js. DONE.
- [ ] Option B (post-launch): feed enriched venue data (editorial_summary, price_level, rating) into a second Claude call to rewrite suggestion narratives using ground truth. Adds ~3–5s latency — defer until real users signal narrative quality is a pain point.

**Limited-time & live events (new sprint — do after venue quality)**
> Differentiating feature: a concert suggestion that's actually playing when the user is free is a completely different value prop than a generic venue recommendation.
- [ ] **Ticketmaster Discovery API** — free tier (5,000 calls/day). Fetch concerts, shows, sports by location + date range. Register at developer.ticketmaster.com. Store as `TICKETMASTER_API_KEY`.
- [ ] **Eventbrite API** — local festivals, pop-ups, neighborhood events. Register at eventbrite.com/platform. Store as `EVENTBRITE_API_KEY`.
- [ ] Build `fetchLocalEvents(location, dateRangeStart, dateRangeEnd, interests)` in `server/utils/events.js`. Calls both APIs concurrently, dedupes, filters by relevance to user interests, returns top 5–8 events with name, date/time, venue, category, URL.
- [ ] Inject into `buildSuggestPrompt` as a third content source: "AVAILABLE TIME-SENSITIVE EVENTS (happening during the suggested window): [list]". Instruct Claude to anchor a suggestion around a live event when it matches user interests or contextPrompt.
- [ ] Add 1-hour caching layer per (location, date_range) using a module-scoped Map or Supabase row.
- [ ] Add `event_source` field to suggestion JSONB: `ticketmaster | eventbrite | places | home`. Render 🎟 badge on event-anchored cards with deep link to purchase/info.
- [ ] Privacy: event API keys in `server/.env` only. Only location + date range sent to event APIs — no user data.

**Cultural moment scheduling (new sprint — do after live events)**
> Full spec in SPRINT_SPECS.md. When a context prompt references a specific cultural event —
> a sports game, TV premiere, award show, or movie release — itinerary dates should anchor
> to when that event actually happens. "Watch the Knicks" should suggest plans around the
> actual next game, not a random available slot.
- [ ] Build `extractCulturalSignal(contextPrompt, activityPreferences)` helper — detection layer
  returning `{ type, entity }` (sports / tv / film / awards / concert)
- [ ] Add `fetchSportsSchedule(team, dateRangeStart, dateRangeEnd)` — ESPN unofficial API
  (no key), covers NBA / MLB / NFL / NHL / MLS
- [ ] Wire PRIORITY EVENT block into `buildSuggestPrompt` — higher priority than general events block
- [ ] Add 🔴 Live badge to ItineraryView: `🔴 Live · Knicks tip-off 7:30 PM`
  Same rendering pattern as 🎟 Ticketmaster and 🎾 activity badges
- [ ] Extend `suggestion_telemetry` JSONB: cultural_signal_detected, cultural_signal_type,
  cultural_event_found, cultural_anchor_used
- [ ] TMDB API integration — TV premiere dates + film release dates (free tier, themoviedb.org)
  Store as `TMDB_API_KEY`
- [ ] Awards show constants file — Oscars / Grammys / Emmys / Golden Globes annual dates
  (no API needed, simple lookup table updated annually)
- [ ] Privacy: only team/show/movie names sent to external APIs — no user data ever

**Route logic and sequencing**
- [ ] Use Distance Matrix to validate venue sequence is geographically sensible (no zigzagging)
- [ ] Build duration lookup table per venue type: coffee = 45 min, dinner = 90 min, bar = 60 min, show = 2.5 hrs
- [ ] Enforce logical progression: pre-activity → activity → dinner → late night
- [ ] Opening hours validation: confirm all venues are open during the proposed time window before including them
- [ ] Time-of-day awareness: filter venue types that don't make sense for the time of day

**Personalization**
- [ ] `activity_clusters` table exists but is unused — run clustering on onboarding, update on each accepted itinerary
- [ ] Detect compatibility signals: weight toward overlap of what each person historically accepts
- [ ] Avoid suggestion fatigue: track recently suggested venue types in `changelog` jsonb and diversify

**Re-roll experience**
- [ ] Use `edit_history` rejection signals to improve the next prompt, not just retry blindly
- [ ] After 2+ rerolls, proactively surface a prompt asking for more context
- [ ] **Micro-adjustment reroll support** — when a user's reroll prompt contains relative
  modifiers ("same vibe but 30 minutes later", "a bit more casual", "closer to us",
  "slightly earlier"), the current prompt treats these as full replacements of context.
  Instead, detect relative modifier language and inject a MICRO-ADJUSTMENT instruction
  block that explicitly tells Claude to keep the existing itinerary structure and only
  modify the specified dimension. Examples:
  - "same vibe, 30 min later" → preserve venues/activity, shift time only
  - "a bit more casual" → preserve structure, soften venue tier/vibe
  - "somewhere closer" → preserve activity type, re-anchor location
  Detection: keyword list in classifyRerollIntent() (new helper alongside classifyIntent)
  returning 'micro_adjust' | 'full_replace' | 'ambiguous'

### Travel Mode — Multi-Day Itinerary Quality (prompt fix, no new infrastructure)
> Current state: Claude generates all days in a single call but front-loads Day 1 and leaves subsequent days thin. The days[] JSONB schema and ItineraryView day-grouped rendering already support multi-day output — this is purely a prompt improvement.
>
> Fix: explicitly tell Claude the total number of days, instruct it to generate a complete and distinct activity plan for each day with morning/afternoon/evening anchors, and enforce that each day has specific named venues — not filler. Apply to both buildSuggestPrompt (schedule.js) and buildGroupSuggestPrompt (group-itineraries.js) with parity. Prompt in CLAUDE_CODE_PROMPTS.md.

### Travel Mode — Day-by-Day Planning Wizard (future sprint, post-beta signal)
> Alternative to all-at-once generation: user plans one day at a time, with each day's generation informed by what was already selected for prior days. Significantly better quality per day for longer trips, natural iteration, each day feels considered rather than bulk-generated.
>
> Deferred until: real user feedback shows multi-day output quality is a pain point. Four beta users are unlikely to be booking 7-day trips in the first few weeks — need usage signal before investing in the more complex wizard state machine.
>
> When building: new state machine (partial trip state between wizard steps), multiple Claude calls per itinerary (one per day), UI flow for day-by-day review and selection, prior days injected as context for each subsequent call. Backend: itinerary row needs to store per-day status independently. This is a meaningful rewrite of the suggestion flow — do not start until Option 1 (prompt fix) has been validated with real users.

### Location Awareness & Travel Mode
> ✅ DONE — March 13, 2026. location_preference, travel_mode, trip_duration_days, destination columns added to itineraries and group_itineraries. NewEvent UI updated with Local/Travel toggle, where-to-meet selector, duration picker, destination input. buildSuggestPrompt updated with location anchoring and travel mode blocks. Multi-day JSONB schema (days array) shipped. ItineraryView day-grouped rendering done. Backward-compat shim for pre-migration rows in place.
>
> Known gap: trip duration picker uses static presets (1 day / Weekend / Longer). Needs exact day count or range input — logged in Tier 2 below.

### New-User Onboarding Flow
> ✅ DONE — March 14, 2026. 3-step flow (profile, location, notifications) shipped. PATCH /users/onboarding-complete, PATCH /users/location routes added. OnboardingRedirector in App.js. onboarding_completed PostHog event. Finish setup banner in Home.js. push_subscriptions table created (permission granted path stores subscription; delivery is a separate sprint). onboarding_completed_at column added to profiles.

### Turn-based Iteration + Mutual Planning
- [ ] Add `current_turn` field (organizer | attendee) to itineraries
- [ ] Attendee reroll flips turn back to organizer
- [ ] `planning_mode: 'standard' | 'mutual'` checkbox in NewEvent ("Open to counterproposals?")
- [ ] Mutual mode: both see all suggestions, both can reroll non-selected cards, both must accept same card to lock

### Cost Estimates
- [ ] Add `cost` object to suggestion schema: `{ min, max, per_person, currency, notes, breakdown: [] }`
- [ ] Per-venue cost estimate (Claude knowledge of venue tier + Maps data)
- [ ] Display "~$40–65/person" range on cards with expandable breakdown
- [ ] Mark all costs as estimated — no false precision
- [ ] Trip mode: detect when destination is outside user's metro, add flight/train/lodging estimates

### MCP Server
> End state: "Bobby and I want to go on a golf trip" → destinations, logistics, cost breakdown, calendar invite.
- [ ] MCP server — thin auth wrapper around existing API endpoints
- [ ] Tool: `resolve_friend(name)` — fuzzy first-name match → UUID
- [ ] Tool: `create_itinerary_proposal(friend_ids, activity, date_range, context)`
- [ ] Tool: `list_pending_itineraries()`
- [ ] Tool: `get_itinerary(id)`
- [ ] Tool: `accept_itinerary(id)` / `decline_itinerary(id)`
- [ ] Tool: `get_cost_estimate(destination, activity, party_size, dates)`
- [ ] Tool: `book_or_deeplink(venue, party_size, datetime)`
- [ ] `conversation_context` param — injected alongside structured profile data
- [ ] Context priority: explicit instruction > conversation context > shared interests > individual interests
- [ ] Profile update prompting — surface "save this to your profile?" when Claude infers preferences
- [ ] MCP auth — token-based, scoped per user, revocable
- [ ] Register with Claude.ai as available MCP connector
- [ ] Prompt-triggered agent — "set up plans with Jamie" → tools called in sequence → itinerary proposed

### Calendar Attendee Sync
> Build after group planning — requires itinerary_participants table.
- [ ] Manual "Sync attendees from calendar" button on locked itinerary
- [ ] Fetch current attendee list via `events.get` using organizer's stored OAuth token
- [ ] Diff against itinerary_participants, surface Rendezvous profile matches
- [ ] Organizer one-click "Add to itinerary" — sends normal participant invite flow
- [ ] Non-Rendezvous attendees: show "Invite to Rendezvous" prompt (acquisition moment)
- [ ] Privacy: never silently add anyone — always organizer-initiated
- [ ] v2: `calendar.events.watch` webhook (requires Vercel URL + renewal logic, max 7-day channels)

### Visual Design Refresh (after React Native migration, before App Store submission)

Simon (graphic designer) will create mockups in Figma or Canva. Implementation path:
- Simon delivers: screen mockups (PNG exports), hex color palette, font choices (Google Fonts preferred), component-level detail on cards/buttons/nav
- Upload screenshots to Claude.ai — Claude reads them directly and writes a precise Claude Code prompt
- Claude Code updates CSS variables (--brand, --surface-2, --border, etc.), NavBar, card components, and Google Fonts import
- Expect 80–90% fidelity from screenshots; one round of iteration for spacing/fine-tuning
- No code or asset files needed from Simon — mockups + color/font spec is sufficient

Sequencing rationale: design refresh is highest value as a native app heading to the App Store,
where first impressions against polished competitors matter most. Less critical for the PWA
early-user phase where feedback on functionality is the priority.

---

### React Native Migration & Native App
> PWA is the right first platform — no App Store review, installable on home screen, backend unchanged. React Native migration comes after the PWA is stable and the core feature set is proven. The migration unlocks native capabilities (EventKit, push, haptics) and proper App Store distribution.

**PWA phase (current target)**
- [ ] PWA config — manifest.json + service worker (already in deployment checklist)
- [ ] Push notifications via Web Push API — needed for real-time nudges without the app open
- [ ] Onboarding copy: "Google Calendar supported, Apple Calendar coming soon"
- [ ] Test PWA install flow on iOS Safari and Android Chrome

**React Native migration (post-PWA, when feature set is stable)**
- [ ] Migrate client/ from CRA/React to React Native — backend (server/) unchanged
- [ ] Replace browser-based Google OAuth with react-native-app-auth or Expo AuthSession
- [ ] Apple Calendar via EventKit (iOS native only — not available in PWA/web)
- [ ] Native push notifications via APNs (iOS) and FCM (Android) — replaces Web Push
- [ ] App Store submission — review guidelines audit, privacy policy, screenshots, metadata
- [ ] Play Store submission
- [ ] Haptic feedback on key moments (lock confirmation, new suggestion)
- [ ] Native share sheet for itinerary sharing

**Calendar provider expansion (can partially happen before RN migration)**
- [ ] iCloud CalDAV fallback for web (app-specific passwords — evaluate UX tradeoff)
- [ ] Outlook / Microsoft 365 Calendar (Graph API — similar OAuth flow to Google)

### Google OAuth Verification (before opening to public beyond 100 test users)

Google requires app verification before removing the 100-user test limit on OAuth consent.
This is free but takes 1–4 weeks. Apps requesting sensitive scopes (Calendar read/write)
require a CASA Tier 2 third-party security assessment (~$75–150 one-time cost).

**Prerequisites — complete all before submitting:**

1. **Privacy policy** — must be a publicly accessible URL. See "Privacy policy" item in Tier 3 above for full required content. Host at rendezvous-gamma.vercel.app/privacy. Complete this before submitting for verification.

2. **Terms of service** — recommended, sometimes required. Can be minimal for early stage.

3. **OAuth consent screen accuracy** — verify the consent screen in Google Cloud Console
   accurately lists only the scopes you actually use:
   - openid, email, profile (basic OAuth)
   - https://www.googleapis.com/auth/calendar.events (create events on lock)
   - https://www.googleapis.com/auth/calendar.readonly (read freebusy for availability)
   Remove any scopes listed that the app no longer uses.

4. **App must be live and testable** — Google will attempt to use the app during review.
   Ensure the production URL works end-to-end including Google Calendar connection.

5. **Walkthrough video** — Google frequently requests a short screen recording showing
   exactly how Calendar data is used. Prepare a 2–3 minute video showing:
   - Sign in with Google
   - Calendar permission request
   - How availability is read to find free windows
   - How an event is created on the calendar after a plan is locked

6. **CASA Tier 2 assessment** — required for apps with Calendar scope. Register at
   appdefensealliance.dev, select CASA Tier 2, complete the self-assessment, and submit
   for third-party review. Allow 1–2 weeks for turnaround. Cost: ~$75–150.

7. **Branding requirements** — app name, logo, and homepage URL must be consistent
   across the OAuth consent screen, privacy policy, and the live app.

**Submission process:**
- Google Cloud Console → APIs & Services → OAuth consent screen → Submit for verification
- Have all prerequisite URLs ready before clicking submit — you cannot pause mid-review
- Respond promptly to any Google follow-up requests (delays extend the timeline)

**Timeline expectation:** 1–4 weeks from submission to approval, assuming no back-and-forth.
CASA assessment adds 1–2 weeks if not done in advance. Start the CASA assessment first.

---

---

## 🟡 Beta Backlog (prioritized)

### Tier 1 — Before/during first beta wave

- [x] **Bug report + feedback buttons** — DONE March 14. Two pill buttons bottom-right. Feedback → Google Form. Bug → modal → POST /bug-report → bug_reports table. nodemailer removed (DB write only for beta).
- [x] **Discord button** — DONE. "💬 Discord" pill button added to top of floating cluster, opens https://discord.gg/6xc8ERrDDb in a new tab. DISCORD_INVITE_URL constant defined alongside FEEDBACK_URL. Auth-gated and excluded from /onboarding.

- [ ] **Discord automations (post-beta, when Discord has active members)** — Feed telemetry and user feedback into Discord automatically so the server becomes a live signal dashboard, not just a chat room. Three candidates:
  - **Bug reports → Discord channel**: when a row is inserted into `bug_reports` (Supabase), post a formatted message to a #bug-reports Discord channel via a webhook. Include category, description, timestamp, and user UUID (no PII). Can be a Supabase webhook → Vercel serverless function → Discord webhook.
  - **Feedback form → Discord channel**: Google Sheets `onFormSubmit` trigger (Apps Script) posts new feedback responses to a #feedback channel. Simple Apps Script webhook call — no backend needed.
  - **Key PostHog events → Discord channel**: PostHog destinations/webhooks can forward specific events (itinerary_locked, suggestion_generated, friend_added) to a Discord channel for real-time usage signal. Useful during early beta to see the app being used in real time.
  - Sequencing: build these only once Discord has enough members that the signal is worth surfacing. During very early beta (4 users), direct Supabase access is sufficient.
- [x] **Group invite notification frontend** — DONE March 14. group_invite type renders inline Accept/Decline in notification center.
- [x] **Group friend search dropdown** — DONE March 14. Live typeahead in GroupDetail, excludes existing members, "No matches" state.
- [x] **PostHog targeting events** — DONE March 14. home_view_loaded, itinerary_view_loaded, friends_view_loaded firing with relevant properties.
- [ ] **Feature tooltips (PostHog)** — deferred to Tier 2/3, needs PostHog drop-off data to prioritize moments

---

### Tier 2 — Build after first wave of feedback (signal-dependent except items 1-4)

**1. Travel duration picker fix (HIGH — confirmed UX gap)**
- Duration picker currently shows static presets (1 day / Weekend / Longer)
- Needs exact day count or range input (e.g. 3 days, 4–5 days)
- Options: numeric stepper (1–14) or range picker (min days / max days)
- Resolve UX choice before building; full prompt in CLAUDE_CODE_PROMPTS.md

**2. Voting rules in group event planning UI — DONE**
- Quorum threshold and tie_behavior now visible and configurable in NewGroupEvent
- Quorum: custom threshold (N of X votes) or Unanimous toggle
- Tie behavior: "Lock it in anyway" or "Skip the suggestion"
- Radio card pattern with brand-highlighted active selection

**3. Remote mode (new planning mode — no travel required)**
- Third mode alongside Local and Travel for virtual hangouts
- Suggests at-home/remote activities (video calls, multiplayer games, watch parties, etc.)
- No venue suggestions, no travel specs, no location preference needed
- Toggle button next to Local/Travel on NewEvent and NewGroupEvent
- Full prompt with parity instructions in CLAUDE_CODE_PROMPTS.md

**4. Delete draft button — 1:1 and group itinerary views**
- Inline confirmation (no modal) in ItineraryView and GroupItineraryView
- Organizer only, unsent drafts only, navigate home on confirm
- Server route already exists for 1:1; new DELETE /group-itineraries/:id needed for group
- Full prompt with parity instructions in CLAUDE_CODE_PROMPTS.md

**5. Micro-adjustment reroll support**
- See re-roll experience section below

**6. Manual busy blocks (organizer + attendee)**
- See manual busy blocks section below
- Prerequisite for MCP server and guest mode — builds the shared exclusion block format both will reuse

**7. Web push notifications**
- push_subscriptions table and permission grant path exist; delivery not built
- Full spec: server-side web push via web-push npm package, VAPID keys in .env
- Triggers: friend request received, group invite, itinerary sent to you, itinerary locked
- See notification tiers in SPRINT_SPECS.md

**8. Other calendars (Apple Calendar + multi-calendar support)**
- Build the calendar_connections DB schema first — unblocks both multi-Google and Apple CalDAV
- See Apple Calendar and Multi-calendar support sections below for full spec
- Implementation phases (must be done in order):
  1. DB schema — calendar_connections table (additive, sessions table untouched)
  2. OAuth connect flow — secondary Google account connection route
  3. Availability aggregation — merge freebusy across all connections per user
  4. Calendar write path — write events to is_primary connection
  5. Connected Calendars UI — list/add/remove connections in profile settings
     - Apple Calendar connection requires an inline step-by-step setup guide in the UI
       (non-technical users need hand-holding through the app-specific password flow):
       Step 1: Go to appleid.apple.com and sign in
       Step 2: Under Security, tap "App-Specific Passwords" → "Generate Password"
       Step 3: Label it "Rendezvous" and tap Create
       Step 4: Copy the 16-character password and paste it here
       Step 5: Enter your iCloud email address (the one tied to your Apple ID)
     - Guide should include a direct link to appleid.apple.com
     - Make clear the password only grants calendar access, not full Apple ID access
     - Note that the password can be revoked at any time from Apple ID settings
  6. Apple CalDAV — app-specific passwords path (PWA only; EventKit available after React Native migration)
- Apple Calendar is confirmed blocking adoption — Phase 6 is not speculative
- Apple auth note: on the web, only CalDAV + app-specific passwords is viable (EventKit is iOS-native only). UX requires user to manually generate a password in Apple ID settings. React Native migration unlocks EventKit and a cleaner auth flow — that's the right time to make Apple Calendar fully first-class. For PWA, CalDAV is the only path.
- Decision gate on Apple CalDAV itself removed — build it after phases 1-5 are verified

**9. Live events integration**

**V1 — Intent-driven temporal anchoring (do first, lower infrastructure cost)**
When a user's context prompt references something that happens at a specific time — a sports game, TV premiere, award show, concert, movie opening — the system should detect that signal, look up when it's actually happening within the scheduling window, and weight those time slots more heavily in free window selection and the Claude prompt. No external event browsing, no ticket links. Just: "you said Knicks, the next home game is Saturday at 7:30 PM, here's an itinerary built around that."

Detection + data sources:
- `extractCulturalSignal(contextPrompt, activityPreferences)` helper — returns `{ type, entity }` (sports / tv / film / awards / concert)
- Sports: ESPN unofficial API (no key) — covers NBA, MLB, NFL, NHL, MLS
- TV/film: TMDB API (free tier, themoviedb.org) — premiere dates, episode air dates, release dates. Store as `TMDB_API_KEY`
- Awards shows: hardcoded constants file (Oscars/Grammys/Emmys/Golden Globes annual dates) — no API needed
- Concerts: reuse Ticketmaster from V2 when available, skip in V1

Prompt integration:
- Inject a PRIORITY EVENT block into buildSuggestPrompt — higher priority than general availability windows
- Anchor the itinerary start time relative to the event (e.g. 1.5-2 hrs before tip-off for a sports game)
- "Watching" vs "attending" distinction: "watch the Knicks" → bar suggestion; "go to the Knicks game" → MSG/venue suggestion
- 🔴 Live badge in ItineraryView: `🔴 Live · Knicks tip-off 7:30 PM`

Telemetry: cultural_signal_detected, cultural_signal_type, cultural_event_found, cultural_anchor_used on suggestion_telemetry JSONB

**V2 — Full event discovery (do after V1, has booking implications)**
Proactive event browsing — Ticketmaster, Eventbrite, SeatGeek, Bandsintown. Surface events happening in the user's area during the scheduling window that match their interests, even when they didn't ask for a specific event. Includes ticket deep links and eventually booking integration.

V2 is where booking capabilities become relevant — Ticketmaster/Eventbrite ticket links are the natural first step, followed by OpenTable/Resy/GolfNow for venue reservations. Spec these together when V2 is prioritized.

Data sources: Ticketmaster Discovery API (5,000 calls/day free), Eventbrite, SeatGeek, Bandsintown
Prompt integration: AVAILABLE EVENTS block in buildSuggestPrompt — optional context, not priority anchor
UI: 🎟 badge on event-anchored cards with deep link to purchase/info page
Caching: 1-hour module-scoped cache per (location, date_range)
Privacy: only location + date range sent to event APIs — no user data

**9. Home screen sorting — DONE commit 53f39e1**
- Sort options: Date (soonest first), Recent (updated_at desc), Activity (updated_at desc)
- Persists to localStorage under 'rendezvous_home_sort', defaults to 'date'
- Sort pills right-aligned on same row as tab bar; stacks below tabs on mobile
- Applies uniformly across all four tabs; resets visibleCount on change

**10. Pre-login landing page — DONE commit 10fa724**
- Fraunces display font via Google Fonts, dark background, indigo accent
- Hero: "Stop suggesting. Start going." headline, pill OAuth CTA, privacy note, animated scroll hint
- 3 scroll-triggered feature sections with Intersection Observer (alternating layout, fade+slide)
  - Calendar overlap SVG mock, SuggestionCard HTML mock, phone calendar SVG mock
- Final CTA section: "Your next plans are waiting."
- Floating "Get Started →" button: fixed bottom-right, fades in past hero, links to OAuth
- Auth redirect logic in Login.js untouched — authenticated users still redirect immediately

**11. Apple Calendar support (moved from React Native section)**
- Apple Calendar uses CalDAV, not a REST API — requires a CalDAV client library on the server rather than the Google Calendar SDK
- Auth flow is different: Apple uses app-specific passwords or Sign in with Apple, not OAuth 2.0 in the same pattern
- Current architecture assumes Google OAuth tokens in `google_tokens` table — need a parallel `apple_tokens` table or a more generic `calendar_tokens` table with a `provider` column and a separate token refresh path
- `createCalendarEventForUser` (now in calendarUtils.js) and `findFreeWindows` are both Google-specific — need provider-abstracted versions or separate implementations per provider called through a common interface
- Cross-provider free/busy: if one user has Google Calendar and another has Apple, availability detection needs to produce a unified free window — more complex than two Google users
- Onboarding flow currently assumes Google OAuth — needs a calendar provider selection step
- Decision gate: build when there is real signal that adoption is being blocked by the Google Calendar requirement. Most users willing to use an AI scheduling app are already Google Calendar users. Apple Calendar users who care enough will likely connect a Google account for this purpose. Do not start until at least one beta user flags this as a blocker.

**12. Multi-calendar support (linked calendars per user)**
> Users commonly have more than one calendar they need to check for availability — multiple Google Calendars (personal + work), an Apple Calendar alongside a Google Calendar, or a shared family calendar. Currently Rendezvous only reads the primary Google Calendar linked at sign-in. This causes false availability: a user with a work Google Calendar not connected will appear free during meetings they actually have.
>
> This is a prerequisite for Apple Calendar being genuinely useful — if a user has both Google and Apple calendars, they need both connected for availability to be accurate.
>
> **Architecture approach:**
> - Rename or migrate `google_tokens` to a more generic `calendar_connections` table with columns: `user_id`, `provider` (google | apple), `account_label` (e.g. "Work Gmail", "Personal iCloud"), `tokens` (jsonb, encrypted), `calendar_ids` (text[], the specific calendar IDs within that account to include in free/busy), `is_primary` (boolean, the calendar to write new events to), `created_at`
> - During onboarding and from a new "Connected Calendars" section in profile settings, users can add multiple calendar accounts. Each additional Google account goes through its own OAuth flow; Apple goes through CalDAV (when built).
> - `findFreeWindows` and `findFreeWindowsForGroup` need to aggregate free/busy across all connected calendars for a given user, not just the single token. The freebusy API supports querying multiple calendar IDs in one call for Google — use that to minimize round trips.
> - `createCalendarEventForUser` writes to the `is_primary` calendar for each user — not necessarily the first connected account.
> - UI: "Connected Calendars" section in profile settings showing each linked account with its label, which calendars within it are included, and a "Primary" badge on the write calendar. Add / remove accounts inline. Toggle individual sub-calendars on/off (e.g. user has Google account with Personal + Work + Family calendars and only wants to include Work in availability checks).
>
> **DB migration note:** `google_tokens` already exists with RLS. The migration to `calendar_connections` needs to be done carefully — existing rows should be migrated with `provider='google'`, `is_primary=true`. RLS policies need to transfer. Do not drop `google_tokens` until the migration is verified.
>
> **Decision gate:** Build the DB schema and "Connected Calendars" UI before Apple Calendar — the schema change unblocks both multi-Google and Apple support. The schema migration is the foundational step; adding Apple CalDAV is a separate sprint on top of it.

---

### Tier 3 — Pre-wider-rollout (before >20-30 users)

**Pre-login home page (marketing/landing page) — moved to Tier 2**
> See Tier 2 for full spec.

**Help page (`/help`)**
- Accessible from nav (logged in and logged out) and from onboarding
- Four sections:
  1. **How it works** — brief walkthrough of the core flow (connect calendar → add friends → create event → get itinerary → lock plans)
  2. **FAQ** — anticipated questions: "What does Rendezvous do with my calendar?", "Can my friends see my events?", "What if I don't have Google Calendar?", "How do group events work?", "What's Remote mode?"
  3. **What's coming** — lightweight roadmap/vision section: group trip planning, booking integrations, MCP/AI chat interface. Keep it honest and high-level — not a commitment, just a direction
  4. **Privacy policy** — full text inline (not a separate page, but anchor-linkable as `/help#privacy`) — see privacy policy item below
- Static page, no backend. Can be built as a simple React component.
- The FAQ should be seeded from beta feedback — update it as real questions come in

**Privacy policy (external-facing, required for Google OAuth verification)**
- Must be publicly accessible at a stable URL before Google OAuth verification can be submitted
- Host at `rendezvous-gamma.vercel.app/privacy` (or `/help#privacy` with a canonical URL)
- Minimum required content per Google's requirements:
  - What data is collected: Google account info (name, email, profile picture), calendar availability (free/busy windows only — not event titles or descriptions), user-entered profile data (location, activity preferences, dietary/mobility restrictions), itinerary history
  - Why it's collected: scheduling suggestions, calendar event creation on plan lock
  - How it's used: AI suggestion generation via Anthropic API (dietary/mobility data may be included in prompts — disclose this explicitly), not sold or shared with third parties
  - Data retention: calendar availability data is not stored; itinerary data retained until user deletes account
  - How users can request deletion: email address or in-app mechanism
  - PostHog analytics disclosure: anonymized usage data collected via PostHog, no PII
  - Third-party services: Google Calendar API, Anthropic API, Google Maps Platform, PostHog
- Link the privacy policy URL on the OAuth consent screen in Google Cloud Console
- Link it from the pre-login landing page and from the Help page
- This is a blocker for Google OAuth verification — do before submitting

**Notification settings page**
- Users need per-type toggles before you have many users
- See spec below
- Two channels: in-product (bell) and push. Each has its own global on/off toggle plus per-type overrides.
- Structure:
  - In-product notifications: [global on/off] → per-type toggles for all 8 types
  - Push notifications: [global on/off] → per-type toggles for all 8 types
- 8 notification types:
  - Friend request received
  - Friend request accepted
  - Group invite received
  - Itinerary sent to you
  - Itinerary declined
  - Suggest alternative received
  - Group counter-proposal
  - Itinerary locked
- Global off overrides all per-type settings for that channel — no need to toggle each one individually
- Per-type toggles only visible/active when global is on
- Server checks preferences before both the notifications insert (in-product) and the sendPush call (push) — two independent checks, not one shared flag
- Store as two jsonb columns on profiles: notification_preferences_inapp and notification_preferences_push, each a map of type → boolean. Global toggle stored as a top-level key (e.g. { enabled: true, friend_request: false, ... })

**User privacy settings (new — added March 14, 2026)**
- Separate from notification settings — controls who can interact with the user's account
- Ship alongside notification settings page as a combined Settings screen, or as a distinct tab within it
- Toggle: **Allow group invites from non-friends** (default: ON)
  - When OFF: POST /groups/:id/members returns 403 if the invitee has no accepted friendship with the organizer
  - Server enforcement is required — client-side only is not sufficient (API is accessible directly)
  - Store as `allow_non_friend_group_invites` boolean on the profiles table (default true)
  - Check this flag in the group invite route before inserting the membership row
  - If the invite is blocked, return a clear error the organizer can understand: "This person only accepts group invites from friends."
  - The invitee should never be notified that a blocked invite was attempted — silent reject on the server
- Additional privacy toggles to consider for the same screen (placeholder, not yet specced):
  - Allow friend requests from anyone vs. friends-of-friends only
  - Profile visibility (anyone with link vs. friends only)

**User travel preferences (consideration — not yet specced, added March 14, 2026)**
- Users may want to set default constraints for travel itineraries on their profile so they don't have to re-enter them every time
- Two candidates:
  - **Max travel distance / budget tier** — e.g. "I prefer trips under 4 hours away" or "keep it budget-friendly"
  - **Default spend range** — e.g. low / medium / high as a soft signal injected into the suggest prompt
- Not committed to building this — depends on whether beta users signal that re-entering these constraints per event is friction. If users are creating multiple travel events and always setting the same constraints, profile-level defaults make sense.
- Design question before building: profile-level default vs. event-level setting. Distance is probably too context-dependent for a profile default (sometimes Catskills, sometimes Nashville). Spend tier is a better fit for profile-level since it tends to be consistent per person. Best approach: profile default with per-event override — cleaner UX but adds form complexity.
- If built: store as `travel_preferences` jsonb on profiles (max_distance_hours, spend_tier: 'low'|'medium'|'high'). Inject as soft signals (not hard constraints) into buildSuggestPrompt and buildGroupSuggestPrompt alongside dietary/mobility. Do NOT enforce spend as a hard NEVER rule — it's a preference, not a constraint. Spend tier should influence venue tier suggestions, not block anything.
- Decision gate: wait for beta feedback before speccing further. If multiple users independently mention spend or distance as friction points, build it.

**Email notifications channel**
- Supplement push with email for users who deny push permission
- Especially important for: itinerary locked, friend request accepted
- Use nodemailer + Gmail SMTP (same setup as bug report email)
- Respect notification preferences per type and per channel

**Google OAuth verification**
- Needed before 100-user cap becomes a problem
- Start CASA Tier 2 assessment early — it takes the longest
- See full prerequisites checklist below

---

### Group mode — UX gaps (post-beta, pre-wider-rollout)

**Friend search dropdown in GroupDetail invite flow**
- [x] Live typeahead dropdown with friend search — DONE March 14 (Tier 1)
- [ ] No visible submit trigger — user can't tell when an invite is sent. Fix: add explicit Invite button + prominent green confirmation banner (auto-dismiss after 3s). Claude Code prompt in progress.

**Group invite notification**
- [x] Backend fires the notification insert — DONE (already existed)
- [x] Frontend renders group_invite type with inline Accept/Decline — DONE March 14 (Tier 1)

**Voting rules visible in group event planning screen**
- [ ] Quorum threshold and tie_behavior never shown to organizer in NewGroupEvent UI — Tier 2, see above

**Group event creation entry points (UX gap)**
- Currently the only way to create a group event is from a saved group's detail page — there's no way to start a group event from the Home screen's "+ New Event" button or from a friend's profile
- This is a meaningful friction point: users who want to plan something with multiple friends have to navigate to Groups first, find the right group, then start the event
- Two paths to consider:
  1. **NewEvent multi-friend selector**: allow the organizer to add more than one friend in the standard NewEvent flow. If more than one friend is selected, the event automatically routes to the group itinerary path. This is the lowest-friction fix and avoids users needing to pre-create a saved group.
  2. **Home screen "+ New Event" group option**: add a mode selector at the top of NewEvent — "1:1" / "Group" / "Remote" — where Group mode shows the multi-friend selector and optionally lets the user save the assembled list as a new group inline.
- The inline group creation toggle ("Save this group for later") from SPRINT_SPECS.md applies here: if the user assembles a group for a one-off event, give them the option to save it without requiring it
- Decision to make before building: does group event creation always require a pre-existing saved group, or should ad-hoc group events (no group_id) be a first-class supported path? The DB already supports null group_id on group_itineraries — the UX just needs to match.
- [ ] NewGroupEvent has no way to add users not in the saved group for a one-off event
- [ ] Add "Add someone else" search input below attendee list — same friend search pattern, doesn't modify saved group membership

**Username change behavior (minor, informational)**
- [ ] Notifications already stored in DB will show old username text (cosmetic only, not a data integrity issue)

### Feature onboarding / tooltips (beta phase — build before wider rollout)
> Not profile completion — this is a product tour that teaches users what the app can do.
> Building during beta increases the quality of feedback you get back: testers who never
> discover a feature can't tell you whether they liked it.

- [ ] Identify the 4–5 moments where users most commonly get lost or don't discover a feature
  (inform this from PostHog drop-off data + beta feedback form responses — but don't wait
  for data to build the first pass, the beta itself generates that signal)
- [ ] Tooltip/spotlight approach: trigger on first visit to a screen, dismiss on interaction,
  never repeat after dismissed. Priority moments for beta:
  - Home screen: explain Waiting / In Progress / Upcoming tabs
  - ItineraryView: spotlight "New time" and "New vibe" buttons — easy to miss, high value
  - GroupItineraryView: explain voting, comment threads, quorum badge
  - Friends tab: surface the Schedule button on a confirmed friend's profile
- [ ] Implementation: use PostHog In-App Messaging (Surveys feature) — zero custom code,
  configurable via PostHog UI, A/B testable, analytics built in.
  Claude can create and configure PostHog surveys directly via the PostHog MCP connection
  without manual configuration in the PostHog UI. Visual styling/branding adjustments
  (colors, position) still require the PostHog web UI.
  Target audience: users who signed up but haven't completed a specific action yet
  (e.g. show ItineraryView tooltip only to users who haven't triggered itinerary_locked)
- [ ] Do NOT over-engineer — 3–4 targeted tooltips beats a full product tour wizard

### Manual busy blocks (organizer + attendee)
> Users sometimes have informal commitments that aren't on their calendar.
> This lets them communicate constraints without polluting their Google Calendar.
>
> **MCP / conversational scheduling note (added March 14, 2026):** Manual busy blocks become
> especially critical once the MCP server is live. A conversational user saying "I'm busy
> Thursday morning" or "skip anything before noon" needs that constraint honored without
> requiring them to open Google Calendar. The free-text parsing infrastructure built here
> should be the same path the MCP `create_itinerary_proposal` tool uses when a
> `conversation_context` param includes time constraints — not a separate code path.
> Design the input format and injection block to be callable from both the UI and the MCP layer.

**Organizer — at event creation time**
- [ ] Add a "Block off times" optional section in NewEvent below the date range picker
- [ ] Allow free-text entry of time ranges to exclude: "Don't book 3/15 9–11 AM"
- [ ] Parse and inject as an exclusion block in the Claude prompt:
  EXCLUDED WINDOWS (organizer has blocked these off — do not suggest plans during these times):
  - March 15, 9:00–11:00 AM
- [ ] Store as manual_busy_blocks jsonb on the itinerary row (new column, nullable)
- [ ] Reroll: re-inject the same exclusion block so it persists across rerolls

**Attendee — when declining or suggesting an alternative**
- [ ] When an attendee declines or hits "Suggest something else", surface an optional
  text field: "Any times that don't work for you?" (e.g. "I can't do Saturday morning")
- [ ] Inject this as an additional exclusion signal in the attendee-side reroll prompt
- [ ] Store as attendee_busy_notes text on the itinerary row (nullable)
- [ ] Privacy: these notes are visible to the organizer (they're scheduling context),
  clearly labeled as such in the UI

**DB changes**
- [ ] Add manual_busy_blocks jsonb (nullable) to itineraries table
- [ ] Add attendee_busy_notes text (nullable) to itineraries table


> Before building any Maps JS embedded component, split the current single Maps API key into two separate keys. The existing key is used server-side (Geocoding, Distance Matrix, Places) and must not have HTTP referrer restrictions because server-side fetch() calls don't send a Referer header. The Maps JavaScript API is loaded client-side and should be locked to the Rendezvous domain. Using the same key for both makes it impossible to apply referrer restrictions safely.
- [ ] Create a second Google Maps API key in Google Cloud Console — restrict to Maps JavaScript API only
- [ ] Add HTTP referrer restriction to the new browser key: `https://rendezvous-gamma.vercel.app/*`
- [ ] Add the new key to Vercel env vars as `GOOGLE_MAPS_JS_API_KEY` (distinct from server-side `GOOGLE_MAPS_API_KEY`)
- [ ] Add `GOOGLE_MAPS_JS_API_KEY` to `client/.env.production` and reference it in the Maps JS component
- [ ] Keep the existing server-side key with API restrictions only (no referrer restriction) — do not change it
- [ ] Verify both keys work end-to-end before removing the old key from any client-side usage

### Embedded Views — Calendar & Route iframes
> Inline visual context where it matters most. Users shouldn't have to mentally reconstruct a route or check a separate app to see if a time works — surface that information directly in the UI.

**Route visualization (high value, Maps JS already enabled)**
- [ ] Embed a Google Maps JS iframe on each itinerary card showing the venue sequence as a route
  - Waypoints in order: stop 1 → stop 2 → stop 3
  - Uses Maps JavaScript API (already enabled and configured)
  - Show estimated total travel time pulled from Distance Matrix data already being calculated
  - Collapsed by default, expandable inline — don't add visual weight by default
- [ ] For travel mode / destination itineraries: show a wider overview map (city-level, not street-level)
- [ ] "Getting There" link (already exists) upgrades to show the route inline before linking out

**Calendar availability view (post-deploy, requires real OAuth tokens)**
- [ ] On the NewEvent date picker, embed a mini calendar strip showing busy/free blocks for both users
  - Pulls from the availability data already being fetched for scheduling logic
  - Visual indicator of mutual free windows — green = both free, yellow = partial, red = blocked
  - Clicking a free window pre-populates the date/time fields
- [ ] On locked itinerary view, show a small calendar widget confirming the event is on both calendars
  - Embed Google Calendar event preview (public link rendering or custom view)
  - Falls back to plain date/time display if calendar embed is unavailable

**Implementation notes**
- Maps JS iframe: straightforward, no new API keys needed, just Maps JavaScript API already enabled
- Calendar embed: Google Calendar public embed is simple HTML iframe but requires event to be on a shared/public calendar — for private events, build a custom mini-view from the event data we already have rather than relying on Google's embed
- Both should be lazy-loaded and collapsed by default to keep the UI clean
- React Native consideration: iframes don't exist in RN — plan WebView components as the equivalent for the native migration
- [ ] Resy / OpenTable — check availability, book or deep link
- [ ] GolfNow — tee time booking
- [ ] Deep link fallback — Fever, Eventbrite, Tock, ClassPass
- [ ] Booking confirmation back-sync → triggers calendar write
- [ ] Trip mode: lodging — Google Hotels or Booking.com API

### Guest Mode (v2 — no account required)
> Allow users to invite someone who doesn't have a Rendezvous account to participate in a plan. The guest bypasses OAuth entirely — no calendar connection, no profile. Availability is determined solely by manual busy blocks rather than calendar reads.
>
> **Core flow:**
> - Organizer creates an event as normal, but instead of selecting a registered friend, selects "Invite a guest" and enters an email address
> - A unique invite link is generated (time-limited token, e.g. 7 days) and sent to the guest's email
> - Guest opens the link, sees the itinerary suggestions, and can optionally enter their busy times as free-text manual blocks ("I can't do Saturday morning")
> - Guest can accept, decline, or suggest a different option — no account creation required
> - On lock, calendar event is written to the organizer's Google Calendar only; guest receives a standard `.ics` file attachment via email that they can add to any calendar app
>
> **Why manual busy blocks are central here:** Without a Google Calendar connection, the only availability signal is what the guest self-reports. The manual busy blocks infrastructure (Tier 2 item) is a prerequisite — build that first. The guest mode prompt injection path should reuse the same `EXCLUDED WINDOWS` block format rather than building a separate code path.
>
> **Architecture notes:**
> - Guest sessions are token-based, not cookie-based — the invite token in the URL is the auth mechanism for that specific itinerary only
> - Guests have no profile row; their name and email are stored on the itinerary row itself (`guest_name`, `guest_email`)
> - RLS: guest token must be validated server-side on every request; guests can only read/write the specific itinerary they were invited to
> - No persistent guest accounts — tokens expire, guest data is scoped to the single itinerary
> - If a guest later creates a full account with the same email, their past guest participation should link to their new profile
>
> **Decision gate:** Build after manual busy blocks are shipped and after there is beta signal that the "both users must have an account" requirement is causing meaningful drop-off. Do not build speculatively.

### Always-On Agent
> Build last — most powerful when calendar integrations + group planning + booking are all in place.
- [ ] Background process (Supabase Edge Functions or cron): monitors nudge expiry, detects calendar gaps, proactively surfaces suggestions
- [ ] Writes to notifications table silently or interrupts depending on threshold
- [ ] Shares same MCP tool layer as prompt-triggered agent — different consumer, same interface
- [ ] nudges table already designed for this

---

## 🔵 Known Polish Items — Deprioritized Until Post-Launch

These are known issues or small improvements that aren't worth debugging time now.
Revisit after sharing with first users and collecting signal on what actually matters.

- **Draft cards date range pill** — cards in the Drafts/pending state should show the scheduling
  window (e.g. "Mar 13 – Mar 15"). Previous fix attempt did not stick. Hold for user feedback
  on whether this causes confusion before prioritizing a deeper fix.

---

## Outstanding pre-deploy items (status as of March 14, 2026)

- [x] Vercel deployment — DONE March 12
- [x] Session persistence (Supabase sessions table) — DONE March 12
- [x] OAuth handoff → HTTP-only cookies — DONE March 12
- [ ] HTTP referrer restriction on Maps API key — **PARTIALLY DONE (March 14, 2026).** New browser-specific key created, referrer restriction applied to `https://rendezvous-gamma.vercel.app/*`, added to Vercel as `REACT_APP_GOOGLE_MAPS_JS_KEY` (prod only). No client wiring needed yet — Maps JS API is not loaded in the client (existing maps links are plain `maps.google.com` deep-links, no API key required). `REACT_APP_GOOGLE_MAPS_JS_KEY` will be wired in during the route visualization sprint (Tier 2 / Embedded Views). Server-side key unchanged.
- [ ] Tighten notifications RLS — `notifications_service_role_all` USING(true); verify if fixed in Audit 2 or still outstanding
- [ ] PWA config — manifest.json + service worker (needed before push notifications)
- [ ] Push notifications (PWA web push) — push_subscriptions infrastructure exists, delivery not built (Tier 2)

---

## 🧪 Testing Needed (current pass)

### Auth & Session
- [ ] Log out and back in → supabaseId now populates in sessionStorage (required after today's fix)
- [ ] Dev switcher users (jamiec etc.) → pick/reroll buttons appear correctly as organizer

### Itinerary — Organizer flow
- [ ] Event title set at creation → shows in itinerary header (not "Plans with [Name]")
- [ ] Inline title edit: click pencil → edit → save → persists on refresh
- [x] Pick this one → sends to attendee, organizer sees "waiting on them" badge (post-send UX done)
- [x] New time / New vibe buttons → single card rerolls with correct constraint (timing vs activity)
- [x] After submitting New Event, edit button removed, Return Home shown — duplicate prevention done

### Itinerary — Attendee flow
- [x] Attendee receives sent itinerary → Accept / Decline / Reroll visible on organizer's picked card
- [x] Non-picked cards show "↩ Suggest this instead"
- [x] Reroll button opens modal, Generate fires request, new suggestions load — stuck state fixed
- [x] Suggest this instead → sets attendee's pick, shows "Suggestion sent" badge, organizer sees re-evaluate state
- [x] Suggest-alternative does NOT auto-lock — organizer must re-pick
- [x] Accept → locks when organizer already accepted same card (calendar invite created)
- [x] Full ping-pong negotiation state machine rewritten — DB constraint bug resolved, attendeeSelected JSONB flag approach

### Home screen
- [ ] Pills show `Morgan · Golf weekend` format (or just `Morgan` if no title)
- [ ] Correct tab bucketing: Waiting / In Progress / Upcoming
- [x] Load more — visibleCount progressive disclosure (+3 per click) per tab

### Generate More
- [x] "+ Generate More Options" button in ItineraryView — appends 3 new suggestions via appendMode: true reroll, no negotiation state reset

### Calendar invites
- [x] Wrong year bug fixed — year: 'numeric' added to toLocaleDateString in buildSuggestPrompt

### Friends
- [ ] Schedule button visible on confirmed friends' profiles
- [ ] Add friend button appears on profiles with no existing relationship

### Reroll bounds
- [ ] Rerolled suggestions stay within original date window (no past dates)

### Duplicate title safety
- [ ] Multiple itineraries/events with the same title must never conflict — verify all lookups, comparisons, and calendar event creation use itinerary UUID (not title) as the identifier throughout client and server
- [ ] Google Calendar event creation should include the itinerary UUID in the event description as a reference anchor so external calendar events can always be traced back to the correct itinerary row

### Location & Travel Mode — Steps 5–6
- [ ] Create a local single-day event → render identical to before, no visible day header
- [ ] Create a travel event with a destination set + multi-day → day headers appear in ItineraryView ("Day 1 — Arrival day" etc.)
- [ ] Open an old itinerary (pre-migration) → renders correctly via backward-compat shim (flat stops array treated as days[0].stops)
- [ ] Create a travel event with no destination → suggestions anchor to organizer's city, do not drift to a random location
- [ ] Reroll a travel itinerary → confirm travel_mode, trip_duration_days, and destination all read from DB row (verify in Supabase, not echoed from client)
- [ ] Multi-day itinerary → all stops stay within a single city/region across all days (no city-hopping between days)

### Activity & hobby venue discovery
- [ ] Create event with context prompt "let's play tennis" → 🎾 badge appears on at least one suggestion card
- [ ] Create event with context prompt "pottery class" → 🏺 badge appears on at least one suggestion card
- [ ] Create event with context prompt "escape room" → 🔐 badge appears on at least one suggestion card
- [ ] Venue in activity-anchored card has "Reserve / Book →" link pointing to venue website
- [ ] Activity-anchored suggestion anchors to a real named venue (not a generic Claude-hallucinated one)
- [ ] Context prompt with no detectable activity type → no badge, normal suggestions generated
- [ ] Telemetry: activity_type_detected and activity_venues_injected fields present on itinerary row

### Group mode backend — automated checks (Claude Code can run these without user input)

- [ ] **[AUTO]** POST /groups with valid session → 201 with group id and name. Verify creator inserted into group_members with role='admin', status='active'. Claude Code seeds via service role and asserts.
- [ ] **[AUTO]** POST /groups/:id/members beyond 15-member cap → 400. Claude Code seeds 15 active members and attempts a 16th invite, asserts error.
- [ ] **[AUTO]** quorum_threshold is always present on group_itineraries INSERT — never NULL. Claude Code queries SELECT id FROM group_itineraries WHERE quorum_threshold IS NULL after seeding test rows.
- [ ] **[AUTO]** Lock trigger fires: seed 'awaiting_responses' row with 3 attendees, quorum=2. Update 2 to 'accepted'. Assert itinerary_status='locked' and locked_at IS NOT NULL.
- [ ] **[AUTO]** Lock trigger cancel path: all 3 decline. Assert itinerary_status='cancelled', locked_at IS NULL.
- [ ] **[AUTO]** Lock trigger draft guard: seed 'organizer_draft' row. Update attendee_statuses. Assert status remains 'organizer_draft' — trigger must not fire.
- [ ] **[AUTO]** nudges ON DELETE SET NULL: insert itinerary, insert nudge pointing to it, hard-delete itinerary. Assert nudge.itinerary_id is NULL (not deleted, no FK violation).
- [ ] **[AUTO]** nudges mutual-exclusion CHECK: INSERT nudge with both itinerary_id and group_itinerary_id set. Assert Postgres rejects with CHECK violation.
- [ ] **[AUTO]** notifications_read_sync trigger: INSERT notification with read=false. UPDATE read_at=now(). Assert read=true without explicitly setting it.
- [ ] **[AUTO]** GIN index present: query pg_indexes and assert idx_group_itineraries_attendee_statuses exists.
- [ ] **[AUTO]** PATCH /group-itineraries/:id/vote as non-member → 403.
- [ ] **[AUTO]** POST /group-itineraries/:id/reroll as attendee (not organizer) → 403.
- [ ] **[AUTO]** POST /group-itineraries/:id/send with empty suggestions array → 400.

### Group mode backend — requires user input (test with dev switcher)

- [ ] Full group creation: create group as jamiec → invite mrivera and tkim → switch to each, accept → verify 3 active members in group_members
- [ ] Group event suggestion: as jamiec, create group itinerary → generate suggestions → verify suggestions array populated and event_title present in Supabase
- [ ] Send and vote to lock: jamiec sends → mrivera accepts s1 → tkim accepts s1 → verify itinerary_status='locked', locked_at set
- [ ] Tie-breaking schedule: 2-member group, tie_behavior='schedule', 1 accept / 1 decline (50/50) → locked
- [ ] Decline path: all members decline → itinerary_status='cancelled'
- [ ] Organizer reroll mid-voting: members have voted, organizer rerolls → attendee_statuses all reset to 'pending', new suggestions generated
- [ ] Comment flow: mrivera adds comment on s1 → tkim sees it → 2000-char limit enforced in UI
- [ ] 15-member cap enforced in UI: attempt 16th invite → 400 error surfaced to user
- [ ] Ad-hoc group event (no saved group): create with attendee_user_ids but no group_id → group_id null in Supabase, itinerary works normally
- [ ] Leave group: tkim leaves → status='left', tkim no longer receives notifications for that group

### Venue enrichment + output quality — automated checks

- [ ] **[AUTO]** enrichVenues() failure mode: mock Places API 500, assert suggestions returned unmodified with venue_verified=false, no crash.
- [ ] **[AUTO]** No-duplicate-venues instruction present in prompt string: Claude Code calls buildSuggestPrompt and asserts the no-duplicate rule text is present.
- [ ] **[AUTO]** deriveGeoContext() same-city users → single-city context. Claude Code calls directly with test profiles.
- [ ] **[AUTO]** classifyIntent() edge cases: "watch the Knicks at my place" → home_likely. "watch the Knicks at MSG" → activity_specific. Empty string → ambiguous. Assert without API calls.
- [ ] **[AUTO]** themeMatchesContextPrompt(): "golf weekend" context + suggestions with "golf" in title → true. No match → false.

### Location & Travel mode — automated checks

- [ ] **[AUTO]** Backward-compat shim: call ItineraryView render logic with flat stops array (pre-migration format). Assert no crash and output treated as days[0].stops.
- [ ] **[AUTO]** Reroll reads travel fields from DB, not req.body: inspect reroll route handler and assert travel_mode, destination, trip_duration_days sourced from DB fetch, not request body.
- [ ] **[AUTO]** Geographic containment rule in prompt: call buildSuggestPrompt with travel_mode='travel', assert GEOGRAPHIC CONTAINMENT RULE block present in returned prompt string.

### Notification settings page
> Users need a way to control what they get notified about. Build before wider rollout.

- [ ] Build client/src/pages/NotificationSettings.js
- [ ] Toggles per notification type: friend requests, group invites, itinerary invites,
  itinerary locked, nudges — each independently on/off
- [ ] Store preferences in notification_preferences jsonb column on profiles table
- [ ] Server: check preferences before inserting notifications — skip if user disabled that type
- [ ] Link to notification settings from notification bell / profile menu
- [ ] Default all to ON for new users

### Web push QA
- [ ] Verify push permission prompt fires correctly on step 3 of onboarding (mobile Safari,
  mobile Chrome, desktop Chrome)
- [ ] Verify granted/denied/dismissed paths all handled correctly — no crash, no block on progression
- [ ] Note: push_subscriptions table and actual push delivery are a separate sprint

### Bug report + feedback buttons
- [x] BugReportButton.jsx — two pill-shaped floating buttons, auth-gated, excluded from /onboarding. DONE March 14.
- [x] POST /bug-report route — validates category, inserts to bug_reports, returns success. DONE March 14.
- [x] bug_reports DB table with RLS. DONE March 14.
- [x] nodemailer removed — DB write only for beta (deliberate decision March 14).

### Shipped March 14, 2026 (second Claude Code session)
- [x] Group member vote responses visible to all members (not gated on isOrganizer)
- [x] Group + 1:1 events comingled on home screen — same 4-tab layout, 👥 badge on group cards, [Group Name] — [Event Title] format
- [x] DELETE /group-itineraries/:id — organizer-only, draft-only; client routes to correct endpoint via handleDeleteDraft(id, isGroup)
- [x] + New Group Event button on home screen — routes to /group-event/new; group picker is now live-search + dropdown (same UX as friend picker in NewEvent.js)
- [x] Attendee re-roll button visibility fix — on non-organizer-pick cards all 3 buttons visible before voting; hidden after "suggest this card" is clicked

### Active bugs — confirmed by 56-item audit (March 14, 2026)

**Confirmed fixed (audit found these already resolved):**
- [x] Route path typos — `/schedule/itinerary:id/title` and `/schedule/itinerary:id` — both correct in current code (schedule.js:2048, 2090)
- [x] Shared profile link `/u/:username` — route registered in App.js (line 149)

**Confirmed FIXED — commit 5eaeed2 (March 14, 2026):**
- [x] **findFreeWindows date clustering** — collect up to 100 windows, bucket into 3 equal date ranges, sample 7 from each, trim to 20. Applied to both findFreeWindows (schedule.js) and findFreeWindowsForGroup (group-itineraries.js).
- [x] **No-duplicate-venues instruction** — explicit hard rule added to both buildSuggestPrompt and buildGroupSuggestPrompt. Single-card reroll explicitly exempted — user may intentionally reference a venue from another card. **Watch item:** exemption relies on Claude inferring the venue reference from the reroll prompt. If users report single-card rerolls ignoring venue references or wrongly refusing a venue they named, iterate on the rerollNote wording before considering a structural fix. See CLAUDE_CODE_PROMPTS.md for detail.
- [x] **classifyIntent('') returns ambiguous** — empty/blank guard now returns 'ambiguous'. ambiguous branch in intentBlock confirmed correct.
- [x] **Google Calendar event description missing itinerary UUID** — itineraryId param added to createCalendarEventForUser, appended to description at all call sites.
- [x] **1:1 suggestions returning fewer than 3** — "exactly 3" instruction + window-reuse fallback added to both prompt builders.
- [x] **Event title PATCH: silent catch** — input stays open on error, inline error shown, console.error added in ItineraryView.js. GroupItineraryView has no title edit yet — TODO comment added.

**Still outstanding:**
- [x] **Delete draft button** — commit 6d89f8d. Group server route already existed with correct guards (no changes needed). GroupItineraryView.js now has inline confirmation row matching ItineraryView.js pattern. Note: both 1:1 and group delete are only surfaced from within their respective itinerary views — not from the Home screen pill. This is consistent behavior across both modes.
- [x] **1:1 suggestions always returning 3** — commit 726e649. Root cause was a post-generation window filter silently dropping suggestions whose times didn't exactly match free windows. Fix: snapshot pre-filter set, backfill to 3 if count drops. Prompt fix (FIX 2) was correct — Claude was generating 3, the filter was trimming them.
- [x] **Group invite search submit + confirmation** — commits f599165, 9e132bc, e520022. Two-step select → confirm flow, multi-select with bulk invite, overflow fix, dropdown opens on click not focus, member rows navigate to friend profile.
- [x] **Group list 403 on click** — commit c117696. GET /groups was fetching all groups in DB with no filter, non-member groups defaulted to role='member', 403 on detail click. Fix: .in('id', groupIds).

**Still unverified (needs manual testing, can't confirm from code alone):**
- [ ] Dev switcher drops test users into onboarding — PATCH /users/location 404 in onboarding step 2
- [ ] Rerolled suggestions constrained to original date window — clamping exists but edge case behavior unverified

---

## ✅ Completed

- [x] Project scaffolded: CRA frontend + Express backend
- [x] Git repo, .gitignore, all env vars configured
- [x] Supabase: all tables + RLS + triggers + migrations
- [x] Google OAuth + calendar scopes (including calendar.events write)
- [x] Google Maps API key restricted to 4 APIs
- [x] All server routes wired
- [x] schedule.js — 9 endpoints + AI suggestion engine
- [x] Notification inserts: friend request, invite, confirm, decline, reroll, suggest-alternative
- [x] Per-card reroll with timing/vibe split (rerollType: timing | activity | both)
- [x] Reroll limit: 10
- [x] Reroll respects original date bounds + floors to today
- [x] Attendee reroll no longer auto-locks (organizer_status downgraded from accepted → sent)
- [x] Google Calendar write on lock (best-effort, graceful no-op if no tokens)
- [x] GCal link: template URL (eventedit/{id} was 500ing)
- [x] event_title: set at creation, inline edit in header, persists across sessions
- [x] Home screen: Friend · Title pill labels
- [x] friendshipStatus: schedule button gated on accepted friendship
- [x] Add friend button on FriendProfile when no relationship exists
- [x] NewEvent back button from generating spinner
- [x] Attendee suggest-alternative flow + server isSuggestAlternative logic
- [x] supabaseId fix: OAuth redirect now passes supabaseId; auth.js stores + exposes it; ItineraryView uses it for organizer_id comparison — fixes pick/reroll/suggest buttons for real OAuth users
- [x] ItineraryView title uses friend's first name only
- [x] Calendar footer hidden on non-locked cards; action buttons raised with border
- [x] Free/public venue prompt + variety + cost range mix
- [x] Narrative tone: direct, no marketing language
- [x] Home.js: single API call, client-side split into waiting/in-progress/upcoming
- [x] Friends.js: inline errors, no alert()
- [x] ItineraryView: expand/collapse, Getting There link, isPicked badge
- [x] Dev user switcher
- [x] Mock busy slots for all 4 test users
- [x] 4 test users seeded (jamiec, mrivera, tkim, alexp)
- [x] STATUS.md + TODO.md tracking

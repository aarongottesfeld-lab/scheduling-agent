## Status & Session Notes

Updated at the end of every significant session. Two parallel systems:
1. Google Calendar all-day event: "Rendezvous Save State — [description]" with git SHA + summary
2. Entry appended here with the same information

GCal is the mobile fallback when STATUS.md can't be updated directly. At the start of each session, check GCal for save states newer than the last STATUS.md entry and backfill here before proceeding.

ROADMAP.md is the source of truth for prioritization. STATUS.md is the historical log — if they conflict, ROADMAP.md wins.

---

## March 14, 2026 — 56-item audit results received
SHA: pending (changes deployed, commit pending)

Audit corrections vs. what ROADMAP previously said:
- Route path typos: already fixed before audit ran — both routes correct in current code
- SharedProfile /u/:username: DONE (App.js:149) — was incorrectly listed as outstanding
- No-duplicate-venues: confirmed NOT in either prompt builder — STATUS.md was wrong
- classifyIntent(''): confirmed returns home_likely not ambiguous — fix needed
- GCal event UUID: confirmed missing from createCalendarEventForUser — fix needed
- Delete draft in ItineraryView (1:1): confirmed NOT DONE — only on Home screen
- Title PATCH: route reachable (typo fixed), but catch block swallows errors silently — PARTIAL

Confirmed done by audit (44/56 items):
- All output quality / prompt engineering items (contextPrompt position, shared interests, persona, dietary/mobility constraints, deriveGeoContext, exactMatchBlock, buildVenueSubstitutionBlock, fetchAcceptedPairHistory, themeMatchesContextPrompt, structured telemetry)
- All venue enrichment items (enrichVenues, enrichment wired in suggest + reroll, verified badge, tooltip, formatted_address, server-side key)
- All group mode items (GET includes group_name, DELETE with guards, deriveGroupTab, 👥 indicator, handleDeleteDraft routing, [group] — [title] format, responses visible to all, vote labels, re-roll visibility, /group-event/new route, live-search group picker, + New Group Event button)
- Auth/session items (initSessionFromUrl before /auth/me, OnboardingRedirector, setOnboardingCompleted)
- QoL items (BugReportButton, + Generate More, inline title edit, SharedProfile route, onboarding route, PostHog init + identify, PageViewTracker, visibleCount/load more, attendee_suggestion_map)

---

## March 14, 2026 — Group invite + misc bug sprint (commits 726e649 → e520022)

726e649 — Backfill window-filtered suggestions to always return 3
- Root cause found: Claude was generating 3 suggestions correctly, but a post-generation window filter was silently dropping suggestions whose times didn't match computed free windows. Fix: snapshot pre-filter suggestions, backfill if count drops below 3. Mirrors single-card reroll fallback pattern already in reroll route. Group itineraries has no window filter — no parity change needed.

42e3b09 — Group invite dropdown clipped by card overflow
- overflow: visible added to invite card container. One line.

f599165 — Two-step invite select → confirm flow in GroupDetail.js
- Clicking a friend in dropdown now stages them as a pill, does not immediately send invite
- Invite button only fires when someone is staged
- Auto-fire on single match removed

c117696 — Group list query missing .in(groupIds) filter
- GET /groups was fetching all groups in DB with no filter, defaulting non-member groups to role='member'
- Users clicking those groups got 403. Fix: .in('id', groupIds) scopes query to user's actual memberships

9e132bc — Multi-select staged friends + bulk invite
- selectedFriend → selectedFriends array
- Search bar stays open after each pick so admin can keep adding
- Already-staged friends excluded from dropdown
- Button label: "Invite" / "Invite 3" etc.
- Promise.allSettled — partial failure keeps failed entries staged for retry

e520022 — Invite dropdown opens on click not focus; member rows navigate to friend profile
- onFocus → onClick prevents browser auto-focus from opening dropdown on page load
- Non-self member rows wrapped in button navigating to /friends/:userId

No active bugs remaining from the original list. New items added to ROADMAP:
- User privacy settings (allow_non_friend_group_invites toggle)

---

## March 14, 2026 — Delete draft button commit 6d89f8d
SHA: 6d89f8d

Fixed:
- GroupItineraryView.js: inline delete confirmation row (3 state vars, handleDeleteDraft, no modal)
- Server: DELETE /group-itineraries/:id already existed with correct guards — no changes needed
- Both 1:1 and group delete now live inside the itinerary detail view, consistent behavior across modes

Remaining active bugs:
- Group invite search submit button + confirmation still missing

---

## March 14, 2026 — Bug batch commit 5eaeed2
SHA: 5eaeed2

Fixed (all 6 confirmed shipped):
- findFreeWindows date clustering — 3-bucket sampling in both findFreeWindows and findFreeWindowsForGroup
- No-duplicate-venues instruction — added to both prompt builders; single-card rerolls explicitly exempted
- classifyIntent('') — now returns ambiguous (was home_likely)
- GCal event description — itinerary UUID appended at all createCalendarEventForUser call sites
- Suggestion count fallback — "exactly 3" + window-reuse instruction in both prompt builders
- ItineraryView title save error handling — input stays open, inline error shown, console.error added; GroupItineraryView TODO comment added

Remaining active bugs:
- Delete draft button not in ItineraryView (1:1 view) — prompt in CLAUDE_CODE_PROMPTS.md
- Group invite search submit button + confirmation still missing

---

## March 14, 2026 — 56-item audit results reconciled
SHA: d476b21
GCal event: "Rendezvous Save State — Beta Launch + 56-Item Audit"

56-item audit confirmed status (44 DONE · 4 PARTIAL/UNCLEAR · 8 NOT DONE):

Confirmed fixed (previously thought to be bugs):
- Route path typos in schedule.js — both already correct in code
- /u/:username route — already registered in App.js:149

Confirmed NOT DONE (fix these next, in priority order):
- findFreeWindows date clustering — sequential fill, no date spread
- No-duplicate-venues instruction — absent from both buildSuggestPrompt and buildGroupSuggestPrompt (STATUS.md was wrong)
- classifyIntent('') → home_likely, should be ambiguous
- Google Calendar event description missing itinerary UUID
- Delete draft button not in ItineraryView (1:1) — Home screen only
- 1:1 suggestions returning fewer than 3
- Event title PATCH silent catch — route reachable but errors swallowed
- Group invite search submit/confirmation still missing
- Dev switcher onboarding drop — unverified (can't confirm from code alone)

New items shipped in this session (second Claude Code run):
- Group member vote responses visible to all (not gated on isOrganizer)
- Group + 1:1 events comingled on home screen (4-tab layout, 👥 badge)
- DELETE /group-itineraries/:id route
- + New Group Event home screen button with live-search group picker
- Attendee re-roll button visibility fix

---

## March 14, 2026 — Second Claude Code session + 56-item audit
SHA: pending commit
Production: https://rendezvous-gamma.vercel.app

Shipped:
- Group member vote responses visible to all (removed isOrganizer gate)
- Group + 1:1 events comingled on home screen (same 4-tab layout, 👥 badge)
- DELETE /group-itineraries/:id (organizer-only, draft-only)
- + New Group Event button on home screen with live-search group picker
- Attendee re-roll button visibility fix
- ROADMAP.md updated: MCP note added to manual busy blocks, Tier 2 #9 (home screen sorting) added
- 56-item status audit completed

Audit findings — confirmed bugs not yet fixed:
- Route path typo (HIGH): /schedule/itinerary:id missing slash — PATCH title and DELETE are unreachable
- findFreeWindows date clustering (all suggestions near start of window)
- No-duplicate-venues instruction confirmed missing from both prompt builders (STATUS.md was wrong)
- classifyIntent('') returns home_likely not ambiguous
- GCal event description missing itinerary UUID
- Group invite search: no submit button, no confirmation
- /u/:username → 404 (route and endpoint both missing)
- Dev switcher + onboarding drop + PATCH /users/location 404

---

## March 14, 2026 — Tier 1 review, docs restructure, roadmap updates
SHA: not yet committed (session in progress)
Production: https://rendezvous-gamma.vercel.app

Completed:
- Reviewed Claude Code Tier 1 output: bug report button, group invite notification, group friend search, PostHog targeting events — all approved
- Removed nodemailer from bugReport.js (DB write only for beta)
- Identified 3 bugs from beta testing: group invite search UX, shared profile link 404, dev switcher onboarding drop
- Wrote Claude Code prompts for all 3 bugs
- Created CLAUDE_CODE_PROMPTS.md with saved prompts for: remote mode, delete draft (1:1), delete draft (group)
- Added Audit 4 (parity/consistency audit before wider rollout) to ROADMAP.md
- Rebuilt README.md as a proper file map and reference index
- Added GCal/STATUS sync protocol to STATUS.md header
- Backfilled STATUS.md entries from GCal save states (Pre-Audit 3, Pre-Launch, Tier 1 Beta Start)

Next: Claude Code finishes bug fixes → commit/push → Vercel verify → save state → Tier 2

---

## March 14, 2026 — Pre-Launch / Share with Real Users
SHA: 5ab29a1
GCal event: "Rendezvous Save State — Pre-Launch (Share with Real Users)"

Completed:
- Audit 3: 2 HIGH (prompt injection) + 1 WARN (ghost votes) fixed
- New-user onboarding: 3-step flow (profile, location, notifications)
  - PATCH /users/onboarding-complete, PATCH /users/location
  - OnboardingRedirector in App.js
  - onboarding_completed PostHog event
  - Finish setup banner in Home.js
- All 10 release gate steps complete
- App shared with real users

Post-launch WARN items (non-blocking, logged in ROADMAP):
- RATE_LIMIT_EXEMPT → move to env var
- INJECTION_RE multiline coverage
- tags field cleanup
- Promise.all parallelization
- schedule.js file split

Next: Tier 1 beta work (bug report, group invite UI, PostHog events)

---

## March 14, 2026 — Tier 1 Beta Work Starting
SHA: b9b912a
GCal event: "Rendezvous Save State — Tier 1 Beta Work Starting"

Completed:
- Mobile responsiveness: bottom tab bar, overflow-x fixes
- ROADMAP restructured into Tier 1/2/3 priority order
- BETA_TESTING.md created with tester process, feedback links, bug bash plan
- Group mode UX gaps logged (friend search dropdown, voting rules, ad-hoc attendees, group invite notification)
- Micro-adjustment reroll spec added
- Manual busy blocks spec added
- Live events moved to Tier 2, email notifications added to Tier 3
- Travel duration picker gap logged

Tier 1 Claude Code prompt submitted (4 items):
1. Bug report + feedback floating buttons
2. Group invite notification frontend
3. Group friend search dropdown
4. PostHog targeting events (home_view_loaded, itinerary_view_loaded, friends_view_loaded)

Next: Tier 1 output review → Tier 2 (travel duration picker, voting rules UI)

---

## March 14, 2026 — Pre-Audit 3
SHA: ed5c605
GCal event: "Rendezvous Save State — Pre-Audit 3"

Completed:
- Group mode frontend: Groups tab, GroupDetail, NewGroupEvent, GroupItineraryView
- Voting UI, draft→send flow, group edit + default_activities
- Automated QA: 14/14 passing (server/tests/qa-automated.js), classifyIntent bug fixed
- PostHog: SDK wired, identify() on auth, 4 core events instrumented

Next: Audit 3 (full pre-launch security/privacy/DR audit)

---

## March 12–13, 2026 — Output quality sprint

### Completed this session

**Prompt engineering sprint (all shipped to prod):**
- [x] RENDEZVOUS_SYSTEM_PROMPT constant — injected as system: param into both Claude calls. Establishes voice, banned phrases, home-plan specificity.
- [x] contextPrompt moved to top of prompt with "MOST IMPORTANT" framing
- [x] friend_annotations.shared_interests injected as high-signal input
- [x] Dietary/mobility restrictions promoted to hard NEVER constraints
- [x] All NYC/Manhattan hardcoding removed — deriveGeoContext() builds dynamic geo context from profiles
- [x] classifyIntent() — returns home_likely | activity_specific | ambiguous. Extended with possessive phrases, movement idioms, named venue prepositions, sports-at-home gap
- [x] Home vs venue split — home_likely: 2 home + 1 venue. ambiguous: at least 1 home. activity_specific: all venue. location_type field in JSON schema. 🏠 badge in SuggestionCard.
- [x] Single-card reroll exact-match block — user input treated as near-literal instruction
- [x] extractVenueName() — detects named venues in contextPrompt
- [x] buildVenueSubstitutionBlock() — if named venue unavailable, find closest match by vibe/price/neighborhood with honest note field
- [x] No duplicate venues rule added to prompt
- [x] Tags field AUDIT-NOTE added — evaluate at Audit 3

**Commits (all READY on Vercel):**
3ae0db1, 40ced19, 00cd218, d4ddf49, 8edd65e, b90b94c, a1f2067, 8f805b8, c0770ff, 6df30cf, d70d014, 5803ec8

### Output quality — remaining sequence

1. **Feed past accepted itineraries as context** (next) — query accepted pair history, inject as "what has worked before" block
2. **Short-circuit validation** — retry once if contextPrompt is specific but suggestions don't match
3. **Venue quality as soft signals** — pass rating/reviews/price_level/editorial_summary to Claude as data, not hard filters
4. **Limited-time & live events sprint** — Ticketmaster + Eventbrite APIs, fetchLocalEvents() utility, event_source field in JSONB, 🎟 badge on event-anchored cards

### YOU ARE HERE
Output quality sprint — venue enrichment complete. Remaining items before moving to Location & Travel Mode:
- [ ] Haiku vs Sonnet QA pass (manual test run)
- [ ] Structured telemetry on itinerary row
- [ ] Limited-time & live events sprint (Ticketmaster + Eventbrite)
- [ ] Option B post-launch (narrative rewrite via second Claude call)

---

## Session Notes (March 11, 2026 — major feature session)

### Completed this session

**Bug fixes (5/5 done):**
- [x] NewEvent generating state — edit button removed entirely after submit, Return Home shown
- [x] Attendee reroll stuck state — finally blocks added, rerolling now works reliably
- [x] Wrong year on calendar invites — added year: 'numeric' to toLocaleDateString in buildSuggestPrompt
- [x] Load more on Home — replaced showAll with visibleCount (progressive, +3 per click)
- [x] Suggest this instead — traced full flow, fixed silent failure

**Load More / Generate More:**
- Home.js: visibleCount progressive disclosure (shows 3 more per click) per itinerary tab
- ItineraryView: "+ Generate More Options" button calls reroll endpoint with appendMode: true
  - Generates 3 new suggestions and appends to existing list without resetting negotiation state
- Server: appendMode param added to reroll route

**Back-and-forth negotiation ("ping pong") state machine rewrite:**
- Root cause found: DB check constraint only allows pending/accepted/declined — 'sent' was silently failing on every write
- DB trigger check_itinerary_lock auto-locks whenever both statuses are 'accepted'
- Rewrote state machine: attendee counter-propose keeps attendee_status: 'pending', uses attendeeSelected: true on the JSONB suggestion object as the signal
- deriveStatus updated to detect attendee_suggested via JSONB flag rather than status values
- orgPickedId and deriveTab in Home.js updated to match
- Organizer counter-proposing back clears all attendeeSelected flags and resets attendee_status: pending
- Server always clears attendeeSelected flags when organizer makes any regular accept

**Post-send UX:**
- After organizer sends their pick: other cards hidden, Edit removed, "We'll let you know when [Name] responds" + Return Home shown
- Same treatment for attendee after "Suggest this instead"
- sentAndWaiting and attendeeSentAndWaiting flags control this
- sentAndWaiting correctly excludes the re-evaluate case

**Card sorting:**
- Attendee view: organizer's pick card always sorts to top
- Organizer re-evaluate view: attendee's suggested card sorts to top

**Button fixes:**
- Non-attendee-pick cards in re-evaluate mode now show "↩ Suggest this instead" | "🕐 New time" | "🎲 New vibe"
- "Reroll all" removed from attendee's highlighted suggestion card
- Single-card reroll preserves attendeeSelected flag on untouched cards

**New vibe prompt:**
- "New vibe" button toggles inline textarea for user to describe what they want
- Text passed as contextPrompt scoped only to that card's single-card reroll
- Enter submits, Escape cancels

---

### Still open / known issues

- MyProfile.js has an unused navigate variable (ESLint warning — low priority)
- Session persistence in production: swap sessionStorage bridge for Supabase sessions + HTTP-only cookies before Vercel deploy
- [x] End-to-end test of full flow (login → friend → new event → send → switch user → accept → lock) — passed
- [x] Full codebase audit completed — saved as audit-2026-03-12.md in project root
- [x] audit-2026-03-12.md severity revised: schedule.js:761 'sent' bug downgraded to Medium (dead code path through UI)

## Release gating decision (March 12, 2026)
Output quality, location/travel mode, and group planning must all be in place before sharing
with real users. First impressions with friends are hard to recover from — a functional but
generic app will be mentally filed as "not ready" and re-engagement is difficult. The revised
sequence is:

  1. ✅ Session persistence + OAuth cookie fix — DONE (March 12)
  2. Privacy/security fixes (friends.js:186, rate limiting, avatar MIME)
  3. Deploy to Vercel (needed for Maps API referrer restriction + live testing)
  4. Output quality — prompt engineering first (highest ROI, zero new infrastructure)
  5. Location & Travel Mode
  6. Group planning
  7. Share with real users
  8. React Native migration + App Store (after feature set is proven on live users)

See TODO.md for full task breakdown per phase.

## Roadmap documents
- ROADMAP.md — full product roadmap: audit schedule, release gating, feature backlog in priority order
- SPRINT_SPECS.md — detailed design specs per sprint: prompt engineering, venue quality, live events,
  activity/hobby venues, group scheduling, location & travel mode, timezone localization

## Next session (March 13, 2026)

### First priority — fix before sharing with any test users
- friends.js:186 — any authenticated user can read any user's full profile (High / Privacy)
  Fix: if friendshipStatus !== 'accepted', return only public fields (full_name, username, avatar_url)
  This must be done before adding any test users outside your immediate circle

### Queue for same session
- schedule.js:761 — replace 'sent' with 'pending' in reroll route (Medium — dead code but clean it up)
- schedule.js:315 — add per-user daily suggestion cap to prevent API credit abuse (High / Security)
- users.js:170 — magic-bytes MIME type validation on avatar uploads (High / Security)

### Pre-deploy blockers (already known — save for deploy sprint)
- index.js:250 — session key + supabaseId in OAuth redirect URL → move to HTTP-only cookie
- index.js:75 — in-memory sessions incompatible with Vercel serverless → persist to Supabase

### Low priority / quality cleanup (can batch into one Claude Code session)
- Stale 'sent' comments: ItineraryView.js:8,10,499,603 and schedule.js:454
- Duplicate JSDoc block: ItineraryView.js:576–579
- console.log PII: schedule.js:458 — gate behind !IS_PROD
- Duplicate sanitizeSearch helper — extract to server/utils/sanitize.js
- friends.js:299 — create anthropic as module-level singleton
- notifications.js:18–33 — add error handling to read/read-all routes
- showOrganizerWaitingIndicator unused variable — remove or implement
- MyProfile.js — remove unused navigate variable
- Duplicate title safety audit: verify all itinerary lookups use UUID not title throughout client and server
- Full codebase audit (consistency, security, privacy, disaster recovery) — prompt saved in Apple Notes

---

## Session Notes (March 10, 2026 — second save state, Claude Code limit hit)

### Bugs identified (now fixed — see above)

1. New Event generating state — edit button / Back to Home
2. Attendee reroll stops after ~2 tries — missing finally block
3. Suggest this instead — silent failure
4. Home screen load more — hard-capped at 3
5. Calendar invites wrong year — toLocaleDateString missing year: 'numeric'

---

## Session Notes (March 10, 2026 — earlier save state)

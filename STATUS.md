## Status & Session Notes

Updated at the end of every significant session. Two parallel systems:
1. Google Calendar all-day event: "Rendezvous Save State — [description]" with git SHA + summary
2. Entry appended here with the same information

GCal is the mobile fallback when STATUS.md can't be updated directly. At the start of each session, check GCal for save states newer than the last STATUS.md entry and backfill here before proceeding.

ROADMAP.md is the source of truth for prioritization. STATUS.md is the historical log — if they conflict, ROADMAP.md wins.

---

## March 15, 2026 — Other Calendars Phase 2 commit [SHA pending]
SHA: pending — update when Claude Code outputs commit hash

Shipped:
- server/index.js: GET /auth/google/connect (new, requireAuth) — base64url JSON state {csrf, userId, mode:'connect'}, csrf stored in oauth_state cookie, prompt:'select_account' forces Google account picker. GET /auth/google/callback modified to detect connect flow via base64url JSON parse — validates csrf, duplicate check on (user_id + account_email), inserts into calendar_connections, redirects to /profile?connected=1. Primary login path completely unchanged.
- GET /calendar/connections (new, requireAuth): returns all connections for user, tokens column never included in response.
- client/src/utils/api.js: getGoogleConnectUrl() and getCalendarConnections() added.
- client/src/pages/MyProfile.js: Connected Calendars section — reads ?connected=1/?error= URL params on mount, sets banner, cleans URL. Read-only list of connections. "Add Google Calendar" button navigates to server connect route (full-page nav, not React Router).

Next: Phase 4 — calendar write path (createCalendarEventForUser writes to is_primary connection)

## March 15, 2026 — ICS Download Button commit [SHA pending]
SHA: pending — update when Claude Code outputs commit hash

Shipped:
- ItineraryView.js + GroupItineraryView.js: generateICS and downloadICS helpers added at module level (identical logic, PRODID string differs by source). Button renders inside existing locked/isLocked && isWinner guard — no new conditions. Single-day: parses suggestion.time + suggestion.date into UTC Date, DTEND from durationMinutes || 120. Multi-day: VALUE=DATE all-day format, exclusive DTEND. Group summary: group_name + event_title. 1:1 summary: venueName with FirstName. Client-side only — Blob + temporary anchor, no server route, no new dependencies.

Multi-calendar sprint fully complete: Phases 1-6 + ICS download button.

Next: Live Events V1 — intent-driven temporal anchoring

---

## March 15, 2026 — Other Calendars Phase 6 commit [SHA pending]
SHA: pending — update when Claude Code outputs commit hash

Shipped:
- server/utils/appleCalendarUtils.js (new): createAppleDAVClient(email, password) — DAVClient Basic auth at https://caldav.icloud.com, calls client.login() to validate credentials, throws on failure. fetchAppleBusy(email, password, calendarIds, startISO, endISO) — fetches calendars, filters by calendarIds if provided, fetchCalendarObjects with timeRange, parses DTSTART/DTEND via regex, returns flat [{start,end}], returns [] on any error, logs email only (never password). createAppleCalendarEvent — picks first writable VEVENT calendar, hand-crafted RFC 5545 ICS string with CRLF line endings, calls createCalendarObject, returns {uid} or null.
- server/index.js: POST /calendar/connections/apple — validates email+password (400), createAppleDAVClient credential check (400 friendly message on failure), duplicate check by (user_id, provider, account_email), is_primary=true only if first connection, inserts tokens:{email,password}. Password never logged or returned.
- server/utils/fetchBusyAggregated.js: branches on conn.provider — apple → fetchAppleBusy (flat array); google/no provider → existing googleapis path; unknown → logged+skipped. Apple and Google result shapes handled separately.
- server/utils/getPrimaryCalendarTokens.js: now selects tokens+provider, returns {tokens, provider}. Fallback returns {tokens: sessionTokens, provider: 'google'}. Token detection accepts Apple (.email) and Google (.access_token).
- server/utils/calendarUtils.js: destructures {tokens, provider} from getPrimaryCalendarTokens. New branch: provider==='apple' → delegates to createAppleCalendarEvent. Google path and backward-compat fallback unchanged.
- Password safety confirmed: appears only in function parameters, DAVClient credentials object, and Supabase tokens insert. Zero console.* calls, zero response bodies, zero error messages.

Next: ICS download button on locked itinerary views (client-side generation, no new server route)

---

## March 15, 2026 — Other Calendars Phase 5 commit [SHA pending]
SHA: pending — update when Claude Code outputs commit hash

Shipped:
- server/index.js: PATCH /calendar/connections/:id — ownership check (403), clears is_primary on all user connections then sets on target row, returns {ok:true}, never returns tokens. DELETE /calendar/connections/:id — ownership check (403), guards last is_primary connection with 400 message, hard-deletes otherwise, returns {ok:true}. POST /calendar/connections/apple — stub, returns 501.
- client/src/utils/api.js: setPrimaryCalendarConnection(id), removeCalendarConnection(id), connectAppleCalendar({email, password}) added.
- client/src/pages/MyProfile.js: 9 new state vars (connectionLoading, connectionError, confirmingRemoveId, appleGuideOpen, appleEmail, applePassword, appleSubmitting, appleMessage). Click-away useEffect for confirmingRemoveId via document mousedown listener on [data-remove-btn]. refetchConnections (useCallback), showConnectionError (4s auto-clear), handleSetPrimary, handleRemove (two-click pattern), handleAppleSubmit (501 → coming soon message). Connections list now interactive: provider badge, email, Primary badge (badge--green) on is_primary row, Set as primary button (hidden on primary row), Remove/Confirm remove two-click with data-remove-btn. connectionLoading scoped per-row. Apple CalDAV guide: collapsed by default, chevron toggle, 5-step instructions, iCloud email + password inputs, coming soon on 501, revocation note + Apple ID settings link.

- KNOWN ISSUE: PATCH /calendar/connections/:id runs two sequential UPDATEs (clear all is_primary, then set target). If the server crashes between them the user is left with no primary connection. Wrap in a Postgres transaction before wider rollout. Flag for Audit 4.

Next: Phase 6 — Apple CalDAV implementation

---

## March 15, 2026 — Other Calendars Phase 4 commit [SHA pending]
SHA: pending — update when Claude Code outputs commit hash

Shipped:
- server/utils/getPrimaryCalendarTokens.js (new): queries calendar_connections for is_primary=true row, returns those tokens if access_token present, falls back to sessionTokens. Never throws, logs with userId on error. Backward-compat: users with no calendar_connections rows get sessionTokens unchanged.
- server/utils/calendarUtils.js: createCalendarEventForUser now accepts optional supabase and userId. Resolves tokens via getPrimaryCalendarTokens when both present, else session.tokens. createOAuth2Client, expiry check, and token refresh all use resolved tokens. Removed session.tokens = credentials mutation (shared-state risk — auth.setCredentials is sufficient). Event construction and calendar.events.insert unchanged.
- server/routes/schedule.js: replaced single activeSession = organizerSession || attendeeSession with two concurrent createCalendarEventForUser calls via Promise.all. Organizer and attendee each resolve their own is_primary tokens independently. Organizer result preferred for calendarEventId/calendarEventUrl storage, attendee as fallback. Both users now reliably get the event written on lock.
- server/routes/group-itineraries.js: added supabase and userId: memberId to per-member createCalendarEventForUser call in finalize-lock path. No structural change.

Next: Phase 5 — Connected Calendars UI (list/add/remove/set primary in profile settings)

---

## March 15, 2026 — Other Calendars Phase 3 commit [SHA pending]
SHA: pending — update when Claude Code outputs commit hash

Shipped:
- server/utils/getCalendarConnectionsForUser.js (new): queries calendar_connections by user_id, returns [] on any error, never throws.
- server/utils/fetchBusyAggregated.js (new): backward-compat path (no connections) calls freebusy on sessionTokens with items:[primary] — byte-for-byte equivalent to pre-Phase-3 behavior. Aggregated path (connections exist): one freebusy call per connection via Promise.allSettled, calendar_ids used as items when non-empty else defaults to [primary], failed calls logged by connection.id and skipped, all busy arrays merged into flat {start,end} array. tokens passed only to createOAuth2Client — never logged, serialized, or returned.
- server/routes/schedule.js: fetchBusy real-calendar branch replaced with fetchBusyAggregated call. Mock fallback untouched. All 3 call sites (/suggest, /reroll organizer, /reroll attendee) inherit automatically.
- server/routes/group-itineraries.js: identical replacement in fetchBusy real-calendar branch. Unused {google} import removed. Concurrent-per-member pattern in generateGroupSuggestions unchanged — per-connection fan-out now handled inside fetchBusyAggregated.

---

---

## March 15, 2026 — Other Calendars Phase 1 commit 39f6cba
SHA: 39f6cba

Shipped:
- calendar_connections table created (additive — no existing tables touched):
  - Columns: id, user_id, provider (google|apple), account_label, account_email, tokens jsonb, calendar_ids text[], is_primary bool, created_at, updated_at
  - RLS enabled, 5 policies: SELECT/INSERT/UPDATE/DELETE user-scoped + ALL service role
  - Index on user_id, updated_at trigger
  - All 6 verification checks passed
- google_tokens confirmed: exists, 0 rows, schema only. Not touched. Tokens have always lived in sessions table. Can be dropped in a future cleanup migration.
- No application code changed in this phase.

Next: Phase 2 — OAuth connect flow for secondary Google accounts

---

## March 15, 2026 — Push copy alignment + 4 new triggers commit 8a64ca4
SHA: 8a64ca4

Shipped:
- Aligned existing 4 push triggers to match in-product notification copy exactly:
  - Friend request received: title/body now matches insertNotification copy
  - Group invite: body now includes organizer name (was generic "Tap to review and vote.")
  - Itinerary sent: title/body matches 'New plan from ' + senderName copy
  - Itinerary locked: title 'Plans confirmed — calendar invite sent', full body with Google Calendar line
- Added 4 new push triggers:
  - Friend request accepted (friends.js): fires on /accept success
  - Itinerary declined (schedule.js): fires on /decline
  - Suggest alternative (schedule.js): fires on /confirm with isSuggestAlternative === true only
  - Group counter-proposal (group-itineraries.js): fires on /vote with isCounterProposal === true only

Full push notification stack now complete: 8 triggers total, consistent copy across push and in-product, all fire-and-forget.

---

## March 15, 2026 — FCM token re-registration on app load commit 93e222b
SHA: 93e222b

Shipped:
- App.js: silent FCM token re-registration fires inside /auth/me .then() after onboarding check. Floating .then()/.catch() chain — never awaited, never delays setAuthReady(true) or spinner clearing. Only fires when Notification.permission === 'granted'. Covers users who completed onboarding before push was wired.

---

## March 15, 2026 — FCM web push commit 24d6471
SHA: 24d6471

Shipped:
- client/src/firebase.js (new): Firebase app init + messaging export, all config from REACT_APP_FIREBASE_* env vars.
- public/firebase-messaging-sw.js (new): background push handler, notificationclick → deep link navigation. Config injected via self.FIREBASE_* assignments in public/index.html (CRA replaces %REACT_APP_*% tokens at build time).
- public/index.html: self.FIREBASE_* script block added before </head> for service worker config.
- client/src/utils/api.js: registerPushToken() added.
- client/src/pages/Onboarding.js: step 3 push stub replaced with real FCM getToken() + registerPushToken() call. Non-fatal — never blocks onboarding progression.
- DB migration: push_subscriptions updated with token text + updated_at timestamptz columns. Old compound unique constraint dropped, new user_id-only unique constraint added.
- server/routes/notifications.js: POST /push/register route added — upserts FCM token by user_id.
- server/utils/pushNotifications.js (new): sendPush(supabase, userId, { title, body, actionUrl }) using firebase-admin. Never throws, returns boolean. Stale token auto-cleanup on messaging/registration-token-not-registered error.
- server/routes/friends.js, schedule.js, group-itineraries.js: sendPush wired into all 4 Tier 1 triggers (friend request, group invite, itinerary sent, itinerary locked — 5 call sites total).

Verification: all 6 checks passed (index.html script block, DB columns, unique constraint, CI build, service worker in build output, sendPush grep).

GCal event: "Rendezvous Save State — FCM Web Push"

---

## March 15, 2026 — Manual busy blocks commit ac48ca9
SHA: ac48ca9

Shipped:
- DB migration: manual_busy_blocks jsonb (DEFAULT '[]') + attendee_busy_notes text on itineraries; manual_busy_blocks jsonb + attendee_busy_notes jsonb (keyed by user_id) on group_itineraries. Schema note: group attendee_busy_notes is jsonb not text — correct for multi-attendee attribution.
- NewEvent.js + NewGroupEvent.js: collapsible 'Block off dates' section after context prompt. Date picker auto-adds on selection (no Add button), From/To time inputs, optional reason label, pill tags with × delete. Full parity across both files.
- schedule.js: buildExcludedWindowsBlock() + buildAttendeeNotesBlock() helpers. buildSuggestPrompt updated to accept and inject both blocks after AVAILABLE TIME WINDOWS. POST /suggest validates + stores manual_busy_blocks, adds has_manual_busy_blocks to telemetry. POST /reroll reads both fields from DB row and re-injects on every reroll. POST /decline stores attendee_busy_notes.
- group-itineraries.js: full parity. buildGroupAttendeeNotesBlock() concatenates per-user notes with attribution. generateGroupSuggestions passes both blocks into buildGroupSuggestPrompt. PATCH /vote merges decline notes into attendee_busy_notes[userId].
- ItineraryView.js: decline panel with optional busy notes textarea. Organizer banner shows attendee_busy_notes when non-empty, hidden from attendee view.
- GroupItineraryView.js: same decline panel. Organizer banner attributes each attendee's notes by name.

---

## March 15, 2026 — Micro-adjustment reroll commit 504931f
SHA: 504931f

Shipped:
- server/utils/classifyRerollIntent.js (new): classifyRerollIntent(prompt) → 'micro_adjust' | 'full_replace' | 'ambiguous'. Ambiguous: null/empty/<2 words. micro_adjust: 5 pattern groups (temporal, vibe, distance, swap, preservers). full_replace: everything else. Full try/catch → returns 'ambiguous' on any error. console.debug on every classification.
- schedule.js (reroll route only — suggest route untouched): imports classifyRerollIntent, classifies safeRerollContext (user's new text, not original context) immediately after combinedContext. microAdjustBlock + priorSuggestionsBlock built before buildSuggestPrompt call — both empty strings for non-micro_adjust. contextPrompt array: micro-adjust blocks prepended, join separator changed from '. ' to '\n'. reroll_intent_class added to rerollTelemetry.
- group-itineraries.js (generateGroupSuggestions only): same import and classification block added after vibeAddendum. buildGroupSuggestPrompt call: rerollNote replaced with [microAdjustBlock, priorSuggestionsBlock, rerollNote].filter(Boolean).join('\n') for full parity.

---

## March 15, 2026 — Home screen sorting commit 53f39e1
SHA: 53f39e1

Shipped:
- SORT_OPTIONS constant (date / recent / activity) added to Home.js
- sortBy state initialized from localStorage ('rendezvous_home_sort'), defaults to 'date'
- sortItems(a, b) comparator: date = byEventDate; recent + activity = updated_at desc (falls back to created_at)
- All four tab .sort(byEventDate) calls replaced with .sort(sortItems)
- Sort pills sit right-aligned on same row as tab bar, space-between flex layout
- Changing sort persists to localStorage + resets visibleCount to INITIAL_VISIBLE
- Mobile: outer flex wraps so pills stack below tabs without crowding

---

## March 15, 2026 — Pre-login landing page commit 10fa724
SHA: 10fa724

Shipped:
- public/index.html: Fraunces loaded via Google Fonts preconnect; title changed from "React App" to "Rendezvous"
- Landing.css: all styles scoped to .lp-*, dark background (#0f0f13), indigo accent (#6366f1), Fraunces headlines, responsive stacking at 768px, scroll animation classes, floating button fade
- Login.js: auth redirect logic untouched; LandingPage component added for unauthenticated users
  - Hero: "Stop suggesting. Start going." headline, pill CTA, privacy note, animated scroll hint
  - 3 feature sections with Intersection Observer fade+slide on enter, alternating layout
    - CalendarOverlapSVG: two 7x5 calendar grids, red busy cells, indigo overlap cells
    - SuggestionCardMock: HTML mock styled like SuggestionCard with gradient header, 3 venues, action buttons
    - PhoneCalendarSVG: SVG phone with calendar, day 21 highlighted, indigo event block
  - Final CTA: "Your next plans are waiting." with same auth button
  - Floating "Get Started →": fixed bottom-right, fades in when hero scrolls out of view, links to OAuth

---

## March 15, 2026 — Voting rules UI commit 2866f66
SHA: 2866f66

Shipped:
- Voting rules now visible and configurable in NewGroupEvent UI
- Quorum: custom threshold (N of X votes needed) or Unanimous toggle
- Tie behavior: "Lock it in anyway" or "Skip the suggestion"
- Radio card pattern with brand-highlighted active selection

In flight: pre-login landing page (Claude Code)

Next: home screen sorting, micro-adjustment reroll, manual busy blocks

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

## March 14, 2026 — Discord button + session wrap
SHA: fdfacf9 (last confirmed)
Discord: https://discord.gg/6xc8ERrDDb
Production: https://rendezvous-gamma.vercel.app

Shipped this session (full list):
- fdfacf9: Multi-day UI (date range header, day count duration, collapsed day preview, full-span GCal event — parity across 1:1 and group)
- 04b2194: Multi-day prompt fix (per-day instructions, no front-loading — parity across 1:1 and group)
- 3e029d7: Group calendar write path (calendarUtils.js extraction, POST /group-itineraries/:id/finalize-lock, client-side trigger)
- 06cb301: Calendar confirmation UX (direct event link, home screen calendar status, lock notification copy)
- b9fe605: Remote mode + trip duration stepper (full parity, DB constraints updated)
- Discord button: '💬 Discord' pill added to top of floating cluster, DISCORD_INVITE_URL constant
- Google OAuth flipped to Production mode
- Browser Maps JS API key created with HTTP referrer restriction

ROADMAP additions this session:
- Discord automations (future: bug reports, feedback, PostHog events → Discord channels)
- Travel preferences profile settings (consideration, gated on beta signal)
- Day-by-day planning wizard (deferred, needs beta signal)

Beta testers invited and messaged. App is live and shared.

Next:
- Pre-login landing page (Tier 3)
- Privacy policy (Tier 3, blocks OAuth verification)
- Notification + privacy settings page (Tier 3)

---

## March 14, 2026 — Group calendar write path commit 3e029d7
SHA: 3e029d7

Shipped:
- server/utils/calendarUtils.js (new): createOAuth2Client and createCalendarEventForUser extracted from schedule.js into shared utility. schedule.js now imports from it — zero behavior change for 1:1.
- POST /group-itineraries/:id/finalize-lock: idempotent, Promise.allSettled per member, persists calendar_event_id + calendar_event_url on first success
- GroupItineraryView.js: calls finalize-lock after vote triggers lock (best-effort, never blocks UI), then reloads. TODO comment replaced with real calendar button using calendar_event_url.
- Home screen: no changes needed — "📅 On your calendar" already gates on calendar_event_id, now fires for group events too
- Vercel build passed (buildGCalUrl unused variable resolved as part of this commit)

Group scheduling now at full parity with 1:1 on calendar event creation.

---

## March 14, 2026 — Calendar confirmation UX commit 06cb301
SHA: 06cb301

Shipped:
- createCalendarEventForUser returns { id, htmlLink }; htmlLink stored as calendar_event_url on itineraries (new column, DB migration applied)
- ItineraryView: "📅 View in Google Calendar" uses direct event URL when available; falls back to TEMPLATE URL only when no write happened
- GroupItineraryView: calendar button removed with TODO comment (group write path not built yet)
- Home EventCard: "📅 On your calendar" line on confirmed pills when calendar_event_id present; group items ready for when write path is built
- New itinerary_locked notification type with personalized copy sent to both users
- Group lock notification: honest "add manually" note until group calendar write is built
- NotificationBell: itinerary_locked: '📅' added to TYPE_ICON
- calendar_event_url cached in client state on confirm — no page refresh needed

Also shipped this session (separate commits):
- Remote mode b9fe605: full parity, DB constraints updated on both tables
- Trip duration stepper b9fe605: static presets replaced with 1–14 day numeric stepper
- Google OAuth flipped to Production mode
- Browser-specific Maps JS API key created with HTTP referrer restriction

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

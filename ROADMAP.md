# Rendezvous — Product Roadmap
Last updated: March 13, 2026

Full product roadmap: audit schedule, release gating, and the complete feature backlog
in priority order. For detailed design specs on each sprint (architecture, data model,
prompt changes, UI), see SPRINT_SPECS.md.

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

**Audit 4 — Before App Store submission**
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
  4. Output quality → prompt engineering first (zero new infrastructure, highest ROI)  ← YOU ARE HERE
  5. Location & Travel Mode
  6. Group planning
  7. Audit 3 → full pre-launch audit before real users
  8. Share with real users
  9. React Native / App Store → after feature set is proven on live users

---

## 🔴 Next Up (after current testing pass)

- [x] **Session persistence** — Supabase sessions table, HTTP-only cookie, requireAuth DB lookup. DONE March 12.
- [x] **Switch OAuth handoff** from URL params to HTTP-only cookie. DONE March 12 (combined with session persistence).
- [ ] **friends.js:186** — privacy fix before sharing with anyone new (High / Privacy) ← START HERE
- [ ] **Vercel deployment** — connect GitHub repo, set env vars, verify all routes
- [ ] **HTTP referrer restriction** on Google Maps API key (needs live Vercel URL)
- [ ] **Tighten RLS** — `notifications_service_role_all` currently `USING(true)`, fix before deploy
- [x] **Switch OAuth handoff** from URL params to HTTP-only cookie. DONE March 12.

---

## 🟡 Feature Backlog (prioritized)

### Group Planning
> ⚠️ BEFORE STARTING THIS SECTION: Bring ROADMAP.md and SPRINT_SPECS.md into a Claude.ai session and ask for a full scoping review. Group planning is the most complex item on the roadmap — new DB tables, three decision modes, vote logic, batched notifications, and significant ItineraryView changes. Confirm requirements, surface hidden complexity, and agree on implementation sequencing BEFORE handing anything to Claude Code.
>
> One organizer, N participants. Everyone sees the same suggestion set. Decision mode set at creation.
- [ ] DB: add `itinerary_participants` table (id, itinerary_id, user_id, role, status, voted_for, joined_at, responded_at)
- [ ] DB: add to `itineraries`: group_size, decision_mode (organizer_picks | majority_vote | unanimous), vote_deadline, voting_closed_at
- [ ] NewEvent: multi-friend selector (up to 6)
- [ ] NewEvent: decision mode radio cards — "Organizer picks" / "Majority vote" / "Everyone must agree"
- [ ] NewEvent: vote-by deadline picker (shown for vote/unanimous modes)
- [ ] Suggestion engine: support N user profiles in prompt
- [ ] ItineraryView — organizer_picks mode: identical to 1:1, only organizer's pick triggers lock
- [ ] ItineraryView — majority_vote mode: live vote tally per card, "Vote for this" button, organizer can close early, deadline countdown badge
- [ ] ItineraryView — unanimous mode: per-person accept/decline chips per card, locks when all green, any decline reopens for reroll
- [ ] Reroll in group context: any participant can propose reroll on non-winning card; vote mode resets votes; unanimous mode resets all statuses on that card
- [ ] Notifications: batched responses (don't ping organizer once per person), deadline reminders to non-responders only, unresolved flag on deadline pass

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
- [x] No duplicate venues rule added to buildSuggestPrompt. DONE.
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

### Location Awareness & Travel Mode
> Full spec in SPRINT_SPECS.md. Core design principle: intent over distance sensing. 8 miles means different things in NYC vs Buffalo. The organizer declares the mode — the system never tries to infer it from coordinates.

**Local mode — where to meet (applies to all itineraries, not just long-distance)**
- [ ] Add `location_preference` column to `itineraries` table — enum: `closer_to_organizer | closer_to_attendee | system_choice | destination`
- [ ] NewEvent: add "Where should you meet?" step with 3-button selector (Closer to me / Closer to them / Up to the system)
- [ ] Update `buildSuggestPrompt` to anchor Places API search to the correct location based on `location_preference`
- [ ] System choice: compute midpoint between profile locations using Geocoding API (already enabled), anchor to that

**Travel mode — destination planning**
- [ ] Add `travel_mode` column to `itineraries` — enum: `local | travel`, default `local`
- [ ] Add `destination` column — text, nullable
- [ ] Add `trip_duration_days` column — int, default 1
- [ ] NewEvent: add Local | Travel toggle; Travel mode shows same 3-button selector + duration picker (1 day / Weekend / Longer)
- [ ] "Closer to me / Closer to them" in travel mode: anchor Places API to organizer's or attendee's city
- [ ] "Somewhere new": 2-step generation flow — first prompt asks Claude to suggest 3 destination options with rationale; organizer picks one; second prompt generates full itinerary for that destination
- [ ] Update suggestions JSONB to support day grouping for multi-day trips: `{ days: [{ day, label, stops: [...] }] }` — single-day trips use one-entry array for schema consistency
- [ ] ItineraryView: day-grouped rendering for multi-day itineraries
- [ ] Multi-day itinerary prompts: include travel logistics awareness (fly vs drive, realistic arrival/departure on day 1 and last day), accommodation area suggestions (links only, no booking)

**Cost estimates (paired with travel mode)**
- [ ] Trip mode: detect when `travel_mode = 'travel'` — add flight/train/lodging cost estimates to suggestion output
- [ ] See Cost Estimates section below for full spec

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

### Maps API Key Split (pre-maps-feature)
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

- [ ] Vercel deployment
- [ ] HTTP referrer restriction on Maps API key
- [ ] Tighten notifications RLS
- [ ] Session persistence (Supabase sessions table)
- [ ] OAuth handoff → HTTP-only cookies
- [ ] PWA config — manifest.json + service worker
- [ ] Push notifications (PWA web push) — needed to close MCP loop

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

### Bug report button
- [ ] Floating button (bottom corner, all pages, logged-in users only) opens a modal with category picker + freeform text field
  - Categories: "Something broke" / "Wrong info in itinerary" / "Bad suggestion quality" / "Other"
  - Auto-attaches: current page URL + supabaseId + timestamp on submit
- [ ] On submit: write to `bug_reports` Supabase table AND send email to Aaron via POST /bug-report server route
- [ ] DB migration: `bug_reports` table — id (uuid), user_id (uuid FK → profiles), category (text), message (text), page_url (text), created_at (timestamptz). RLS: users can insert own reports only, service role reads all.
- [ ] Email: nodemailer + Gmail SMTP (lightweight, no new services). Subject: "Rendezvous bug: [category]". Body: message, page URL, user ID, timestamp.
- [ ] Create BugReportButton.jsx as a standalone reusable component — import once into App.js so it renders on every route automatically

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

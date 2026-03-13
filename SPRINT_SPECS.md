# Rendezvous — Sprint Specs
Last updated: March 13, 2026

Detailed design specs for each feature sprint. Covers prompt engineering, venue quality,
live events, activity/hobby venue discovery, group scheduling, location & travel mode,
and timezone localization. This is the deep-dive companion to ROADMAP.md — where
ROADMAP.md tracks what to build and when, this file explains how and why.

---

## Prompt engineering & output quality
Added: March 12, 2026

Core thesis: functional scaffolding is nearly done. The differentiator — and the driver of user
retention — is the quality of itinerary suggestions and route logic. A technically working app
that suggests mediocre plans gets abandoned. Suggestions that feel personalized and thoughtfully
sequenced are what make people come back and tell friends.

---

## Prompt engineering (highest leverage, do first)

The Claude prompt in `buildSuggestPrompt` is the engine. Current state is functional but generic.

- Weight `contextPrompt` as the highest-priority signal — if the user said "something low-key"
  or "we both love sushi", that should dominate the output
- Inject shared interest signals explicitly — pull from `friend_annotations.shared_interests`
  and surface them in the system prompt
- Use past accepted itineraries (both statuses = accepted) to infer what landed well for this
  pair — feed as context
- Add a persona instruction: suggestions should feel like a well-connected local friend, not a
  Yelp list
- Hard-constraint dietary and mobility restrictions with explicit "never suggest X" framing,
  not soft hints
- Make city context fully dynamic — no hardcoded NYC assumptions anywhere in the prompt

---

## Venue quality signals

Right now Places API returns results ranked by proximity and generic rating. Low bar.

**Key decision: use quality signals as soft context for Claude, not hard filters.**
A 4.2+ star / 100+ review threshold mechanically excludes newer spots, hidden gems,
neighborhood joints, and niche venues — biasing everything toward the Yelp-famous tier.
That defeats the product's differentiation. Instead:

- Pass `rating` and `user_ratings_total` per venue to Claude as context — let Claude reason
  about whether a 4.0 with 38 reviews is the right underground pick
- Pull `price_level` and pass to Claude — match vibe to budget implicitly
- Use `editorial_summary` from Places API (New) where available — far richer than name + address
- Pass `has_photos` boolean to Claude — signals active, real business
- Do NOT implement a hard star/review floor

---

## Limited-time & live events
Added: March 13, 2026

This is a meaningful product differentiator. A concert recommendation that's actually
playing when the user is free is a completely different value prop than "there are generally
concerts at Brooklyn Steel."

### Data sources

| Source | API | Coverage | Free tier |
|---|---|---|---|
| Ticketmaster | Discovery API | Concerts, sports, shows | 5,000 calls/day |
| Eventbrite | Events API | Local festivals, pop-ups, community events | Free with registration |
| Museum exhibitions | None reliable | NYC has no unified API | Out of POC scope |
| Comedy shows | None reliable | Venue-specific | Out of POC scope |

### Architecture

New utility: `server/utils/events.js`
- `fetchLocalEvents(location, dateRangeStart, dateRangeEnd, interests)`
- Calls Ticketmaster + Eventbrite concurrently
- Dedupes by name + date
- Filters by relevance to user interests (string match against interests array)
- Returns top 5–8 events: name, date/time, venue, category, URL
- 1-hour module-scoped cache per (location, date_range) — event data doesn't change minute-to-minute

Claude prompt injection (third content source alongside Places + profiles):
```
AVAILABLE TIME-SENSITIVE EVENTS (happening during the suggested window):
- Knicks vs. Celtics @ MSG — Sat Mar 14, 7:30 PM [sports, basketball]
- LCD Soundsystem @ Terminal 5 — Sat Mar 14, 9 PM [music, concert]
- NYC Brewery Crawl @ Williamsburg — Sun Mar 15, 2 PM [local event, food/drink]

If any of these match the users' interests or context prompt, strongly prefer them
over generic venue suggestions. These are real events with real dates.
```

Suggestion JSONB: add `event_source` field — `ticketmaster | eventbrite | places | home`
UI: 🎟 badge on event-anchored cards with deep link to purchase/info page

### Privacy
- Event API keys in server/.env only, never client-exposed
- Only location + date range sent to event APIs — no user data

---

## Activity-specific venue discovery
Added: March 13, 2026

Currently, venue discovery is passive — Claude names a venue from training data and the
Places API verifies it after the fact. For activity-specific requests ("I want to play
tennis", "let's golf", "pickleball?"), the right approach is proactive discovery: fetch
real, relevant venues before Claude generates, then anchor suggestions to them.

### How it differs from live events

Live events are time-anchored (a specific concert on a specific night). Activity venues
are persistent infrastructure — courts, courses, ranges, mountains. The fetch logic is
simpler (no date-range filtering) but the intent classification is more nuanced.

### Intent extraction

`classifyIntent()` already returns `activity_specific`. A second pass — `extractActivityType()`
— would identify which category:

| User says | Activity type | Places API type |
|---|---|---|
| "play tennis" / "tennis courts" | tennis | `tennis_court` |
| "golf" / "hit balls" / "driving range" | golf | `golf_course` |
| "ski" / "skiing" / "hit the slopes" | skiing | `tourist_attraction` + keyword "ski" |
| "pickleball" | pickleball | `sports_complex` + keyword "pickleball" |
| "bowling" | bowling | `bowling_alley` |
| "climbing" / "bouldering" | climbing | `sports_complex` + keyword "climbing" |
| "ice skating" | ice_skating | `tourist_attraction` + keyword "skating" |
| "mini golf" | mini_golf | `tourist_attraction` + keyword "mini golf" |

### New utility: `server/utils/activityVenues.js`

- `fetchActivityVenues(activityType, location)` — Places API Text Search with type hint +
  keyword fallback for types without a clean Places category
- Returns top 3–5 venues: name, address, rating, user_ratings_total, website URL, place_id
- Module-scoped 60-min cache per `(activityType, location)` — same pattern as venueEnrichment.js
- Best-effort: returns [] on any failure, never blocks generation

### Claude prompt injection

Fourth content source (alongside Ticketmaster, Places enrichment, and past history):

```
## NEARBY [TENNIS COURTS / GOLF COURSES / etc.]
The following real venues exist near the users' location. If the context prompt requests
this activity, anchor at least one suggestion to one of these venues.

- Riverside Park Tennis Courts — 79th St & Riverside Dr, Manhattan (rated 4.3, 210 reviews)
- Central Park Tennis Center — Mid-Park at 93rd St (rated 4.1, 340 reviews)
- Crosstown Tennis — 14 W 31st St, Midtown (rated 4.0, 88 reviews)
```

### Suggestion JSONB

Add `activity_source: 'places_activity'` alongside the existing `event_source` field for
activity-anchored cards.

### UI

🎾 / ⛳ / ⛷️ / 🎳 activity-type badge on relevant cards. "Book / Reserve" link pointing to
venue website (Google Maps fallback if no website). Same pattern as the 🎟 event badge.

### Booking deep links (v2, not POC)

Direct booking via GolfNow, CourtReserve, OpenTable, etc. is explicitly out of POC scope.
For POC: deep link to the venue's website or Google Maps listing. The booking integration
would follow the same pattern as the Ticketmaster ticket link but require per-platform API
keys and auth flows.

### Additional event sources (v2 roadmap)

Eventbrite's public city-wide search endpoint has been deprecated since 2020 with no
suitable replacement. Future event source candidates when APIs mature or new options emerge:

| Source | Status | Notes |
|---|---|---|
| SeatGeek | Available | Concert and sports discovery, similar to Ticketmaster |
| Bandsintown | Available | Music-focused, artist + venue tracking |
| Meetup | Available | Community events, group activities |
| Resident Advisor | No public API | Electronic music events |
| NYC Open Data | Available | City-permitted events (free, but low coverage) |

SeatGeek and Bandsintown are the highest-priority additions — both have free tiers and
cover the same concert/sports use case as Ticketmaster, providing redundancy and broader
coverage.

---

## Route logic and sequencing

This is where the app can really differentiate — nobody else sequences a full evening
intelligently.

- Use Distance Matrix to validate that the venue sequence makes geographic sense (no zigzagging)
- Build a duration lookup table per venue type: coffee = 45 min, dinner = 90 min, bar = 60 min,
  show = 2.5 hrs
- Suggest venues in logical progression: pre-activity drink → activity → dinner → late night
- Time-of-day awareness: a rooftop bar at 11am is wrong even if both users love rooftop bars
- Opening hours validation: confirm all suggested venues are open during the proposed window

---

## Personalization depth

- `activity_clusters` table already exists — actually use it. Run clustering on onboarding,
  update on each accepted itinerary
- Detect compatibility signals: find the overlap between what each person accepts and weight
  toward it
- Avoid suggestion fatigue: track which venue types have been suggested recently (changelog
  jsonb) and diversify

---

## Re-roll experience

Re-rolling is the fallback when suggestions miss. Make it smarter:

- Log what was rejected (already in `edit_history`) — use rejection signals to improve the
  next prompt
- The `contextPrompt` on single-card reroll is gold: "something more casual" — parse and
  amplify in the replacement prompt
- After 2+ rerolls, proactively surface a prompt asking for more context

---

## Implementation sequencing

1. Prompt engineering + dynamic city support — no new infrastructure, highest ROI
2. Venue quality filtering — minor changes to Places API + pre-processing before Claude
3. Route sequencing validation — Distance Matrix already wired, just needs logic layer
4. Opening hours validation — Places API already returns this, just needs the filter
5. Personalization from clusters + history — needs real itinerary data post-launch

---

## Target bar

A user reads the first suggestion on the first try and thinks "yeah, that actually sounds
like us." Everything above is in service of that.


---

## Location awareness and travel mode
Added: March 12, 2026

### Core design principle

Distance-based detection is the wrong approach. 8 miles in NYC is a completely different
cognitive and logistical experience than 8 miles in Buffalo, Phoenix, or rural Vermont.
Intent is the right primitive. The organizer knows whether this is a local hangout or a
trip — the app shouldn't try to infer it from coordinates.

### Travel Mode toggle (first-class feature, not edge case)

When an organizer starts drafting an itinerary, they see a "Travel Mode" toggle. This is
a first-class input at event creation time.

**Local mode — where to meet (always available, not just for long-distance pairs):**
- Closer to me
- Closer to them
- Up to the system (true midpoint / best fit)

Example: Aaron in Greenpoint, mom on the Upper West Side. "Closer to me" = Greenpoint/
Williamsburg. "Closer to her" = UWS. "Up to the system" = LES, Midtown, etc.

**Travel mode — destination planning:**
- Closer to me (suggestions in organizer's city)
- Closer to them (suggestions in attendee's city)
- Somewhere new — system proactively suggests a destination city or region, organizer picks,
  then full itinerary generates for that destination (two-step generation flow)

"Somewhere new" example: "You're in NYC, Bobby's in Buffalo — here are 3 easy meeting
points: Pittsburgh, Philadelphia, or the Catskills."

### Multi-day itinerary support

Travel mode requires multi-day support. Overnight trips need:
- Number of days input (1-day / weekend / longer)
- Suggestions structured by day, not a flat venue list
- Hotel/accommodation area suggestions (links only, no booking)
- Travel logistics awareness: fly vs drive, realistic arrival/departure times factored
  into day 1 and last day

### What changes in the data model

New columns on `itineraries` table (all additive, no breaking changes):
- `travel_mode` (enum: local / travel) — default local
- `location_preference` (enum: closer_to_organizer / closer_to_attendee / system_choice /
  destination)
- `destination` (text, nullable) — populated when organizer specifies or system suggests
- `trip_duration_days` (int, default 1)

Suggestions JSONB gains day grouping for multi-day trips:
```
{
  "days": [
    { "day": 1, "label": "Arrival day", "stops": [ { venue, address, duration_min, notes } ] },
    { "day": 2, "label": "Main day", "stops": [ ... ] }
  ]
}
```
Single-day itineraries use a one-entry days array — consistent schema regardless of length.

### What changes in the Claude prompt

- Local / closer_to_organizer: anchor Places API to organizer's location
- Local / closer_to_attendee: anchor to attendee's location
- Local / system_choice: use midpoint, let Claude reason about best area
- Travel / destination chosen: anchor to destination city, prompt includes travel context
- Travel / somewhere_new: two-step — first prompt asks Claude for 3 destination options with
  rationale; organizer picks one; second prompt generates full multi-day itinerary

### Geographic containment rule (critical for multi-day itineraries)

Without an explicit constraint, Claude will treat each day as an opportunity to suggest
a new area — producing itineraries that bounce between cities. "Day 1: Buffalo, Day 2:
drive down to NYC" is geographically coherent to Claude but logistically absurd for a
weekend trip. This must be prevented at the prompt level.

**Rule: all stops across all days must stay within a single coherent geographic region.**

The region is determined once at generation time and locked in. Claude must not change
cities or metro areas between days.

- 1-day / weekend trips: all stops within one city and its immediate surroundings (~30 miles)
- "Longer" trips: one home base city with optional day trips that return to base — never
  treat a day trip destination as a new home base for subsequent days
- Day 1 (arrival) and last day (departure): realistic logistics — no full-day activity
  schedules on travel days unless the destination is driveable

**Prompt injection for all travel mode itineraries:**
```
GEOGRAPHIC CONSTRAINT (strictly enforced):
All stops across all days must remain within a single city or metro region.
Do NOT suggest travel between different cities on different days.
Home base for this trip: [destination ?? organizer city ?? attendee city].
Day trips must return to the home base — never treat a day trip as a pivot
to a new region for subsequent days.
A "Weekend" trip means 2 days in one place, not a multi-city tour.
```

**Null destination fallback:**
If travel_mode is 'travel' but destination is null, fall back to the organizer's profile
location as the geographic anchor. This prevents Claude from choosing its own arbitrary
anchor, which is the root cause of city-hopping itineraries. The "Somewhere new" 2-step
flow (step 6b, deferred) is the proper long-term fix — it forces explicit destination
selection before generation begins, eliminating this case entirely.

### What changes in the UI

NewEvent flow gets a new step after date/time:
1. "Where should you meet?" toggle: Local | Travel
2. Local → 3-button selector (Closer to me / Closer to them / Up to the system)
3. Travel → same selector + duration picker (1 day / Weekend / Longer)
4. "Somewhere new" triggers destination suggestion step before itinerary generation

ItineraryView gets day-grouped rendering for multi-day trips.

### Implementation sequencing

1. Add `location_preference` to itineraries table — minimal risk migration
2. Add `travel_mode` and `trip_duration_days`
3. Update NewEvent UI — toggle and submenu
4. Update `buildSuggestPrompt` to consume `location_preference` and anchor Places API
5. Build multi-day JSONB structure + ItineraryView day-group rendering
6. Build proactive destination suggestion (2-step flow) — most complex, do last

Steps 1–4 ship together as a cohesive local mode improvement.
Steps 5–6 are travel mode proper and ship as a follow-on.

---

## Group scheduling
Added: March 13, 2026

Group scheduling is a meaningful scope expansion beyond 1:1. The core complexity is
not technical — it's UX. Finding mutual availability across 8 people, and generating
suggestions that work for a group with established context, requires a different mental
model than two-person scheduling.

### Groups as a first-class object

Users should be able to create named groups, invite members, and reuse them across
events. A group carries persistent context that informs itinerary generation:

- **Group name** — e.g. "Book Club", "D&D Crew", "Work Lunches"
- **Group description / default prompt** — free text describing what this group
  typically does. This is the key differentiator:
  - Book club: "We meet at a bar to discuss the current book and have drinks"
  - D&D: "We play Dungeons and Dragons, usually at someone's place or online"
  - Hiking crew: "We do a hike then grab food or drinks after"
  This description injects directly into the Claude prompt as high-signal context,
  replacing or supplementing the organizer's one-off context prompt.
- **Members** — list of user IDs; each member must be a Rendezvous user
- **Join/leave** — members can leave groups; organizer can add/remove members
- **Activity history** — past accepted group itineraries feed back as taste signal,
  same as the 1:1 accepted history pattern

### Meeting modes

Groups need flexible meeting modes since not all groups always meet in person:

| Mode | Use case | Suggestion behavior |
|---|---|---|
| In-person | Book club, hiking, brunch | Normal venue-based itinerary |
| At someone's home | D&D, game night, potluck | Home-based suggestions, rotating host logic |
| Digital / online | Remote groups, gaming | No venue needed — suggest activity + platform |
| Hybrid | Mixed preference groups | One suggestion per mode |

The group description should be the primary signal for defaulting the mode, but
the organizer can override per-event.

### Availability logic changes

1:1 freebusy logic finds one pair's mutual windows. Group scheduling must:
- Fetch freebusy for N members concurrently
- Find windows where ALL members are free (strict) OR where a quorum is free
  (configurable — "at least 6 of 8")
- Surface conflicts clearly: "3 members are busy Saturday afternoon"
- Consider group size when sizing venue suggestions (a bar for 8 needs a reservation)

### Data model additions

New tables:

**groups**
- id, name, description (the default prompt), created_by, avatar_url, created_at

**group_members**
- id, group_id, user_id, role (admin / member), joined_at, status (active / left)
  -- NOTE: role = 'admin' is the group manager (creator or promoted member), not the event organizer.
  -- Event organizer is tracked via group_itineraries.organizer_id. These are distinct concepts.
- RLS: members can view their own groups; organizer can add/remove members

**group_itineraries** (or extend itineraries table)
- Extend itineraries to support group_id in addition to organizer_id / attendee_id
- attendee_statuses: JSONB map of user_id → status (pending/accepted/declined)
- Lock condition: all active members accepted (or quorum threshold met)

### UI additions

- Groups tab in the app (alongside Friends)
- "Create group" flow: name, description, invite members by username
- Group detail page: members list, past itineraries, edit description
- Create event from group: same flow as 1:1 but with group context pre-loaded
- Per-event override: organizer can edit the default group prompt before generating
- Group member status on itinerary: show who has accepted/declined

### Claude prompt changes

When generating for a group:
- Inject group name + description as the primary context block
- Inject group size so Claude can reason about venue capacity
- Inject past group itinerary history (same pattern as 1:1 pair history)
- For home-based groups: inject rotating host logic if known (store last_host on group)
- For digital groups: suppress venue suggestions entirely, focus on activity + tools

### Implementation sequencing

1. DB schema: groups + group_members tables with RLS
2. Groups UI: create, invite, join/leave
3. Group event creation: availability logic for N members
4. Claude prompt: group context injection
5. Group itinerary UI: multi-member status tracking
6. Lock logic: quorum vs all-members threshold (configurable per group)

### What stays the same

- Venue enrichment, activity detection, live events — all apply to groups unchanged
- Calendar event creation fires once locked, same trigger pattern as 1:1
- Re-roll and negotiation logic — same state machine, extended to N members

---

## Cultural moment scheduling
Added: March 2026

### Core idea

When a user's context prompt references a specific cultural event — a game, a TV premiere,
the Oscars, a concert, a movie opening — the itinerary should be anchored to when that
event actually happens. "Watch the Knicks" shouldn't suggest a random Tuesday. It should
find the next Knicks home game in the user's date window and build the plan around tip-off.

This applies across all cultural event types, not just sports:

| Signal in context prompt | Event type | Anchor logic |
|---|---|---|
| "watch the Knicks / Yankees / Mets" | Sports game | Game date + time; anchor itinerary start 2 hrs before |
| "watch the game" + sport inferred from profile | Sports game | Same, infer team from preferences |
| "Oscars / Emmys / Grammys" | Award show | Broadcast date/time (annual, predictable) |
| "new episode of [show]" / "season premiere" | TV | Air date + network from TV API |
| "the new [movie] is out" | Film | Release date from movie API |
| "see [artist] in concert" | Live music | Ticketmaster / SeatGeek show date (already partially covered by events.js) |
| "Mets opening day" / "Super Bowl" / "playoffs" | Major sports event | Specific date from sports schedule API |

### Why this matters

This is a meaningful product differentiator. The scenario "we both want to watch the Knicks
game" is extremely common, and right now the itinerary engine ignores the actual game schedule
entirely. Anchoring suggestions to real event dates makes the product feel genuinely
intelligent rather than just well-prompted.

The "Live" badge is the visible signal to users that this isn't a generic suggestion —
it's been matched to a real event. That increases trust in the recommendation.

### Detection layer

New helper: `extractCulturalSignal(contextPrompt, activityPreferences)`

Returns: `{ type: 'sports' | 'tv' | 'film' | 'awards' | 'concert' | null, entity: string | null }`

Examples:
- "watch the Knicks game" → `{ type: 'sports', entity: 'knicks' }`
- "the new Severance episode drops" → `{ type: 'tv', entity: 'Severance' }`
- "go see Mission Impossible" → `{ type: 'film', entity: 'Mission Impossible' }`
- "Oscars watch party" → `{ type: 'awards', entity: 'Oscars' }`
- Falls back to null if no signal detected — no behavior change

This runs alongside the existing `classifyIntent()` and `extractActivityType()` — not a
replacement, an additional layer.

### Data sources by event type

**Sports schedules**
- Primary: ESPN unofficial API (no key required, well-documented, returns JSON schedules)
- Secondary: the-sports-db.com (free tier, clean schema)
- Ticketmaster Discovery API already wired in events.js — also returns sports events
  with specific game dates. Use as a third signal for cross-validation.
- Coverage: NBA, MLB, NFL, NHL, MLS — all major US leagues
- New utility function: `fetchSportsSchedule(team, dateRangeStart, dateRangeEnd)`
  Returns: array of `{ date, time, opponent, venue, home_or_away }` sorted by date

**TV premiere dates**
- The Movie Database (TMDB) — free API, covers premiere dates, episode air dates,
  season information. Register at themoviedb.org/settings/api.
- Store as `TMDB_API_KEY` in server/.env
- New function: `fetchTVAirDate(showName, dateRangeStart, dateRangeEnd)`
  Returns: `{ episode_title, air_date, season, episode_number, network }` or null

**Film release dates**
- TMDB covers movies too — same API key
- New function: `fetchMovieRelease(movieTitle)` → `{ release_date, title, confirmed }`
- Wide releases are reliable; limited releases less so — flag confidence level

**Award shows**
- Known annual dates — can be hardcoded with yearly update rather than API-dependent:
  Oscars (March), Grammys (February), Emmys (September), Golden Globes (January)
- Simple lookup table in a constants file, updated annually
- No API needed for MVP

**Concerts**
- Already covered by Ticketmaster Discovery API in events.js
- `extractCulturalSignal` detects artist names and routes to existing events.js logic

### Scheduling anchor logic

When a cultural signal is detected and a matching event is found within the date range:

1. **Hard preference, not hard gate** — prioritize dates with the event, but do not fail
   if no event falls in the date window. Fall back to normal generation silently.
2. **Tip-off / air time anchoring** — for sports and TV, start the itinerary 1.5–2 hours
   before the event. Enough time for pre-game food + drinks. For films, anchor to showtime.
3. **Inject into Claude prompt as a PRIORITY EVENT block** — higher priority than the
   general events block already in `buildSuggestPrompt`:

```
PRIORITY EVENT (anchor this itinerary to this specific date and time):
- Knicks vs. Celtics @ Madison Square Garden — Saturday March 15, 7:30 PM tip-off
  Suggested start: 5:30–6 PM (bar or restaurant near MSG before the game)
  This event was detected from the context prompt. At least one suggestion should
  be structured around attending or watching this game.
```

4. **Soft mode for "watching" vs "attending"** — "watch the Knicks" could mean going to
   MSG or watching at a bar. Default: suggest both if tickets aren't confirmed. Claude
   determines venue type from context. If the user said "go to the Knicks game" vs
   "watch the Knicks" — treat differently.

### "Live" badge

Any suggestion anchored to a real cultural event gets a 🔴 **Live** badge in ItineraryView.

Badge format: `🔴 Live · Knicks tip-off 7:30 PM` or `🔴 Live · Oscars start 8 PM ET`

Same rendering pattern as the existing 🎟 Ticketmaster badge and 🎾 activity badge.
`event_source` JSONB field extended to include: `sports_schedule | tv_premiere | film_release |
awards | concert` (concert already covered by ticketmaster).

### Privacy

- Only team names, show titles, and movie names sent to external APIs — no user data
- API keys (TMDB, ESPN if needed) in server/.env only
- Same best-effort / graceful-fail pattern as events.js — never blocks suggestion generation

### Telemetry additions

Extend `suggestion_telemetry` JSONB on itineraries:
- `cultural_signal_detected` (string | null) — e.g. `'knicks'`, `'Severance'`, `'Oscars'`
- `cultural_signal_type` (string | null) — e.g. `'sports'`, `'tv'`, `'film'`, `'awards'`
- `cultural_event_found` (bool) — whether an event was found in the date window
- `cultural_anchor_used` (bool) — whether a suggestion was actually anchored to it

### Implementation sequencing

1. Build `extractCulturalSignal()` helper — detection only, no API calls yet
2. Add sports schedule fetch (`fetchSportsSchedule`) using ESPN unofficial API — covers the
   highest-frequency use case (NBA, MLB, NFL) with no API key requirement
3. Wire into `buildSuggestPrompt` — PRIORITY EVENT block injection
4. Add 🔴 Live badge to ItineraryView (same pattern as existing badges)
5. Add telemetry fields
6. Add TMDB integration for TV + film — requires API key registration
7. Add awards show constants file (Oscars, Grammys, Emmys, Golden Globes dates)

Steps 1–5 are the high-value MVP. Steps 6–7 are additive.

### What this is NOT

- Not a real-time odds, score, or standings system — only schedule data
- Not automatic — requires the user's context prompt to reference an event
- Not a gate — never blocks generation if no event is found

---

## Timezone localization
Added: March 12, 2026

Required when travel mode ships. Two users in different timezones creates ambiguity in
availability windows, suggested meeting times, and calendar event creation.

### Core problem

All scheduling logic currently assumes both users share a timezone. A user in NYC and a
friend in LA have a 3-hour offset — "evening" means different things, and a calendar
event must be created with the correct local time for each user.

### What needs to change

- Store `timezone` on `profiles` (column already exists — confirm it's being populated)
- All availability queries against Google Calendar API must request events in each user's
  respective timezone — not UTC, not a single shared timezone
- Overlap detection must normalize both calendars to UTC before finding mutual free windows,
  then convert suggested times back to each user's local timezone before display
- Claude prompt should receive timezone-aware time windows (e.g., "7pm–10pm ET / 4pm–7pm PT")
  so suggestions reflect actual local experience
- Calendar event creation must set the correct `timeZone` field per attendee in the Google
  Calendar API call
- UI should display times in the viewing user's local timezone with an optional "their time"
  annotation (e.g., "7:00pm your time / 4:00pm their time")

### Edge cases to handle

- Users who travel and have stale timezone on profile — consider pulling timezone from
  Google Calendar API's calendar object, which reflects current device timezone
- DST transitions during a multi-day trip window — use IANA timezone identifiers throughout,
  never raw UTC offsets
- "Any" time of day selection — define sensible local-time bounds per user rather than a
  single global window

### Implementation sequencing

1. Audit current timezone handling — confirm `profiles.timezone` is populated on OAuth login
2. Update availability query to normalize to UTC, surface results in local time
3. Update Claude prompt to include both users' timezone-aware windows
4. Update calendar event creation to use per-user `timeZone` field
5. Update UI to show times in viewer's local timezone with "their time" annotation

---

## Group mode — availability badges on itinerary tiles
Added: March 14, 2026

### What it is

Each itinerary suggestion tile shows per-member availability during the suggested time slot.
Each group member gets a small indicator: checkmark if free, X if conflicted. This gives the
organizer and attendees a quick read on who can make a given option work without anyone having
to manually cross-reference calendars.

### Data shape

At suggestion generation time, the suggest route already fires freebusy calls per member to
find mutual windows. The availability result for each suggestion's time slot should be stored
directly on the suggestion object inside the `suggestions` JSONB column, alongside venue data.

Proposed shape per suggestion:
```json
{
  "venues": [...],
  "days": [...],
  "time_slot": { "start": "...", "end": "..." },
  "member_availability": [
    { "user_id": "uuid", "display_name": "Aaron", "available": true },
    { "user_id": "uuid", "display_name": "Jacob", "available": true },
    { "user_id": "uuid", "display_name": "Harrison", "available": false },
    { "user_id": "uuid", "display_name": "George", "available": false }
  ],
  "availability_checked_at": "2026-03-14T18:00:00Z"
}
```

This is a snapshot — no live sync. The `availability_checked_at` timestamp drives the
"as of" note in the UI.

### Refresh button

A "Refresh availability" button appears on each suggestion tile (not the whole itinerary view).
Clicking it re-fires freebusy calls for that suggestion's time slot only — no reroll, no
Claude call, no venue changes. Result updates `member_availability` and `availability_checked_at`
on that suggestion in the DB.

**Rate limit:** Once per hour per itinerary. Enforced server-side. Store `availability_last_refreshed_at`
on the itinerary row (or per-suggestion in JSONB — confirm during implementation).

**Post-lock behavior:** Refresh button is hidden once `locked_at` is set. Availability is
irrelevant after both parties have accepted and the event is locked.

### "As of" note

Each tile shows: "Availability as of [relative time, e.g. '2 hours ago']" — derived from
`availability_checked_at`. Updates in real time as the timestamp ages without a page reload.

### On reroll

When a single card is rerolled, the new suggestion's time slot differs from the old one.
Availability badges must be re-fetched for the new time slot as part of the reroll response —
not lazily loaded after. The reroll route fires freebusy for the new slot before returning.

### UI placement

Badges render as a compact horizontal row of avatar initials + icon below the venue list on
each tile. Keep it minimal — not a table, just a quick glance indicator.

### Implementation sequencing

1. Update `buildSuggestPrompt` response schema and suggest route to compute + store
   `member_availability` per suggestion at generation time
2. Add `availability_last_refreshed_at` to itineraries table (migration)
3. Add `/itineraries/:id/refresh-availability` POST route — rate-limited to 1/hr
4. Update ItineraryView to render availability badges per tile
5. Wire refresh button with rate limit feedback (disabled state + "Refresh available in Xm")
6. Update reroll route to re-fetch availability for the new suggestion's time slot
7. Hide refresh button when `locked_at` is set

---

## Group mode — tie-breaking rule
Added: March 14, 2026

### The problem

Even-numbered groups (4, 6, 8 members) can hit a tie when votes on a suggestion are split
50/50. With threshold-based quorum, this is a real edge case that needs a defined resolution
— not a silent failure or an ambiguous locked state.

### Organizer toggle at event creation

During group event setup, the organizer selects a tie-breaking rule. Two options:

- **Schedule on tie** (default): If votes are tied and quorum is otherwise met, the event
  locks in favor of scheduling. Optimizes for the group actually doing something.
- **Decline on tie**: If votes are tied, the suggestion is not locked. Falls back to
  awaiting more responses or triggering a reroll prompt to the organizer.

The selected rule is stored on the itinerary row (`tie_behavior`: `schedule` | `decline`).
The lock trigger reads `tie_behavior` when evaluating whether a tied vote count meets the
quorum threshold.

### Cost/overhead

One extra column, minor trigger logic change. No external API implications. This is purely
DB and state machine logic.

### Default recommendation

Default to "schedule on tie" — the worst outcome for a social scheduling app is paralysis,
not a slightly suboptimal plan. Users can override if their group dynamic calls for it.

---

## Group mode — per-tile comment threads
Added: March 14, 2026

### What it is

Each itinerary suggestion tile has a comment sidebar. Any group member can leave a note on
a specific tile — "I've been to this place, the food is great", "the timing doesn't work for
me", or a reroll request directed at the organizer. All members can read all comments.

This replaces the need for out-of-band texting about itinerary options, which is the actual
UX problem: group members currently have no structured way to give feedback without forcing
a full reroll.

### Data shape

Comments are stored in a `group_comments` table (not embedded in the JSONB). This keeps
the itineraries JSONB from growing unbounded and makes comment queries efficient.

Proposed schema:
```
group_comments
  id              uuid primary key
  itinerary_id    uuid references group_itineraries(id)
  suggestion_index int  -- which tile (0, 1, 2...)
  user_id         uuid references profiles(id)
  body            text
  created_at      timestamptz default now()
```

RLS: users can read comments on itineraries they are a member of. Users can insert their
own comments. Users cannot delete or edit others' comments (read-only after submit).

### Refresh and persistence

Comments persist in the DB for the lifetime of the itinerary. The comment sidebar polls
or fetches on open — no real-time websocket needed for v1. A simple "load comments" fetch
on sidebar open is sufficient.

**Soft cap:** If a suggestion tile accumulates more than 50 comments, collapse older ones
behind a "show older comments" toggle rather than loading all at once. This prevents UI
bloat for active groups.

### Privacy and data retention

Comments are not fed into user preference signals or behavioral data. They are not used
for AI training, itinerary improvement, or cross-user analytics. They exist solely to
facilitate coordination within a specific event.

When an itinerary is deleted or expires, associated comments are hard-deleted via cascade.
No archival. This is the privacy-correct default — don't retain coordination data longer
than the event it belongs to.

**Do not log comment content in telemetry.** Log only: comment_added (itinerary_id,
suggestion_index, user_id) — enough to know the feature is used, nothing about what was said.

### Bloat mitigation

- 50 comment soft cap per tile with pagination
- No threading or replies in v1 — flat list only
- No rich text, attachments, or reactions in v1
- Hard-delete on itinerary expiry/deletion

### Cost/overhead

One additional table. Comment fetches are lightweight reads — no Claude calls, no Maps
calls. At scale, this is among the cheapest features in the app. The main cost risk is
if comments are naively loaded on every page render rather than only when the sidebar is
opened — make sure fetch is lazy.

### Implementation sequencing

1. Create `group_comments` table with RLS (migration)
2. Add GET `/itineraries/:id/suggestions/:index/comments` route
3. Add POST `/itineraries/:id/suggestions/:index/comments` route
4. Build comment sidebar UI component — lazy load on open
5. Add 50-comment soft cap with "show older" pagination
6. Wire telemetry: `comment_added` event (no body content)
7. Add cascade delete on itinerary deletion

---

## Group mode — group formation
Added: March 14, 2026

### Core question

Do users create a named group first and then create an event from it? Or do they assemble
members inline during event creation? The answer shapes the DB schema, the nav structure,
and the re-use story.

### Two entry points, same underlying data model

Users can create a group in either of two ways — both produce the same `groups` +
`group_members` records and both support the same re-use story.

**Path A: Standalone group creation (Groups tab / section)**
- User navigates to a dedicated Groups section in the app nav
- Taps "New Group", gives it a name, searches for friends to add (same username search
  as existing friend flow)
- Group is saved immediately with no event attached
- From the group detail view, the user can tap "Plan an event" to jump into New Event
  with the member list pre-filled

**Path B: Inline creation during event setup (New Event screen)**
- During new event setup, the organizer searches for friends and adds them one at a time
- After confirming the member list, the organizer sees a toggle: **"Save this group for
  later"** with an optional name field (e.g., "Tennis crew", "Book club")
- If saved, a `groups` record is created and linked. If not, the event proceeds with an
  ephemeral member list and no `groups` record is created.

Both paths converge on the same schema — there is no "group event without a groups record"
distinction in the DB. Path B without saving is just an itinerary with a populated
`attendee_statuses` JSONB and no linked `group_id`.

### Group re-use

Saved groups appear in a "Groups" section on the New Event screen (or a dedicated Groups
tab). Selecting a saved group pre-fills the member list. The organizer can add or remove
members before confirming — the saved group is a template, not a locked list.

### Mid-planning membership changes

**Before lock:** The organizer can add or remove members at any time before the itinerary
is locked. Adding a new member resets their `attendee_statuses` entry to `pending`. Removing
a member removes their entry and re-evaluates quorum. This should re-run quorum check
immediately and notify all remaining members of the change.

**After lock:** No membership changes. The event is locked and the calendar invite is set.
Any post-lock changes are a changelog entry and a manual coordination problem.

### Leaving a group (saved groups)

Any member can leave a saved group at any time from the group's settings. Leaving a saved
group does not affect in-progress events that group was used to create — those events have
their own independent member lists. The group record is soft-deleted (hidden from the
leaving user) not hard-deleted, since other members still have it in their group lists.

### Knowing which groups you're in

A "Groups" view shows all saved groups the user is a member of, with member avatars and
the last event created from the group. This is a passive discovery surface — users don't
need to check it, but it's there. Notification when added to a group: "Aaron added you to
Tennis crew."

### DB shape

```
groups
  id           uuid primary key
  name         text
  created_by   uuid references profiles(id)
  created_at   timestamptz default now()

group_members
  group_id     uuid references groups(id)
  user_id      uuid references profiles(id)
  joined_at    timestamptz default now()
  left_at      timestamptz  -- null if still active
  primary key (group_id, user_id)
```

RLS: users can see groups they are members of (left_at is null). Users can see group_members
rows for their own groups. The creating user (created_by) can add/remove members.

### Cost/overhead

Two small tables. Group fetches are simple lookups — no external API calls. The main cost
consideration is notification volume when members are added: one push notification per
added member, which is negligible. No ongoing cost implications.

### What's NOT in v1

- Group admins or co-organizers (organizer is always the event creator)
- Group-level chat (separate from per-tile comments)
- Group invite links
- Public or discoverable groups

### Implementation sequencing

1. Create `groups` and `group_members` tables with RLS (migration)
2. Update NewEvent UI to support multi-member selection with inline search
3. Add "Save this group" toggle at confirmation step
4. Add Groups view / section to surface saved groups
5. Wire group selection to pre-fill member list in NewEvent
6. Add mid-planning member add/remove (pre-lock only)
7. Add leave group flow from group settings
8. Notification: "X added you to [group name]"

---

## Notifications system
Added: March 14, 2026

### Two tiers of notifications

**Tier 1 — Action required (web push + in-product notification center)**
These are notifications that require the user to do something. They are the highest-priority
and warrant interrupting the user outside the app via web push. Examples:
- Friend request received
- Group invitation received
- Event invite: "You've been invited to a plan — waiting on you"
- Plan locked: "This plan is locked in — add it to your calendar"
- Nudge: organizer-set or default reminder that a response is overdue

**Tier 2 — Informational updates (in-product notification center only)**
These are status updates that are useful but don't require action. They live in the
in-product notification center and do not trigger web push. Examples:
- "Harrison and George voted on Saturday Night Plan"
- "Alex updated the group description for Tennis Crew"
- "Morgan left the D&D Group"

**Rationale:** Push fatigue is a real product risk. Blasting every group activity as
a web push will cause users to disable notifications entirely, which breaks the action-required
flow. Keeping Tier 2 in-app only preserves the signal value of push for things that matter.

### Notification settings page

Users can control their notification preferences from a dedicated settings page. Minimum
controls for v1:
- Web push: on/off toggle (with browser permission prompt on first enable)
- Per-type overrides: allow users to opt out of specific Tier 1 categories if desired

Email notifications are out of scope for v1. Flag as future state.

### Delivery infrastructure

Web push via the Web Push API (VAPID keys). `push_subscriptions` table stores subscriptions
per user (already specced in onboarding flow). Server sends push via `web-push` npm package.

In-product notification center: `notifications` table in Supabase. Fetched on app load and
on relevant actions. No websocket required for v1 — polling on focus is sufficient.

Proposed `notifications` table:
```
notifications
  id           uuid primary key
  user_id      uuid references profiles(id)
  type         text  -- e.g. 'friend_request', 'event_invite', 'plan_locked', 'nudge', 'group_invite'
  tier         int   -- 1 = action required, 2 = informational
  title        text
  body         text
  data         jsonb -- payload (e.g. itinerary_id, group_id, friend_id)
  read_at      timestamptz
  created_at   timestamptz default now()
```

RLS: users can only read and update their own notifications. No cross-user visibility.

### Cost/overhead

Web push is free (VAPID). The `web-push` npm package handles signing. The main cost risk is
volume — for a group of 15 with high activity, Tier 2 in-product notifications could accumulate
fast. Add a retention policy: auto-delete read Tier 2 notifications after 30 days and unread
ones after 90. This keeps the table lean.

---

## Nudges (updated for group mode)
Added: March 14, 2026

Nudges are action-required notifications triggered when an event has been sitting without a
response for too long. They map to Tier 1 in the notifications system.

### Organizer-configurable nudge window

When creating an event, the organizer can set how long the event can sit before non-responding
members are nudged. Default: 48 hours. Options: 24h / 48h (default) / 72h / 1 week.

The nudge window is stored on the itinerary row (`nudge_after_hours`, default 48). The
`nudges` table already exists in the schema with `expires_at` auto-set to `created_at + 7 days`.

### Non-response behavior by group size

**Small groups (≤3 members):** Non-response after the nudge window is treated as a decline.
The event state reflects this — quorum is evaluated as if they declined.

**Larger groups (4+ members):** Non-response after the nudge window is treated as an
abstention. The member's slot in `attendee_statuses` is updated to `abstained` (new status
value alongside pending/accepted/declined). Quorum is evaluated over responding members only
— abstentions neither help nor hurt the count.

This distinction matters: in a small group, one ghost can block everyone. In a larger group,
one ghost shouldn't derail the whole event.

### Event lifecycle and data retention

**Events are soft-removed from the UI after their end date, not hard-deleted from the DB.**

Rationale:
- Past itineraries are a key input to `fetchAcceptedPairHistory` — the behavioral signal
  that improves future suggestions for pairs who have planned together before
- Hard-deleting removes this signal permanently
- Users deserve access to past plans (activity history view is a future feature)

Soft removal: add `archived_at` timestamptz to `group_itineraries` (and backfill on
`itineraries`). Events where `date_range_end < now()` AND `archived_at IS NULL` are
auto-archived by a scheduled job or trigger. Archived events are excluded from the active
events UI but remain in the DB and queryable for history/signals.

**Hard delete only on explicit user deletion (account deletion or manual event deletion).
Cascade-delete all associated records (comments, nudges, notifications, changelog).**

### Cost/overhead

Nudge evaluation requires a background job or DB trigger to check `nudge_after_hours` vs
elapsed time. In-memory timers won't survive server restarts. The right v1 approach is a
lightweight cron job on Supabase (pg_cron, available on free tier) or a Vercel cron function
that runs every hour and fires nudges for overdue itineraries. Vercel cron is free on the
hobby plan and requires no additional infrastructure.

---

## Account deletion and data portability
Added: March 14, 2026

### Why this matters now

GDPR Article 17 (right to erasure) and App Store requirements (both Apple and Google) require
that apps provide users with a way to delete their account and all associated data. This must
be in place before any public distribution — including TestFlight and Play Store open testing.

This is not optional and should be scoped into Audit 3 / pre-real-users work.

### What "delete my account" must do

A single user-initiated action that:
1. Revokes and deletes all Google OAuth tokens (`google_tokens` table)
2. Deletes or anonymizes all user-generated content:
   - Profile row (hard delete)
   - Friend relationships in both directions (`friendships`)
   - Friend annotations (`friend_annotations`)
   - Group memberships (`group_members`) — sets `left_at` if group persists for others
   - Comments (`group_comments`)
   - Nudges sent/received
   - Notifications
   - Push subscriptions
3. Itinerary handling: if the user is the organizer of an active (unlocked) itinerary,
   cancel it and notify attendees. If they are an attendee, remove their status entry
   and re-evaluate quorum. Locked itineraries: soft-delete the user's copy, retain the
   record for the other party's history.
4. PostHog: call `posthog.reset()` to disassociate the device. Do not make a deletion
   API call to PostHog in v1 (event data is anonymous by supabaseId anyway).
5. Revoke the active session token.
6. Send a confirmation email (future state — note for when email is wired).

### UI placement

Account deletion lives in Settings → Account → "Delete my account". Require a confirmation
step ("Type DELETE to confirm") before executing — this is irreversible.

### Data portability (future state)

GDPR also includes a right to data portability (Article 20). Not required for v1, but flag
for v2: a "Download my data" export that returns a JSON file of the user's profile,
preferences, and past itineraries. Note in ROADMAP.md.

### Cost/overhead

This is a single cascading delete operation triggered by the user. The main engineering cost
is ensuring every table's cascade behavior is correctly defined in the schema — most are
already covered by FK constraints. The delete route itself is low cost and fires rarely.
The risk is an incomplete delete that leaves orphaned data — this must be audited in Audit 3.

---

## Groups tab and group onboarding
Added: March 14, 2026

### Navigation placement

Groups gets a dedicated tab in the main app nav, alongside Home, Friends, and Events.
The tab contains:
- List of groups the user is a member of (avatar grid, group name, member count, last event)
- "+ Create Group" button in the top right

### Group creation flow (from Groups tab)

1. Name the group (required)
2. Add members via username search (same search as friend flow) — minimum 2 members
3. Add a group description / prompt context (optional but surfaced prominently — this
   is the primary AI signal for group itineraries)
4. Confirm and create — all added members receive a group invitation notification (Tier 1)

Members must accept the invitation before they appear as active group members. Pending
invitations show as "Awaiting [name]" in the group member list.

### First-time group creation onboarding

On a user's first group creation, show a brief onboarding overlay (3 steps max):
1. "Groups let you plan with your crew — add anyone you want to meet up with regularly"
2. "The group description helps our AI suggest plans your whole group will love"
3. "Everyone needs to accept before they're in — invites expire after 7 days"

Dismiss and don't show again (store `group_onboarding_seen_at` on the profile row or in
localStorage — confirm approach during implementation).

### Admin model

One admin per group: the creator. Admin can:
- Edit group name, description, and prompt context
- Add and remove members
- Delete the group

Non-admin members can:
- View group details and member list
- Leave the group
- Initiate event planning from the group (any member can lead scheduling, even non-admins)
- This last point is important: group membership grants scheduling rights, not just the admin

### Future: multiple admins

Flagged as v2. The schema supports it (add `role` to `group_members`), but for v1 keep it
simple — one admin, clear ownership.

### Group invitation flow

Receiving a group invite surfaces as a Tier 1 notification: "Aaron invited you to Tennis Crew."
The notification links to a group invite detail view showing the group name, description,
current members, and Accept / Decline buttons. Invites expire after 7 days (consistent with
the existing nudges `expires_at` pattern).

### Cost/overhead

The Groups tab is a straightforward read from `groups` + `group_members` — cheap queries.
Group invitations add one notification row per invited member (covered by the notifications
system above). No external API calls. The main complexity is the invitation state machine,
which is a simple `status` column on `group_members` (pending / active / declined / left).


### Group size cap

Maximum 15 members per group. This cap applies to both saved groups and ad-hoc event
member lists. Enforced server-side on group creation and member addition.

Surface the cap in the UI with a note during group creation: "Groups support up to 15 members."
Do not surface the cap as an error — prevent the add action from firing once the limit is hit.

**Internal note (not user-facing):** The 15-member cap is a cost and complexity ceiling,
not a hard technical limit. Increasing it is a candidate for a paid tier in future. See
MONETIZATION.md. When/if a paid tier is introduced, this cap and the associated freebusy
call budget should be re-evaluated together.

---

## Nudge behavior (updated)
Added: March 14, 2026

### Cadence

Nudges fire daily — not once. A member who hasn't responded gets a daily Tier 1 nudge
until they respond or the event expires. The daily cron job (Vercel cron, hourly run)
checks for itineraries where:
- `locked_at` IS NULL (not yet locked)
- `date_range_end` > now() (event hasn't passed)
- At least one member has `attendee_statuses[user_id] = 'pending'`
- Last nudge for that user on that itinerary was sent > 24 hours ago

**Critical: only nudge members who still need to act.** Members with `accepted`,
`declined`, or `abstained` status must never receive nudges for that itinerary.
This is not optional — nudging someone who already responded is a trust-destroying UX
failure. Enforce this check in the nudge evaluation query, not application logic.

### Nudge window (organizer-configurable)

Organizer sets how long before nudges begin: 24h / 48h (default) / 72h / 1 week.
Stored as `nudge_after_hours` on the itinerary row.

First nudge fires when `created_at + nudge_after_hours` has elapsed and the member
is still pending. Subsequent nudges fire daily after that.

---

## Onboarding telemetry
Added: March 14, 2026

Applies to ALL onboarding flows — new user onboarding, first group creation, and any
future onboarding steps added to the product.

### What to track

For each onboarding flow, instrument the following PostHog events:
- `onboarding_step_viewed` — fires when a step is rendered
  - Properties: `flow` (e.g. 'new_user', 'first_group'), `step` (int), `step_name` (string)
- `onboarding_step_completed` — fires when a step's primary action is taken
  - Same properties as above
- `onboarding_step_skipped` — fires when a skip link is used (only on skippable steps)
  - Same properties as above
- `onboarding_completed` — fires when the full flow finishes
  - Properties: `flow`, `steps_skipped` (int), `total_steps` (int)
- `onboarding_abandoned` — fires if the user navigates away mid-flow without completing
  - Properties: `flow`, `last_step_seen` (int)

### Privacy constraints

Same rules as all PostHog instrumentation:
- No PII in event properties — no email, name, location coordinates, dietary/mobility data
- `user_id` sent as `supabaseId` (UUID) only
- Step names should describe the UI step, not the user's input (e.g., `'location_permission'`
  not `'user_location_NYC'`)

### Why this matters

Onboarding drop-off data is among the highest-leverage product signal available early on.
Knowing which step loses users lets you reorder, simplify, or remove friction before
it compounds. PostHog's funnel analysis view handles this natively once the events are
instrumented correctly.

Add to Audit 3 scope: verify all onboarding flows have complete step telemetry before
real users are onboarded.

---

## Group mode — organizer draft review before sending
Added: March 14, 2026

### Behavior

When an organizer creates a group event, they see the generated itinerary suggestions
first — in draft state — before any group members are notified. This mirrors the existing
1:1 flow where the organizer picks a suggestion and sends it to the attendee.

**No member is notified until the organizer explicitly sends the itinerary.**

The organizer can:
- Review all suggestion tiles
- Reroll individual cards
- Edit the context prompt and regenerate
- Select a suggestion to send to the group

Once the organizer taps "Send to group", all members receive a Tier 1 notification:
"[Organizer] wants to plan something — waiting on you."

### State machine addition

Add `organizer_draft` as a status on `group_itineraries`. This is the initial state
when the itinerary is first created. Transition to `awaiting_responses` when the organizer
sends it. The lock trigger only evaluates quorum when status is `awaiting_responses` or
later — draft itineraries cannot accidentally lock.

Proposed status sequence:
`organizer_draft` → `awaiting_responses` → `locked` | `cancelled`

The existing `itinerary_status` view logic will need to be extended to cover
`group_itineraries` and include `organizer_draft` as a valid computed state.

### UI

Draft itineraries appear in the organizer's Events view with a "Draft — not sent yet" badge.
They do not appear in any other member's Events view until the organizer sends them.

### Cost/overhead

No additional API calls — suggestion generation happens at creation time regardless.
The only addition is the `organizer_draft` status and the "Send to group" action.
This is a state machine change, not a new feature with external dependencies.

---

## Notifications table migration strategy
Added: March 14, 2026

The `notifications` table already exists in production with a slightly different shape than
the group mode spec requires. This section defines how to evolve it safely.

### Current state (live in Supabase)
- `read` boolean (NOT NULL, default false) — used by existing unread count and bell logic
- `ref_id` uuid (nullable) — single foreign key reference, not flexible enough for group payloads
- Missing: `tier`, `data jsonb`, `read_at`

### Migration approach: additive, not destructive

Do NOT drop `read` or `ref_id`. Existing code reads them and removing either column requires
a full audit and coordinated code change. Instead:

1. Add `tier int NOT NULL DEFAULT 1` — all existing notifications are Tier 1 by default
2. Add `data jsonb` — flexible payload for group context (itinerary_id, group_id, etc.)
3. Add `read_at timestamptz` — new canonical read field

4. Add a trigger: when `read_at` is set, auto-set `read = true`. This keeps both fields
   in sync without touching any existing code that reads the `read` boolean.

5. Future cleanup (after group mode ships): audit all references to `read`, migrate them
   to `read_at IS NOT NULL`, then drop the `read` boolean and `ref_id` column in a
   subsequent migration. Document this as a known cleanup item.

### Why not migrate cleanly now

Dropping `read` before auditing all references risks breaking the unread count badge,
notification bell, and any polling logic that checks read state. The backward-compat
approach carries zero risk and the cleanup can happen in a low-pressure window.

---

## Group formation — smart group save suggestion (future state)
Added: March 14, 2026

After a user creates an ad-hoc event (no saved group) with the same set of friends
multiple times, the system can surface a gentle prompt: "It looks like you've scheduled
with Alex and Harrison a few times — would you like to save them as a group?"

This is a v2 feature. Implementation sketch for when it's ready:
- Query `group_itineraries` for recurring organizer + attendee_statuses combinations
  where no `group_id` is set
- Threshold: 3+ events with the same member set, no saved group → trigger suggestion
- Surface as a Tier 2 in-product notification (informational, not action-required)
- Tapping it pre-fills the group creation flow with those members
- Track `group_suggestion_dismissed` in PostHog so we can measure conversion

Do not build this during the group mode sprint. Note it here so the data model supports
it when ready — specifically, preserving `group_id` as nullable on `group_itineraries`
is what makes this possible.

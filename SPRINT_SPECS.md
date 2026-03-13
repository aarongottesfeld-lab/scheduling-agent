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
- id, group_id, user_id, role (organizer / member), joined_at, status (active / left)
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

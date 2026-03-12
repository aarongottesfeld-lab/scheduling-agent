# Rendezvous — Output Quality & Location Roadmap
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

- Filter by minimum threshold (4.2+ stars, 100+ reviews) before passing to Claude
- Pull `price_level` and pass to Claude — match vibe to budget implicitly
- Use `editorial_summary` from Places API (New) — much richer than name + address
- Prefer places with photos (signals active, real business)
- Consider pulling recent review summaries as a sentiment quality signal

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

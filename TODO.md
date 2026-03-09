# Rendezvous — TODO

---

## 🔴 In Progress / Next Up

- [ ] **Separate timing vs. activity reroll** — add two buttons per card: "Different time" and "Different vibe". Pass `rerollType: 'timing' | 'activity' | 'both'` to server. Server adjusts Claude prompt accordingly. (DECIDED: build now)
- [ ] **Iteration loop / turn-based flow** — add `current_turn` field (organizer | attendee) to itineraries. Attendee reroll flips turn back to organizer. Display logic ("waiting on you" vs "waiting on them") driven by current_turn, not just organizer_status.
- [ ] **Mutual planning mode** — `planning_mode: 'standard' | 'mutual'` checkbox in NewEvent labeled "Open to counterproposals?". In mutual mode: both see all suggestions, both can reroll non-selected cards, both must accept same card to lock.
- [ ] Google Calendar event creation when itinerary locks (both users get invite)

---

## 🟡 Feature Development

### Cost Estimates
- [ ] Add `cost` object to suggestion JSON schema: `{ min, max, per_person, currency, notes, breakdown: [] }`
- [ ] Each venue gets a per-person estimate (sourced from Claude knowledge of venue type/tier, Maps data, ticket APIs)
- [ ] Display cost range per card: "~$40–65/person" with expandable breakdown
- [ ] Mark all costs as estimated — no false precision
- [ ] **Trip mode costs**: when destination is outside user's city, add flight/train estimates (use Google Flights deep link + rough range), lodging estimates (Google Hotels / Booking.com API)
- [ ] Trip mode trigger: detect when itinerary neighborhood/destination is not in user's metro area

### Recommendation Quality
- [ ] **Variety injection in prompt** — current prompt pulls whatever Claude knows about popular spots. Add explicit instruction: "Include a mix of well-known venues, neighborhood gems, and unexpected options. Avoid defaulting to the most-reviewed spots on Google Maps. NYC has thousands of good options — don't weight toward highest-rated."
- [ ] **Session-level feedback loop** — pass declined suggestion titles and reroll feedback into subsequent Claude calls as context. Already partially wired via edit_history — make it explicit.
- [ ] **Cross-session learning** — on itinerary lock, background job updates both users' activity_clusters with accepted activity types/venues. Pull clusters at suggestion time and weight Claude prompt. (activity_clusters table already exists)
- [ ] Activity cluster caching — avoid re-clustering on every request

### Scheduling UI
- [ ] Validate `itineraryId` URL param before API calls in ItineraryView.js

### AI / Intelligence
- [ ] **Instruction override logic** — explicit activity in user prompt anchors the suggestion (overrides profile interests). Profile interests used only for adjacent planning.
- [ ] **Prompt intent classification** — distinguish: local hangout / day trip / overnight trip. Drives venue lookup vs. destination + lodging format.
- [ ] **Trip mode suggestions** — when prompt implies multi-day or travel, switch to destination + course/lodging/itinerary format
- [ ] Nudge generation logic — scan both users' calendars, call Claude, insert into nudges table

### Google Calendar
- [ ] Calendar write on itinerary lock — create event for both users
- [ ] Calendar privacy: already correct — fetchBusy uses freebusy.query (free/busy only, no event details). Document this.

---

## 🗺️ Roadmap

### MCP Server
> Build after core app is fully tested. End state: user says "Bobby and I want to go on a golf trip" → Claude responds with destination recommendations, how to get there, cost breakdown, surrounding activities, and option to create calendar invite with all details.

- [ ] MCP server — thin auth wrapper around existing API endpoints
- [ ] Tool: `resolve_friend(name)` — fuzzy first-name match → UUID. "Bobby" → Robert Chen
- [ ] Tool: `create_itinerary_proposal(friend, activity, date_range, context)`
- [ ] Tool: `list_pending_itineraries()` — "what plans do I have pending?"
- [ ] Tool: `get_itinerary(id)` — fetch status + suggestions
- [ ] Tool: `accept_itinerary(id)` / `decline_itinerary(id)`
- [ ] Tool: `get_cost_estimate(destination, activity, party_size, dates)` — surfaces before committing
- [ ] Tool: `book_or_deeplink(venue, party_size, datetime)` — Resy/GolfNow native or deep link fallback
- [ ] `conversation_context` parameter — Claude populates with relevant session context before calling tools. Injected into suggestion engine alongside structured profile data.
- [ ] **Context priority ordering**: explicit instruction > conversation context > shared profile interests > individual profile interests
- [ ] Profile update prompting — when Claude infers something meaningful from conversation, surface "want to save this to your Rendezvous profile?"
- [ ] MCP auth — token-based, scoped per user, revocable
- [ ] Register with Claude.ai as available MCP connector

- [ ] **Always-on agent** — background process (Supabase Edge Functions or cron) that: monitors nudge expiry, detects when friends haven't made plans, watches for calendar gaps, proactively surfaces suggestions. Writes to notifications table silently or interrupts user depending on threshold. nudges table already designed for this.
- [ ] **Prompt-triggered agent** — single conversation turn: user says "set up plans with Jamie for next weekend" → MCP tools called in sequence → itinerary proposed without opening the app
- [ ] Both agent modes share same MCP server/tools — different consumers, same interface

### Booking Integrations
- [ ] **Resy / OpenTable** — check availability, book or deep link
- [ ] **GolfNow** — tee time booking. "Bethpage Black has a 9am Saturday, want me to book for 2?"
- [ ] **Deep link fallback** — Fever, Eventbrite, Tock, ClassPass
- [ ] **Booking confirmation back-sync** — user confirms booking → triggers calendar write
- [ ] **Trip mode: lodging** — Google Hotels or Booking.com API

### Notifications
- [ ] Push notifications (PWA web push) — needed to close MCP loop. Bobby gets notified, responds, itinerary locks without opening app.
- [ ] Email fallback for notifications

### Other
- [ ] **SeatGeek** — live events (Knicks, Yankees, Broadway, concerts)
- [ ] **Group scheduling** — 3–5 people
- [ ] **Recurring events** — "monthly dinner club"
- [ ] Apple Calendar support

---

## 🟢 Deployment & Infrastructure

- [ ] Vercel deployment — connect GitHub repo, set env vars
- [ ] HTTP referrer restriction on Google Maps API key (needs Vercel URL)
- [ ] Tighten `notifications_service_role_all` RLS policy before Vercel deploy
- [ ] Switch in-memory session Map to Supabase persistence (survives server restarts)
- [ ] Switch OAuth handoff from URL params to HTTP-only cookies
- [ ] PWA configuration — manifest.json + service worker

---

## 🧪 Testing Needed

- [ ] Two separate invitations to same user (was failing with "Could not save itinerary" — fixed in this session, needs retest)
- [ ] Jamie reroll → buttons persist after reroll (fixed this session — verify)
- [ ] Aaron picks one → "Your pick — waiting on them" badge shows on selected card
- [ ] Calendar event details: title "Brooklyn Bowl with Jamie", address as location, proper end time
- [ ] Full lock → 🎉 banner → "Add to Calendar" with correct event details

---

## ✅ Completed

- [x] Project scaffolded: CRA frontend + Express backend
- [x] Git repo, .gitignore, all env vars configured
- [x] Supabase: all tables + RLS + triggers + migrations
- [x] Google OAuth credentials + calendar scopes
- [x] Google Maps API key, restricted to 4 APIs
- [x] All server routes wired and working
- [x] schedule.js — all 8 scheduling endpoints + AI suggestion engine
- [x] Notification inserts: friend request, itinerary invite, confirm, decline, reroll
- [x] Per-card reroll (replaceSuggestionId) — swaps only targeted card
- [x] Reroll limit raised to 10
- [x] Jamie's buttons: attendee sees Accept/Decline/Reroll after organizer sends
- [x] Attendee reroll preserves organizer_status (buttons no longer disappear)
- [x] Insert bug fix: date_range_start/end/time_of_day/context_prompt now included
- [x] "Your pick — waiting on them" badge for organizer pre-lock
- [x] buildGCalUrl: proper title, address, end time
- [x] Narrative tone: direct, no marketing language
- [x] Home.js: single API call, client-side split into waiting/in-progress/upcoming
- [x] Friends.js: inline errors, no alert()
- [x] ItineraryView: smooth expand/collapse, Getting There Google Maps link
- [x] Dev user switcher: /dev/switch-user/:username
- [x] Mock busy slots for all 4 test users
- [x] 4 test users seeded (jamiec, mrivera, tkim, alexp)
- [x] STATUS.md and TODO.md tracking docs

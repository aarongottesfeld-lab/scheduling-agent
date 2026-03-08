# Rendezvous — TODO

---

## 🔴 Blocking — Scheduling Engine (next major milestone)

- [ ] `POST /schedule/suggest` — AI engine: read both calendars, find overlap, call Claude, return 3 suggestions
- [ ] `GET /schedule/itineraries` — list with ?filter=waiting|upcoming
- [ ] `GET /schedule/itinerary/:id` — single itinerary + suggestions JSON
- [ ] `POST /schedule/confirm` — attendee accepts a suggestion
- [ ] `POST /schedule/itinerary/:id/send` — organizer sends to attendee
- [ ] `POST /schedule/itinerary/:id/decline` — attendee declines
- [ ] `POST /schedule/itinerary/:id/reroll` — regenerate with updated context
- [ ] `POST /schedule/itinerary/:id/changelog` — append change message to locked itinerary

---

## 🟡 Feature Development

### AI / Intelligence
- [ ] SeatGeek API integration — live events (sports, concerts, Broadway) in NYC suggestions
  - User action needed: sign up at https://platform.seatgeek.com → add SEATGEEK_CLIENT_ID + SEATGEEK_CLIENT_SECRET to server/.env
- [ ] Nudge generation logic — scan both users' calendars for mutual free windows, generate reason via Claude
- [ ] Activity cluster caching (activity_clusters table) — avoid re-running semantic grouping on every request
- [ ] Define Claude output schema for suggestions: { date, time, neighborhood, venues[], rationale, narrative, travelTime }

### Google Calendar
- [ ] Calendar write — create event for both users when itinerary locks (dual acceptance)
- [ ] Token refresh reuse — ensure refresh logic from /calendar/availability is shared across all calendar calls

### Frontend
- [ ] Replace alert() in Friends.js with inline alert--error div
- [ ] Validate itineraryId from URL params in ItineraryView.js before API calls
- [ ] Wire startDate, endDate, timeOfDay, maxTravelMinutes, contextPrompt into getSuggestions() once backend accepts them (NewEvent.js already collects them)
- [ ] Home.js: test nudge cards render correctly once nudge generation is live

---

## 🟢 Deployment & Infrastructure

- [ ] Vercel deployment — connect GitHub repo, set env vars
- [ ] Add HTTP referrer restriction to Google Maps API key (needs Vercel URL)
- [ ] Switch in-memory session Map to Supabase persistence (survives server restarts)
- [ ] Switch OAuth handoff from URL params to HTTP-only cookies
- [ ] PWA configuration — manifest.json + service worker

---

## 🧪 Testing Needed (user)

- [ ] Friend search → send request → accept flow (end to end)
- [ ] MyProfile view and edit
- [ ] Friend profile view + private annotations + AI shared interests
- [ ] Custom time picker on New Event (verify full 24h range)
- [ ] Dev user switcher: http://localhost:3001/dev/switch-user/jamiec etc.

---

## ✅ Completed

- [x] Project scaffolded: CRA frontend + Express backend
- [x] Git repo initialized, .gitignore protecting .env
- [x] Supabase project created, all tables + RLS + triggers
- [x] Google OAuth credentials configured
- [x] Google Maps API key, restricted to 4 APIs, billing alert at $10
- [x] server/index.js: health, OAuth, auth, calendar availability
- [x] client/src/utils/auth.js — in-memory session helpers
- [x] client/src/utils/client.js — shared axios client with error normalization
- [x] client/src/utils/api.js — named API calls (uses shared client)
- [x] All 10 original frontend files (Login, ProfileSetup, Home, Friends, FriendProfile, NewEvent, ItineraryView, NavBar, PillInput, ProtectedRoute)
- [x] MyProfile.js — view + edit own profile, wired to /profile
- [x] Security fix: /profile/setup behind ProtectedRoute
- [x] Security fix: api.js merged onto shared client.js axios instance
- [x] Server routes modularized: server/routes/users.js, friends.js, nudges.js
- [x] GET/POST /users/me, /users/profile, /users/search, /geocode
- [x] Full friends lifecycle: list, search, request, accept, decline, profile, annotations, shared-interests
- [x] Nudges: /nudges/pending, /nudges/:id/dismiss
- [x] 4 test users seeded in Supabase (jamiec, mrivera, tkim, alexp)
- [x] Dev user switcher (dev-only, /dev/switch-user/:username)
- [x] NewEvent: scheduling window labels, Custom Time picker (full 24h, flexibility window)
- [x] Activity suggestions expanded with NYC sports, shows, concerts, outdoor
- [x] Avatar in NavBar links to /profile
- [x] Friend profile links wired from Friends list
- [x] STATUS.md and TODO.md tracking docs
- [x] Apple Notes: "Rendezvous — Test Users", "Scheduling Agent — Project Context", "Scheduling Agent — Full Database Schema"

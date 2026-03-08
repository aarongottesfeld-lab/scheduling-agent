# Rendezvous — TODO

_Completed items stay here for reference. Add new items as they surface in code or planning._

---

## 🔴 Critical / Blocking

- [ ] Build all stubbed server endpoints (see STATUS.md for full list)
- [ ] Run frontend for first time and verify it loads (`cd client && npm start`)

---

## 🟡 Feature Development

### Server — Core Endpoints
- [ ] `GET /geocode` — reverse geocode lat/lng to city name (keep Maps key server-side)
- [ ] `GET /users/me` — return current user's profile
- [ ] `POST /users/profile` — save/update profile
- [ ] `GET /users/search` — search by email or username
- [ ] `GET /friends` — list accepted friends (support ?search= filter)
- [ ] `GET /friends/requests/incoming` — pending friend requests
- [ ] `POST /friends/request` — send a friend request
- [ ] `POST /friends/requests/:id/accept` — accept a request
- [ ] `POST /friends/requests/:id/decline` — decline a request
- [ ] `GET /friends/:id/profile` — public profile of a friend
- [ ] `GET /friends/:id/annotations` — current user's private notes on a friend
- [ ] `PUT /friends/:id/annotations` — save private notes
- [ ] `GET /friends/:id/shared-interests` — AI semantic comparison of both users' activity preferences

### Server — Scheduling
- [ ] `GET /schedule/itineraries` — list itineraries with ?filter=waiting|upcoming
- [ ] `GET /schedule/itinerary/:id` — get a single itinerary with suggestions
- [ ] `POST /schedule/suggest` — main AI suggestion engine (reads both calendars, runs Claude)
- [ ] `POST /schedule/confirm` — confirm a suggestion (triggers calendar write later)
- [ ] `POST /schedule/itinerary/:id/send` — organizer sends suggestion to attendee
- [ ] `POST /schedule/itinerary/:id/decline` — attendee declines
- [ ] `POST /schedule/itinerary/:id/reroll` — regenerate suggestions with new context
- [ ] `POST /schedule/itinerary/:id/changelog` — add a change message to locked itinerary

### Server — Nudges
- [ ] `GET /nudges/pending` — return active nudges for current user
- [ ] `POST /nudges/:id/dismiss` — mark nudge as dismissed
- [ ] Nudge generation logic — scan both users' calendars for mutual free windows, trigger Claude

### AI / Intelligence
- [ ] Activity cluster generation (`activity_clusters` table) — semantic grouping of preferences to avoid re-running on every request
- [ ] `GET /friends/:id/shared-interests` — compare user + friend activity_preferences via Claude
- [ ] Context prompt parsing in `/schedule/suggest` — extract intent signals (vibe, location hints, constraints)
- [ ] Itinerary suggestion format — define Claude output schema (date, time, neighborhood, venues, rationale, travel times)

### Google Calendar
- [ ] Calendar write — create event for both users when itinerary locks (dual acceptance triggers this)
- [ ] Token refresh logic — already in `/calendar/availability`, ensure it's reused across all calendar calls

---

## 🟡 Frontend — Known Issues

- [ ] `Friends.js`: Replace `alert()` error handling with inline `alert--error` div (matches pattern used elsewhere)
- [ ] `ItineraryView.js`: Validate `itineraryId` from URL params before using in API calls (guard against malformed values)
- [ ] `NewEvent.js`: Wire up `startDate`, `endDate`, `timeOfDay`, `maxTravelMinutes`, `contextPrompt` to `getSuggestions()` call once backend accepts them (currently only passes `targetUserId` + `daysAhead`)
- [ ] No CSS written yet — app will be functionally correct but unstyled; need to write `index.css` or component styles

---

## 🟢 Deployment & Infrastructure

- [ ] Vercel deployment — set up project, connect GitHub repo
- [ ] Add HTTP referrer restriction to Google Maps API key (needs Vercel URL)
- [ ] Set `REACT_APP_SERVER_URL` in Vercel env vars pointing to production server
- [ ] PWA configuration — update `manifest.json`, add service worker
- [ ] Switch OAuth redirect session handoff from URL params to HTTP-only cookies (production hardening)

---

## ✅ Completed

- [x] Project scaffolded: CRA frontend + Express backend
- [x] Git repo initialized, `.gitignore` protecting `.env`
- [x] Supabase project created, all tables + RLS + triggers set up
- [x] Google OAuth credentials configured
- [x] Google Maps API key created, restricted to 4 APIs
- [x] Billing alert set at $10
- [x] `server/index.js` written: health check, OAuth, auth, calendar availability (371 lines)
- [x] `client/src/utils/auth.js` — in-memory session helpers
- [x] `client/src/utils/client.js` — shared authenticated axios client with error normalization
- [x] `client/src/utils/api.js` — all named API call functions (now uses shared client)
- [x] `client/src/components/ProtectedRoute.js`
- [x] `client/src/components/PillInput.js`
- [x] `client/src/components/NavBar.js`
- [x] `client/src/App.js` — routing (all routes now protected except `/`)
- [x] `client/src/pages/Login.js`
- [x] `client/src/pages/ProfileSetup.js`
- [x] `client/src/pages/Home.js`
- [x] `client/src/pages/Friends.js`
- [x] `client/src/pages/FriendProfile.js`
- [x] `client/src/pages/NewEvent.js`
- [x] `client/src/pages/ItineraryView.js`
- [x] Security fix: `/profile/setup` wrapped in ProtectedRoute
- [x] Security fix: `api.js` merged onto shared `client.js` axios instance

# Rendezvous — Project Status

_Update this file after every major change. Reference alongside compacted transcript at `/mnt/transcripts/` on session start._

---

## Current Goal
Run the frontend for the first time (`npm start`) and confirm the app loads, OAuth flow works, and basic routing is functional.

---

## Last Completed
- Full frontend build: 10 files written by Claude Code (~2,750 lines total)
- Security review of all frontend files
- Fixed: `/profile/setup` now wrapped in `ProtectedRoute` (was publicly accessible)
- Fixed: `api.js` now imports shared `client` from `client.js` instead of maintaining a duplicate axios instance with no error normalization

---

## Stack & Infrastructure

| Layer | Tech | Notes |
|---|---|---|
| Frontend | React (CRA), React Router v7, axios | `client/` |
| Backend | Node.js, Express 5 | `server/index.js` (371 lines) |
| Database | Supabase (Postgres), RLS on all tables | Project ID: `bgeqxnrwrphbzenfrbdb` |
| Auth | Google OAuth 2.0 | Tokens stored in `google_tokens` table |
| Maps | Google Maps API (server-side only) | Key restricted to 4 APIs |
| AI | Anthropic Claude API | Used server-side for suggestions + shared interests |

---

## Environment

- Project root: `~/Documents/scheduling-agent`
- Server runs on: `http://localhost:3001`
- Frontend runs on: `http://localhost:3000`
- Node: v24.14.0, npm: 11.9.0
- Git remote: `aarongottesfeld-lab/scheduling-agent` (private)
- Caffeinate: active during builds (run manually before long sessions)

---

## What's Running Right Now

- `server/index.js` — running via `npm run dev` (node --watch), port 3001
- Frontend — not yet started

---

## Server Endpoints — Implemented

| Method | Route | Status |
|---|---|---|
| GET | `/health` | ✅ |
| GET | `/auth/google` | ✅ |
| GET | `/auth/google/callback` | ✅ |
| GET | `/auth/me` | ✅ |
| POST | `/auth/logout` | ✅ |
| GET | `/calendar/availability` | ✅ |

---

## Server Endpoints — Stubbed / Needed by Frontend

These are called by the frontend but not yet implemented in `server/index.js`:

| Method | Route | Called From |
|---|---|---|
| GET | `/geocode` | ProfileSetup.js |
| GET | `/nudges/pending` | Home.js |
| POST | `/nudges/:id/dismiss` | Home.js |
| GET | `/friends` | Home.js, Friends.js, NewEvent.js |
| GET | `/friends/requests/incoming` | Friends.js |
| POST | `/friends/request` | Friends.js |
| POST | `/friends/requests/:id/accept` | Friends.js |
| POST | `/friends/requests/:id/decline` | Friends.js |
| GET | `/friends/:id/profile` | FriendProfile.js, NewEvent.js |
| GET | `/friends/:id/annotations` | FriendProfile.js |
| PUT | `/friends/:id/annotations` | FriendProfile.js |
| GET | `/friends/:id/shared-interests` | FriendProfile.js |
| GET | `/users/me` | Friends.js |
| GET | `/users/search` | Friends.js (via api.js) |
| POST | `/users/profile` | ProfileSetup.js (via api.js) |
| GET | `/schedule/itineraries` | Home.js |
| GET | `/schedule/itinerary/:id` | ItineraryView.js |
| POST | `/schedule/suggest` | NewEvent.js (via api.js) |
| POST | `/schedule/confirm` | ItineraryView.js (via api.js) |
| POST | `/schedule/itinerary/:id/send` | ItineraryView.js |
| POST | `/schedule/itinerary/:id/decline` | ItineraryView.js |
| POST | `/schedule/itinerary/:id/reroll` | ItineraryView.js |
| POST | `/schedule/itinerary/:id/changelog` | ItineraryView.js |

---

## Outstanding Security Notes (for production hardening)

- `userId` briefly appears in URL after OAuth redirect before being cleared — switch to HTTP-only cookies before production
- `alert()` used in `Friends.js` for error display — replace with inline error UI
- `itineraryId` from URL params should be validated against a safe pattern before use in API calls

---

## Up Next (in order)

1. Run frontend: `cd client && npm start`
2. Confirm OAuth flow works end-to-end
3. Commit current frontend + fixes to git
4. Build remaining server endpoints (see stubbed list above)
5. Implement AI suggestion engine (`POST /schedule/suggest`)
6. Implement nudge generation logic
7. Google Calendar event creation on itinerary lock
8. Vercel deployment
9. Add HTTP referrer restriction to Maps API key (needs Vercel URL first)
10. PWA configuration

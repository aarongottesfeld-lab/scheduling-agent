# Rendezvous — Project Status

_Updated after every major change. On session start, read this file + TODO.md + /mnt/transcripts/ compacted history._

---

## Current Goal
Build the scheduling engine — the core AI feature that reads both users' calendars, generates 3 itinerary suggestions, and persists them so both sides can view and respond.

---

## Last Completed (this session)
- Full frontend build: 11 pages, 3 components, ~2,800 lines
- Security review + 2 fixes (ProtectedRoute on /profile/setup, unified axios client)
- Server routes modularized into server/routes/
- Users endpoints: /users/me, POST /users/profile, GET /users/search, /geocode
- Friends endpoints: full lifecycle (list, search, request, accept, decline, profile, annotations, shared-interests w/ AI)
- Nudges endpoints: /nudges/pending, /nudges/:id/dismiss
- 4 test users seeded in Supabase (jamiec, mrivera, tkim, alexp)
- Dev user switcher: http://localhost:3001/dev/switch-user/:username
- NewEvent: renamed date labels to scheduling window, added Custom Time picker (full 24h)
- MyProfile page: read-only view + edit form, wired to /profile
- Avatar in NavBar now links to /profile
- Friend profile links wired from Friends list → /friends/:id
- Activity suggestions updated with NYC sports, shows, concerts, outdoor activities
- STATUS.md and TODO.md added for persistent tracking

---

## Stack

| Layer | Tech | Notes |
|---|---|---|
| Frontend | React (CRA), React Router v7, axios | client/ |
| Backend | Node.js, Express 5 | server/index.js + server/routes/ |
| Database | Supabase (Postgres), RLS on all tables | Project: bgeqxnrwrphbzenfrbdb |
| Auth | Google OAuth 2.0 | Tokens in google_tokens table, sessions in-memory |
| Maps | Google Maps API (server-side only) | Restricted to 4 APIs |
| AI | Anthropic Claude API (claude-sonnet-4-20250514) | Used server-side |
| Tickets | SeatGeek API (planned) | For live events in suggestion engine |

---

## Environment

- Project root: ~/Documents/scheduling-agent
- Server: http://localhost:3001 (npm run dev, node --watch)
- Frontend: http://localhost:3000 (npm start)
- Node v24.14.0, npm 11.9.0
- Git: aarongottesfeld-lab/scheduling-agent (private)
- Session storage: in-memory Map (lost on server restart → re-auth required)

---

## Server Endpoints — Implemented

| Method | Route | File |
|---|---|---|
| GET | /health | index.js |
| GET | /auth/google | index.js |
| GET | /auth/google/callback | index.js |
| GET | /auth/me | index.js |
| POST | /auth/logout | index.js |
| GET | /calendar/availability | index.js |
| GET | /users/me | routes/users.js |
| POST | /users/profile | routes/users.js |
| GET | /users/search | routes/users.js |
| GET | /geocode | routes/users.js |
| GET | /friends | routes/friends.js |
| GET | /friends/requests/incoming | routes/friends.js |
| POST | /friends/request | routes/friends.js |
| POST | /friends/requests/:id/accept | routes/friends.js |
| POST | /friends/requests/:id/decline | routes/friends.js |
| GET | /friends/:id/profile | routes/friends.js |
| GET | /friends/:id/annotations | routes/friends.js |
| PUT | /friends/:id/annotations | routes/friends.js |
| GET | /friends/:id/shared-interests | routes/friends.js |
| GET | /nudges/pending | routes/nudges.js |
| POST | /nudges/:id/dismiss | routes/nudges.js |
| GET | /dev/switch-user/:username | index.js (dev only) |
| GET | /dev/users | index.js (dev only) |

---

## Server Endpoints — Still Needed

| Method | Route | Notes |
|---|---|---|
| GET | /schedule/itineraries | list with ?filter=waiting|upcoming |
| GET | /schedule/itinerary/:id | single itinerary + suggestions |
| POST | /schedule/suggest | AI engine — main feature |
| POST | /schedule/confirm | accept a suggestion |
| POST | /schedule/itinerary/:id/send | organizer sends to attendee |
| POST | /schedule/itinerary/:id/decline | attendee declines |
| POST | /schedule/itinerary/:id/reroll | regenerate with new context |
| POST | /schedule/itinerary/:id/changelog | add change message |

---

## Production Hardening (deferred)

- Switch session storage from in-memory Map to Supabase (survives restarts)
- Switch OAuth handoff from URL params to HTTP-only cookies
- Add HTTP referrer restriction to Google Maps API key (needs Vercel URL)
- Replace alert() in Friends.js with inline error UI
- Validate itineraryId URL param before API calls in ItineraryView.js

---

## Up Next (in order)

### My next actions (no user needed)
1. Build server/routes/schedule.js with all 8 scheduling endpoints
2. Implement the AI suggestion engine in POST /schedule/suggest
3. Integrate SeatGeek API for live event data in suggestions
4. Build nudge generation logic (scan calendars for mutual free windows)

### Needs user action
1. Sign up for SeatGeek API key at https://platform.seatgeek.com → add SEATGEEK_CLIENT_ID + SEATGEEK_CLIENT_SECRET to server/.env
2. Test friend request flow end-to-end (search → add → accept)
3. Test MyProfile view and edit
4. Vercel deployment (after scheduling engine works)

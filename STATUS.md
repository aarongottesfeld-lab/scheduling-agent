# Rendezvous — Project Status

_Updated after every major change._

---

## Current Goal
Wire `ItineraryView.js` to the scheduling engine, then test the full event flow end to end.

---

## Last Completed (this session)
- Fixed `/profile` "cannot load" bug — OAuth callback now creates a Supabase profile row and stores the real UUID in the session (previously the session key was a random hex with no Supabase mapping)
- DB migration: dropped `auth.users` FK on profiles, added `UNIQUE` on email, made `full_name` nullable for new signups
- Built `server/routes/schedule.js` — all 8 endpoints: `/schedule/suggest`, `/schedule/itineraries`, `/schedule/itinerary/:id`, `/schedule/confirm`, `/send`, `/decline`, `/reroll`, `/changelog`
- AI suggestion engine: reads both users' calendars, computes free windows, calls Claude with full profile context, returns 3 structured suggestions
- Clickable profile nav: avatar + name in NavBar → `/profile`; avatar + name in Friends list → `/friends/:id`
- Custom time picker: now shows 8-row scrollable list instead of full-screen dropdown
- Added SeatGeek + MCP server as roadmap items in TODO.md

---

## Architecture

| Layer | Tech | Notes |
|---|---|---|
| Frontend | React (CRA), React Router v7, axios | client/ |
| Backend | Node.js, Express 5 | server/index.js + server/routes/ |
| Database | Supabase (Postgres), RLS | Project: bgeqxnrwrphbzenfrbdb, us-east-1 |
| Auth | Google OAuth 2.0 | Sessions in-memory Map, supabaseId stored per session |
| Maps | Google Maps API (server-side) | Restricted to 4 APIs |
| AI | Anthropic claude-sonnet-4-20250514 | Server-side only |

---

## Session Architecture (important)
- `userSessions` Map key = random hex session token (sent to client as `userId`)
- `session.supabaseId` = the real Supabase UUID used for all DB queries
- `req.userId` in routes = `session.supabaseId` (resolved by `requireAuth`)
- Dev switcher: session key IS the Supabase UUID (stored as `supabaseId` too)
- Known limitation: sessions lost on server restart → re-auth required

---

## All Implemented Endpoints

| Method | Route | File |
|---|---|---|
| GET | /health | index.js |
| GET | /auth/google | index.js |
| GET | /auth/google/callback | index.js — now creates Supabase profile |
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
| POST | /schedule/suggest | routes/schedule.js ✅ NEW |
| GET | /schedule/itineraries | routes/schedule.js ✅ NEW |
| GET | /schedule/itinerary/:id | routes/schedule.js ✅ NEW |
| POST | /schedule/confirm | routes/schedule.js ✅ NEW |
| POST | /schedule/itinerary/:id/send | routes/schedule.js ✅ NEW |
| POST | /schedule/itinerary/:id/decline | routes/schedule.js ✅ NEW |
| POST | /schedule/itinerary/:id/reroll | routes/schedule.js ✅ NEW |
| POST | /schedule/itinerary/:id/changelog | routes/schedule.js ✅ NEW |
| GET | /dev/switch-user/:username | index.js (dev only) |
| GET | /dev/users | index.js (dev only) |

---

## Up Next

1. Wire `ItineraryView.js` to `GET /schedule/itinerary/:id` + `POST /schedule/confirm`
2. Test: OAuth login → /profile loads → add friend → new event → itinerary view
3. Google Calendar write on lock
4. Vercel deploy

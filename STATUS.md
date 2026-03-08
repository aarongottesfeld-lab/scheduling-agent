# Rendezvous — Project Status

_Updated after every major change._

---

## Current Goal
End-to-end test of the full scheduling flow, then Vercel deploy.

---

## Last Completed
- Avatar upload on MyProfile (click avatar → file picker → uploads to Supabase storage → saves avatar_url)
- Notification bell in NavBar: polls every 30s, dropdown panel, mark read, mark all read
- Search results in Friends always clickable → /friends/:id
- NewEvent friend selector: dropdown of all friends on focus + filter by typing, no need to know usernames
- Custom time picker reverted to standard dropdown
- Fixed getSuggestions in api.js — was dropping all params (root cause of 'Could not generate' error)
- Added notifications table + storage bucket (avatars) to Supabase
- Better error messages from schedule/suggest endpoint

## Last Completed (prev)
- Scheduling engine fully built and wired (server/routes/schedule.js, all 8 endpoints)
- ItineraryView.js wired to real API — field mappings fixed (organizer_id, selected_suggestion_id, locked_at, estimatedTravelA/B, changelog ts field)
- Home.js ItineraryCard fixed — resolves friend name from isOrganizer flag, derives status from locked_at + organizer/attendee_status
- /profile bug fixed — OAuth callback now upserts to Supabase and stores real UUID in session
- DB migration: dropped auth.users FK, added UNIQUE on email, full_name nullable
- Clickable nav: avatar + name → /profile; friend card avatar + name → /friends/:id
- Custom time picker: 8-row scrollable list
- Roadmap items added: SeatGeek, MCP server

---

## Architecture

| Layer | Tech | Notes |
|---|---|---|
| Frontend | React (CRA), React Router v7, axios | client/ |
| Backend | Node.js, Express 5 | server/index.js + routes/ |
| Database | Supabase (Postgres), RLS | bgeqxnrwrphbzenfrbdb, us-east-1 |
| Auth | Google OAuth 2.0 | In-memory sessions, supabaseId per session |
| Maps | Google Maps API (server-side) | 4 APIs restricted |
| AI | Anthropic claude-sonnet-4-20250514 | Server-side only |

## Session Architecture
- Session map key = random hex token (sent to client as userId param)
- session.supabaseId = real Supabase UUID (used in all DB queries via req.userId)
- Dev switcher: session key IS the UUID, stored as supabaseId too
- Known limit: sessions cleared on server restart

---

## All Endpoints

| Method | Route | Status |
|---|---|---|
| GET | /health | ✅ |
| GET/GET | /auth/google + /callback | ✅ creates Supabase profile |
| GET | /auth/me | ✅ |
| POST | /auth/logout | ✅ |
| GET | /calendar/availability | ✅ |
| GET | /users/me | ✅ |
| POST | /users/profile | ✅ |
| GET | /users/search | ✅ |
| GET | /geocode | ✅ |
| GET | /friends + /requests/incoming | ✅ |
| POST | /friends/request + accept + decline | ✅ |
| GET | /friends/:id/profile + annotations + shared-interests | ✅ |
| PUT | /friends/:id/annotations | ✅ |
| GET | /nudges/pending | ✅ |
| POST | /nudges/:id/dismiss | ✅ |
| POST | /schedule/suggest | ✅ AI engine |
| GET | /schedule/itineraries | ✅ |
| GET | /schedule/itinerary/:id | ✅ |
| POST | /schedule/confirm | ✅ |
| POST | /schedule/itinerary/:id/send | ✅ |
| POST | /schedule/itinerary/:id/decline | ✅ |
| POST | /schedule/itinerary/:id/reroll | ✅ |
| POST | /schedule/itinerary/:id/changelog | ✅ |
| GET | /dev/switch-user/:username | ✅ dev only |

---

## Up Next
1. Re-auth via Google OAuth (fresh login required for /profile fix)
2. End-to-end test: login → add friend → new event → view itinerary → send → switch user → accept → lock
3. Google Calendar write on lock
4. Vercel deploy

# Rendezvous — TODO

---

## 🔴 In Progress / Next Up

- [ ] Test full scheduling flow end-to-end (generate → send → switch user → accept → lock)
- [ ] Wire `ItineraryView.js` to consume `GET /schedule/itinerary/:id` and `POST /schedule/confirm`
- [ ] Google Calendar event creation when itinerary locks (both users get invite)

---

## 🟡 Feature Development

### Scheduling UI
- [ ] ItineraryView: show 3 suggestion cards, accept/decline/reroll actions
- [ ] Home.js: list active itineraries from `GET /schedule/itineraries?filter=waiting`
- [ ] Inline error states (replace all `alert()` calls in Friends.js)
- [ ] Validate `itineraryId` URL param before API calls in ItineraryView.js

### AI / Intelligence
- [ ] Nudge generation logic — scan both users' calendars, call Claude, insert into nudges table
- [ ] Activity cluster caching (activity_clusters table) — avoid re-clustering on every request

### Google Calendar
- [ ] Calendar write on itinerary lock — create event for both users

---

## 🗺️ Roadmap (future milestones)

- [ ] **SeatGeek integration** — pull live events (Knicks, Yankees, Broadway, concerts) into NYC suggestions. Sign up at https://platform.seatgeek.com → add SEATGEEK_CLIENT_ID + SEATGEEK_CLIENT_SECRET to server/.env
- [ ] **MCP server** — expose Rendezvous as an MCP tool so users can schedule meetups directly from Claude.ai, Claude Code, Cursor, or any MCP-compatible AI chat. Endpoints: `schedule_with_friend`, `list_friends`, `get_itinerary`. Enables "hey Claude, schedule lunch with Jamie next week" from any AI interface.
- [ ] **Group scheduling** — expand beyond 1:1 to 3–5 people
- [ ] **Recurring events** — "monthly dinner club" style repeat scheduling
- [ ] **Venue booking** — OpenTable / Resy integration to book directly from itinerary
- [ ] **Push notifications** — nudge delivery via web push when friend accepts/declines

---

## 🟢 Deployment & Infrastructure

- [ ] Vercel deployment — connect GitHub repo, set env vars
- [ ] HTTP referrer restriction on Google Maps API key (needs Vercel URL)
- [ ] Switch in-memory session Map to Supabase persistence (survives server restarts)
- [ ] Switch OAuth handoff from URL params to HTTP-only cookies
- [ ] PWA configuration — manifest.json + service worker

---

## 🧪 Testing Needed (user)

- [ ] Re-authenticate via Google OAuth — profile should now load at /profile
- [ ] Friend search → add → accept flow end to end
- [ ] Custom time picker — verify 8-row scrollable list
- [ ] Click friend name/avatar in Friends list → goes to /friends/:id
- [ ] Click your name or avatar in NavBar → goes to /profile
- [ ] Full scheduling flow once ItineraryView is wired

---

## ✅ Completed

- [x] Project scaffolded: CRA frontend + Express backend
- [x] Git repo, .gitignore, all env vars configured
- [x] Supabase: all tables + RLS + triggers + migrations
- [x] Google OAuth credentials + calendar scopes
- [x] Google Maps API key, restricted to 4 APIs
- [x] All server routes: health, auth, calendar, users, friends, nudges
- [x] **schedule.js** — all 8 scheduling endpoints + AI suggestion engine
- [x] MyProfile.js — view + edit own profile at /profile
- [x] FriendProfile.js — public info + private annotations
- [x] NavBar avatar + first name both link to /profile
- [x] Friends list: avatar + name both link to /friends/:id
- [x] Custom time picker: full 24h, 8-row scrollable list
- [x] OAuth callback now upserts Supabase profile and stores stable UUID in session
- [x] DB migration: dropped auth.users FK, added email UNIQUE constraint
- [x] 4 test users seeded (jamiec, mrivera, tkim, alexp)
- [x] Dev user switcher: /dev/switch-user/:username
- [x] STATUS.md and TODO.md tracking docs

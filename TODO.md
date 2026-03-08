# Rendezvous — TODO

---

## 🔴 In Progress / Next Up

- [ ] Apply `fetchBusy` mock slot fallback to `server/routes/schedule.js` (see reminder + last Claude message for exact code), then commit + push
- [ ] Test full scheduling flow end-to-end (getSuggestions payload bug now fixed — retry)
- [ ] Wire server-side notification inserts: friend request sent/accepted, itinerary proposed/accepted/declined/rerolled
- [ ] Google Calendar event creation when itinerary locks (both users get invite)

---

## 🟡 Feature Development

### Scheduling UI
- [ ] Replace remaining `alert()` calls in Friends.js with inline errors
- [ ] Validate `itineraryId` URL param before API calls in ItineraryView.js

### AI / Intelligence
- [ ] **Instruction override logic** — explicit activity in user prompt anchors the suggestion (overrides profile interests). Profile interests used only for adjacent planning (e.g. "golf trip" → plan around golf even if neither profile lists it, use shared interests for dinner/bar adjacent to the activity). Applies equally to app context prompt and MCP conversational input.
- [ ] **Prompt intent classification** — distinguish: local hangout / day trip / overnight trip. Drives whether to use venue lookup (local) or destination + lodging format (trip mode).
- [ ] **Trip mode suggestions** — when prompt implies multi-day or travel, switch from NYC venue lookup to destination + course/lodging/itinerary format
- [ ] Nudge generation logic — scan both users' calendars, call Claude, insert into nudges table
- [ ] Activity cluster caching (activity_clusters table) — avoid re-clustering on every request

### Google Calendar
- [ ] Calendar write on itinerary lock — create event for both users

---

## 🗺️ Roadmap

### MCP Server
> Build after core app is fully tested. MCP is a wrapper around the same endpoints — bugs in the core become bugs in the MCP flow too.
- [ ] MCP server — thin auth wrapper around existing API endpoints
- [ ] Tool: `resolve_friend(name)` — fuzzy first-name match against friends list → UUID. Handles "Bobby" → Robert Chen without knowing username
- [ ] Tool: `create_itinerary_proposal(friend, activity, date_range, context)`
- [ ] Tool: `list_pending_itineraries()` — "what plans do I have pending?"
- [ ] Tool: `get_itinerary(id)` — fetch status + suggestions
- [ ] Tool: `accept_itinerary(id)` / `decline_itinerary(id)`
- [ ] `conversation_context` parameter — Claude populates with relevant session context before calling the tool (e.g. "user prefers walking courses, mentioned wanting to get out of the city more"). Injected into suggestion engine prompt alongside structured profile data.
- [ ] **Context priority ordering in suggestion engine**: explicit instruction > conversation context > shared profile interests > individual profile interests
- [ ] Profile update prompting — when Claude infers something meaningful from conversation not in profile, surface "want to save this to your Rendezvous profile?" so signal persists
- [ ] MCP auth — token-based, scoped per user, revocable
- [ ] Register with Claude.ai as an available MCP connector

### Booking Integrations
- [ ] **Resy / OpenTable** — restaurant reservations (highest priority, applies to almost every itinerary type). Native integration: check availability for party size + time, book or surface deep link
- [ ] **GolfNow** — tee time booking. Directly serves the golf trip use case. "Bethpage Black has a 9am Saturday opening, want me to book for 2?"
- [ ] **Deep link fallback pattern** — for all other platforms (Fever, Eventbrite, Tock, ClassPass), surface pre-populated booking page rather than building native integration
- [ ] **Booking confirmation back-sync** — user marks confirmed booking in Rendezvous, triggers calendar write. Avoids needing full API integrations for every platform
- [ ] **Trip mode: lodging** — Google Hotels or Booking.com API for overnight trip scenarios

### Notifications
- [ ] Push notifications (PWA web push) — required to close the MCP loop. Bobby gets notified without opening the app, can respond, itinerary locks. Without this the MCP flow is incomplete.
- [ ] Email fallback for notifications

### Other
- [ ] **SeatGeek** — live events (Knicks, Yankees, Broadway, concerts) in NYC suggestions
- [ ] **Group scheduling** — 3–5 people
- [ ] **Recurring events** — "monthly dinner club" style
- [ ] Apple Calendar support

---

## 🟢 Deployment & Infrastructure

- [ ] Vercel deployment — connect GitHub repo, set env vars
- [ ] HTTP referrer restriction on Google Maps API key (needs Vercel URL)
- [ ] Tighten `notifications_service_role_all` RLS policy before Vercel deploy (currently `USING (true)` — intentional for custom auth POC, needs app-layer enforcement)
- [ ] Switch in-memory session Map to Supabase persistence (survives server restarts)
- [ ] Switch OAuth handoff from URL params to HTTP-only cookies
- [ ] PWA configuration — manifest.json + service worker

---

## 🧪 Testing Needed (user)

- [ ] Phase 1: Fresh OAuth login → /profile loads, set username/bio/pills, upload avatar
- [ ] Phase 2: Search "jamiec" → clickable result → their profile. Send request → switch to Jamie → accept → switch back → Jamie in friends list
- [ ] Phase 3: New Event → friends dropdown opens on focus, filters by typing, select Jamie, set March 9–15 window
- [ ] Phase 4: Apply fetchBusy code + restart server (see reminder)
- [ ] Phase 5: Generate suggestions → verify 3 cards, check times avoid Jamie's busy slots (golf 9am Mar 11, watch party 2pm Mar 10, dinner 7pm Mar 11) → Send → switch to Jamie → Accept → lock → 🎉 banner
- [ ] Phase 6: Notification bell panel opens. Reroll on unlocked itinerary. Changelog on locked itinerary.

---

## ✅ Completed

- [x] Project scaffolded: CRA frontend + Express backend
- [x] Git repo, .gitignore, all env vars configured
- [x] Supabase: all tables + RLS + triggers + migrations (17 migrations clean)
- [x] Google OAuth credentials + calendar scopes
- [x] Google Maps API key, restricted to 4 APIs
- [x] All server routes: health, auth, calendar, users, friends, nudges, schedule, notifications
- [x] schedule.js — all 8 scheduling endpoints + AI suggestion engine
- [x] MyProfile.js — view + edit + avatar upload
- [x] FriendProfile.js — public info + private annotations
- [x] NavBar: avatar + first name link to /profile, notification bell added
- [x] Friends: search results always clickable → /friends/:id
- [x] NewEvent: friends dropdown on focus + filter by typing (no username memorization needed)
- [x] Custom time picker reverted to standard dropdown
- [x] Fixed getSuggestions in api.js — was silently dropping all params (root cause of suggestion error)
- [x] OAuth callback upserts Supabase profile and stores stable UUID in session
- [x] DB migration: dropped auth.users FK, added email UNIQUE constraint
- [x] Supabase storage bucket: avatars (public, 5MB limit, image types only)
- [x] Notifications table + RLS
- [x] Mock busy slots seeded for all 4 test users (March 9–28, 20 slots each, persona-matched)
- [x] 4 test users seeded (jamiec, mrivera, tkim, alexp) with activity preferences
- [x] Dev user switcher: /dev/switch-user/:username
- [x] STATUS.md and TODO.md tracking docs

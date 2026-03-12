# Rendezvous — TODO

---

## 🔴 Next Up (after current testing pass)

- [ ] **Session persistence** — swap in-memory `userSessions` Map for Supabase `sessions` table. Store session token in HTTP-only cookie. `requireAuth` middleware does DB lookup. Unblocks Vercel deploy.
- [ ] **Vercel deployment** — connect GitHub repo, set env vars, verify all routes
- [ ] **HTTP referrer restriction** on Google Maps API key (needs live Vercel URL)
- [ ] **Tighten RLS** — `notifications_service_role_all` currently `USING(true)`, fix before deploy
- [ ] **Switch OAuth handoff** from URL params to HTTP-only cookies

---

## 🟡 Feature Backlog (prioritized)

### Group Planning
> One organizer, N participants. Everyone sees the same suggestion set. Decision mode set at creation.
- [ ] DB: add `itinerary_participants` table (id, itinerary_id, user_id, role, status, voted_for, joined_at, responded_at)
- [ ] DB: add to `itineraries`: group_size, decision_mode (organizer_picks | majority_vote | unanimous), vote_deadline, voting_closed_at
- [ ] NewEvent: multi-friend selector (up to 6)
- [ ] NewEvent: decision mode radio cards — "Organizer picks" / "Majority vote" / "Everyone must agree"
- [ ] NewEvent: vote-by deadline picker (shown for vote/unanimous modes)
- [ ] Suggestion engine: support N user profiles in prompt
- [ ] ItineraryView — organizer_picks mode: identical to 1:1, only organizer's pick triggers lock
- [ ] ItineraryView — majority_vote mode: live vote tally per card, "Vote for this" button, organizer can close early, deadline countdown badge
- [ ] ItineraryView — unanimous mode: per-person accept/decline chips per card, locks when all green, any decline reopens for reroll
- [ ] Reroll in group context: any participant can propose reroll on non-winning card; vote mode resets votes; unanimous mode resets all statuses on that card
- [ ] Notifications: batched responses (don't ping organizer once per person), deadline reminders to non-responders only, unresolved flag on deadline pass

### Suggestion Refinement
> The user's freeform context prompt should be the highest-weighted input — currently suggestions appear to disregard it.
- [ ] Audit `buildSuggestPrompt` in `schedule.js` — move `contextPrompt` earlier in the prompt, add explicit instruction that it overrides preference defaults
- [ ] Add emphasis framing: "MOST IMPORTANT — treat this as the primary constraint, above activity preferences and neighborhood defaults: {contextPrompt}"
- [ ] Reroll: same fix — `singleCardNote` and `contextPrompt` are joined as a flat string; ensure reroll prompt treats original context as highest-priority carry-forward
- [ ] Haiku vs Sonnet: test whether prompt-following improves in prod (Sonnet) vs dev (Haiku) — poor instruction-following may be a model capability gap, not just a prompting issue
- [ ] Consider adding a short-circuit: if contextPrompt is present and specific (e.g. "golf"), validate returned suggestions against it before saving — reject and retry once if none match
- [ ] Add telemetry: log `context_prompt` hit rate — how often returned suggestions actually reflect the prompt (manual QA for now, structured eval later)

### Turn-based Iteration + Mutual Planning
- [ ] Add `current_turn` field (organizer | attendee) to itineraries
- [ ] Attendee reroll flips turn back to organizer
- [ ] `planning_mode: 'standard' | 'mutual'` checkbox in NewEvent ("Open to counterproposals?")
- [ ] Mutual mode: both see all suggestions, both can reroll non-selected cards, both must accept same card to lock

### Cost Estimates
- [ ] Add `cost` object to suggestion schema: `{ min, max, per_person, currency, notes, breakdown: [] }`
- [ ] Per-venue cost estimate (Claude knowledge of venue tier + Maps data)
- [ ] Display "~$40–65/person" range on cards with expandable breakdown
- [ ] Mark all costs as estimated — no false precision
- [ ] Trip mode: detect when destination is outside user's metro, add flight/train/lodging estimates

### MCP Server
> End state: "Bobby and I want to go on a golf trip" → destinations, logistics, cost breakdown, calendar invite.
- [ ] MCP server — thin auth wrapper around existing API endpoints
- [ ] Tool: `resolve_friend(name)` — fuzzy first-name match → UUID
- [ ] Tool: `create_itinerary_proposal(friend_ids, activity, date_range, context)`
- [ ] Tool: `list_pending_itineraries()`
- [ ] Tool: `get_itinerary(id)`
- [ ] Tool: `accept_itinerary(id)` / `decline_itinerary(id)`
- [ ] Tool: `get_cost_estimate(destination, activity, party_size, dates)`
- [ ] Tool: `book_or_deeplink(venue, party_size, datetime)`
- [ ] `conversation_context` param — injected alongside structured profile data
- [ ] Context priority: explicit instruction > conversation context > shared interests > individual interests
- [ ] Profile update prompting — surface "save this to your profile?" when Claude infers preferences
- [ ] MCP auth — token-based, scoped per user, revocable
- [ ] Register with Claude.ai as available MCP connector
- [ ] Prompt-triggered agent — "set up plans with Jamie" → tools called in sequence → itinerary proposed

### Calendar Attendee Sync
> Build after group planning — requires itinerary_participants table.
- [ ] Manual "Sync attendees from calendar" button on locked itinerary
- [ ] Fetch current attendee list via `events.get` using organizer's stored OAuth token
- [ ] Diff against itinerary_participants, surface Rendezvous profile matches
- [ ] Organizer one-click "Add to itinerary" — sends normal participant invite flow
- [ ] Non-Rendezvous attendees: show "Invite to Rendezvous" prompt (acquisition moment)
- [ ] Privacy: never silently add anyone — always organizer-initiated
- [ ] v2: `calendar.events.watch` webhook (requires Vercel URL + renewal logic, max 7-day channels)

### Apple Calendar + Other Providers (paired with React Native migration)
- [ ] PWA → React Native migration (unlocks EventKit on iOS)
- [ ] Apple Calendar via EventKit (iOS native only — not available in PWA/web)
- [ ] iCloud CalDAV fallback for web (app-specific passwords — evaluate UX tradeoff)
- [ ] Outlook / Microsoft 365 Calendar (Graph API — similar OAuth flow to Google)
- [ ] Onboarding copy: "Google Calendar supported, Apple Calendar coming soon" in the interim

### Booking Integrations
- [ ] Resy / OpenTable — check availability, book or deep link
- [ ] GolfNow — tee time booking
- [ ] Deep link fallback — Fever, Eventbrite, Tock, ClassPass
- [ ] Booking confirmation back-sync → triggers calendar write
- [ ] Trip mode: lodging — Google Hotels or Booking.com API

### Always-On Agent
> Build last — most powerful when calendar integrations + group planning + booking are all in place.
- [ ] Background process (Supabase Edge Functions or cron): monitors nudge expiry, detects calendar gaps, proactively surfaces suggestions
- [ ] Writes to notifications table silently or interrupts depending on threshold
- [ ] Shares same MCP tool layer as prompt-triggered agent — different consumer, same interface
- [ ] nudges table already designed for this

---

## 🟢 Deployment & Infrastructure

- [ ] Vercel deployment
- [ ] HTTP referrer restriction on Maps API key
- [ ] Tighten notifications RLS
- [ ] Session persistence (Supabase sessions table)
- [ ] OAuth handoff → HTTP-only cookies
- [ ] PWA config — manifest.json + service worker
- [ ] Push notifications (PWA web push) — needed to close MCP loop

---

## 🧪 Testing Needed (current pass)

### Auth & Session
- [ ] Log out and back in → supabaseId now populates in sessionStorage (required after today's fix)
- [ ] Dev switcher users (jamiec etc.) → pick/reroll buttons appear correctly as organizer

### Itinerary — Organizer flow
- [ ] Event title set at creation → shows in itinerary header (not "Plans with [Name]")
- [ ] Inline title edit: click pencil → edit → save → persists on refresh
- [x] Pick this one → sends to attendee, organizer sees "waiting on them" badge (post-send UX done)
- [x] New time / New vibe buttons → single card rerolls with correct constraint (timing vs activity)
- [x] After submitting New Event, edit button removed, Return Home shown — duplicate prevention done

### Itinerary — Attendee flow
- [x] Attendee receives sent itinerary → Accept / Decline / Reroll visible on organizer's picked card
- [x] Non-picked cards show "↩ Suggest this instead"
- [x] Reroll button opens modal, Generate fires request, new suggestions load — stuck state fixed
- [x] Suggest this instead → sets attendee's pick, shows "Suggestion sent" badge, organizer sees re-evaluate state
- [x] Suggest-alternative does NOT auto-lock — organizer must re-pick
- [x] Accept → locks when organizer already accepted same card (calendar invite created)
- [x] Full ping-pong negotiation state machine rewritten — DB constraint bug resolved, attendeeSelected JSONB flag approach

### Home screen
- [ ] Pills show `Morgan · Golf weekend` format (or just `Morgan` if no title)
- [ ] Correct tab bucketing: Waiting / In Progress / Upcoming
- [x] Load more — visibleCount progressive disclosure (+3 per click) per tab

### Generate More
- [x] "+ Generate More Options" button in ItineraryView — appends 3 new suggestions via appendMode: true reroll, no negotiation state reset

### Calendar invites
- [x] Wrong year bug fixed — year: 'numeric' added to toLocaleDateString in buildSuggestPrompt

### Friends
- [ ] Schedule button visible on confirmed friends' profiles
- [ ] Add friend button appears on profiles with no existing relationship

### Reroll bounds
- [ ] Rerolled suggestions stay within original date window (no past dates)

### Duplicate title safety
- [ ] Multiple itineraries/events with the same title must never conflict — verify all lookups, comparisons, and calendar event creation use itinerary UUID (not title) as the identifier throughout client and server
- [ ] Google Calendar event creation should include the itinerary UUID in the event description as a reference anchor so external calendar events can always be traced back to the correct itinerary row

---

## ✅ Completed

- [x] Project scaffolded: CRA frontend + Express backend
- [x] Git repo, .gitignore, all env vars configured
- [x] Supabase: all tables + RLS + triggers + migrations
- [x] Google OAuth + calendar scopes (including calendar.events write)
- [x] Google Maps API key restricted to 4 APIs
- [x] All server routes wired
- [x] schedule.js — 9 endpoints + AI suggestion engine
- [x] Notification inserts: friend request, invite, confirm, decline, reroll, suggest-alternative
- [x] Per-card reroll with timing/vibe split (rerollType: timing | activity | both)
- [x] Reroll limit: 10
- [x] Reroll respects original date bounds + floors to today
- [x] Attendee reroll no longer auto-locks (organizer_status downgraded from accepted → sent)
- [x] Google Calendar write on lock (best-effort, graceful no-op if no tokens)
- [x] GCal link: template URL (eventedit/{id} was 500ing)
- [x] event_title: set at creation, inline edit in header, persists across sessions
- [x] Home screen: Friend · Title pill labels
- [x] friendshipStatus: schedule button gated on accepted friendship
- [x] Add friend button on FriendProfile when no relationship exists
- [x] NewEvent back button from generating spinner
- [x] Attendee suggest-alternative flow + server isSuggestAlternative logic
- [x] supabaseId fix: OAuth redirect now passes supabaseId; auth.js stores + exposes it; ItineraryView uses it for organizer_id comparison — fixes pick/reroll/suggest buttons for real OAuth users
- [x] ItineraryView title uses friend's first name only
- [x] Calendar footer hidden on non-locked cards; action buttons raised with border
- [x] Free/public venue prompt + variety + cost range mix
- [x] Narrative tone: direct, no marketing language
- [x] Home.js: single API call, client-side split into waiting/in-progress/upcoming
- [x] Friends.js: inline errors, no alert()
- [x] ItineraryView: expand/collapse, Getting There link, isPicked badge
- [x] Dev user switcher
- [x] Mock busy slots for all 4 test users
- [x] 4 test users seeded (jamiec, mrivera, tkim, alexp)
- [x] STATUS.md + TODO.md tracking

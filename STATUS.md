## Session Notes (March 11, 2026 — major feature session)

### Completed this session

**Bug fixes (5/5 done):**
- [x] NewEvent generating state — edit button removed entirely after submit, Return Home shown
- [x] Attendee reroll stuck state — finally blocks added, rerolling now works reliably
- [x] Wrong year on calendar invites — added year: 'numeric' to toLocaleDateString in buildSuggestPrompt
- [x] Load more on Home — replaced showAll with visibleCount (progressive, +3 per click)
- [x] Suggest this instead — traced full flow, fixed silent failure

**Load More / Generate More:**
- Home.js: visibleCount progressive disclosure (shows 3 more per click) per itinerary tab
- ItineraryView: "+ Generate More Options" button calls reroll endpoint with appendMode: true
  - Generates 3 new suggestions and appends to existing list without resetting negotiation state
- Server: appendMode param added to reroll route

**Back-and-forth negotiation ("ping pong") state machine rewrite:**
- Root cause found: DB check constraint only allows pending/accepted/declined — 'sent' was silently failing on every write
- DB trigger check_itinerary_lock auto-locks whenever both statuses are 'accepted'
- Rewrote state machine: attendee counter-propose keeps attendee_status: 'pending', uses attendeeSelected: true on the JSONB suggestion object as the signal
- deriveStatus updated to detect attendee_suggested via JSONB flag rather than status values
- orgPickedId and deriveTab in Home.js updated to match
- Organizer counter-proposing back clears all attendeeSelected flags and resets attendee_status: pending
- Server always clears attendeeSelected flags when organizer makes any regular accept

**Post-send UX:**
- After organizer sends their pick: other cards hidden, Edit removed, "We'll let you know when [Name] responds" + Return Home shown
- Same treatment for attendee after "Suggest this instead"
- sentAndWaiting and attendeeSentAndWaiting flags control this
- sentAndWaiting correctly excludes the re-evaluate case

**Card sorting:**
- Attendee view: organizer's pick card always sorts to top
- Organizer re-evaluate view: attendee's suggested card sorts to top

**Button fixes:**
- Non-attendee-pick cards in re-evaluate mode now show "↩ Suggest this instead" | "🕐 New time" | "🎲 New vibe"
- "Reroll all" removed from attendee's highlighted suggestion card
- Single-card reroll preserves attendeeSelected flag on untouched cards

**New vibe prompt:**
- "New vibe" button toggles inline textarea for user to describe what they want
- Text passed as contextPrompt scoped only to that card's single-card reroll
- Enter submits, Escape cancels

---

### Still open / known issues

- MyProfile.js has an unused navigate variable (ESLint warning — low priority)
- Session persistence in production: swap sessionStorage bridge for Supabase sessions + HTTP-only cookies before Vercel deploy
- [x] End-to-end test of full flow (login → friend → new event → send → switch user → accept → lock) — passed
- [x] Full codebase audit completed — saved as audit-2026-03-12.md in project root
- [x] audit-2026-03-12.md severity revised: schedule.js:761 'sent' bug downgraded to Medium (dead code path through UI)

## Release gating decision (March 12, 2026)
Output quality, location/travel mode, and group planning must all be in place before sharing
with real users. First impressions with friends are hard to recover from — a functional but
generic app will be mentally filed as "not ready" and re-engagement is difficult. The revised
sequence is:

  1. ✅ Session persistence + OAuth cookie fix — DONE (March 12)
  2. Privacy/security fixes (friends.js:186, rate limiting, avatar MIME)
  3. Deploy to Vercel (needed for Maps API referrer restriction + live testing)
  4. Output quality — prompt engineering first (highest ROI, zero new infrastructure)
  5. Location & Travel Mode
  6. Group planning
  7. Share with real users
  8. React Native migration + App Store (after feature set is proven on live users)

See TODO.md for full task breakdown per phase.

## Roadmap documents
- OUTPUT_QUALITY_ROADMAP.md — suggestion quality, venue filtering, route sequencing,
  re-roll improvements, and full location/travel mode spec (added March 12)

## Next session (March 13, 2026)

### First priority — fix before sharing with any test users
- friends.js:186 — any authenticated user can read any user's full profile (High / Privacy)
  Fix: if friendshipStatus !== 'accepted', return only public fields (full_name, username, avatar_url)
  This must be done before adding any test users outside your immediate circle

### Queue for same session
- schedule.js:761 — replace 'sent' with 'pending' in reroll route (Medium — dead code but clean it up)
- schedule.js:315 — add per-user daily suggestion cap to prevent API credit abuse (High / Security)
- users.js:170 — magic-bytes MIME type validation on avatar uploads (High / Security)

### Pre-deploy blockers (already known — save for deploy sprint)
- index.js:250 — session key + supabaseId in OAuth redirect URL → move to HTTP-only cookie
- index.js:75 — in-memory sessions incompatible with Vercel serverless → persist to Supabase

### Low priority / quality cleanup (can batch into one Claude Code session)
- Stale 'sent' comments: ItineraryView.js:8,10,499,603 and schedule.js:454
- Duplicate JSDoc block: ItineraryView.js:576–579
- console.log PII: schedule.js:458 — gate behind !IS_PROD
- Duplicate sanitizeSearch helper — extract to server/utils/sanitize.js
- friends.js:299 — create anthropic as module-level singleton
- notifications.js:18–33 — add error handling to read/read-all routes
- showOrganizerWaitingIndicator unused variable — remove or implement
- MyProfile.js — remove unused navigate variable
- Duplicate title safety audit: verify all itinerary lookups use UUID not title throughout client and server
- Full codebase audit (consistency, security, privacy, disaster recovery) — prompt saved in Apple Notes

---

## Session Notes (March 10, 2026 — second save state, Claude Code limit hit)

### Bugs identified (now fixed — see above)

1. New Event generating state — edit button / Back to Home
2. Attendee reroll stops after ~2 tries — missing finally block
3. Suggest this instead — silent failure
4. Home screen load more — hard-capped at 3
5. Calendar invites wrong year — toLocaleDateString missing year: 'numeric'

---

## Session Notes (March 10, 2026 — earlier save state)

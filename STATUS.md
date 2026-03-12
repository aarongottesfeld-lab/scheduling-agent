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
- End-to-end test of full flow (login → friend → new event → send → switch user → accept → lock) before deploy
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

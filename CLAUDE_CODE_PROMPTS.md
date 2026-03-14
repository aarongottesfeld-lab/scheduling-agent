# Rendezvous — Claude Code Prompt Reference
Last updated: March 14, 2026

Saved prompts ready to hand to Claude Code when the corresponding roadmap item is picked up.
Each prompt is self-contained — read the indicated files first, then execute.

---

## Remote Mode (New planning mode for virtual hangouts)
Roadmap ref: Tier 2 / Location & Travel Mode section
Status: Ready to implement after current bug fix pass

```
Add a "Remote" mode to the event planning form — a third option alongside Local and Travel for virtual hangouts (video calls, multiplayer games, watch parties, etc.) that don't require venue suggestions or travel specs.

Read NewEvent.js, NewGroupEvent.js, server/routes/schedule.js (focus on buildSuggestPrompt, classifyIntent, and the /schedule/suggest and /schedule/reroll routes), server/routes/group-itineraries.js (focus on buildGroupSuggestPrompt), and the itineraries + group_itineraries table schema before starting.

PARITY REQUIREMENT: Remote mode must work identically for both 1:1 events and group events. Any UI change in NewEvent.js must be mirrored in NewGroupEvent.js. Any prompt change in schedule.js must be mirrored in group-itineraries.js. Verify both flows end-to-end before committing.

---

1. NewEvent.js + NewGroupEvent.js — UI changes

Add 'remote' to the TRAVEL_MODE_OPTIONS array in both files:
  { value: 'remote', label: 'Remote' }

Place it between Local and Travel in the toggle.

When travelMode === 'remote':
- Hide the "Where should you meet?" section entirely (location preference is irrelevant)
- Hide the "Max travel time" selector
- Hide the trip duration picker (already gated on 'travel', no change needed)
- Update the hint text below the mode toggle: "Suggestions for hanging out virtually — no travel needed."

When switching away from 'remote', reset locationPreference to 'system_choice' if it somehow got set (defensive cleanup, same pattern as the existing 'local' reset).

Do NOT send locationPreference, maxTravelMinutes, or destination to the server when travelMode is 'remote' — set them to null in the submitSuggestions payload.

---

2. server/routes/schedule.js + server/routes/group-itineraries.js — server changes

In both /schedule/suggest and /group-itineraries POST routes, update the travel_mode validation to accept 'remote':
  const travelMode = ['travel', 'remote'].includes(rawTravelMode) ? rawTravelMode : 'local';

In both buildSuggestPrompt and buildGroupSuggestPrompt, add a remote mode block alongside the existing travelModeBlock:

  If travelMode === 'remote', inject this block after LOCATION ANCHORING:

  REMOTE MODE: These people are not meeting in person. Suggest virtual/remote activities only. Examples: a video call with a shared activity (cooking the same recipe, watching a film simultaneously, playing an online game), a multiplayer game session, a collaborative playlist, a watch party. Do NOT suggest any physical venues, restaurants, bars, or activities that require being in the same location. All 3 suggestions should be remote-friendly. Set location_type to "home" for all suggestions since no venue is involved.

Also update classifyIntent to return 'home_likely' immediately when travelMode is 'remote' — remote mode bypasses intent classification entirely. classifyIntent does not currently accept travelMode as a parameter, so either add it as an optional second parameter or handle the override in both buildSuggestPrompt and buildGroupSuggestPrompt before calling classifyIntent.

The intentBlock in both prompt builders should be overridden for remote mode — skip the home vs. venue split instruction entirely and use the REMOTE MODE block above as the sole directive.

---

3. DB migrations

The itineraries table has a CHECK constraint on travel_mode: CHECK (travel_mode IN ('local', 'travel')). Add 'remote' to it:

  ALTER TABLE itineraries DROP CONSTRAINT IF EXISTS itineraries_travel_mode_check;
  ALTER TABLE itineraries ADD CONSTRAINT itineraries_travel_mode_check CHECK (travel_mode IN ('local', 'travel', 'remote'));

Check whether group_itineraries has the same constraint and apply the same fix if so.

---

After all changes: git add -A && git commit -m "Add remote mode for virtual hangout suggestions" && git push origin main.
```

---

## Delete Draft Button — 1:1 ItineraryView
Roadmap ref: Polish / UX
Status: Ready to implement

```
Add a delete button for drafts inside ItineraryView. Read ItineraryView.js and Home.js before starting.

The delete action already exists on the Home screen's Drafts tab (the 🗑 ItineraryCard button calls DELETE /schedule/itinerary/:id). This task surfaces the same action inside the itinerary detail view itself.

Changes needed:

1. In ItineraryView.js, check whether the current itinerary is a draft (organizer_status === 'pending' and the viewer is the organizer). If so, render a "Delete draft" button near the top of the view — below the header, above the suggestion cards. Style it as btn--ghost with a muted/danger color, matching the visual weight of the existing ghost buttons in the view.

2. On click, show an inline confirmation — not window.confirm(). A small inline row with "Delete this draft?" + "Yes, delete" and "Cancel" buttons, same pattern used for friend removal in Friends.js. Do not use a modal.

3. On confirm, call DELETE /schedule/itinerary/:id (already implemented server-side), then navigate('/home') on success. Show an inline error if the delete fails — don't navigate on failure.

4. The button should not appear if the itinerary is locked, sent, or the viewer is the attendee. Only visible to the organizer on an unsent draft.

No new routes needed. No DB changes. After the fix: git add -A && git commit -m "Add delete draft button in ItineraryView" && git push origin main.
```

---

## Delete Draft Button — Group GroupItineraryView
Roadmap ref: Polish / UX (parity with 1:1 delete draft)
Status: Ready to implement

```
Add a delete draft button to GroupItineraryView — parity with the ItineraryView delete button. Read GroupItineraryView.js and server/routes/group-itineraries.js before starting.

PARITY REQUIREMENT: This should match the delete draft behavior already implemented in ItineraryView.js exactly — same placement, same inline confirmation pattern, same navigate('/home') on success. UX must be consistent between 1:1 and group itinerary views.

---

1. Server — verify or add DELETE /group-itineraries/:id

IMPORTANT: Before writing anything, read group-itineraries.js and check whether DELETE /group-itineraries/:id already exists. The 56-item audit (March 14, 2026, item #27) confirmed this route was added in a prior session. If the route already exists and correctly enforces organizer-only + organizer_draft-only, skip the server step entirely and proceed to the client changes only.

Only add the route if it is genuinely missing or missing required guards. If adding, match DELETE /schedule/itinerary/:id exactly:

- requireAuth
- UUID validation on req.params.id
- Fetch the row, 404 if not found
- 403 if req.userId !== organizer_id
- 400 if itinerary_status !== 'organizer_draft' (only unsent drafts can be deleted)
- Hard-delete the row
- Return { message: 'Draft deleted.' }

---

2. Client — add delete button in GroupItineraryView.js

- Only render when itinerary_status === 'organizer_draft' AND is_organizer === true
- Place it below the header, above the suggestion cards
- Inline confirmation row — not window.confirm() and not a modal. "Delete this draft?" + "Yes, delete" + "Cancel", same pattern as Friends.js friend removal
- On confirm, call DELETE /group-itineraries/:id via the api util (add deleteGroupItinerary to utils/api.js if it doesn't exist), then navigate('/home') on success
- Inline error on failure, no navigation

---

No DB changes needed — hard delete on a draft row with no downstream FK dependencies that would cause issues (group_comments cascade deletes, nudges use ON DELETE SET NULL).

After changes: git add -A && git commit -m "Add delete draft button for group itineraries" && git push origin main.
```

---

## Notes on parity
Any time a feature touches one of these three flows, verify it works in all three:
- 1:1 itinerary (ItineraryView, schedule.js)
- Group itinerary (GroupItineraryView, group-itineraries.js)
- Remote mode (once shipped — no venue logic, same state machine)

The prompt should always call this out explicitly so Claude Code doesn't implement something in one place and skip the others.

---

## Bug batch: date spread + suggestion count + dedup + classifyIntent + GCal UUID + title error handling
Roadmap ref: Active bugs section
Status: Ready to run (March 14, 2026)
Parity: fixes apply to both schedule.js (1:1) and group-itineraries.js (group) unless noted

```
You are fixing multiple confirmed bugs. Read the following files before starting:
  - server/routes/schedule.js
  - server/routes/group-itineraries.js
  - client/src/pages/ItineraryView.js
  - client/src/pages/GroupItineraryView.js

Make all fixes below. Every fix that touches schedule.js must also be applied to the equivalent location in group-itineraries.js, and vice versa, unless the note explicitly says 1:1 only. Do not skip parity.

---

FIX 1 — findFreeWindows date clustering (BOTH route files)

In schedule.js: fix findFreeWindows().
In group-itineraries.js: fix findFreeWindowsForGroup().

Both functions fill windows sequentially from startDate and stop at maxWindows=20. When the calendar is open across a month-long range, all 20 windows land in the first 2–3 days.

Fix: after collecting all free windows up to an internal cap of 100, divide the full date range into 3 equal buckets. Sample up to 7 windows from each bucket (21 total, then trim to maxWindows=20). If a bucket has fewer than 7 free windows, fill the remainder from adjacent buckets rather than returning fewer than maxWindows. Return exactly maxWindows windows (or all found if fewer exist). Keep maxWindows=20 as the external return cap — only the selection strategy changes.

---

FIX 2 — Fewer than 3 suggestions + window reuse fallback (BOTH prompt builders)

In schedule.js: fix buildSuggestPrompt().
In group-itineraries.js: fix buildGroupSuggestPrompt().

Both already instruct Claude to "use different time windows for each suggestion when possible" but neither tells Claude what to do when fewer than 3 windows are available.

Replace the current time window instruction in both prompt builders with:
"Generate exactly 3 suggestions. Use different time windows and spread them across different parts of the scheduling window — do not cluster all suggestions near the earliest available dates. If fewer than 3 windows are available, reuse windows and vary activity, neighborhood, and vibe across suggestions instead. Never return fewer than 3 suggestions."

---

FIX 3 — No-duplicate-venues instruction (BOTH prompt builders, with single-card reroll exemption)
// KNOWN WATCH ITEM (logged March 14, 2026):
// The single-card reroll exemption relies on Claude correctly inferring user intent from the
// reroll prompt. The exemption text unlocks the behavior ("you are not bound by the no-duplicate
// rule") but does not guarantee Claude will execute it correctly. For example, if a user types
// "I want that rooftop bar but earlier" and the rooftop bar appears on card 2, Claude needs to
// infer the reference and act on it. If users report that single-card rerolls are (a) ignoring
// explicit venue references or (b) over-applying the dedup rule and refusing to use a venue the
// user asked for, the fix is in the single-card rerollNote wording — make the venue reference
// instruction more explicit, e.g. "If the user's prompt names or implies a venue visible on
// another card, treat that as a direct instruction to use that venue." Iterate on the prompt
// language before considering a structural fix.

In schedule.js: add to buildSuggestPrompt() Rules section.
In group-itineraries.js: add to buildGroupSuggestPrompt() Rules section.

The audit confirmed neither prompt builder has an explicit no-duplicate rule — only soft variety guidance. Add the following to the Rules section of both prompts, immediately after the existing venue variety rule:

"No venue should appear in more than one suggestion within this generated set. Each suggestion must use a completely distinct set of venues. This rule applies when generating multiple suggestions simultaneously (initial generation, full reroll, append). It does NOT apply to single-card rerolls — when replacing one card, the user may intentionally direct Claude toward a venue already shown on another card, and that is allowed."

Additionally, in both route files, find the rerollNote construction for single-card rerolls (where singleCard === true or replaceSuggestionId is set). Append to the existing single-card instruction:
"You are replacing a single card, not a full set. You are not bound by the cross-card no-duplicate venue rule — if the user's request references or implies a venue shown on another card, use it."

---

FIX 4 — classifyIntent('') returns home_likely, not ambiguous (schedule.js ONLY)

group-itineraries.js does not call classifyIntent() — it has its own inline home/venue split instruction in buildGroupSuggestPrompt. This fix is 1:1 only.

In schedule.js, classifyIntent() returns home_likely when contextPrompt is empty or whitespace-only. The spec says empty string should return ambiguous.

Fix: change the empty/blank guard at the top of classifyIntent() to return 'ambiguous' instead of 'home_likely'. Then verify the intentBlock logic in buildSuggestPrompt() — the 'ambiguous' branch should already exist ("Generate at least 1 of the 3 itineraries as a home-based plan. The others may be venue-based."). Confirm it is correct and no other logic depends on the old home_likely return for empty prompts.

While in group-itineraries.js: read the hardcoded home/venue split line in buildGroupSuggestPrompt. If it defaults to all-venue for an empty context prompt, add a comment confirming this is intentional for group events (groups default to venue-based). Do not change behavior, just verify and document.

---

FIX 5 — GCal event description missing itinerary UUID (schedule.js ONLY)

group-itineraries.js has no calendar write path yet. This fix is 1:1 only.

In createCalendarEventForUser() in schedule.js, the description field is built from suggestion.narrative and venueLines only. The itinerary UUID is never included.

Fix: append the itinerary UUID to the description field so calendar events can always be traced back to their itinerary row. Format:
  "\n\nRendezvous itinerary ID: {itineraryId}"

The itineraryId must be passed into createCalendarEventForUser as a new parameter. Find all call sites for createCalendarEventForUser, read what itinerary data is available at each call site, and pass the itinerary id from the DB row. Do not hardcode or guess.

---

FIX 6 — Event title save: silent catch and missing parity (BOTH client views)

In ItineraryView.js: fix handleSaveTitle().
In GroupItineraryView.js: find the equivalent title save handler and apply the same fix. If GroupItineraryView.js does not yet have an inline title edit at all, do not build it from scratch here — add a comment flagging the gap for a future prompt and move on.

Fix in both files where the handler exists:
- On catch, do NOT call setEditingTitle(false) — keep the input open so the user can retry
- Surface the specific error message inline below the title input field, same pattern used elsewhere in the file for other errors
- Add console.error logging so failures are visible in Vercel logs

---

No DB changes. No new routes.

After all fixes: git add -A && git commit -m "Fix: date spread, suggestion count, no-duplicate venues (with single-card exemption), classifyIntent empty string, GCal UUID, title error handling — parity across 1:1 and group" && git push origin main.
```

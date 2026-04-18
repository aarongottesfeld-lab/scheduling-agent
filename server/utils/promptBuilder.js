'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

// System prompt shared by both the suggest and reroll Claude calls.
// Defines the voice, constraints, and output contract for every generation.
// Kept as a constant so changes here apply to all routes simultaneously.
const RENDEZVOUS_SYSTEM_PROMPT =
  "You are Rendezvous, a sharp, well-connected activity planner who knows cities intimately. " +
  "You make plans like a trusted local friend — specific, opinionated, and practical. " +
  "You never use marketing language. You never say 'vibrant', 'perfect blend', 'iconic', or 'unique'. " +
  "You name real places, real activities, and real reasons why something works for two specific people. " +
  "When suggesting home-based plans, you describe what they'll actually do — the specific game, " +
  "the cooking project, the jam session — not just 'hang out at home'. " +
  "Always follow the JSON schema exactly as instructed.";

// Use Haiku in dev (cheap, fast for testing), Sonnet in production (quality suggestions)
const IS_PROD = process.env.NODE_ENV === 'production';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL
  || (IS_PROD ? 'claude-sonnet-4-5-20250929' : 'claude-haiku-4-5-20251001');

// Filler words excluded from keyword extraction in themeMatchesContextPrompt.
// These are common English words that appear in prompts but carry no activity signal.
const THEME_FILLER = new Set([
  'want', 'something', 'with', 'just', 'like', 'lets', "let's", 'going', 'maybe',
  'some', 'have', 'that', 'this', 'would', 'could', 'should', 'think', 'feel',
  'really', 'kind', 'sort', 'maybe', 'around', 'about', 'very', 'much', 'more',
]);

// Month/day name tables — avoids locale-dependent toLocaleDateString across Lambda envs.
const _MONTHS   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ── Helper functions ─────────────────────────────────────────────────────────

/** Format a UTC Date as "Friday, 2026-03-13 (Mar 13), 5:00 PM" */
function fmtWindowDate(d) {
  const year  = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day   = String(d.getUTCDate()).padStart(2, '0');
  const weekday = _WEEKDAYS[d.getUTCDay()];
  const monthName = _MONTHS[d.getUTCMonth()];
  let h = d.getUTCHours(), m = d.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12; else if (h === 0) h = 12;
  return `${weekday}, ${year}-${month}-${day} (${monthName} ${d.getUTCDate()}), ${h}:${String(m).padStart(2,'0')} ${ampm}`;
}

function formatTime12h(t) { // '14:00' → '2:00 PM'
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/**
 * Split blocks whose timeEnd < timeStart (midnight-crossing) into two entries:
 *   { date: D, timeStart: '17:00', timeEnd: '01:00' }
 * becomes:
 *   { date: D,   timeStart: '17:00', timeEnd: '23:59' }
 *   { date: D+1, timeStart: '00:00', timeEnd: '01:00' }
 */
function splitMidnightBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.timeStart && b.timeEnd && b.timeEnd < b.timeStart) {
      // First half: original date until end of day
      out.push({ ...b, timeEnd: '23:59' });
      // Second half: next day from midnight until original end time
      const d = new Date(b.date + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      const nextDate = d.toISOString().slice(0, 10);
      out.push({ ...b, date: nextDate, timeStart: '00:00' });
    } else {
      out.push(b);
    }
  }
  return out;
}

// ── Exported functions ───────────────────────────────────────────────────────

/**
 * Check whether at least one Claude suggestion plausibly matches the organizer's intent.
 * Used as a short-circuit to trigger a retry when Claude ignores an activity_specific prompt.
 *
 * Only meaningful for 'activity_specific' intents (e.g. "golf", "sushi dinner", "escape room").
 * Returns true (bypass retry) for: absent/blank contextPrompt, 'home_likely', 'ambiguous'.
 *
 * Matching is intentionally simple — no external calls, no NLP:
 *   1. Extract keywords from contextPrompt (words >3 chars, not in filler list).
 *   2. Concatenate each suggestion's title + narrative + tags into one lowercase string.
 *   3. Return true if ANY keyword appears in ANY suggestion's combined text.
 *
 * Never throws — returns true (skip retry) on any error so a bug here never blocks responses.
 *
 * @param {Array}  suggestions   - parsed suggestion objects from Claude
 * @param {string} contextPrompt - organizer's raw context string
 * @returns {boolean}
 */
function themeMatchesContextPrompt(suggestions, contextPrompt) {
  try {
    if (!contextPrompt || !contextPrompt.trim()) return true;
    // Only validate activity_specific intents — home/ambiguous are too open-ended to keyword-match.
    if (classifyIntent(contextPrompt) !== 'activity_specific') return true;
    if (!suggestions || suggestions.length === 0) return false;

    // Extract meaningful keywords: lowercase words longer than 3 chars, not in the filler set.
    const keywords = contextPrompt.toLowerCase()
      .split(/\s+/)
      .map(w => w.replace(/[^a-z]/g, '')) // strip punctuation
      .filter(w => w.length > 3 && !THEME_FILLER.has(w));

    if (keywords.length === 0) return true; // nothing meaningful to check — skip retry

    // Build a searchable blob per suggestion from title + narrative + tags.
    const blobs = suggestions.map(s =>
      [s.title, s.narrative, ...(s.tags || [])].join(' ').toLowerCase()
    );

    // Pass if ANY keyword matches ANY suggestion blob.
    return keywords.some(kw => blobs.some(blob => blob.includes(kw)));
  } catch {
    // Safety net: any unexpected error skips the retry to avoid blocking the response.
    return true;
  }
}

/**
 * Classify the organizer's intent based on the context prompt.
 * Used to decide how many home-based vs. venue-based itineraries Claude should generate.
 *
 * Returns one of:
 *   'home_likely'      — contextPrompt is absent or implies staying in
 *                        (e.g. "hang out", "chill", "come over", "game night")
 *   'activity_specific'— contextPrompt implies a specific out-of-home activity
 *                        (e.g. "dinner", "concert", "golf", "drinks", "museum")
 *   'ambiguous'        — doesn't clearly fit either category
 */
function classifyIntent(contextPrompt) {
  // No prompt at all → ambiguous (no signal to classify; let the prompt builder decide the home/venue split)
  if (!contextPrompt || !contextPrompt.trim()) return 'ambiguous';
  const text = contextPrompt.toLowerCase();

  // Single-card reroll patterns: "go to [place]" or "watch [title]" are near-literal
  // instructions — treat as activity_specific so Claude focuses on the named thing.
  // "go to" almost always means a specific venue, even if no venue name follows.
  if (/^\s*go\s+to\b/.test(text)) return 'activity_specific';

  // "watch [something] at [Named Venue]" — attending a live event (game, concert, show) at a
  // specific place.  The original-case text is used so uppercase venue names are detected.
  // e.g. "watch the Knicks at MSG", "watch the game at Madison Square Garden" → activity_specific.
  if (/\bwatch\b/.test(text) && /\bat [A-Z]/.test(contextPrompt)) {
    return 'activity_specific';
  }
  // "watch [something]" with no named venue → home streaming / movie night.
  // Still exempt explicit theater/cinema mentions so "watch a movie at the cinema" stays correct.
  if (/\bwatch\b/.test(text) && !/\b(theater|cinema|movie theater|imax)\b/.test(text)) {
    return 'home_likely';
  }

  // Keywords that strongly imply going out to a venue
  if (/\b(dinner|lunch|brunch|restaurant|bar|bars|drinks|cocktails|concert|show|museum|gallery|golf|bowling|movie theater|cinema|club|lounge|arcade|escape room|spa|class|workout|gym|hike|beach|park outing|sporting event|game night out|rooftop)\b/.test(text)) {
    return 'activity_specific';
  }

  // Keywords that suggest staying in / home-based hangout.
  // The possessive proper-noun check ("at Aaron's", "at Jamie's") uses the original-case
  // text so the capital letter is preserved, but is evaluated after the venue-name check
  // above — extractVenueName handles "at Carmine's" (named venue) while this catches
  // informal first-name possessives that clearly mean someone's home.
  const homePhrases =
    /\b(hang(ing)? out|chill|come over|just hang|at (my|your|his|her|their|our) (place|apartment|apt|house|flat|spot)|home|house|apartment|cook(ing)?|bake|movie night|netflix|jam(ming)?|game night|board games?|video games?|play(ing)? games?|night in|stay in|order in|take(out|away)|come (over|through|by)|head (over|to mine|to yours))\b/.test(text);
  // Possessive proper noun: "at Aaron's", "at Jamie's" — implies going to that person's place.
  // Deliberately excludes venue-style names (already caught by extractVenueName).
  const possessiveHome = /\bat [A-Z][a-z]+'s\b/.test(contextPrompt);
  if (homePhrases || possessiveHome) return 'home_likely';

  return 'ambiguous';
}

/**
 * Attempt to extract a specific named venue from a user-supplied context prompt.
 * Returns the extracted name string, or null if no specific venue is detected.
 *
 * Detection patterns (applied to the original-case text, not lowercased):
 *   "go to [Venue Name]"              — strongest signal
 *   "at [Venue Name]" / "dinner at"   — activity + preposition pattern
 *
 * The captured name is limited to 2–50 characters and must start with a capital
 * letter so that generic phrases like "go to a bar" are not mistakenly extracted.
 */
function extractVenueName(text) {
  if (!text) return null;
  // "go to [Venue Name]" — capture the capitalized phrase after "go to"
  let m = text.match(/\bgo\s+to\s+([A-Z][^.!?\n,]{1,49})/);
  if (m) return m[1].trim();
  // "[preposition] [Venue Name]" — "drinks at", "dinner at", "meet at", etc.
  m = text.match(/\b(?:at|dinner at|drinks at|lunch at|meet at|brunch at|going to)\s+([A-Z][^.!?\n,]{1,49})/);
  if (m) return m[1].trim();
  return null;
}

/**
 * Build the venue-substitution instruction block for a named venue.
 * Injected into the Claude prompt when a specific venue is referenced so Claude
 * doesn't silently drop it or return a generic suggestion if the venue can't be used.
 */
function buildVenueSubstitutionBlock(venueName) {
  return `VENUE SUBSTITUTION RULE: If "${venueName}" is unavailable, closed during the requested time window, or cannot be confirmed as a real place, do NOT omit it silently or return a generic suggestion. Instead, find the closest alternative that matches on ALL of these dimensions:
  - Vibe and atmosphere (e.g. speakeasy-style, casual dive, upscale cocktail bar)
  - Price point (use the same general tier)
  - Neighborhood or proximity to the original venue's location
  - Relevant to the same time of day and occasion
In the suggestion output, include a note field explaining the substitution: "${venueName} is closed at this time — [Substitute] has a similar [vibe/price/location]." The note should be honest and specific, not generic.`;
}

/**
 * Build the EXCLUDED WINDOWS block for the Claude prompt.
 * Returns empty string when blocks is empty — no injection occurs.
 * Handles both full-day blocks and specific time ranges.
 */
function buildExcludedWindowsBlock(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  const lines = blocks.map(b => {
    let line = `- ${b.date}`;
    if (b.timeStart && b.timeEnd) line += ` from ${formatTime12h(b.timeStart)} to ${formatTime12h(b.timeEnd)}`;
    else if (b.timeStart)         line += ` from ${formatTime12h(b.timeStart)} onwards`;
    if (b.label) line += ` — ${b.label}`;
    return line;
  }).join('\n');
  return `\nEXCLUDED WINDOWS (strictly enforced):\nDo NOT suggest plans on any of these organizer-blocked dates:\n${lines}`;
}

/**
 * Build the ATTENDEE CONSTRAINTS block for the Claude prompt.
 * Only injected on rerolls after an attendee has declined and left notes.
 */
function buildAttendeeNotesBlock(notes) {
  if (!notes || typeof notes !== 'string' || !notes.trim()) return '';
  return `\nATTENDEE CONSTRAINTS (from previous decline):\nThe attendee noted: "${notes.trim()}"`;
}

/**
 * Build the ATTENDEE CONSTRAINTS block for group itineraries.
 * notesMap is { userId: notesString }. Concatenates all non-empty notes.
 */
function buildGroupAttendeeNotesBlock(notesMap) {
  if (!notesMap || typeof notesMap !== 'object') return '';
  const entries = Object.values(notesMap).filter(n => n && typeof n === 'string' && n.trim());
  if (entries.length === 0) return '';
  const lines = entries.map(n => `- "${n.trim()}"`).join('\n');
  return `\nATTENDEE CONSTRAINTS (from previous declines):\nSome attendees noted these scheduling constraints:\n${lines}`;
}

/**
 * Derive a human-readable city/area string from two location strings.
 * Used to give Claude geographic context without hardcoding NYC.
 * Returns empty string if neither user has a location set.
 */
function deriveGeoContext(userA, userB) {
  const locA = userA.location?.trim();
  const locB = userB.location?.trim();
  if (!locA && !locB) return ''; // no locations — omit geographic anchoring entirely
  if (locA && locB && locA !== locB) {
    return `${userA.name} is based in ${locA}; ${userB.name} is based in ${locB}.`;
  }
  return `Both users are based in ${locA || locB}.`;
}

/**
 * Build the Claude prompt for generating itinerary suggestions.
 *
 * Parameter additions vs. original:
 *   sharedInterests    {string[]} — interests tagged on this friendship (from friend_annotations);
 *                                  injected explicitly so Claude can weight them highly.
 *   organizerFirstName {string}  — first name of the organizer, used in home-based agenda copy.
 *   attendeeFirstName  {string}  — first name of the attendee, used in home-based agenda copy.
 *
 * Structural changes:
 *   1. contextPrompt moved to top with "MOST IMPORTANT" framing so Claude treats it as
 *      the primary constraint before reading any profile data.
 *   2. sharedInterests injected as an explicit line if present.
 *   3. Dietary and mobility restrictions promoted from soft suggestions to hard NEVER constraints.
 *   4. NYC / Manhattan / New York hardcoding removed; geographic context derived from user
 *      profile locations instead. If locations are absent, city anchoring is omitted.
 *   5. classifyIntent() drives a home vs. venue instruction block so home-based suggestions
 *      are generated when the intent is casual/vague, and venue-focused when specific.
 *   6. location_type field added to the JSON schema so the client can badge home vs. venue cards.
 */
function buildSuggestPrompt({ userA, userB, freeWindows, contextPrompt, maxTravelMinutes, eventTitle, durationMinutes, sharedInterests, organizerFirstName, attendeeFirstName, pastHistory = [], localEvents = [], activityVenuesBlock = '', locationPreference = 'system_choice', travelMode = 'local', tripDurationDays = 1, destination = null, excludedWindowsBlock = '', attendeeBusyNotesBlock = '', priorityEventBlock = '' }) {
  const windowList = freeWindows.slice(0, 15).map(w => {
    const s = new Date(w.start);
    const e = new Date(w.end);
    let eh = e.getUTCHours(), em2 = e.getUTCMinutes();
    const eampm = eh >= 12 ? 'PM' : 'AM';
    if (eh > 12) eh -= 12; else if (eh === 0) eh = 12;
    return `- ${fmtWindowDate(s)} – ${eh}:${String(em2).padStart(2,'0')} ${eampm}`;
  }).join('\n');

  // Geographic context derived from user profiles — no hardcoded city.
  // If neither user has a location, this is empty and the geo line is omitted.
  const geoContext = deriveGeoContext(userA, userB);

  // Classify the organizer's intent so Claude knows how many home vs. venue plans to generate.
  // The first names are interpolated into the instruction so Claude can say "at Aaron's place".
  const orgFirst = organizerFirstName || userA.name?.split(' ')[0] || 'the organizer';
  const attFirst = attendeeFirstName  || userB.name?.split(' ')[0] || 'the attendee';

  // Remote mode: skip classifyIntent entirely and override with a virtual-only instruction.
  let intentBlock;
  if (travelMode === 'remote') {
    intentBlock = `REMOTE MODE: These people are not meeting in person. Suggest virtual/remote activities only — video calls with a shared activity (cooking the same recipe, watching a film simultaneously, playing an online game together), multiplayer game sessions, collaborative playlists, watch parties, etc. Do NOT suggest any physical venues, restaurants, bars, or activities that require being in the same location. All 3 suggestions should be remote-friendly. Set location_type to "home" for all suggestions since no venue is involved.`;
  } else {
    const intent = classifyIntent(contextPrompt);
    intentBlock = intent === 'home_likely'
      ? `HOME VS. VENUE SPLIT: Generate 2 of the 3 itineraries as home-based plans — one at ${orgFirst}'s place and one at ${attFirst}'s place. Include what they'd do (cook together, watch a game, jam, play games, etc.) based on their shared interests. The 3rd itinerary should be a venue-based option as an alternative. Do not suggest restaurants or bars as the primary activity for home-based agendas. Set location_type to "home" for home plans and "venue" for the venue option.`
      : intent === 'ambiguous'
      ? `HOME VS. VENUE SPLIT: Generate at least 1 of the 3 itineraries as a home-based plan. The others may be venue-based. Set location_type accordingly.`
      : `HOME VS. VENUE SPLIT: All 3 itineraries should be venue-based. Focus on the specific activity requested. Set location_type to "venue" for all.`;
  }

  // Dietary restrictions as hard NEVER constraints, one per person.
  // Filtered to non-empty, non-"none" values so we only emit real restrictions.
  const dietaryA = (userA.dietary_restrictions || []).filter(r => r && r !== 'none');
  const dietaryB = (userB.dietary_restrictions || []).filter(r => r && r !== 'none');
  const dietaryConstraints = [
    ...(dietaryA.length ? [`NEVER suggest any venue that cannot fully accommodate ${userA.name}'s dietary restrictions: ${dietaryA.join(', ')}. This is a hard requirement, not a preference.`] : []),
    ...(dietaryB.length ? [`NEVER suggest any venue that cannot fully accommodate ${userB.name}'s dietary restrictions: ${dietaryB.join(', ')}. This is a hard requirement, not a preference.`] : []),
  ].join('\n');

  // Mobility restrictions as hard NEVER constraints, same pattern as dietary above.
  const mobilityA = (userA.mobility_restrictions || []).filter(r => r && r !== 'none');
  const mobilityB = (userB.mobility_restrictions || []).filter(r => r && r !== 'none');
  const mobilityConstraints = [
    ...(mobilityA.length ? [`NEVER suggest venues that do not meet ${userA.name}'s accessibility needs: ${mobilityA.join(', ')}. This is a hard requirement, not a preference.`] : []),
    ...(mobilityB.length ? [`NEVER suggest venues that do not meet ${userB.name}'s accessibility needs: ${mobilityB.join(', ')}. This is a hard requirement, not a preference.`] : []),
  ].join('\n');

  const hardConstraints = [dietaryConstraints, mobilityConstraints].filter(Boolean).join('\n');

  // ── Location anchoring block ───────────────────────────────────────────────
  // Tells Claude which geographic area to anchor venue suggestions to.
  // closer_to_organizer / closer_to_attendee: use that user's profile location.
  //   If that location is missing, fall through to system_choice silently.
  // system_choice: use the derived geo context (equidistant / best connected area).
  // orgFirst / attFirst are already declared above (intent block) — reused here.
  // Remote mode: skip entirely — no physical location is relevant.
  const orgLocation = userA.location?.trim();
  const attLocation = userB.location?.trim();

  let locationAnchorBlock;
  if (travelMode === 'remote') {
    locationAnchorBlock = '';
  } else if (locationPreference === 'closer_to_organizer' && orgLocation) {
    locationAnchorBlock =
      `\nLOCATION ANCHORING\nSuggest venues in or near ${orgLocation}. ` +
      `${orgFirst} wants plans closer to their side of the city.`;
  } else if (locationPreference === 'closer_to_attendee' && attLocation) {
    locationAnchorBlock =
      `\nLOCATION ANCHORING\nSuggest venues in or near ${attLocation}. ` +
      `${orgFirst} wants plans closer to ${attFirst}'s side of the city.`;
  } else {
    // system_choice (default), or fallback when the requested location is missing.
    // Only emit the block when geoContext is available — no point repeating an empty string.
    locationAnchorBlock = geoContext
      ? `\nLOCATION ANCHORING\nBoth users are located in: ${geoContext}. ` +
        `Suggest venues in a convenient area between them — consider neighborhoods ` +
        `that are roughly equidistant or well-connected by transit.`
      : '';
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Travel mode block (Step 6) ─────────────────────────────────────────────
  // Injected after LOCATION ANCHORING. Local mode emits no block.
  // Travel mode tells Claude this is a multi-day trip and enforces the geographic
  // containment rule: all stops must stay within a single region across all days.
  // Null destination falls back to organizer's profile location to prevent Claude
  // from choosing an arbitrary anchor — the root cause of city-hopping itineraries.
  let travelModeBlock = '';
  if (travelMode === 'travel') {
    const geoAnchor    = destination || orgLocation || attLocation || 'the destination';
    const durationLabel = tripDurationDays === 1 ? '1-day'
      : tripDurationDays === 2 ? 'weekend'
      : `${tripDurationDays}-day`;
    travelModeBlock =
      `\nTRAVEL MODE: This is a ${durationLabel} trip. ` +
      (destination
        ? `The destination is: ${destination}. Generate all venue suggestions in or near ${destination}.`
        : `No destination specified — anchor all venue suggestions near ${orgLocation || 'the organizer\'s location'}.`) +
      `\nGEOGRAPHIC CONSTRAINT (strictly enforced): All stops across all days must remain within ` +
      `a single city or metro region. Home base: ${geoAnchor}. ` +
      `Do NOT suggest travel between different cities on different days. ` +
      `Day trips must return to the home base — never treat a day trip as a pivot to a new region for subsequent days.` +
      (tripDurationDays >= 2
        ? ` A "Weekend" trip means 2 days in one place, not a multi-city tour. ` +
          `Day 1 (arrival) and last day (departure): account for travel logistics — no full-day activity schedules on travel days unless the destination is driveable.`
        : '');
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Multi-day JSON schema (Step 5) ────────────────────────────────────────
  // For multi-day trips (tripDurationDays > 1), Claude must return a days array
  // per suggestion instead of a flat venues array. Single-day still uses venues
  // (write side wraps to days structure before DB save; read side has backward-compat shim).
  const isMultiDay = tripDurationDays > 1;
  const multiDayInstructionsBlock = isMultiDay
    ? `MULTI-DAY TRIP INSTRUCTIONS (strictly enforced for all ${tripDurationDays} days):
- Generate a complete, distinct activity plan for EVERY day — not just Day 1.
- Each day must have at least 2 named stops with real venue names and addresses.
- Follow a logical day structure: morning activity → afternoon activity → evening/dinner. Not every day needs all three, but each day should feel like a full, considered plan.
- Day 1 is typically arrival — keep it lighter (1-2 activities, afternoon/evening only unless the destination is driveable same-day). Last day is typically departure — keep it to morning only.
- Every day across the trip must use completely different venues. Do not repeat a venue across days.
- Vary the energy level across days — not every day should be the same intensity. Mix active days with relaxed days where appropriate.
- The narrative for each day should describe what makes that specific day's plan worth doing, not just list the venues.`
    : '';
  const venueSchema = isMultiDay
    ? `"days": [
        { "day": 1, "label": "Arrival afternoon", "stops": [
            { "name": "Venue Name", "type": "bar|restaurant|activity|venue|home", "address": "123 Main St, City, State" },
            { "name": "Dinner Spot", "type": "restaurant", "address": "456 Oak Ave, City, State" }
          ]
        },
        { "day": 2, "label": "Main day", "stops": [
            { "name": "Morning Activity", "type": "activity", "address": "789 Park Rd, City, State" },
            { "name": "Lunch Spot", "type": "restaurant", "address": "321 River St, City, State" },
            { "name": "Evening Venue", "type": "bar", "address": "654 Main St, City, State" }
          ]
        }
      ]
      // ... repeat structure for all tripDurationDays days`
    : `"venues": [
        { "name": "Venue Name or Person's Home", "type": "bar|restaurant|activity|venue|home", "address": "123 Main St, City, State (omit for home)" }
      ]`;
  // ──────────────────────────────────────────────────────────────────────────

  return `You are Rendezvous, an activity planner. Generate exactly 3 itinerary suggestions for two people to meet up.
${geoContext ? `GEOGRAPHIC CONTEXT: ${geoContext}` : ''}
ADDRESS ACCURACY (strictly enforced): Every venue address must be real and correct. Do NOT fabricate or guess street addresses — if you are not confident a venue exists at a specific address, use only the venue name and neighborhood without a numbered street address. In New York City, be precise about boroughs: Manhattan venues must have Manhattan/New York addresses, Brooklyn venues must have Brooklyn addresses. Do NOT place a Manhattan venue at a Brooklyn address or vice versa.
${eventTitle ? `EVENT NAME: "${eventTitle}"` : ''}

${contextPrompt
  // contextPrompt is placed first and framed as the primary constraint so Claude
  // treats the user's explicit intent above all profile-derived preferences.
  ? `MOST IMPORTANT — treat this as the primary constraint above all other preferences: ${contextPrompt}\n`
  : ''}
PERSON A: ${userA.name}
Location: ${userA.location || 'not specified'}
Into: ${(userA.activity_preferences || []).join(', ') || 'general activities'}

PERSON B: ${userB.name}
Location: ${userB.location || 'not specified'}
Into: ${(userB.activity_preferences || []).join(', ') || 'general activities'}
${
  // Inject shared interests explicitly — these are interests the organizer has tagged on
  // this specific friendship and should be weighted more heavily than general preferences.
  sharedInterests && sharedInterests.length > 0
    ? `\nInterests this pair has in common: ${sharedInterests.join(', ')}`
    : ''
}${locationAnchorBlock}${travelModeBlock}${
  // Past accepted plans for this pair — used as a taste signal so Claude can avoid
  // repeating plans they've already done and learn what kinds of things they enjoy.
  // Injected as context, not as a template: the instruction explicitly says not to repeat.
  pastHistory && pastHistory.length > 0
    ? `\nWHAT HAS WORKED FOR THIS PAIR BEFORE (accepted plans — use as context, not as a template to repeat):\n` +
      pastHistory.map(p =>
        `- ${p.title}: ${p.neighborhood || 'unspecified area'}, venues: ${p.venues.join(', ') || 'N/A'}, tags: ${p.tags.join(', ') || 'none'}`
      ).join('\n') +
      `\nUse this as a taste signal only. Do NOT suggest these specific plans or revisit these venues.`
    : ''
}${priorityEventBlock}${
  // Live events block — only injected when events were found. If empty, omit entirely:
  // never send Claude a "no events found" message, which could bias output toward apology.
  // Events are optional context: Claude should only anchor a suggestion on one if it
  // genuinely fits both users' interests and the requested date range.
  localEvents && localEvents.length > 0
    ? `${priorityEventBlock ? '\n' : ''}\nAVAILABLE TIME-SENSITIVE EVENTS\nThe following real events are happening during the requested date range. If any align well with the users' interests and context, you MAY anchor one suggestion around an event. This is optional — only use an event if it genuinely fits. Do not force events that don't match.\n` +
      localEvents.map(ev =>
        `- ${ev.title} at ${ev.venue_name || 'TBD'} (${ev.date}${ev.time ? ' at ' + ev.time : ''}) — ${ev.category || 'Event'} — Ticket link: ${ev.url}`
      ).join('\n') +
      `\nIf you use an event as the anchor for a suggestion, set "event_source": "${localEvents[0]?.source || 'ticketmaster'}" (or "eventbrite" as appropriate) and include the ticket URL in a top-level "event_url" field on that suggestion object.`
    : ''
}${
  // Activity venues block — injected when the context prompt references a specific
  // physical activity or hobby and real nearby venues were found via Places API.
  // Claude should anchor at least one suggestion to these venues when present.
  activityVenuesBlock || ''
}
AVAILABLE TIME WINDOWS (use one per suggestion):
${windowList || 'Flexible — pick reasonable times in the next 2 weeks'}${excludedWindowsBlock}${attendeeBusyNotesBlock}

MAX TRAVEL TIME: ${maxTravelMinutes ? maxTravelMinutes + ' minutes each way' : 'no limit'}
EVENT DURATION: Set durationMinutes based on the actual activity planned (e.g. coffee/drinks=60, lunch=75-90, dinner=90-120, bar night=120, concert/game/show=150-180, hike/full day=240-360). Do not default to 120 for everything — reason about what the activity actually takes.

${intentBlock}
${hardConstraints ? `\nHARD REQUIREMENTS — these are non-negotiable:\n${hardConstraints}` : ''}${multiDayInstructionsBlock ? `\n${multiDayInstructionsBlock}` : ''}
Return ONLY a JSON object (no markdown, no preamble) in this exact shape:
{
  "suggestions": [
    {
      "id": "s1",
      "title": "Short catchy title",
      "date": "YYYY-MM-DD",
      "time": "7:00 PM",
      "durationMinutes": 120,
      "location_type": "home|venue|mixed",
      "neighborhood": "Neighborhood extracted from the first venue's address (e.g. 'Williamsburg' not 'Brooklyn', 'Flatiron' not 'Manhattan') — must match where the primary venue actually is",
      ${venueSchema},
      "narrative": "2-3 sentences. Be specific and direct — name the actual activity and why the spot is good. Skip the flowery adjectives. No 'perfect blend', 'vibrant', or similar filler. Just tell them what they're doing and why it makes sense for both people.",
      "estimatedTravelA": "15 min",
      "estimatedTravelB": "20 min",
      // AUDIT-NOTE: tags are generated by Claude but not currently consumed by the
      // client. Before Audit 3, evaluate whether to wire tags into filtering/display
      // or remove them from the schema to reduce hallucination surface area and token
      // waste. If unused at that point, remove.
      "tags": ["cocktails", "rooftop"],
      // Optional — only set when this suggestion is anchored on a real event fetched
      // from Ticketmaster or Eventbrite. Omit entirely for venue-based or home suggestions.
      "event_source": "ticketmaster|eventbrite|places|home",
      // Optional — deep link to the event's ticket/detail page. Only present when
      // event_source is 'ticketmaster' or 'eventbrite'. Rendered as "Get tickets →" in the UI.
      "event_url": "https://...",
      // Optional — only set when this suggestion is anchored to a venue from the
      // activity-specific Places API discovery pass. Omit for all other suggestions.
      "activity_source": "places_activity",
      // Optional — the detected activity type key (e.g. 'tennis', 'pottery', 'board_games').
      // Only present alongside activity_source. Used for badge rendering in the UI.
      "activity_type": "tennis",
      // Optional — website URL for the activity venue, from the Places Details API.
      // Rendered as "Reserve / Book →" in the UI. Omit if no website was found.
      "venue_url": "https://...",
      // Optional — only set when this suggestion is anchored to a PRIORITY EVENT.
      // Shape: { title, date, time }. Claude should populate this on the anchored suggestion only.
      "priority_event": { "title": "Knicks vs. Pacers", "date": "March 18, 2026", "time": "7:30 PM ET" }
    }
  ]
}

Rules:
- All venues must be real, currently open establishments
- Spread suggestions across different vibes (e.g. chill, active, social)
- Generate exactly 3 suggestions. Use different time windows and spread them across different parts of the scheduling window — do not cluster all suggestions near the earliest available dates. If fewer than 3 windows are available, reuse windows and vary activity, neighborhood, and vibe across suggestions instead. Never return fewer than 3 suggestions.
- Venue variety: do not default to the most popular or highest-rated spots. Mix well-known places with neighborhood spots and less obvious choices. Avoid recommending the same venues repeatedly across sessions.
- Free and public options are valid and often preferred: parks, public courts, piers, plazas, beaches, trails, free museum nights, open-air markets. If the activity is naturally free (spikeball, frisbee, picnic, running), suggest a specific named park or public space — not a paid venue. Do not bias toward paid experiences.
- Cost range across suggestions: aim for a mix — at least one low-cost or free option per set of suggestions when the context allows it. Users should not feel like every plan requires spending money.
- Narrative tone: direct and practical, like a friend who knows the area recommending something. Name specific things about the venues. No marketing language, no "perfect blend of X and Y", no "vibrant" or "iconic". Just what it is and why it works.
- No venue should appear in more than one suggestion within this generated set. Each suggestion must use a completely distinct set of venues. This rule applies when generating multiple suggestions simultaneously (initial generation, full reroll, append). It does NOT apply to single-card rerolls — when replacing one card, the user may intentionally direct Claude toward a venue already shown on another card, and that is allowed.`;
}

/**
 * Build the Claude prompt for a group itinerary.
 * Group-adapted version of buildSuggestPrompt from schedule.js:
 *   - Uses group description + context_prompt as the primary AI signal
 *   - Lists all member names and preferences (not just organizer + attendee)
 *   - Aggregates dietary and mobility restrictions across all members as hard constraints
 *   - Injects group size so Claude can reason about venue capacity
 */
function buildGroupSuggestPrompt({ groupName, groupDescription, members, freeWindows, contextPrompt, eventTitle, maxTravelMinutes, durationMinutes = 120, pastHistory = [], localEvents = [], activityVenuesBlock = '', locationPreference = 'system_choice', travelMode = 'local', tripDurationDays = 1, destination = null, rerollNote = '', excludedWindowsBlock = '', attendeeBusyNotesBlock = '', priorityEventBlock = '' }) {
  const windowList = freeWindows.slice(0, 15).map(w => {
    const s = new Date(w.start);
    const e = new Date(w.end);
    let eh = e.getUTCHours(), em2 = e.getUTCMinutes();
    const eampm = eh >= 12 ? 'PM' : 'AM';
    if (eh > 12) eh -= 12; else if (eh === 0) eh = 12;
    return `- ${fmtWindowDate(s)} – ${eh}:${String(em2).padStart(2,'0')} ${eampm}`;
  }).join('\n');

  // Derive geo context from member locations.
  const locations = members.map(m => m.location).filter(Boolean);
  const uniqueLocations = [...new Set(locations)];
  const geoContext = uniqueLocations.length === 1
    ? `All members are based in ${uniqueLocations[0]}.`
    : uniqueLocations.length > 1
    ? `Members are based in: ${uniqueLocations.join(', ')}.`
    : '';

  // Location anchoring block — mirrors schedule.js pattern.
  // Remote mode: skip entirely — no physical location is relevant.
  const organizerLocation = members.find(m => m.isOrganizer)?.location?.trim();
  let locationAnchorBlock = '';
  if (travelMode !== 'remote') {
    if (locationPreference === 'closer_to_organizer' && organizerLocation) {
      locationAnchorBlock = `\nLOCATION ANCHORING\nSuggest venues in or near ${organizerLocation}. The organizer wants plans closer to their area.`;
    } else if (geoContext) {
      locationAnchorBlock = `\nLOCATION ANCHORING\n${geoContext} Suggest venues in a convenient area for the group — consider neighborhoods that are roughly equidistant or well-connected by transit.`;
    }
  }

  // Travel mode block — mirrors schedule.js pattern.
  const attLocation = members.filter(m => !m.isOrganizer).map(m => m.location).find(Boolean) || '';
  let travelModeBlock = '';
  if (travelMode === 'travel') {
    const geoAnchor    = destination || organizerLocation || attLocation || 'the destination';
    const durationLabel = tripDurationDays === 1 ? '1-day'
      : tripDurationDays === 2 ? 'weekend'
      : `${tripDurationDays}-day`;
    travelModeBlock =
      `\nTRAVEL MODE: This is a ${durationLabel} group trip. ` +
      (destination
        ? `The destination is: ${destination}. Generate all venue suggestions in or near ${destination}.`
        : `No destination specified — anchor all venue suggestions near ${organizerLocation || 'the organizer\'s location'}.`) +
      `\nGEOGRAPHIC CONSTRAINT (strictly enforced): All stops across all days must remain within ` +
      `a single city or metro region. Home base: ${geoAnchor}. Do NOT suggest travel between different cities on different days.` +
      (tripDurationDays >= 2
        ? ` A "Weekend" trip means 2 days in one place, not a multi-city tour.`
        : '');
  }

  // Multi-day schema — mirrors schedule.js Step 5.
  const isMultiDay = tripDurationDays > 1;
  const multiDayInstructionsBlock = isMultiDay
    ? `MULTI-DAY TRIP INSTRUCTIONS (strictly enforced for all ${tripDurationDays} days):
- Generate a complete, distinct activity plan for EVERY day — not just Day 1.
- Each day must have at least 2 named stops with real venue names and addresses.
- Follow a logical day structure: morning activity → afternoon activity → evening/dinner. Not every day needs all three, but each day should feel like a full, considered plan.
- Day 1 is typically arrival — keep it lighter (1-2 activities, afternoon/evening only unless the destination is driveable same-day). Last day is typically departure — keep it to morning only.
- Every day across the trip must use completely different venues. Do not repeat a venue across days.
- Vary the energy level across days — not every day should be the same intensity. Mix active days with relaxed days where appropriate.
- The narrative for each day should describe what makes that specific day's plan worth doing, not just list the venues.`
    : '';
  const venueSchema = isMultiDay
    ? `"days": [
        { "day": 1, "label": "Arrival afternoon", "stops": [
            { "name": "Venue Name", "type": "bar|restaurant|activity|venue|home", "address": "123 Main St, City, State" },
            { "name": "Dinner Spot", "type": "restaurant", "address": "456 Oak Ave, City, State" }
          ]
        },
        { "day": 2, "label": "Main day", "stops": [
            { "name": "Morning Activity", "type": "activity", "address": "789 Park Rd, City, State" },
            { "name": "Lunch Spot", "type": "restaurant", "address": "321 River St, City, State" },
            { "name": "Evening Venue", "type": "bar", "address": "654 Main St, City, State" }
          ]
        }
      ]
      // ... repeat structure for all tripDurationDays days`
    : `"venues": [
        { "name": "Venue Name", "type": "bar|restaurant|activity|venue|home", "address": "123 Main St, City, State (omit for home)" }
      ]`;

  // Aggregate dietary and mobility restrictions as hard constraints.
  // Attributed to each member by name so Claude knows who the restriction belongs to.
  const hardConstraintLines = [];
  members.forEach(m => {
    const dietary  = (m.dietary_restrictions  || []).filter(r => r && r !== 'none');
    const mobility = (m.mobility_restrictions || []).filter(r => r && r !== 'none');
    if (dietary.length)  hardConstraintLines.push(`NEVER suggest any venue that cannot fully accommodate ${m.full_name}'s dietary restrictions: ${dietary.join(', ')}. This is a hard requirement, not a preference.`);
    if (mobility.length) hardConstraintLines.push(`NEVER suggest venues that do not meet ${m.full_name}'s accessibility needs: ${mobility.join(', ')}. This is a hard requirement, not a preference.`);
  });
  const hardConstraints = hardConstraintLines.join('\n');

  // Member list for the prompt — all group members.
  const memberBlock = members.map(m =>
    `- ${m.full_name}${m.isOrganizer ? ' (organizer)' : ''}: ${(m.activity_preferences || []).join(', ') || 'general activities'}`
  ).join('\n');

  // Group events default to venue-based when contextPrompt is empty — intentional, no classifyIntent() call here.
  // Remote mode: override with virtual-only instruction.
  const groupIntentBlock = travelMode === 'remote'
    ? `REMOTE MODE: This group is not meeting in person. Suggest virtual/remote activities only — video calls with a shared activity (cooking the same recipe, watching a film simultaneously, playing an online game together), multiplayer game sessions, collaborative playlists, watch parties, etc. Do NOT suggest any physical venues, restaurants, bars, or activities that require being in the same location. All 3 suggestions should be remote-friendly. Set location_type to "home" for all suggestions since no venue is involved.`
    : `HOME VS. VENUE SPLIT: For a group event, prefer venue-based suggestions unless the group context strongly implies a home setting. Set location_type to "venue" or "home" accordingly.`;

  return `You are Rendezvous, an activity planner. Generate exactly 3 itinerary suggestions for a group of ${members.length} people.
${geoContext ? `GEOGRAPHIC CONTEXT: ${geoContext}` : ''}
ADDRESS ACCURACY (strictly enforced): Every venue address must be real and correct. Do NOT fabricate or guess street addresses — if you are not confident a venue exists at a specific address, use only the venue name and neighborhood without a numbered street address. In New York City, be precise about boroughs: Manhattan venues must have Manhattan/New York addresses, Brooklyn venues must have Brooklyn addresses. Do NOT place a Manhattan venue at a Brooklyn address or vice versa.
${eventTitle ? `EVENT NAME: "${eventTitle}"` : ''}
GROUP: ${groupName}${groupDescription ? `\nGROUP CONTEXT: ${groupDescription}` : ''}
GROUP SIZE: ${members.length} people — suggest venues with adequate capacity for this group size. Reserve-friendly spots are preferred over walk-in-only.
${contextPrompt ? `\nMOST IMPORTANT — treat this as the primary constraint above all other preferences: ${contextPrompt}\n` : ''}
MEMBERS:
${memberBlock}
${locationAnchorBlock}${travelModeBlock}
${pastHistory && pastHistory.length > 0
  ? `\nWHAT HAS WORKED FOR THIS GROUP BEFORE (accepted plans — use as context, not as a template to repeat):\n` +
    pastHistory.map(p =>
      `- ${p.title}: ${p.neighborhood || 'unspecified area'}, venues: ${p.venues.join(', ') || 'N/A'}, tags: ${p.tags.join(', ') || 'none'}`
    ).join('\n') +
    `\nUse this as a taste signal only. Do NOT suggest these specific plans or revisit these venues.`
  : ''}
${priorityEventBlock}${
localEvents && localEvents.length > 0
  ? `${priorityEventBlock ? '\n' : ''}\nAVAILABLE TIME-SENSITIVE EVENTS\nThe following real events are happening during the requested date range. If any align well with the group's interests and context, you MAY anchor one suggestion around an event. This is optional — only use an event if it genuinely fits.\n` +
    localEvents.map(ev =>
      `- ${ev.title} at ${ev.venue_name || 'TBD'} (${ev.date}${ev.time ? ' at ' + ev.time : ''}) — ${ev.category || 'Event'} — Ticket link: ${ev.url}`
    ).join('\n') +
    `\nIf you use an event, set "event_source": "${localEvents[0]?.source || 'ticketmaster'}" and include the ticket URL in a top-level "event_url" field.`
  : ''}
${activityVenuesBlock || ''}
AVAILABLE TIME WINDOWS (use one per suggestion):
${windowList || 'Flexible — pick reasonable times in the next 2 weeks'}${excludedWindowsBlock}${attendeeBusyNotesBlock}

MAX TRAVEL TIME: ${maxTravelMinutes ? maxTravelMinutes + ' minutes each way' : 'no limit'}
EVENT DURATION: Set durationMinutes based on the actual activity planned (coffee/drinks=60, lunch=75-90, dinner=90-120, bar night=120, concert/game/show=150-180, hike/full day=240-360).

${groupIntentBlock}
${hardConstraints ? `\nHARD REQUIREMENTS — these are non-negotiable:\n${hardConstraints}` : ''}${multiDayInstructionsBlock ? `\n${multiDayInstructionsBlock}` : ''}
Return ONLY a JSON object (no markdown, no preamble) in this exact shape:
{
  "suggestions": [
    {
      "id": "s1",
      "title": "Short catchy title",
      "date": "YYYY-MM-DD",
      "time": "7:00 PM",
      "durationMinutes": 120,
      "location_type": "home|venue|mixed",
      "neighborhood": "Neighborhood extracted from the first venue's address (e.g. 'Williamsburg' not 'Brooklyn', 'Flatiron' not 'Manhattan') — must match where the primary venue actually is",
      ${venueSchema},
      "narrative": "2-3 sentences. Be specific — name the actual activity and why the spot works for this group. No marketing language. Just what they're doing and why it makes sense.",
      "estimatedTravelA": "15 min",
      "tags": ["cocktails", "rooftop"],
      // Optional — only set when this suggestion is anchored to a PRIORITY EVENT.
      // Shape: { title, date, time }. Claude should populate this on the anchored suggestion only.
      "priority_event": { "title": "Knicks vs. Pacers", "date": "March 18, 2026", "time": "7:30 PM ET" }
    }
  ]
}

${rerollNote ? `\nREROLL INSTRUCTION (highest priority):\n${rerollNote}\n` : ''}Rules:
- All venues must be real, currently open establishments with sufficient capacity for ${members.length} people
- Spread suggestions across different vibes (chill, active, social)
- Generate exactly 3 suggestions. Use different time windows and spread them across different parts of the scheduling window — do not cluster all suggestions near the earliest available dates. If fewer than 3 windows are available, reuse windows and vary activity, neighborhood, and vibe across suggestions instead. Never return fewer than 3 suggestions.
- Venue variety: mix well-known places with neighborhood spots
- Free and public options are valid: parks, public courts, plazas, beaches, trails
- No venue should appear in more than one suggestion within this generated set. Each suggestion must use a completely distinct set of venues. This rule applies when generating multiple suggestions simultaneously (initial generation, full reroll, append). It does NOT apply to single-card rerolls — when replacing one card, the user may intentionally direct Claude toward a venue already shown on another card, and that is allowed.
- The neighborhood field must be derived from the first venue's actual address — never from a different area`;
}

/**
 * Looks up a user's first name by their Supabase UUID.
 * Used for notification body text (e.g. "Jamie rolled new suggestions").
 * Falls back to 'Someone' if the profile can't be found.
 */
async function getProfileName(userId, supabase) {
  const { data } = await supabase.from('profiles').select('full_name').eq('id', userId).single();
  return data?.full_name?.split(' ')[0] || 'Someone';
}

/**
 * Fetch the last N accepted itineraries shared between two users (in either direction).
 * Used to give Claude context on what this pair has already done together, so new
 * suggestions feel fresh rather than repeating plans they've already made.
 *
 * Returns a lightweight array of objects: { title, neighborhood, venues[], tags[] }.
 * Never throws — returns [] on any error so a DB hiccup never blocks generation.
 *
 * @param {string} organizerId - UUID of the current organizer
 * @param {string} attendeeId  - UUID of the current attendee
 * @param {object} supabase    - Supabase client
 * @param {number} limit       - max past itineraries to return (default 3)
 */
async function fetchAcceptedPairHistory(organizerId, attendeeId, supabase, limit = 3) {
  try {
    // Query itineraries where either user was the organizer, both accepted, and the plan locked.
    const { data, error } = await supabase
      .from('itineraries')
      .select('id, suggestions, selected_suggestion_id, context_prompt, locked_at')
      .or(
        `and(organizer_id.eq.${organizerId},attendee_id.eq.${attendeeId}),` +
        `and(organizer_id.eq.${attendeeId},attendee_id.eq.${organizerId})`
      )
      .eq('organizer_status', 'accepted')
      .eq('attendee_status', 'accepted')
      .not('locked_at', 'is', null)
      .order('locked_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    // For each itinerary, extract the selected suggestion (matched by selected_suggestion_id).
    // Fall back to the first suggestion if the ID can't be matched (shouldn't happen in practice).
    return data.flatMap(itin => {
      const suggestions = itin.suggestions || [];
      const selected = suggestions.find(s => s.id === itin.selected_suggestion_id)
        || suggestions[0];
      if (!selected) return [];
      return [{
        title:        selected.title        || '',
        neighborhood: selected.neighborhood || '',
        // Step 5 backward-compat: new rows store venues in days[0].stops; older rows use flat venues[].
        // Use days[0].stops when present, fall back to venues for pre-migration rows.
        venues:       (selected.days?.[0]?.stops ?? selected.venues ?? []).map(v => v.name).filter(Boolean),
        tags:         selected.tags         || [],
      }];
    });
  } catch (err) {
    console.warn('fetchAcceptedPairHistory failed:', err.message);
    return [];
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  RENDEZVOUS_SYSTEM_PROMPT,
  CLAUDE_MODEL,
  THEME_FILLER,
  themeMatchesContextPrompt,
  classifyIntent,
  extractVenueName,
  buildVenueSubstitutionBlock,
  buildExcludedWindowsBlock,
  buildAttendeeNotesBlock,
  buildGroupAttendeeNotesBlock,
  deriveGeoContext,
  buildSuggestPrompt,
  buildGroupSuggestPrompt,
  getProfileName,
  fetchAcceptedPairHistory,
};

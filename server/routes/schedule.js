// routes/schedule.js — scheduling engine
//
// POST /schedule/suggest       — AI suggestion engine (creates a new itinerary)
// GET  /schedule/itineraries   — list the current user's itineraries
// GET  /schedule/itinerary/:id — fetch a single itinerary with profiles
// POST /schedule/itinerary/:id/send     — notify attendee that organizer has sent
// POST /schedule/itinerary/:id/decline  — decline the itinerary
// POST /schedule/itinerary/:id/reroll   — regenerate suggestions
// POST /schedule/confirm       — accept / counter-propose a suggestion
// PATCH /schedule/itinerary/:id/title   — update event title
// POST  /schedule/itinerary/:id/changelog — append a changelog entry
// DELETE /schedule/itinerary/:id — hard-delete a draft
//
// Session access:
//   This router receives a `sessionStore` object (not the old in-memory Map).
//   sessionStore.getSessionBySupabaseId(id) → async, returns session or null.
//   Used to look up Google Calendar tokens for other users (friend free/busy,
//   organizer/attendee calendar event creation).

'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const { createOAuth2Client, createCalendarEventForUser } = require('../utils/calendarUtils');
const fetchBusyAggregated = require('../utils/fetchBusyAggregated');
const { enrichVenues, extractCityFromGeoContext } = require('../utils/venueEnrichment');
const { fetchLocalEvents } = require('../utils/events');
const { extractActivityType, fetchActivityVenues, buildActivityVenuesBlock } = require('../utils/activityVenues');
const { classifyRerollIntent } = require('../utils/classifyRerollIntent');
const { dispatchNotification } = require('../utils/notificationDispatch');
const { extractCulturalSignal } = require('../utils/extractCulturalSignal');
const fetchCulturalEvent = require('../utils/fetchCulturalEvent');
const { UUID_RE, isValidUUID, INJECTION_RE, sanitizePromptInput } = require('../utils/validation');
const { RATE_LIMIT_EXEMPT } = require('../utils/rateLimitExempt');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_CONTEXT  = 500;  // contextPrompt / feedback chars

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
 * Count venues with venue_verified === true across all suggestions.
 * Used by telemetry to track how many venues were successfully confirmed
 * by the Places API enrichment layer.
 * @param {Array} suggestions - Claude suggestion objects with venues[]
 * @returns {number}
 */
function countVerified(suggestions) {
  return (suggestions || []).reduce((n, s) =>
    n + (s.venues || []).filter(v => v.venue_verified === true).length, 0);
}

/**
 * Count venues with venue_verified === false across all suggestions.
 * This includes both Places API misses and home venues (intentionally skipped).
 * Tracked separately from verified count so the ratio is queryable in analytics.
 * @param {Array} suggestions - Claude suggestion objects with venues[]
 * @returns {number}
 */
function countUnverified(suggestions) {
  return (suggestions || []).reduce((n, s) =>
    n + (s.venues || []).filter(v => v.venue_verified === false).length, 0);
}

/* ── Helpers ──────────────────────────────────────────────────────── */

/**
 * Fetch busy slots for a user. Uses real Google Calendar if tokens exist,
 * otherwise falls back to mock_busy_slots from the profile row (test users).
 *
 * Throws if we have tokens but the Google API call fails — so the caller
 * can surface an error rather than treating a calendar failure as "no busy slots"
 * and generating suggestions against incorrect availability data.
 */
async function fetchBusy(session, startISO, endISO, supabase, userId) {
  // Real calendar path — aggregate across all connected calendars for this user
  if (session?.tokens?.access_token) {
    return fetchBusyAggregated(supabase, userId, session.tokens, startISO, endISO);
  }
  // Mock fallback for test users (no OAuth tokens)
  if (userId && supabase) {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('mock_busy_slots')
        .eq('id', userId)
        .single();
      const slots = data?.mock_busy_slots || [];
      const start = new Date(startISO);
      const end   = new Date(endISO);
      return slots
        .filter(s => new Date(s.end) > start && new Date(s.start) < end)
        .map(s => ({ start: s.start, end: s.end }));
    } catch (e) {
      console.warn('fetchBusy (mock) failed:', e.message);
    }
  }
  return [];
}

/**
 * Parse a time-of-day filter into [startHour, endHour] in the user's LOCAL time (24h).
 * The returned hours are in local time and must be converted to UTC before use.
 */
function timeOfDayHours(tod) {
  if (!tod || tod.type === 'any') return [8, 23];
  if (tod.type === 'morning')   return [8, 12];
  if (tod.type === 'afternoon') return [12, 17];
  if (tod.type === 'evening')   return [17, 23];
  if (tod.type === 'custom') {
    const [timePart, ampm] = tod.time.split(' ');
    let [h] = timePart.split(':').map(Number);
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    const winHours = Math.ceil((Number(tod.windowMinutes) || 60) / 60);
    return [Math.max(0, h - winHours), Math.min(23, h + winHours)];
  }
  return [8, 23];
}

/**
 * Generate candidate 2-hour windows across a date range that don't overlap busy slots.
 *
 * Hours are computed in UTC throughout. The caller must convert local time-of-day
 * preferences to UTC using timezoneOffsetMinutes (from the client's
 * Intl.DateTimeFormat().resolvedOptions().timeZone converted to an offset, or
 * new Date().getTimezoneOffset()). getTimezoneOffset() returns minutes WEST of UTC,
 * so EDT = +240. To convert local hour → UTC: utcHour = localHour + offset/60.
 *
 * Busy slots from Google Calendar freebusy are already in UTC, so the overlap
 * check is a straight UTC-vs-UTC comparison.
 */
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
 * Infer event duration in minutes from the event title and optional context.
 * Used to size free-window slots and as a hint to Claude for durationMinutes.
 * Errs toward the typical activity length; defaults to 2 hours.
 */
function inferDurationMinutes(eventTitle, contextPrompt) {
  const text = `${eventTitle || ''} ${contextPrompt || ''}`.toLowerCase();
  if (/\bday[ -]?trip\b|full[ -]?day\b|all[ -]?day\b/.test(text))                          return 360;
  if (/\bhike\b|\bbiking\b|\bsurfing\b|\bclimbing\b/.test(text))                            return 240;
  if (/\bmovie\b|\bfilm\b|\bconcert\b|\bshow\b|\bgame\b|\bmatch\b|\bknicks\b|\bmets\b|\byankees\b|\bgiants\b|\bjets\b|\bnets\b/.test(text)) return 180;
  if (/\bdinner\b|\bdate\b|\bnight\s+out\b|\beverning\s+out\b/.test(text))                  return 120;
  if (/\blunch\b|\bbrunch\b/.test(text))                                                     return 90;
  if (/\bcoffee\b|\bdrinks\b|\bcatch[ -]?up\b|\bquick\b|\bchat\b/.test(text))               return 60;
  return 120;
}

/**
 * Return free time windows within a date range that don't overlap any busy slot.
 * Both busyA (organizer) and busyB (attendee) can be passed — pass [] to skip one.
 * Windows are sized to durationMinutes so Claude gets slots the event will actually fit in.
 *
 * @param {Array}  busyA                - organizer busy slots [{start, end}]
 * @param {Array}  busyB                - attendee busy slots
 * @param {string} startDate            - "YYYY-MM-DD" inclusive
 * @param {string} endDate              - "YYYY-MM-DD" inclusive
 * @param {object} todFilter            - { type: 'morning'|'afternoon'|'evening'|'any' }
 * @param {number} maxWindows           - cap on returned windows (default 20)
 * @param {number} timezoneOffsetMinutes - client's getTimezoneOffset() value (EDT=240)
 * @param {number} durationMinutes      - slot size in minutes (default 120)
 */
function findFreeWindows(busyA, busyB, startDate, endDate, todFilter, maxWindows = 20, timezoneOffsetMinutes = 0, durationMinutes = 120) {
  const [localStart, localEnd] = timeOfDayHours(todFilter);
  // Convert local hours to UTC hours using the client's timezone offset.
  const offsetHours  = timezoneOffsetMinutes / 60;  // positive = west of UTC (e.g. EDT = +4)
  const utcStart     = Math.max(0,  localStart + offsetHours);
  const utcEnd       = Math.min(47, localEnd   + offsetHours); // 47 allows wrapping past midnight UTC
  const durationHours = durationMinutes / 60;
  const durationMs   = durationMinutes * 60000;

  // Collect up to 100 candidate windows sequentially, then sample across 3 equal buckets
  // to ensure suggestions are spread across the full date range rather than clustered early.
  const INTERNAL_CAP = 100;
  const allWindows = [];
  // Use UTC date construction so the loop is timezone-agnostic on any server.
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59));

  while (cur <= end && allWindows.length < INTERNAL_CAP) {
    // Step by 1 hour through the day; each window spans durationMinutes from that hour.
    for (let h = utcStart; h + durationHours <= utcEnd; h += 1) {
      const wStart = new Date(cur);
      wStart.setUTCHours(h, 0, 0, 0);
      const wEnd = new Date(wStart.getTime() + durationMs);

      const overlaps = (slots) => slots.some(s => {
        const sStart = new Date(s.start);
        const sEnd   = new Date(s.end);
        return sStart < wEnd && sEnd > wStart;
      });

      if (!overlaps(busyA) && !overlaps(busyB)) {
        allWindows.push({ start: wStart.toISOString(), end: wEnd.toISOString() });
        if (allWindows.length >= INTERNAL_CAP) break;
      }
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  if (allWindows.length === 0) return [];

  // Divide all found windows into 3 equal buckets and sample up to 7 from each.
  // This spreads returned windows across early, mid, and late portions of the date range.
  const bucketSize = Math.ceil(allWindows.length / 3);
  const buckets = [
    allWindows.slice(0, bucketSize),
    allWindows.slice(bucketSize, bucketSize * 2),
    allWindows.slice(bucketSize * 2),
  ];
  const perBucket = 7;
  const sampled = [];
  // First pass: take up to perBucket from each bucket.
  const remainders = buckets.map(b => {
    const take = b.slice(0, perBucket);
    sampled.push(...take);
    return b.slice(perBucket); // leftover windows
  });
  // Second pass: fill remainder quota from adjacent buckets (left to right) until maxWindows.
  for (const leftover of remainders) {
    for (const w of leftover) {
      if (sampled.length >= maxWindows) break;
      sampled.push(w);
    }
    if (sampled.length >= maxWindows) break;
  }

  return sampled.slice(0, maxWindows);
}

/**
 * Build the Claude prompt for generating itinerary suggestions.
 * Window strings include the year (e.g. "Wed, Mar 12, 2026") to prevent Claude from
 * defaulting to the prior year when the free windows span a year boundary or when
 * Claude's training data year differs from the current calendar year.
 */
// Month/day name tables for unambiguous UTC date formatting in the Claude prompt.
// We avoid toLocaleDateString/toLocaleTimeString because ICU data availability
// varies across Lambda environments and can produce unexpected formats.
const _MONTHS  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/** Format a UTC Date as "Friday, 2026-03-13, 5:00 PM" */
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
/**
 * Build the EXCLUDED WINDOWS block for the Claude prompt.
 * Returns empty string when blocks is empty — no injection occurs.
 * Handles both full-day blocks and specific time ranges.
 */
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

/**
 * @param {object} sessionStore - { getSessionBySupabaseId } — replaces the old userSessions Map.
 *   getSessionBySupabaseId(supabaseId) is async and queries the Supabase sessions table.
 */
module.exports = function scheduleRouter(app, supabase, requireAuth, sessionStore, requireInternalKey) {

  /* ── POST /schedule/suggest ──────────────────────────────── */
  app.post('/schedule/suggest', requireAuth, async (req, res) => {
    const { targetUserId, startDate, endDate, timeOfDay, maxTravelMinutes, contextPrompt, eventTitle, timezoneOffsetMinutes, confirmedOrganizerConflict, locationPreference: rawLocationPreference, travel_mode: rawTravelMode, trip_duration_days: rawTripDurationDays, destination: rawDestination, manual_busy_blocks: rawBusyBlocks } = req.body;
    // Validate and default location_preference — all four values are valid now that
    // travel mode (steps 5–6) ships. 'destination' is used when travel_mode='travel'.
    const VALID_LOCATION_PREFS = new Set(['closer_to_organizer', 'closer_to_attendee', 'system_choice', 'destination']);
    const locationPreference = VALID_LOCATION_PREFS.has(rawLocationPreference)
      ? rawLocationPreference
      : 'system_choice';
    // travel_mode: 'local' | 'travel' | 'remote'. Default 'local'.
    const travelMode = ['travel', 'remote'].includes(rawTravelMode) ? rawTravelMode : 'local';
    // trip_duration_days: int 1–30. Default 1. Client sends 1 / 2 / 5 via the duration picker.
    const tripDurationDays = Math.max(1, Math.min(30, parseInt(rawTripDurationDays) || 1));
    // destination: free text. Only relevant when travel_mode='travel'. Sanitize and cap at 100 chars.
    const destination = (travelMode === 'travel' && typeof rawDestination === 'string')
      ? rawDestination.trim().slice(0, 100) || null
      : null;
    // manual_busy_blocks: array of { date: 'YYYY-MM-DD', label?: string }. Cap at 20 entries.
    // Midnight-crossing blocks (timeEnd < timeStart) are split into two date entries.
    const manualBusyBlocks = splitMidnightBlocks(
      Array.isArray(rawBusyBlocks)
        ? rawBusyBlocks
            .slice(0, 20)
            .filter(b => b && typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date))
            .map(b => {
              const entry = { date: b.date };
              if (typeof b.label === 'string' && b.label.trim())
                entry.label = sanitizePromptInput(b.label.trim().slice(0, 80));
              if (typeof b.timeStart === 'string' && /^\d{2}:\d{2}$/.test(b.timeStart))
                entry.timeStart = b.timeStart;
              if (typeof b.timeEnd === 'string' && /^\d{2}:\d{2}$/.test(b.timeEnd))
                entry.timeEnd = b.timeEnd;
              return entry;
            })
        : []
    );
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required.' });

    // Validate UUID format before any DB queries — mirrors the check in friends.js.
    // Without this, a malformed value reaches .eq('id', targetUserId) and Supabase
    // returns an opaque error instead of a clean 400.
    if (!isValidUUID(targetUserId)) return res.status(400).json({ error: 'Invalid targetUserId.' });

    // ── Daily rate limit ──────────────────────────────────────────────────────
    // Cap each user at 10 new itinerary suggestions per UTC calendar day.
    // Counted against the itineraries table (organizer_id = this user, created today).
    // Checked before any profile fetches or Claude calls to fail fast and cheaply.
    // The cap resets at UTC midnight — `todayUTC` is YYYY-MM-DD in UTC.
    const todayUTC = new Date().toISOString().split('T')[0]; // e.g. "2026-03-12"
    const { count: suggestCount, error: countErr } = await supabase
      .from('itineraries')
      .select('*', { count: 'exact', head: true }) // '*' required — Supabase JS v2 only populates .count when selector is '*'; head:true skips returning rows
      .eq('organizer_id', req.userId)
      .gte('created_at', `${todayUTC}T00:00:00.000Z`);

    if (countErr) {
      // Log but don't block on a count failure — fail open so a DB hiccup
      // doesn't permanently lock users out of suggesting.
      console.warn('suggest rate-limit count failed:', countErr.message);
    } else if (suggestCount >= 10 && !RATE_LIMIT_EXEMPT.has(req.userSession?.email)) {
      // SECURITY-REVIEW: RATE_LIMIT_EXEMPT bypasses per-user rate limiting for listed emails.
      // Ensure this list stays minimal and does not become a broad backdoor. Audit before any
      // public/multi-tenant expansion.
      return res.status(429).json({ error: 'Daily suggestion limit reached. Try again tomorrow.' });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // tzOffset is derived from the client's Intl timezone, forwarded as timezoneOffsetMinutes
    // (matches new Date().getTimezoneOffset() — positive = west of UTC, so EDT = 240).
    // Computed early because it's needed for both the date-window floor and findFreeWindows.
    const tzOffset = Number(timezoneOffsetMinutes) || 0;

    // Date window floor: never suggest times in the past. Uses local time, not UTC —
    // see timezone bug fix in reroll route.
    // Convert "now" to the user's local date by subtracting the UTC offset.
    // Without this, a UTC+10 user would receive a `today` anchored to UTC's yesterday.
    const localNowMs = Date.now() - tzOffset * 60000;
    const localToday = new Date(localNowMs).toISOString().split('T')[0];

    // Clamp the effective start to the later of the organizer-chosen date and local today.
    // This prevents generating windows for dates that are already fully in the past.
    const start = (startDate && startDate >= localToday) ? startDate : localToday;
    const end   = endDate   || (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().split('T')[0]; })();

    // now + 1 hour as an absolute UTC timestamp — used to strip individual windows
    // whose start time has already passed (intra-day portion of the date floor).
    // The +1h buffer gives the user time to actually act before the slot starts.
    const windowFloorMs = Date.now() + 60 * 60 * 1000;

    // Load both profiles
    const [profileARes, profileBRes] = await Promise.all([
      supabase.from('profiles').select('id,full_name,location,activity_preferences,dietary_restrictions,mobility_restrictions').eq('id', req.userId).single(),
      supabase.from('profiles').select('id,full_name,location,activity_preferences,dietary_restrictions,mobility_restrictions').eq('id', targetUserId).single(),
    ]);

    const userA = { name: req.userSession.name || 'User A', ...profileARes.data };
    const userB = { name: profileBRes.data?.full_name || 'Friend', ...profileBRes.data };

    // Fetch calendar availability for both users
    const startISO = new Date(start + 'T00:00:00').toISOString();
    const endISO   = new Date(end   + 'T23:59:59').toISOString();

    // Look up the friend's session to access their Google Calendar tokens.
    // getSessionBySupabaseId intentionally ignores session expiry — we only need the
    // OAuth tokens, which googleapis will auto-refresh via the stored refresh_token.
    // Returns null if the friend has never connected their calendar.
    const friendSession = await sessionStore.getSessionBySupabaseId(targetUserId);

    let busyA, busyB;
    try {
      [busyA, busyB] = await Promise.all([
        fetchBusy(req.userSession,  startISO, endISO, supabase, req.userId),
        fetchBusy(friendSession,    startISO, endISO, supabase, targetUserId),
      ]);
    } catch (e) {
      console.error('fetchBusy failed:', e.message);
      return res.status(502).json({
        error: 'Could not read calendar availability. Make sure both users have connected Google Calendar.',
      });
    }

    // tzOffset is now computed above, before start/end — moved to support the date floor.

    const durationMinutes = inferDurationMinutes(eventTitle, contextPrompt);

    // Windows where the attendee is free — used to detect if the attendee is simply unavailable.
    // Strip past windows immediately so the length === 0 check below reflects real future availability.
    const attendeeWindows = findFreeWindows([], busyB, start, end, timeOfDay, 20, tzOffset, durationMinutes)
      .filter(w => new Date(w.start).getTime() >= windowFloorMs);

    // If the attendee is fully booked in the requested window, bail out early.
    if (attendeeWindows.length === 0) {
      return res.status(422).json({
        error: 'No availability found in the selected time window. Try a different date or time of day.',
      });
    }

    // Windows where BOTH organizer and attendee are free — the ideal case.
    // If any exist, use them and skip the organizer entirely (their conflicts are excluded naturally).
    // Only warn the organizer if they are completely blocked across the entire window with no gaps.
    // Strip past windows for the same reason as attendeeWindows above.
    const bothWindows = findFreeWindows(busyA, busyB, start, end, timeOfDay, 20, tzOffset, durationMinutes)
      .filter(w => new Date(w.start).getTime() >= windowFloorMs);
    let freeWindows;
    if (bothWindows.length > 0) {
      // Organizer has some free time — use shared windows, no warning needed.
      freeWindows = bothWindows;
    } else if (!confirmedOrganizerConflict) {
      // Organizer is fully blocked but attendee has availability — ask for confirmation.
      return res.status(200).json({ needsConfirmation: true });
    } else {
      // Organizer confirmed override — schedule across their conflicts using attendee-only windows.
      // attendeeWindows is already past-filtered above.
      freeWindows = attendeeWindows;
    }

    // Sanitize user-supplied free-text before injecting into the Claude prompt.
    // Strips prompt-injection patterns and enforces the 500-char hard cap.
    const safeContext = sanitizePromptInput(contextPrompt);

    // If the organizer named a specific venue in their context prompt, prepend a
    // substitution instruction so Claude doesn't silently drop it or return a generic
    // suggestion if that venue is unavailable.
    const suggestVenueName = extractVenueName(contextPrompt);
    const suggestVenueBlock = suggestVenueName ? buildVenueSubstitutionBlock(suggestVenueName) : '';
    const finalSuggestContext = [suggestVenueBlock, safeContext].filter(Boolean).join('\n');

    // Fetch shared interests from friend_annotations — organizer's annotation of the attendee.
    // Queried from the organizer's perspective (user_id = organizer, friend_id = attendee).
    // Best-effort: a missing or errored annotation is non-fatal; we just omit the field.
    const { data: annotationData } = await supabase
      .from('friend_annotations')
      .select('shared_interests')
      .eq('user_id', req.userId)
      .eq('friend_id', targetUserId)
      .maybeSingle();
    const sharedInterests = annotationData?.shared_interests || [];

    // Fetch past accepted plans for this pair — gives Claude taste-signal context.
    // Best-effort: a failure returns [] and silently omits the history block.
    const pastHistory = await fetchAcceptedPairHistory(req.userId, targetUserId, supabase);

    // Derive geo context once — reused by fetchLocalEvents, fetchActivityVenues,
    // and the venue enrichment pass below. Avoids calling deriveGeoContext 3× per request.
    const geoContext = deriveGeoContext(userA, userB);

    // Fetch live events for the requested city + date range from Ticketmaster and Eventbrite.
    // Interests are used only for local relevance scoring — never sent to external APIs.
    // Best-effort: a failure returns [] and silently omits the events block from the prompt.
    let localEvents = [];
    try {
      localEvents = await fetchLocalEvents(
        geoContext,
        start,
        end,
        [...(userA.activity_preferences || []), ...(userB.activity_preferences || [])],
      );
    } catch (eventsErr) {
      console.error('[suggest] fetchLocalEvents failed:', eventsErr.message);
    }

    // Activity/hobby venue discovery — proactively fetch real nearby venues when
    // the context prompt mentions a specific activity (tennis, pottery, escape room, etc.).
    // Injects a verified venue list into the prompt so Claude anchors suggestions to
    // real locations rather than hallucinating venue names.
    // Best-effort: any failure leaves activityVenuesBlock as '' and generation continues.
    let activityVenuesBlock = '';
    let detectedActivityType = null;
    let activityVenueCount = 0;
    try {
      detectedActivityType = extractActivityType(safeContext);
      if (detectedActivityType) {
        const cityContext    = extractCityFromGeoContext(geoContext);
        const activityVenues = await fetchActivityVenues(detectedActivityType, cityContext);
        activityVenueCount   = activityVenues.length;
        activityVenuesBlock  = buildActivityVenuesBlock(detectedActivityType, activityVenues);
      }
    } catch (activityErr) {
      console.error('[activityVenues] suggest route failed:', activityErr.message);
    }

    // ── Cultural signal detection ─────────────────────────────────────────────
    // Detect if the organizer's context references a sports game or awards ceremony,
    // then resolve the actual event date/time within the scheduling window.
    // Best-effort: any failure leaves priorityEvent null and generation continues.
    const culturalSignal = extractCulturalSignal(safeContext, [
      ...(userA.activity_preferences || []),
      ...(userB.activity_preferences || []),
    ]);
    let priorityEvent = null;
    if (culturalSignal) {
      try {
        priorityEvent = await fetchCulturalEvent(
          culturalSignal.type,
          culturalSignal.entity,
          start,
          end
        );
      } catch (culturalErr) {
        console.warn('[suggest] fetchCulturalEvent failed:', culturalErr.message);
      }
    }
    const priorityEventBlock = priorityEvent
      ? `\nPRIORITY EVENT (mandatory anchor — you MUST build at least one suggestion around this):\n` +
        `${priorityEvent.title} — ${priorityEvent.date}${priorityEvent.time ? ' at ' + priorityEvent.time : ''}\n` +
        `Venue: ${priorityEvent.venue}\n` +
        `Instruction: Anchor exactly one of the three suggestions around this event. ` +
        `Time the suggestion so it leads into the event (e.g. pre-game dinner, drinks before the show). ` +
        `The other two suggestions should be independent alternatives that don't reference this event.`
      : '';
    // ─────────────────────────────────────────────────────────────────────────

    // Call Claude
    // Extract first names so the prompt can reference "at Aaron's place" in home-based agendas.
    const organizerFirstName = (userA.full_name || userA.name || '').split(' ')[0] || '';
    const attendeeFirstName  = (userB.full_name || userB.name || '').split(' ')[0] || '';
    const prompt = buildSuggestPrompt({ userA, userB, freeWindows, contextPrompt: finalSuggestContext, maxTravelMinutes, eventTitle, durationMinutes, sharedInterests, organizerFirstName, attendeeFirstName, pastHistory, localEvents, activityVenuesBlock, locationPreference, travelMode, tripDurationDays, destination, excludedWindowsBlock: buildExcludedWindowsBlock(manualBusyBlocks), priorityEventBlock });
    let suggestions;
    try {
      const msg = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        system: RENDEZVOUS_SYSTEM_PROMPT, // voice + output contract shared with the reroll call
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = msg.content[0]?.text || '{}';
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      suggestions = parsed.suggestions || [];
    } catch (e) {
      console.error('Claude suggestion error:', e.message, e.stack?.split('\n')[1]);
      // Never expose internal API errors (billing, keys, etc.) to the client
      return res.status(500).json({ error: 'Could not generate suggestions. Please try again.' });
    }

    // ── Theme-match retry (suggest) ──────────────────────────────────────────
    // If the organizer gave an activity_specific prompt (e.g. "bowling", "sushi dinner")
    // but none of Claude's suggestions reflect that activity, retry once with a
    // strengthened prompt that makes the requirement explicit.
    // Only one retry — if it also misses or fails, we keep the original suggestions.
    // Flags are declared outside the block so the telemetry object below can read them.
    let retryAttempted = false;
    let retrySucceeded = false;
    {
      const needsRetry =
        contextPrompt &&
        classifyIntent(contextPrompt) === 'activity_specific' &&
        !themeMatchesContextPrompt(suggestions, contextPrompt);

      if (needsRetry) {
        // ── RETRY POINT ──────────────────────────────────────────────────────
        retryAttempted = true;
        console.error('[suggest] retry_attempted: true — no suggestions matched context:', contextPrompt);
        const retryInstruction =
          `RETRY — the previous attempt did not return any suggestions matching "${safeContext}". ` +
          `This is mandatory: at least one of the 3 suggestions MUST directly feature "${safeContext}" ` +
          `as the primary activity. Do not substitute a thematically adjacent activity.`;
        const retryPrompt = buildSuggestPrompt({
          userA, userB, freeWindows,
          // Prepend the retry instruction before the normal context so Claude sees it first.
          contextPrompt: [retryInstruction, finalSuggestContext].filter(Boolean).join('\n'),
          maxTravelMinutes, eventTitle, durationMinutes,
          sharedInterests, organizerFirstName, attendeeFirstName, pastHistory, localEvents, activityVenuesBlock, locationPreference, travelMode, tripDurationDays, destination,
          excludedWindowsBlock: buildExcludedWindowsBlock(manualBusyBlocks),
          priorityEventBlock,
        });
        try {
          const retryMsg = await anthropic.messages.create({
            model: CLAUDE_MODEL, max_tokens: 2000,
            system: RENDEZVOUS_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: retryPrompt }],
          });
          const retryRaw    = retryMsg.content[0]?.text || '{}';
          const retryParsed = JSON.parse(retryRaw.replace(/```json|```/g, '').trim());
          const retrySugs   = retryParsed.suggestions;
          if (Array.isArray(retrySugs) && retrySugs.length > 0) {
            suggestions = retrySugs;
            retrySucceeded = true;
            console.error('[suggest] retry_succeeded: true');
          } else {
            console.error('[suggest] retry_succeeded: false — retry returned empty, using original');
          }
        } catch (retryErr) {
          // Retry failed — use the original suggestions rather than blocking the response.
          console.error('[suggest] retry_succeeded: false — retry threw:', retryErr.message);
        }
        // ── END RETRY POINT ──────────────────────────────────────────────────
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // Validate Claude's suggestions against the free windows.
    // Claude occasionally picks times that weren't in the provided window list.
    // We reject any suggestion whose local date+time (converted to UTC via the client's
    // timezone offset) doesn't overlap with at least one computed free window.
    //
    // Pre-filter snapshot: saved so we can backfill below if the filter drops us under 3.
    const suggestionsBeforeWindowFilter = suggestions.slice();
    suggestions = suggestions.filter(s => {
      if (!s.date || !s.time) return true; // can't validate, keep it
      const match = s.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!match) return true;
      let h = parseInt(match[1]);
      const min = parseInt(match[2]);
      const ampm = match[3].toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      const [sy2, sm2, sd2] = s.date.split('-').map(Number);
      // Treat the suggestion's date+time as local, then shift to UTC using client offset.
      // Date.UTC gives us ms for those numbers in UTC; adding tzOffset (minutes west) converts
      // to true UTC (e.g. 7 PM EDT + 240 min = 11 PM UTC).
      const localMs  = Date.UTC(sy2, sm2 - 1, sd2, h, min, 0);
      const utcStart = new Date(localMs + tzOffset * 60000);
      const durMs    = (s.durationMinutes || durationMinutes) * 60000;
      const utcEnd   = new Date(utcStart.getTime() + durMs);
      const inWindow = freeWindows.some(w =>
        utcStart < new Date(w.end) && utcEnd > new Date(w.start)
      );
      if (!inWindow) {
        console.warn(`[suggest] Dropping hallucinated suggestion: ${s.date} ${s.time} (UTC ${utcStart.toISOString()})`);
      }
      return inWindow;
    });

    // ── Window-filter fallback (suggest) ─────────────────────────────────────
    // If the window filter dropped suggestions below 3, backfill from the pre-filter
    // set rather than returning fewer cards to the user. Root cause: Claude occasionally
    // picks times slightly outside computed free windows due to timezone edge cases or
    // prompt interpretation. A slightly imprecise time is a better UX than 1 suggestion.
    // This mirrors the single-card reroll fallback already in the reroll route.
    if (suggestions.length < 3 && suggestionsBeforeWindowFilter.length > suggestions.length) {
      const keptTitles = new Set(suggestions.map(s => s.title));
      const dropped = suggestionsBeforeWindowFilter.filter(s => !keptTitles.has(s.title));
      for (const fb of dropped) {
        if (suggestions.length >= 3) break;
        console.warn(`[suggest] Backfilling window-filtered suggestion to reach 3: ${fb.date} ${fb.time}`);
        suggestions.push(fb);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Venue enrichment (suggest) ────────────────────────────────────────────
    // Attach Places API data (place_id, formatted_address, rating, price_level)
    // to each non-home venue. Best-effort — if enrichment throws or the API key
    // is missing, we log and continue with Claude's unenriched suggestions.
    try {
      // geoContext was already computed above — reuse rather than calling deriveGeoContext again
      const cityCtx = extractCityFromGeoContext(geoContext);
      suggestions   = await enrichVenues(suggestions, cityCtx);
    } catch (enrichErr) {
      console.error('[suggest] enrichVenues failed, continuing unenriched:', enrichErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Step 5: wrap venues into days structure before DB save ────────────────
    // Uniform schema: every suggestion has a days array regardless of trip length.
    // Single-day (tripDurationDays === 1): Claude returned venues[], we wrap to days[0].
    // Multi-day (tripDurationDays > 1): Claude returned days[] directly per the updated schema.
    // Read side uses days[0].stops with flat-array fallback for pre-migration rows.
    suggestions = suggestions.map(s => {
      if (s.days && Array.isArray(s.days)) return s; // multi-day: Claude returned days[] directly
      return { ...s, days: [{ day: 1, label: null, stops: s.venues || [] }] };
    });
    // ─────────────────────────────────────────────────────────────────────────

    // ── Telemetry (suggest) ───────────────────────────────────────────────────
    // Stored as JSONB on the itinerary row so it can be queried in analytics
    // without touching the suggestions array. Fields are designed to be cheap
    // to compute (no extra DB queries) and safe to evolve (new fields can be
    // added without breaking old rows, which will simply lack those keys).
    const telemetry = {
      // Was the organizer's context prompt non-empty? Tracks blank vs. guided requests.
      context_prompt_present: Boolean(contextPrompt),
      // Intent classification: 'home_likely' | 'activity_specific' | 'ambiguous'
      // Helps correlate intent class with retry rate and suggestion quality.
      intent_class: classifyIntent(contextPrompt),
      // How many of the 3 returned suggestions are home-based (location_type === 'home').
      // Useful for understanding home vs. venue split distribution.
      home_suggestion_count: suggestions.filter(s => s.location_type === 'home').length,
      // Did the theme-match check trigger a second Claude call?
      retry_attempted: retryAttempted,
      // Did the retry produce usable suggestions that replaced the originals?
      retry_succeeded: retrySucceeded,
      // How many venues were confirmed via Google Places Text Search.
      venue_enrichment_verified_count: countVerified(suggestions),
      // How many venues came back unverified (Places miss, home, or API error).
      venue_enrichment_failed_count: countUnverified(suggestions),
      // Final suggestion count after window-filter drops hallucinated times.
      suggestion_count: suggestions.length,
      // How many past accepted plans were injected as context for this pair.
      past_history_count: (pastHistory || []).length,
      // How many live events were injected into the prompt from Ticketmaster / Eventbrite.
      events_injected_count: localEvents.length,
      // Which activity type was detected in the context prompt (null if none).
      activity_type_detected: detectedActivityType || null,
      // How many activity-specific venues were fetched and injected into the prompt.
      activity_venues_injected: activityVenueCount,
      // Whether organizer blocked off specific dates.
      has_manual_busy_blocks: manualBusyBlocks.length > 0,
      // Cultural signal detection — intent-driven temporal anchoring (Live Events V1).
      cultural_signal_detected: !!culturalSignal,
      cultural_signal_type:     culturalSignal?.type   || null,
      cultural_signal_entity:   culturalSignal?.entity || null,
      cultural_event_found:     !!priorityEvent,
      cultural_anchor_used:     !!priorityEvent,
    };
    // ─────────────────────────────────────────────────────────────────────────

    // Persist itinerary
    const { data: itinerary, error: insertErr } = await supabase
      .from('itineraries')
      .insert({
        organizer_id:     req.userId,
        attendee_id:      targetUserId,
        organizer_status: 'pending',
        attendee_status:  'pending',
        suggestions:      suggestions,
        reroll_count:     0,
        date_range_start: start,
        date_range_end:   end,
        time_of_day:      timeOfDay?.type || 'any',
        max_travel_minutes: maxTravelMinutes || null,
        context_prompt:      contextPrompt || null,
        event_title:         eventTitle?.trim() || null,
        location_preference: locationPreference,
        travel_mode:         travelMode,
        trip_duration_days:  tripDurationDays,
        destination:         destination,
        manual_busy_blocks:  manualBusyBlocks,
        suggestion_telemetry: telemetry,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('Itinerary insert error:', insertErr.message);
      return res.status(500).json({ error: 'Could not save itinerary.' });
    }

    res.json({ itineraryId: itinerary.id, suggestions });
  });

  /* ── GET /schedule/itineraries ───────────────────────────── */
  app.get('/schedule/itineraries', requireAuth, async (req, res) => {
    const filter = req.query.filter; // 'waiting' | 'upcoming' | undefined = all

    // Hard-delete any unlocked itineraries whose scheduling window has already passed.
    // This runs as a side-effect of listing so no separate cron job is needed.
    const todayStr = new Date().toISOString().split('T')[0];
    await supabase
      .from('itineraries')
      .delete()
      .or(`organizer_id.eq.${req.userId},attendee_id.eq.${req.userId}`)
      .is('locked_at', null)
      .lt('date_range_end', todayStr);

    let query = supabase
      .from('itineraries')
      .select('id, organizer_id, attendee_id, organizer_status, attendee_status, suggestions, locked_at, created_at, reroll_count, event_title, date_range_start, date_range_end, selected_suggestion_id')
      .or(`organizer_id.eq.${req.userId},attendee_id.eq.${req.userId}`)
      .order('created_at', { ascending: false })
      .limit(50);

    if (filter === 'waiting')  query = query.is('locked_at', null);
    if (filter === 'upcoming') query = query.not('locked_at', 'is', null);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Could not fetch itineraries.' });

    // Enrich with profile names
    const ids = [...new Set((data || []).flatMap(i => [i.organizer_id, i.attendee_id]))];
    const { data: profiles } = await supabase.from('profiles').select('id,full_name').in('id', ids);
    const nameMap = Object.fromEntries((profiles || []).map(p => [p.id, p.full_name]));

    res.json({
      itineraries: (data || []).map(i => ({
        ...i,
        organizerName: nameMap[i.organizer_id] || 'Unknown',
        attendeeName:  nameMap[i.attendee_id]  || 'Unknown',
        isOrganizer: i.organizer_id === req.userId,
      })),
    });
  });

  /* ── GET /schedule/itinerary/:id ─────────────────────────── */
  app.get('/schedule/itinerary/:id', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid itinerary ID.' });

    const { data, error } = await supabase
      .from('itineraries')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Itinerary not found.' });
    if (data.organizer_id !== req.userId && data.attendee_id !== req.userId) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    const ids = [data.organizer_id, data.attendee_id];
    const { data: profiles } = await supabase.from('profiles').select('id,full_name,location,avatar_url').in('id', ids);
    const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    res.json({
      ...data,
      organizer: profileMap[data.organizer_id] || { id: data.organizer_id, full_name: 'Unknown' },
      attendee:  profileMap[data.attendee_id]  || { id: data.attendee_id,  full_name: 'Unknown' },
      isOrganizer: data.organizer_id === req.userId,
    });
  });

  /* ── POST /schedule/confirm ──────────────────────────────── */
  // Handles three distinct actions depending on who is calling and whether
  // isSuggestAlternative is set:
  //   Organizer (no flag): sets organizer_status='accepted', records selected_suggestion_id
  //   Attendee  (no flag): sets attendee_status='accepted'; auto-locks via DB trigger if IDs match
  //   Attendee  (flag):    sets attendeeSelected:true on JSONB suggestion, keeps att=pending
  //                        (avoids DB auto-lock trigger; deriveStatus reads the JSONB flag instead)
  app.post('/schedule/confirm', requireAuth, async (req, res) => {
    const { itineraryId, suggestionId, isSuggestAlternative } = req.body;
    if (!itineraryId || !suggestionId) return res.status(400).json({ error: 'itineraryId and suggestionId required.' });
    // Validate itineraryId is a real UUID before hitting the DB — same guard used on
    // all other routes in this file.  suggestionId is a Claude-generated string like
    // "s1" (not a UUID), so we only validate the DB-bound itineraryId here.
    if (!isValidUUID(itineraryId)) return res.status(400).json({ error: 'Invalid itinerary ID.' });

    const { data: itin } = await supabase.from('itineraries').select('*').eq('id', itineraryId).single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });

    const isOrganizer = itin.organizer_id === req.userId;
    const isAttendee  = itin.attendee_id  === req.userId;
    if (!isOrganizer && !isAttendee) return res.status(403).json({ error: 'Not authorized.' });

    const statusField = isOrganizer ? 'organizer_status' : 'attendee_status';
    const otherStatus = isOrganizer ? itin.attendee_status : itin.organizer_status;

    const updates = {
      [statusField]: 'accepted',
    };

    if (isSuggestAlternative && isAttendee) {
      // Attendee counter-proposing: store their pick as a JSONB flag on the suggestion.
      // IMPORTANT: keep attendee_status='pending' (not 'accepted') to avoid triggering the
      // check_itinerary_lock DB trigger, which auto-locks when both statuses are 'accepted'.
      // The attendeeSelected:true flag is the signal; deriveStatus reads it to show the
      // 'attendee_suggested' state without needing a separate status column value.
      const updatedSuggestions = (itin.suggestions || []).map(s => ({
        ...s,
        attendeeSelected: s.id === suggestionId,
      }));
      updates.suggestions = updatedSuggestions;
      updates[statusField] = 'pending'; // override the 'accepted' set above — don't trigger lock
    } else {
      // Regular accept — record the picked suggestion ID.
      // Always clear attendeeSelected flags so the re-evaluate state resets regardless of
      // whether the DB auto-lock trigger fires. Prevents organizer getting stuck in re-evaluate mode.
      updates.selected_suggestion_id = suggestionId;
      updates.suggestions = (itin.suggestions || []).map(s => ({ ...s, attendeeSelected: false }));

      // Auto-lock when both sides have accepted the same card.
      // If the other side already accepted but chose a different card, the picker is
      // counter-proposing: reset the other side to pending and clear attendeeSelected flags
      // so the back-and-forth loop can continue.
      if (otherStatus === 'accepted') {
        const otherPicksThisCard = isOrganizer
          ? (itin.suggestions || []).some(s => s.id === suggestionId && s.attendeeSelected)
          : itin.selected_suggestion_id === suggestionId;
        if (otherPicksThisCard) {
          updates.locked_at = new Date().toISOString();
        } else if (isOrganizer) {
          // Organizer counter-proposing back after attendee suggested an alternative.
          // Reset attendee to pending and clear all attendeeSelected flags so the attendee
          // sees the organizer's new pick with fresh Accept/Decline/Suggest controls.
          updates.attendee_status = 'pending';
          updates.suggestions = (itin.suggestions || []).map(s => ({ ...s, attendeeSelected: false }));
        } else {
          // Attendee picking a different card — same as isSuggestAlternative path.
          // Keep attendee_status='pending' to avoid the auto-lock trigger.
          const updatedSuggestions = (itin.suggestions || []).map(s => ({
            ...s,
            attendeeSelected: s.id === suggestionId,
          }));
          updates.suggestions = updatedSuggestions;
          updates[statusField] = 'pending';
          delete updates.selected_suggestion_id;
        }
      }
    }

    const { data: updated, error: updateErr } = await supabase.from('itineraries').update(updates).eq('id', itineraryId).select().single();
    if (updateErr || !updated) {
      console.error('confirm update failed:', updateErr?.message);
      return res.status(500).json({ error: 'Could not save confirmation.' });
    }

    // Notify the other person — only for non-lock accepts.
    // Lock notifications are sent to both users in a dedicated block below.
    const confirmerName = await getProfileName(req.userId, supabase);
    const otherForConfirm = isOrganizer ? itin.attendee_id : itin.organizer_id;
    if (!updated?.locked_at) {
      const confirmMsg = isSuggestAlternative
        ? confirmerName + ' is suggesting a different option. Take a look.'
        : confirmerName + ' accepted a plan. Waiting for the other person to confirm.';
      const confirmTitle = isSuggestAlternative
        ? confirmerName + ' suggested an alternative'
        : confirmerName + ' accepted a plan';
      await dispatchNotification(supabase, {
        userId: otherForConfirm,
        type: 'itinerary_accepted',
        title: confirmTitle,
        body: confirmMsg,
        actionUrl: '/schedule/' + itineraryId,
        refId: itineraryId,
      });
    }

    // If just locked — create Google Calendar events for both users (best-effort)
    let calendarEventId  = updated?.calendar_event_id  || null;
    let calendarEventUrl = updated?.calendar_event_url || null;
    if (updated?.locked_at && !calendarEventId) {
      const suggestion = (itin.suggestions || []).find(s => s.id === suggestionId);

      // Load both profiles for email addresses
      const [orgProfile, attProfile] = await Promise.all([
        supabase.from('profiles').select('id,full_name,email').eq('id', itin.organizer_id).single(),
        supabase.from('profiles').select('id,full_name,email').eq('id', itin.attendee_id).single(),
      ]);
      const organizerProfile = orgProfile.data || {};
      const attendeeProfile  = attProfile.data  || {};

      // Look up sessions for both parties to find valid Google Calendar tokens.
      // Note: token refresh inside createCalendarEventForUser mutates the local session
      // object but does NOT persist back to the DB for these indirect lookups.
      // Worst case: next calendar operation re-refreshes. The event creation is best-effort.
      const [organizerSession, attendeeSession] = await Promise.all([
        sessionStore.getSessionBySupabaseId(itin.organizer_id),
        sessionStore.getSessionBySupabaseId(itin.attendee_id),
      ]);

      // Write calendar events for organizer and attendee independently.
      // Each call resolves its own primary-calendar tokens via getPrimaryCalendarTokens.
      // createCalendarEventForUser returns { id, htmlLink } or null (best-effort, never throws).
      if (suggestion) {
        const [orgCalResult, attCalResult] = await Promise.all([
          organizerSession ? createCalendarEventForUser({
            session:     organizerSession,
            suggestion,
            organizer:   organizerProfile,
            attendee:    attendeeProfile,
            itineraryId,
            supabase,
            userId: itin.organizer_id,
          }) : Promise.resolve(null),
          attendeeSession ? createCalendarEventForUser({
            session:     attendeeSession,
            suggestion,
            organizer:   organizerProfile,
            attendee:    attendeeProfile,
            itineraryId,
            supabase,
            userId: itin.attendee_id,
          }) : Promise.resolve(null),
        ]);

        // Store the first successful event link (organizer preferred).
        const calResult = orgCalResult || attCalResult;
        if (calResult?.id) {
          calendarEventId  = calResult.id;
          calendarEventUrl = calResult.htmlLink || null;
          await supabase.from('itineraries')
            .update({ calendar_event_id: calendarEventId, calendar_event_url: calendarEventUrl })
            .eq('id', itineraryId);
        }
      }
    }

    // Send lock notification to BOTH users when the plan just locked.
    if (updated?.locked_at) {
      const organizerName = await getProfileName(itin.organizer_id, supabase);
      const attendeeName  = await getProfileName(itin.attendee_id,  supabase);
      const lockTitle     = 'Plans confirmed — calendar invite sent';
      // Each user's notification names the other party.
      await Promise.all([
        dispatchNotification(supabase, {
          userId: itin.organizer_id,
          type: 'itinerary_locked',
          title: lockTitle,
          body: `Your plans with ${attendeeName} are locked in. The event has been added to both your Google Calendars.`,
          actionUrl: '/schedule/' + itineraryId,
          refId: itineraryId,
        }),
        dispatchNotification(supabase, {
          userId: itin.attendee_id,
          type: 'itinerary_locked',
          title: lockTitle,
          body: `Your plans with ${organizerName} are locked in. The event has been added to both your Google Calendars.`,
          actionUrl: '/schedule/' + itineraryId,
          refId: itineraryId,
        }),
      ]);
    }

    res.json({ itinerary: updated, locked: !!updated?.locked_at, calendarEventId, calendar_event_url: calendarEventUrl });
  });

  /* ── POST /schedule/itinerary/:id/send ───────────────────── */
  app.post('/schedule/itinerary/:id/send', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid itinerary ID.' });

    const { data: itin } = await supabase.from('itineraries').select('organizer_id,attendee_id,organizer_status').eq('id', req.params.id).single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId) return res.status(403).json({ error: 'Only the organizer can send.' });

    // Note: no status update needed here — /confirm (called immediately after) sets organizer_status='accepted'.
    // The DB check constraint only allows pending/accepted/declined, so 'sent' cannot be stored.

    // Notify attendee
    const senderName = await getProfileName(req.userId, supabase);
    await dispatchNotification(supabase, {
      userId: itin.attendee_id,
      type: 'itinerary_invite',
      title: 'New plan from ' + senderName,
      body: senderName + ' sent you some plans to review.',
      actionUrl: '/schedule/' + req.params.id,
      refId: req.params.id,
    });

    res.json({ ok: true });
  });

  /* ── POST /schedule/itinerary/:id/decline ────────────────── */
  app.post('/schedule/itinerary/:id/decline', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid itinerary ID.' });

    const { data: itin } = await supabase.from('itineraries').select('organizer_id,attendee_id').eq('id', req.params.id).single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId && itin.attendee_id !== req.userId) return res.status(403).json({ error: 'Not authorized.' });

    const isAttendeeDecline = itin.attendee_id === req.userId;
    const field = itin.organizer_id === req.userId ? 'organizer_status' : 'attendee_status';
    const declineUpdate = { [field]: 'declined' };
    // If the attendee left busy notes, store them so the organizer sees them on the next reroll.
    if (isAttendeeDecline && req.body.attendee_busy_notes && typeof req.body.attendee_busy_notes === 'string') {
      const sanitizedNotes = sanitizePromptInput(req.body.attendee_busy_notes.trim().slice(0, 300));
      if (sanitizedNotes) declineUpdate.attendee_busy_notes = sanitizedNotes;
    }
    await supabase.from('itineraries').update(declineUpdate).eq('id', req.params.id);

    // Notify the other person
    const otherUserId = itin.organizer_id === req.userId ? itin.attendee_id : itin.organizer_id;
    const declinerName = await getProfileName(req.userId, supabase);
    await dispatchNotification(supabase, {
      userId: otherUserId,
      type: 'itinerary_declined',
      title: declinerName + ' declined the plan',
      body: declinerName + ' passed on the plans. You can re-roll for new ideas.',
      actionUrl: '/schedule/' + req.params.id,
      refId: req.params.id,
    });

    res.json({ ok: true });
  });

  /* ── POST /schedule/itinerary/:id/reroll ─────────────────── */
  app.post('/schedule/itinerary/:id/reroll', requireAuth, async (req, res) => {
    const itineraryId = req.params.id;
    if (!isValidUUID(itineraryId)) return res.status(400).json({ error: 'Invalid itinerary ID.' });

    const { data: itin } = await supabase.from('itineraries').select('*').eq('id', itineraryId).single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId && itin.attendee_id !== req.userId) return res.status(403).json({ error: 'Not authorized.' });
    if (itin.locked_at) return res.status(400).json({ error: 'Cannot reroll a locked itinerary.' });
    if ((itin.reroll_count || 0) >= 10) return res.status(400).json({ error: 'Max rerolls reached.' });

    const { contextPrompt, feedback, replaceSuggestionId, rerollType = 'both', appendMode = false } = req.body;
    if (contextPrompt && typeof contextPrompt === 'string' && contextPrompt.length > MAX_CONTEXT) {
      return res.status(400).json({ error: `contextPrompt must be ${MAX_CONTEXT} characters or fewer.` });
    }
    if (feedback && typeof feedback === 'string' && feedback.length > MAX_CONTEXT) {
      return res.status(400).json({ error: `feedback must be ${MAX_CONTEXT} characters or fewer.` });
    }

    const [profileARes, profileBRes] = await Promise.all([
      supabase.from('profiles').select('id,full_name,location,activity_preferences,dietary_restrictions,mobility_restrictions').eq('id', itin.organizer_id).single(),
      supabase.from('profiles').select('id,full_name,location,activity_preferences,dietary_restrictions,mobility_restrictions').eq('id', itin.attendee_id).single(),
    ]);

    const userA = profileARes.data || {};
    const userB = profileBRes.data || {};

    // Single-card reroll: ask Claude for 1 replacement; full reroll or append: ask for 3
    const isSingleCard = !!replaceSuggestionId;
    const targetSuggestion = isSingleCard
      ? (itin.suggestions || []).find(s => s.id === replaceSuggestionId)
      : null;
    const existingTitles = (itin.suggestions || [])
      .filter(s => s.id !== replaceSuggestionId)
      .map(s => s.title).filter(Boolean);
    const rerollInstructions = {
      timing: `Keep the same activity concept and venues as "${targetSuggestion?.title || 'this option'}". Only change the date and time — find a different time slot. Do not change the venues, activity type, or narrative theme.`,
      activity: `Keep the same date and time as "${targetSuggestion?.title || 'this option'}" (${targetSuggestion?.date || ''} at ${targetSuggestion?.time || ''}). Suggest a completely different activity and venues. The vibe should be noticeably different.`,
      both: `Replace the option titled "${targetSuggestion?.title || 'unknown'}" with a fresh alternative — different activity and different time.`,
    };
    const singleCardNote = isSingleCard
      ? `Generate exactly 1 suggestion (not 3). ${rerollInstructions[rerollType] || rerollInstructions.both} Make it clearly different from these existing options: ${existingTitles.join(', ')}. Return a JSON object with a "suggestions" array containing exactly 1 item. You are replacing a single card, not a full set. You are not bound by the cross-card no-duplicate venue rule — if the user's request references or implies a venue shown on another card, use it.`
      : '';
    // appendMode: generate 3 new suggestions distinct from everything already shown
    const appendNote = appendMode && !isSingleCard
      ? `Generate 3 brand-new suggestions completely different from these already-shown options: ${existingTitles.join(', ')}. Do not repeat any of these.`
      : '';

    // Rebuild free windows from the original date range so reroll respects bounds.
    // Also clamp start to today — no point generating windows in the past.
    //
    // Date window floor: never suggest times in the past. Uses local time, not UTC —
    // see timezone bug fix in reroll route.
    // NOTE: unlike the suggest route, reroll has no access to the client's
    // timezoneOffsetMinutes (it's not stored on the itinerary). todayStr therefore uses
    // UTC, which is slightly wrong for users significantly east of UTC (e.g. UTC+10 may
    // see "today" anchored to yesterday UTC). The windowFloorMs filter below is
    // timezone-agnostic and catches the intra-day portion regardless of timezone.
    const todayStr   = new Date().toISOString().split('T')[0];
    const rawStart   = itin.date_range_start || todayStr;
    const rerollStart = rawStart < todayStr ? todayStr : rawStart;
    const futureEnd   = (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().split('T')[0]; })();
    const rerollEnd   = (!itin.date_range_end || itin.date_range_end < todayStr) ? futureEnd : itin.date_range_end;
    const rerollStartISO = new Date(rerollStart + 'T00:00:00').toISOString();
    const rerollEndISO   = new Date(rerollEnd   + 'T23:59:59').toISOString();
    const [rerollOrgSession, rerollAttSession] = await Promise.all([
      sessionStore.getSessionBySupabaseId(itin.organizer_id),
      sessionStore.getSessionBySupabaseId(itin.attendee_id),
    ]);
    let rerollBusyA, rerollBusyB;
    try {
      [rerollBusyA, rerollBusyB] = await Promise.all([
        fetchBusy(rerollOrgSession, rerollStartISO, rerollEndISO, supabase, itin.organizer_id),
        fetchBusy(rerollAttSession, rerollStartISO, rerollEndISO, supabase, itin.attendee_id),
      ]);
    } catch (e) {
      console.error('fetchBusy (reroll) failed:', e.message);
      return res.status(502).json({
        error: 'Could not read calendar availability. Make sure both users have connected Google Calendar.',
      });
    }
    const rerollDuration = inferDurationMinutes(itin.event_title, itin.context_prompt);

    // now + 1 hour (UTC, timezone-agnostic) — strips individual windows that have
    // already passed regardless of the user's local timezone. This is the intra-day
    // portion of the date floor; the date-level portion is handled by rerollStart above.
    const rerollWindowFloorMs = Date.now() + 60 * 60 * 1000;
    const rerollWindows = findFreeWindows(rerollBusyA, rerollBusyB, rerollStart, rerollEnd, { type: itin.time_of_day || 'any' }, 20, 0, rerollDuration)
      .filter(w => new Date(w.start).getTime() >= rerollWindowFloorMs);

    if (rerollWindows.length === 0) {
      return res.status(422).json({
        error: 'No availability found in the remaining window. Try editing the event with a different date or time.',
      });
    }

    // Fetch shared interests for the reroll — same pattern as the suggest route.
    // Organizer's annotation of the attendee; best-effort, non-fatal if absent.
    const { data: rerollAnnotation } = await supabase
      .from('friend_annotations')
      .select('shared_interests')
      .eq('user_id', itin.organizer_id)
      .eq('friend_id', itin.attendee_id)
      .maybeSingle();
    const rerollSharedInterests = rerollAnnotation?.shared_interests || [];

    // Fetch past accepted plans for this pair — same pattern as the suggest route.
    // Best-effort: a failure returns [] and silently omits the history block.
    const rerollPastHistory = await fetchAcceptedPairHistory(itin.organizer_id, itin.attendee_id, supabase);

    // Derive geo context once — reused by fetchLocalEvents, fetchActivityVenues, and enrichment.
    const rerollGeoContext = deriveGeoContext(userA, userB);

    // Fetch live events for the itinerary's original date range and city.
    // Best-effort: a failure returns [] and silently omits the events block.
    let rerollLocalEvents = [];
    try {
      rerollLocalEvents = await fetchLocalEvents(
        rerollGeoContext,
        itin.date_range_start,
        itin.date_range_end,
        [...(userA.activity_preferences || []), ...(userB.activity_preferences || [])],
      );
    } catch (eventsErr) {
      console.error('[reroll] fetchLocalEvents failed:', eventsErr.message);
    }

    // Activity/hobby venue discovery — same pattern as the suggest route.
    // IMPORTANT: always prefer itin.context_prompt for activity detection — it carries
    // the organizer's original intent (e.g. "watch the Knicks at a sports bar").
    // A reroll modifier like "make it more casual" must not override the detected
    // activity type; the venue discovery should still fetch sports bars, not bars in general.
    let rerollActivityVenuesBlock = '';
    let rerollDetectedActivityType = null;
    let rerollActivityVenueCount = 0;
    try {
      const rerollContextForActivity = itin.context_prompt || sanitizePromptInput(contextPrompt) || '';
      rerollDetectedActivityType = extractActivityType(rerollContextForActivity);
      if (rerollDetectedActivityType) {
        const cityContext    = extractCityFromGeoContext(rerollGeoContext);
        const activityVenues = await fetchActivityVenues(rerollDetectedActivityType, cityContext);
        rerollActivityVenueCount  = activityVenues.length;
        rerollActivityVenuesBlock = buildActivityVenuesBlock(rerollDetectedActivityType, activityVenues);
      }
    } catch (activityErr) {
      console.error('[activityVenues] reroll route failed:', activityErr.message);
    }

    // ── Cultural signal detection (reroll) ───────────────────────────────────
    // Always use the stored context_prompt — preserves the original intent across rerolls.
    const rerollCulturalSignal = extractCulturalSignal(safeOriginalContext, [
      ...(userA.activity_preferences || []),
      ...(userB.activity_preferences || []),
    ]);
    let rerollPriorityEvent = null;
    if (rerollCulturalSignal) {
      try {
        rerollPriorityEvent = await fetchCulturalEvent(
          rerollCulturalSignal.type,
          rerollCulturalSignal.entity,
          itin.date_range_start,
          itin.date_range_end
        );
      } catch (culturalErr) {
        console.warn('[reroll] fetchCulturalEvent failed:', culturalErr.message);
      }
    }
    const rerollPriorityEventBlock = rerollPriorityEvent
      ? `\nPRIORITY EVENT (mandatory anchor — you MUST build at least one suggestion around this):\n` +
        `${rerollPriorityEvent.title} — ${rerollPriorityEvent.date}${rerollPriorityEvent.time ? ' at ' + rerollPriorityEvent.time : ''}\n` +
        `Venue: ${rerollPriorityEvent.venue}\n` +
        `Instruction: Anchor exactly one of the three suggestions around this event. ` +
        `Time the suggestion so it leads into the event (e.g. pre-game dinner, drinks before the show). ` +
        `The other two suggestions should be independent alternatives that don't reference this event.`
      : '';
    // ─────────────────────────────────────────────────────────────────────────

    // Extract first names for home-based agenda copy, same as in the suggest route.
    const rerollOrgFirst = (userA.full_name || '').split(' ')[0] || '';
    const rerollAttFirst = (userB.full_name || '').split(' ')[0] || '';

    // REROLL CONTEXT PRIORITY:
    // 1. original context_prompt (fetched from DB) — primary intent, never overridden
    // 2. singleCardNote — modifier only (new time = timing change, new vibe = style change within same activity)
    // 3. activity type detected from context_prompt — re-injected on every reroll
    //
    // safeOriginalContext is the sanitized DB context_prompt. It must appear in the prompt
    // on every reroll so Claude never loses the organizer's original intent. Without it, a
    // "New vibe" click on "watch the Knicks at a sports bar" would reach Claude with only
    // "fresh alternative — different activity" as the guide, allowing it to return comedy
    // at a bocce bar instead of a different sports bar.
    const safeOriginalContext = sanitizePromptInput(itin.context_prompt || '');

    // safeRerollContext is any new text the user typed in the reroll UI.
    // It supplements (not replaces) the original intent.
    const safeRerollContext = sanitizePromptInput(contextPrompt);

    // Combined context: original intent first, then any reroll-specific override.
    // This is used as the intent source for exactMatchBlock and retry instructions.
    // Original is always first so Claude treats it as the dominant constraint.
    const combinedContext = [safeOriginalContext, safeRerollContext].filter(Boolean).join('. ');

    // Micro-adjustment detection — classify the user's reroll input (NOT the original context).
    // Only the user's new text (safeRerollContext) is checked for relative modifiers.
    // The original context is always preserved regardless of classification.
    const rerollIntentClass = classifyRerollIntent(safeRerollContext);
    if (rerollIntentClass === 'ambiguous') {
      console.warn('[reroll] classifyRerollIntent returned ambiguous — falling back to full_replace behavior');
    }

    // exactMatchBlock: for single-card rerolls, tell Claude exactly what the intent is.
    // Built from combinedContext (original + modifier) — NOT from singleCardNote alone,
    // which only describes the reroll operation (timing/vibe) without any activity anchor.
    // Without safeOriginalContext here, a "New vibe" reroll would lose all activity signal
    // and return a completely unrelated suggestion.
    const exactMatchBlock = isSingleCard && (combinedContext || singleCardNote)
      ? `EXACT MATCH REQUIRED: The user wants: "${combinedContext || singleCardNote}". Generate a suggestion that matches this intent as closely as possible. If it names a specific venue, activity type, or location, use that directly. If it describes an activity at home (e.g. "just hang out", "watch a movie", "come over"), generate a home-based agenda. Do not substitute a thematically similar but different activity — match the intent as literally as possible.`
      : '';

    // Venue substitution: check original context_prompt first (primary intent source),
    // then fall back to the reroll-specific override if the user named a different venue.
    const rerollVenueName  = extractVenueName(contextPrompt || itin.context_prompt || '');
    const rerollVenueBlock = rerollVenueName ? buildVenueSubstitutionBlock(rerollVenueName) : '';

    // microAdjustBlock: injected only when the user's reroll input is a relative modifier.
    // Instructs Claude to preserve the existing structure and only modify the flagged dimension.
    // Falls back to no injection for full_replace and ambiguous (full replacement behavior).
    const microAdjustBlock = rerollIntentClass === 'micro_adjust'
      ? `MICRO-ADJUSTMENT MODE: The user has requested a small modification to the previous suggestions, not a full replacement.
You MUST preserve the overall structure, venue sequence, activity types, and general vibe of the prior itinerary.
Only modify the specific dimension the user called out.
Do NOT introduce entirely new venues or activity categories unless the user explicitly asks.
The user's modification request is: "${safeRerollContext}"`
      : '';

    // priorSuggestionsBlock: injected only in micro-adjust mode so Claude knows what it's preserving.
    // Uses itin.suggestions — the current suggestions before this reroll is applied.
    const priorSuggestionsBlock = rerollIntentClass === 'micro_adjust' && itin.suggestions?.length > 0
      ? `PRIOR SUGGESTIONS (for reference — preserve structure unless instructed otherwise):
${JSON.stringify(
  (itin.suggestions || []).map(s => ({
    id: s.id,
    title: s.title,
    date: s.date,
    time: s.time,
    location_type: s.location_type,
    neighborhood: s.neighborhood,
    narrative: s.narrative,
    venues: (s.days?.[0]?.stops ?? s.venues ?? []).map(v => v.name),
  })),
  null, 2
)}`
      : '';

    const prompt = buildSuggestPrompt({
      userA: { ...userA, name: userA.full_name || 'User A' },
      userB: { ...userB, name: userB.full_name || 'User B' },
      freeWindows: rerollWindows,
      // REROLL CONTEXT PRIORITY:
      // 1. original context_prompt (fetched from DB) — primary intent, never overridden
      // 2. singleCardNote — modifier only (new time = timing change, new vibe = style change within same activity)
      // 3. activity type detected from context_prompt — re-injected on every reroll
      //
      // safeOriginalContext is always included first so Claude cannot lose the original intent.
      // singleCardNote supplements it as an operation modifier — it does not replace it.
      contextPrompt: [
        microAdjustBlock,       // highest priority when micro_adjust — empty string for full_replace
        priorSuggestionsBlock,  // prior suggestions for reference — empty string when not micro_adjust
        exactMatchBlock,
        rerollVenueBlock,
        safeOriginalContext,                                          // ① original intent — always present, always first
        safeRerollContext,                                            // ② user's reroll-specific input — supplemental
        feedback ? `Feedback: ${sanitizePromptInput(feedback)}` : '', // ③ additional guidance from the reroll UI
        singleCardNote,                                               // ④ operation modifier (new time / new vibe)
        appendNote,
      ].filter(Boolean).join('\n'),
      maxTravelMinutes: itin.max_travel_minutes || null,
      eventTitle: itin.event_title || null,
      durationMinutes: rerollDuration,
      sharedInterests: rerollSharedInterests,
      organizerFirstName:   rerollOrgFirst,
      attendeeFirstName:    rerollAttFirst,
      pastHistory:          rerollPastHistory,
      localEvents:          rerollLocalEvents,
      activityVenuesBlock:  rerollActivityVenuesBlock,
      // location_preference, travel_mode, trip_duration_days, destination are always read
      // from the stored itinerary row — never from the request body. This prevents the client
      // from overriding preferences that were set at creation time. Falls back to safe defaults
      // for pre-migration rows that lack these columns.
      locationPreference:   itin.location_preference  || 'system_choice',
      travelMode:           itin.travel_mode          || 'local',
      tripDurationDays:     itin.trip_duration_days   || 1,
      destination:          itin.destination          || null,
      excludedWindowsBlock: buildExcludedWindowsBlock(itin.manual_busy_blocks || []),
      attendeeBusyNotesBlock: buildAttendeeNotesBlock(itin.attendee_busy_notes || ''),
      priorityEventBlock: rerollPriorityEventBlock,
    });

    let newSuggestions;
    try {
      const msg = await anthropic.messages.create({
        model: CLAUDE_MODEL, max_tokens: 2000,
        system: RENDEZVOUS_SYSTEM_PROMPT, // same voice + output contract as the suggest call
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = msg.content[0]?.text || '{}';
      newSuggestions = JSON.parse(raw.replace(/```json|```/g, '').trim()).suggestions || [];
    } catch (e) {
      console.error('Claude reroll error:', e.message, e.stack?.split('\n')[1]);
      return res.status(500).json({ error: 'Could not generate new suggestions. Please try again.' });
    }

    // ── Theme-match retry (reroll) ───────────────────────────────────────────
    // Mirror of the suggest route retry: if the reroll context is activity_specific
    // but no returned suggestion reflects that activity, retry once with a strengthened prompt.
    // Flags declared outside the block so the telemetry object below can read them.
    let retryAttempted = false;
    let retrySucceeded = false;
    {
      // Use combinedContext (original intent + any reroll override) as the theme-match source.
      // Previously this used `contextPrompt || itin.context_prompt` which put the reroll
      // override first — meaning an empty reroll override fell back to the original, but a
      // non-empty override would shadow it. The combined form is always more complete.
      const rerollContextForMatch = combinedContext || '';
      const needsRerollRetry =
        rerollContextForMatch &&
        classifyIntent(rerollContextForMatch) === 'activity_specific' &&
        !themeMatchesContextPrompt(newSuggestions, rerollContextForMatch);

      if (needsRerollRetry) {
        // ── RETRY POINT ──────────────────────────────────────────────────────
        retryAttempted = true;
        console.error('[reroll] retry_attempted: true — no suggestions matched context:', rerollContextForMatch);
        // Retry instruction anchors on combinedContext so it references the full original
        // intent, not just whatever modifier the user typed on this reroll.
        const rerollRetryInstruction =
          `RETRY — the previous attempt did not return any suggestions matching "${combinedContext || rerollContextForMatch}". ` +
          `This is mandatory: at least one suggestion MUST directly feature "${combinedContext || rerollContextForMatch}" ` +
          `as the primary activity. Do not substitute a thematically adjacent activity.`;
        const retryRerollPrompt = buildSuggestPrompt({
          userA: { ...userA, name: userA.full_name || 'User A' },
          userB: { ...userB, name: userB.full_name || 'User B' },
          freeWindows: rerollWindows,
          // Same context priority as the primary prompt — safeOriginalContext must appear
          // in the retry too so the activity anchor is never lost across attempts.
          contextPrompt: [
            rerollRetryInstruction,
            exactMatchBlock,
            rerollVenueBlock,
            safeOriginalContext,   // ① original intent — always first, always present
            safeRerollContext,     // ② supplemental reroll input
            feedback ? `Feedback: ${sanitizePromptInput(feedback)}` : '',
            singleCardNote,
            appendNote,
          ].filter(Boolean).join('\n'),
          maxTravelMinutes: itin.max_travel_minutes || null,
          eventTitle: itin.event_title || null,
          durationMinutes: rerollDuration,
          sharedInterests: rerollSharedInterests,
          organizerFirstName:   rerollOrgFirst,
          attendeeFirstName:    rerollAttFirst,
          pastHistory:          rerollPastHistory,
          localEvents:          rerollLocalEvents,
          activityVenuesBlock:  rerollActivityVenuesBlock,
          // location_preference, travel_mode, trip_duration_days, destination — all read from DB row.
          // Same source as the primary reroll prompt: never from request body.
          locationPreference:   itin.location_preference  || 'system_choice',
          travelMode:           itin.travel_mode          || 'local',
          tripDurationDays:     itin.trip_duration_days   || 1,
          destination:          itin.destination          || null,
          excludedWindowsBlock: buildExcludedWindowsBlock(itin.manual_busy_blocks || []),
          attendeeBusyNotesBlock: buildAttendeeNotesBlock(itin.attendee_busy_notes || ''),
        });
        try {
          const retryMsg = await anthropic.messages.create({
            model: CLAUDE_MODEL, max_tokens: 2000,
            system: RENDEZVOUS_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: retryRerollPrompt }],
          });
          const retryRaw    = retryMsg.content[0]?.text || '{}';
          const retryParsed = JSON.parse(retryRaw.replace(/```json|```/g, '').trim());
          const retrySugs   = retryParsed.suggestions;
          if (Array.isArray(retrySugs) && retrySugs.length > 0) {
            newSuggestions = retrySugs;
            retrySucceeded = true;
            console.error('[reroll] retry_succeeded: true');
          } else {
            console.error('[reroll] retry_succeeded: false — retry returned empty, using original');
          }
        } catch (retryErr) {
          // Retry failed — use original suggestions rather than blocking the response.
          console.error('[reroll] retry_succeeded: false — retry threw:', retryErr.message);
        }
        // ── END RETRY POINT ──────────────────────────────────────────────────
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // ── Window filter (reroll) ────────────────────────────────────────────────
    // Drop suggestions whose date+time doesn't overlap any computed free window.
    //
    // Reroll windows are built with tzOffset=0 because the stored itinerary has no
    // record of the client's timezone offset. Times in the prompt are therefore UTC,
    // and Claude should pick from them — but it occasionally picks times outside the
    // window (e.g. when asked to keep an existing card's "evening" time and that time
    // maps past the UTC window boundary, or when the theme-match retry fires and
    // returns a suggestion with a different date/time than the prompt specified).
    //
    // FIX — single-card fallback: save Claude's raw output before filtering so that
    // if every suggestion is dropped, we can fall back to the unfiltered first result
    // rather than returning a hard error. The user asked for a replacement — getting
    // one at a slightly imprecise time is always better than seeing an error modal.
    // Full-reroll and append paths are unaffected; they retain the strict filter.
    const newSuggestionsBeforeWindowFilter = newSuggestions.slice(); // snapshot pre-filter

    newSuggestions = newSuggestions.filter(s => {
      if (!s.date || !s.time) return true;
      const match = s.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!match) return true;
      let h = parseInt(match[1]);
      const min = parseInt(match[2]);
      const ampm = match[3].toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      const [sy2, sm2, sd2] = s.date.split('-').map(Number);
      // Times are treated as UTC here because rerollWindows were built with tzOffset=0.
      // See the note above for why this diverges from the suggest route.
      const utcStart = new Date(Date.UTC(sy2, sm2 - 1, sd2, h, min, 0));
      const durMs    = (s.durationMinutes || rerollDuration) * 60000;
      const utcEnd   = new Date(utcStart.getTime() + durMs);
      const inWindow = rerollWindows.some(w =>
        utcStart < new Date(w.end) && utcEnd > new Date(w.start)
      );
      if (!inWindow) {
        console.warn(`[reroll] Window filter dropped suggestion: ${s.date} ${s.time}`);
      }
      return inWindow;
    });
    // ─────────────────────────────────────────────────────────────────────────

    // ── Venue enrichment (reroll) ─────────────────────────────────────────────
    // Enrich only the new suggestions Claude generated — existing preserved cards
    // were enriched (or skipped) when they were first created.
    try {
      // rerollGeoContext was already computed above — reuse rather than calling deriveGeoContext again
      const rerollCityCtx = extractCityFromGeoContext(rerollGeoContext);
      newSuggestions = await enrichVenues(newSuggestions, rerollCityCtx);
    } catch (enrichErr) {
      console.error('[reroll] enrichVenues failed, continuing unenriched:', enrichErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Step 5: wrap venues into days structure before DB save (reroll) ───────
    // Same as the suggest route: normalize new suggestions to days[] schema.
    // Preserves existing suggestions (pre-migration flat venues) unchanged.
    newSuggestions = newSuggestions.map(s => {
      if (s.days && Array.isArray(s.days)) return s;
      return { ...s, days: [{ day: 1, label: null, stops: s.venues || [] }] };
    });
    // ─────────────────────────────────────────────────────────────────────────

    // Single-card: swap only the targeted card, preserve the rest.
    // appendMode: tag new suggestions with fresh IDs and append to existing list.
    // Full reroll: replace all suggestions.
    let suggestions;
    if (isSingleCard && newSuggestions.length > 0) {
      const replacement = { ...newSuggestions[0], id: replaceSuggestionId, attendeeSelected: false };
      // Preserve attendeeSelected on all other cards — single-card reroll shouldn't wipe
      // the attendee's counter-proposal flag, which the organizer still needs to see.
      suggestions = (itin.suggestions || []).map(s =>
        s.id === replaceSuggestionId ? replacement : s
      );
    } else if (isSingleCard && newSuggestionsBeforeWindowFilter.length > 0) {
      // ── Single-card window-filter fallback ────────────────────────────────
      // The window filter dropped every suggestion Claude generated. Rather than
      // returning an error, use the first pre-filter suggestion as the replacement.
      //
      // Root cause: reroll windows use tzOffset=0 (UTC) because the client's timezone
      // offset is not stored on the itinerary. Claude occasionally picks a time that
      // was correct in the original local timezone but maps outside the UTC window
      // range (e.g., 8 PM EDT = 12 AM UTC, past the 11 PM UTC cutoff). The user
      // explicitly asked for a replacement card — a slightly imprecise time is
      // acceptable; a hard error is not.
      console.warn(`[reroll] Single-card window filter dropped all suggestions — using pre-filter fallback.`);
      const fallback = { ...newSuggestionsBeforeWindowFilter[0], id: replaceSuggestionId, attendeeSelected: false };
      suggestions = (itin.suggestions || []).map(s =>
        s.id === replaceSuggestionId ? fallback : s
      );
    } else if (isSingleCard) {
      // Claude returned no suggestions at all (empty array from JSON parse).
      // This is distinct from the window-filter case above — there's nothing to fall back to.
      console.error('[reroll] Single-card reroll: Claude returned 0 suggestions, cannot replace card.');
      return res.status(500).json({ error: 'Could not generate a replacement. Please try again.' });
    } else if (appendMode) {
      // Give each appended suggestion a unique ID so they don't collide with existing IDs
      const appended = newSuggestions.map((s, i) => ({
        ...s,
        id: `appended_${Date.now()}_${i}`,
        attendeeSelected: false,
      }));
      suggestions = [...(itin.suggestions || []), ...appended];
    } else {
      suggestions = newSuggestions;
    }

    const isOrganizer = itin.organizer_id === req.userId;
    const otherUserId = isOrganizer ? itin.attendee_id : itin.organizer_id;

    // ── Telemetry (reroll) ────────────────────────────────────────────────────
    // Same schema as the suggest telemetry, plus reroll_count so trends across
    // successive rerolls on the same itinerary are queryable. feedbackOrContext
    // captures whichever prompt was active: user-supplied feedback or the stored
    // original context (from the itinerary row).
    const feedbackOrContext = contextPrompt || itin.context_prompt || '';
    const updatedRerollCount = (itin.reroll_count || 0) + 1;
    const rerollTelemetry = {
      context_prompt_present: Boolean(feedbackOrContext),
      intent_class: classifyIntent(feedbackOrContext),
      reroll_intent_class: rerollIntentClass,
      home_suggestion_count: newSuggestions.filter(s => s.location_type === 'home').length,
      retry_attempted: retryAttempted,
      retry_succeeded: retrySucceeded,
      venue_enrichment_verified_count: countVerified(newSuggestions),
      venue_enrichment_failed_count: countUnverified(newSuggestions),
      suggestion_count: newSuggestions.length,
      past_history_count: (rerollPastHistory || []).length,
      // How many live events were injected into the prompt from Ticketmaster / Eventbrite.
      events_injected_count: rerollLocalEvents.length,
      // Which activity type was detected in the reroll context prompt (null if none).
      activity_type_detected: rerollDetectedActivityType || null,
      // How many activity-specific venues were fetched and injected into the prompt.
      activity_venues_injected: rerollActivityVenueCount,
      // Which reroll number this was (1-indexed) — useful for analyzing
      // how quality changes with successive rerolls on the same itinerary.
      reroll_count: updatedRerollCount,
      // Cultural signal detection — intent-driven temporal anchoring (Live Events V1).
      cultural_signal_detected: !!rerollCulturalSignal,
      cultural_signal_type:     rerollCulturalSignal?.type   || null,
      cultural_signal_entity:   rerollCulturalSignal?.entity || null,
      cultural_event_found:     !!rerollPriorityEvent,
      cultural_anchor_used:     !!rerollPriorityEvent,
    };
    // ─────────────────────────────────────────────────────────────────────────

    // When the attendee swaps out a card that is NOT the organizer's pick, preserve the
    // organizer's pick and status so the attendee still sees Accept/Decline on the original
    // pick card — and accepting it will still auto-lock (otherStatus stays 'accepted').
    // Any other reroll (organizer rerolling, or attendee replacing the organizer's pick card)
    // clears the pick and resets statuses.
    // appendMode never changes statuses or the organizer's pick — it just adds options.
    const preserveOrgPick = appendMode || (isSingleCard && !isOrganizer
      && replaceSuggestionId !== itin.selected_suggestion_id);

    // Build the update payload, omitting selected_suggestion_id entirely when
    // preserveOrgPick is true. Omitting a key means Supabase leaves the stored value
    // unchanged, which is safer than echoing it back: Claude generates suggestion IDs
    // like "s1"/"s2" (not UUIDs), and writing a non-UUID back to a UUID-typed column
    // would fail. Only include selected_suggestion_id when we explicitly want to null it.
    const rerollData = {
      suggestions,
      reroll_count: updatedRerollCount,
      suggestion_telemetry: rerollTelemetry,
      // appendMode: preserve all statuses — we're only adding options, not resetting negotiation
      organizer_status: preserveOrgPick
        ? itin.organizer_status
        : isOrganizer ? 'pending' : (itin.organizer_status === 'accepted' ? 'pending' : itin.organizer_status), // attendee reroll resets organizer to pending so they must re-confirm the new options; 'sent' is not a valid DB status
      attendee_status: appendMode ? itin.attendee_status : 'pending',
    };
    // Clear the org's pick reference only when we're NOT preserving it.
    if (!preserveOrgPick) {
      rerollData.selected_suggestion_id = null;
    }

    const [rerollResult, rollerName] = await Promise.all([
      supabase.from('itineraries')
        .update(rerollData)
        .eq('id', itineraryId)
        .select().single(),
      getProfileName(req.userId, supabase),
    ]);

    if (rerollResult.error || !rerollResult.data) {
      console.error('reroll update failed:', rerollResult.error?.message);
      return res.status(500).json({ error: 'Could not save reroll.' });
    }
    const updated = rerollResult.data;

    // Notify the other person
    await dispatchNotification(supabase, {
      userId: otherUserId,
      type: 'itinerary_reroll',
      title: rollerName + ' rolled new suggestions',
      body: rollerName + (isSingleCard ? ' swapped one plan option.' : ' rolled new suggestions for your plan.'),
      actionUrl: '/schedule/' + itineraryId,
      refId: itineraryId,
    });

    res.json({ itinerary: updated });
  });

  /* ── PATCH /schedule/itinerary/:id/title ─────────────────── */
  app.patch('/schedule/itinerary/:id/title', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid itinerary ID.' });

    const { eventTitle } = req.body;
    if (eventTitle !== null && eventTitle !== undefined && typeof eventTitle !== 'string') {
      return res.status(400).json({ error: 'eventTitle must be a string or null.' });
    }
    const trimmed = typeof eventTitle === 'string' ? eventTitle.trim().slice(0, 80) : null;

    const { data: itin } = await supabase.from('itineraries').select('organizer_id,attendee_id').eq('id', req.params.id).single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId && itin.attendee_id !== req.userId) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    const { error } = await supabase.from('itineraries').update({ event_title: trimmed || null }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Could not update title.' });
    res.json({ ok: true });
  });

  /* ── POST /schedule/itinerary/:id/changelog ──────────────── */
  app.post('/schedule/itinerary/:id/changelog', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid itinerary ID.' });

    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message is required.' });
    // Cap changelog entries at 500 chars — mirrors MAX_CONTEXT used for contextPrompt/feedback.
    // Prevents oversized payloads from bloating the JSONB column on every itinerary load.
    if (message.trim().length > 500) return res.status(400).json({ error: 'Message must be 500 characters or fewer.' });

    const { data: itin } = await supabase.from('itineraries').select('organizer_id,attendee_id,changelog').eq('id', req.params.id).single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId && itin.attendee_id !== req.userId) return res.status(403).json({ error: 'Not authorized.' });

    const entry = { userId: req.userId, message: message.trim(), ts: new Date().toISOString() };
    const changelog = [...(itin.changelog || []), entry];

    await supabase.from('itineraries').update({ changelog }).eq('id', req.params.id);
    res.json({ ok: true, entry });
  });
  /* ── DELETE /schedule/itinerary/:id ─────────────────────── */
  // Only the organizer can delete a draft (organizer_status = 'pending', not locked)
  app.delete('/schedule/itinerary/:id', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid itinerary ID.' });

    const { data: itin } = await supabase
      .from('itineraries')
      .select('organizer_id, locked_at')
      .eq('id', req.params.id)
      .single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId) return res.status(403).json({ error: 'Only the organizer can delete.' });
    if (itin.locked_at) return res.status(400).json({ error: 'Cannot delete a confirmed plan.' });

    const { error } = await supabase.from('itineraries').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Could not delete itinerary.' });
    res.json({ ok: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Internal API routes — server-to-server calls from the MCP server.
  // Protected by requireInternalKey (shared secret), not user session cookies.
  // ═══════════════════════════════════════════════════════════════════════════

  if (requireInternalKey) {

    /* ── POST /internal/schedule/trigger-suggest ────────────────────────────
     * Generates suggestions for an existing itinerary row (created by MCP with
     * empty suggestions). Runs the full AI generation pipeline and updates the
     * row in-place. Synchronous — waits for generation to complete before
     * responding, ensuring the serverless function stays alive on Vercel.
     */
    app.post('/internal/schedule/trigger-suggest', requireInternalKey, async (req, res) => {
      const { itinerary_id } = req.body;
      if (!itinerary_id || !isValidUUID(itinerary_id)) {
        return res.status(400).json({ error: 'Valid itinerary_id is required.' });
      }

      try {
        const { data: itin, error: fetchErr } = await supabase
          .from('itineraries')
          .select('*')
          .eq('id', itinerary_id)
          .single();

        if (fetchErr || !itin) {
          console.error('[internal/trigger-suggest] Itinerary not found:', itinerary_id);
          return res.status(404).json({ error: 'Itinerary not found.' });
        }
        if (itin.locked_at) {
          return res.status(400).json({ error: 'Cannot trigger generation on a locked itinerary.' });
        }

        // Load profiles
        const [profileARes, profileBRes] = await Promise.all([
          supabase.from('profiles').select('id, full_name, location, activity_preferences, dietary_restrictions, mobility_restrictions').eq('id', itin.organizer_id).single(),
          supabase.from('profiles').select('id, full_name, location, activity_preferences, dietary_restrictions, mobility_restrictions').eq('id', itin.attendee_id).single(),
        ]);
        const userA = { name: profileARes.data?.full_name || 'User A', ...profileARes.data };
        const userB = { name: profileBRes.data?.full_name || 'Friend', ...profileBRes.data };

        // Calendar availability
        const start = itin.date_range_start;
        const end   = itin.date_range_end;
        const startISO = new Date(start + 'T00:00:00').toISOString();
        const endISO   = new Date(end   + 'T23:59:59').toISOString();

        const [orgSession, attSession] = await Promise.all([
          sessionStore.getSessionBySupabaseId(itin.organizer_id),
          sessionStore.getSessionBySupabaseId(itin.attendee_id),
        ]);

        let busyA = [], busyB = [];
        try {
          [busyA, busyB] = await Promise.all([
            fetchBusy(orgSession, startISO, endISO, supabase, itin.organizer_id),
            fetchBusy(attSession, startISO, endISO, supabase, itin.attendee_id),
          ]);
        } catch (e) {
          console.error('[internal/trigger-suggest] fetchBusy failed:', e.message);
        }

        const timeOfDay = typeof itin.time_of_day === 'object' ? itin.time_of_day : { type: itin.time_of_day || 'any' };
        const durationMinutes = inferDurationMinutes(itin.event_title, itin.context_prompt);
        const windowFloorMs = Date.now() + 60 * 60 * 1000;

        let freeWindows = findFreeWindows(busyA, busyB, start, end, timeOfDay, 20, 0, durationMinutes)
          .filter(w => new Date(w.start).getTime() >= windowFloorMs);

        // If no shared windows, try attendee-only
        if (freeWindows.length === 0) {
          freeWindows = findFreeWindows([], busyB, start, end, timeOfDay, 20, 0, durationMinutes)
            .filter(w => new Date(w.start).getTime() >= windowFloorMs);
        }

        if (freeWindows.length === 0) {
          console.error('[internal/trigger-suggest] No free windows for itinerary:', itinerary_id);
          return res.status(422).json({ error: 'No availability found.' });
        }

        // Context gathering
        const safeContext = sanitizePromptInput(itin.context_prompt);
        const suggestVenueName = extractVenueName(itin.context_prompt);
        const suggestVenueBlock = suggestVenueName ? buildVenueSubstitutionBlock(suggestVenueName) : '';
        const finalContext = [suggestVenueBlock, safeContext].filter(Boolean).join('\n');

        const { data: annotationData } = await supabase
          .from('friend_annotations')
          .select('shared_interests')
          .eq('user_id', itin.organizer_id)
          .eq('friend_id', itin.attendee_id)
          .maybeSingle();
        const sharedInterests = annotationData?.shared_interests || [];

        const pastHistory = await fetchAcceptedPairHistory(itin.organizer_id, itin.attendee_id, supabase);
        const geoContext = deriveGeoContext(userA, userB);

        let localEvents = [];
        try {
          localEvents = await fetchLocalEvents(
            geoContext, start, end,
            [...(userA.activity_preferences || []), ...(userB.activity_preferences || [])],
          );
        } catch (e) {
          console.error('[internal/trigger-suggest] fetchLocalEvents failed:', e.message);
        }

        let activityVenuesBlock = '';
        try {
          const activityType = extractActivityType(safeContext);
          if (activityType) {
            const cityContext = extractCityFromGeoContext(geoContext);
            const activityVenues = await fetchActivityVenues(activityType, cityContext);
            activityVenuesBlock = buildActivityVenuesBlock(activityType, activityVenues);
          }
        } catch (e) {
          console.error('[internal/trigger-suggest] activityVenues failed:', e.message);
        }

        // Cultural signal
        const culturalSignal = extractCulturalSignal(safeContext, [
          ...(userA.activity_preferences || []),
          ...(userB.activity_preferences || []),
        ]);
        let priorityEventBlock = '';
        if (culturalSignal) {
          try {
            const pe = await fetchCulturalEvent(culturalSignal.type, culturalSignal.entity, start, end);
            if (pe) {
              priorityEventBlock = `\nPRIORITY EVENT (mandatory anchor — you MUST build at least one suggestion around this):\n` +
                `${pe.title} — ${pe.date}${pe.time ? ' at ' + pe.time : ''}\nVenue: ${pe.venue}\n` +
                `Instruction: Anchor exactly one of the three suggestions around this event. ` +
                `Time the suggestion so it leads into the event. The other two should be independent alternatives.`;
            }
          } catch (e) {
            console.warn('[internal/trigger-suggest] fetchCulturalEvent failed:', e.message);
          }
        }

        const organizerFirstName = (userA.full_name || userA.name || '').split(' ')[0] || '';
        const attendeeFirstName  = (userB.full_name || userB.name || '').split(' ')[0] || '';

        const prompt = buildSuggestPrompt({
          userA, userB, freeWindows, contextPrompt: finalContext,
          maxTravelMinutes: itin.max_travel_minutes, eventTitle: itin.event_title,
          durationMinutes, sharedInterests, organizerFirstName, attendeeFirstName,
          pastHistory, localEvents, activityVenuesBlock,
          locationPreference: itin.location_preference || 'system_choice',
          travelMode: itin.travel_mode || 'local',
          tripDurationDays: itin.trip_duration_days || 1,
          destination: itin.destination || null,
          excludedWindowsBlock: buildExcludedWindowsBlock(itin.manual_busy_blocks || []),
          priorityEventBlock,
        });

        // Call Claude
        let suggestions;
        try {
          const msg = await anthropic.messages.create({
            model: CLAUDE_MODEL, max_tokens: 2000,
            system: RENDEZVOUS_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
          });
          const raw = msg.content[0]?.text || '{}';
          const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
          suggestions = parsed.suggestions || [];
        } catch (e) {
          console.error('[internal/trigger-suggest] Claude error:', e.message);
          return res.status(500).json({ error: 'Suggestion generation failed.' });
        }

        // Theme-match retry
        if (itin.context_prompt && classifyIntent(itin.context_prompt) === 'activity_specific' &&
            !themeMatchesContextPrompt(suggestions, itin.context_prompt)) {
          try {
            const retryInstruction =
              `RETRY — the previous attempt did not return any suggestions matching "${safeContext}". ` +
              `This is mandatory: at least one of the 3 suggestions MUST directly feature "${safeContext}".`;
            const retryPrompt = buildSuggestPrompt({
              userA, userB, freeWindows,
              contextPrompt: [retryInstruction, finalContext].filter(Boolean).join('\n'),
              maxTravelMinutes: itin.max_travel_minutes, eventTitle: itin.event_title,
              durationMinutes, sharedInterests, organizerFirstName, attendeeFirstName,
              pastHistory, localEvents, activityVenuesBlock,
              locationPreference: itin.location_preference || 'system_choice',
              travelMode: itin.travel_mode || 'local',
              tripDurationDays: itin.trip_duration_days || 1,
              destination: itin.destination || null,
              excludedWindowsBlock: buildExcludedWindowsBlock(itin.manual_busy_blocks || []),
              priorityEventBlock,
            });
            const retryMsg = await anthropic.messages.create({
              model: CLAUDE_MODEL, max_tokens: 2000,
              system: RENDEZVOUS_SYSTEM_PROMPT,
              messages: [{ role: 'user', content: retryPrompt }],
            });
            const retryRaw    = retryMsg.content[0]?.text || '{}';
            const retryParsed = JSON.parse(retryRaw.replace(/```json|```/g, '').trim());
            if (Array.isArray(retryParsed.suggestions) && retryParsed.suggestions.length > 0) {
              suggestions = retryParsed.suggestions;
            }
          } catch (e) {
            console.error('[internal/trigger-suggest] retry failed:', e.message);
          }
        }

        // Window filter
        const beforeFilter = suggestions.slice();
        suggestions = suggestions.filter(s => {
          if (!s.date || !s.time) return true;
          const match = s.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
          if (!match) return true;
          let h = parseInt(match[1]);
          const min = parseInt(match[2]);
          const ampm = match[3].toUpperCase();
          if (ampm === 'PM' && h !== 12) h += 12;
          if (ampm === 'AM' && h === 12) h = 0;
          const [sy, sm, sd] = s.date.split('-').map(Number);
          const utcStart = new Date(Date.UTC(sy, sm - 1, sd, h, min, 0));
          const durMs = (s.durationMinutes || durationMinutes) * 60000;
          const utcEnd = new Date(utcStart.getTime() + durMs);
          return freeWindows.some(w =>
            utcStart < new Date(w.end) && utcEnd > new Date(w.start)
          );
        });

        // Backfill if needed
        if (suggestions.length < 3 && beforeFilter.length > suggestions.length) {
          const keptTitles = new Set(suggestions.map(s => s.title));
          for (const fb of beforeFilter.filter(s => !keptTitles.has(s.title))) {
            if (suggestions.length >= 3) break;
            suggestions.push(fb);
          }
        }

        // Venue enrichment
        try {
          const cityCtx = extractCityFromGeoContext(geoContext);
          suggestions = await enrichVenues(suggestions, cityCtx);
        } catch (e) {
          console.error('[internal/trigger-suggest] enrichVenues failed:', e.message);
        }

        // Wrap into days structure
        suggestions = suggestions.map(s => {
          if (s.days && Array.isArray(s.days)) return s;
          return { ...s, days: [{ day: 1, label: null, stops: s.venues || [] }] };
        });

        // Update itinerary
        const { error: updateErr } = await supabase
          .from('itineraries')
          .update({ suggestions })
          .eq('id', itinerary_id);

        if (updateErr) {
          console.error('[internal/trigger-suggest] update failed:', updateErr.message);
          return res.status(500).json({ error: 'Failed to save suggestions.' });
        }

        console.log(`[internal/trigger-suggest] Generated ${suggestions.length} suggestions for ${itinerary_id}`);
        res.json({ ok: true, suggestion_count: suggestions.length });
      } catch (err) {
        console.error('[internal/trigger-suggest] unexpected error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Generation failed.' });
      }
    });

    /* ── POST /internal/schedule/trigger-reroll ────────────────────────────
     * Regenerates suggestions for an existing itinerary. Same pipeline as the
     * user-facing reroll endpoint but triggered by the MCP server. Synchronous.
     */
    app.post('/internal/schedule/trigger-reroll', requireInternalKey, async (req, res) => {
      const { itinerary_id, feedback } = req.body;
      if (!itinerary_id || !isValidUUID(itinerary_id)) {
        return res.status(400).json({ error: 'Valid itinerary_id is required.' });
      }

      try {
        const { data: itin, error: fetchErr } = await supabase
          .from('itineraries')
          .select('*')
          .eq('id', itinerary_id)
          .single();

        if (fetchErr || !itin) {
          console.error('[internal/trigger-reroll] Itinerary not found:', itinerary_id);
          return res.status(404).json({ error: 'Itinerary not found.' });
        }
        if (itin.locked_at) {
          console.error('[internal/trigger-reroll] Itinerary is locked:', itinerary_id);
          return res.status(400).json({ error: 'Cannot reroll a locked itinerary.' });
        }

        // Load profiles
        const [profileARes, profileBRes] = await Promise.all([
          supabase.from('profiles').select('id, full_name, location, activity_preferences, dietary_restrictions, mobility_restrictions').eq('id', itin.organizer_id).single(),
          supabase.from('profiles').select('id, full_name, location, activity_preferences, dietary_restrictions, mobility_restrictions').eq('id', itin.attendee_id).single(),
        ]);
        const userA = { name: profileARes.data?.full_name || 'User A', ...profileARes.data };
        const userB = { name: profileBRes.data?.full_name || 'Friend', ...profileBRes.data };

        // Rebuild free windows
        const todayStr = new Date().toISOString().split('T')[0];
        const start = itin.date_range_start > todayStr ? itin.date_range_start : todayStr;
        const end   = itin.date_range_end;
        const startISO = new Date(start + 'T00:00:00').toISOString();
        const endISO   = new Date(end   + 'T23:59:59').toISOString();

        const [orgSession, attSession] = await Promise.all([
          sessionStore.getSessionBySupabaseId(itin.organizer_id),
          sessionStore.getSessionBySupabaseId(itin.attendee_id),
        ]);

        let busyA = [], busyB = [];
        try {
          [busyA, busyB] = await Promise.all([
            fetchBusy(orgSession, startISO, endISO, supabase, itin.organizer_id),
            fetchBusy(attSession, startISO, endISO, supabase, itin.attendee_id),
          ]);
        } catch (e) {
          console.error('[internal/trigger-reroll] fetchBusy failed:', e.message);
        }

        const timeOfDay = typeof itin.time_of_day === 'object' ? itin.time_of_day : { type: itin.time_of_day || 'any' };
        const durationMinutes = inferDurationMinutes(itin.event_title, itin.context_prompt);
        const windowFloorMs = Date.now() + 60 * 60 * 1000;

        let freeWindows = findFreeWindows(busyA, busyB, start, end, timeOfDay, 20, 0, durationMinutes)
          .filter(w => new Date(w.start).getTime() >= windowFloorMs);

        if (freeWindows.length === 0) {
          freeWindows = findFreeWindows([], busyB, start, end, timeOfDay, 20, 0, durationMinutes)
            .filter(w => new Date(w.start).getTime() >= windowFloorMs);
        }

        if (freeWindows.length === 0) {
          console.error('[internal/trigger-reroll] No free windows for itinerary:', itinerary_id);
          return res.status(422).json({ error: 'No availability found.' });
        }

        // Context
        const safeOriginalContext = sanitizePromptInput(itin.context_prompt);
        const safeFeedback = sanitizePromptInput(feedback);

        const { data: annotationData } = await supabase
          .from('friend_annotations')
          .select('shared_interests')
          .eq('user_id', itin.organizer_id)
          .eq('friend_id', itin.attendee_id)
          .maybeSingle();
        const sharedInterests = annotationData?.shared_interests || [];
        const pastHistory = await fetchAcceptedPairHistory(itin.organizer_id, itin.attendee_id, supabase);
        const geoContext = deriveGeoContext(userA, userB);

        let localEvents = [];
        try {
          localEvents = await fetchLocalEvents(
            geoContext, start, end,
            [...(userA.activity_preferences || []), ...(userB.activity_preferences || [])],
          );
        } catch (e) {
          console.error('[internal/trigger-reroll] fetchLocalEvents failed:', e.message);
        }

        let activityVenuesBlock = '';
        try {
          const activityType = extractActivityType(safeOriginalContext);
          if (activityType) {
            const cityContext = extractCityFromGeoContext(geoContext);
            const activityVenues = await fetchActivityVenues(activityType, cityContext);
            activityVenuesBlock = buildActivityVenuesBlock(activityType, activityVenues);
          }
        } catch (e) {
          console.error('[internal/trigger-reroll] activityVenues failed:', e.message);
        }

        const organizerFirstName = (userA.full_name || userA.name || '').split(' ')[0] || '';
        const attendeeFirstName  = (userB.full_name || userB.name || '').split(' ')[0] || '';

        // Build reroll prompt: original context + feedback
        const combinedContext = [safeOriginalContext, safeFeedback].filter(Boolean).join('\n\nAdditional feedback: ');

        const prompt = buildSuggestPrompt({
          userA, userB, freeWindows, contextPrompt: combinedContext,
          maxTravelMinutes: itin.max_travel_minutes, eventTitle: itin.event_title,
          durationMinutes, sharedInterests, organizerFirstName, attendeeFirstName,
          pastHistory, localEvents, activityVenuesBlock,
          locationPreference: itin.location_preference || 'system_choice',
          travelMode: itin.travel_mode || 'local',
          tripDurationDays: itin.trip_duration_days || 1,
          destination: itin.destination || null,
          excludedWindowsBlock: buildExcludedWindowsBlock(itin.manual_busy_blocks || []),
        });

        // Call Claude
        let suggestions;
        try {
          const msg = await anthropic.messages.create({
            model: CLAUDE_MODEL, max_tokens: 2000,
            system: RENDEZVOUS_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
          });
          const raw = msg.content[0]?.text || '{}';
          const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
          suggestions = parsed.suggestions || [];
        } catch (e) {
          console.error('[internal/trigger-reroll] Claude error:', e.message);
          return res.status(500).json({ error: 'Suggestion generation failed.' });
        }

        // Theme-match retry
        const effectiveContext = itin.context_prompt || feedback;
        if (effectiveContext && classifyIntent(effectiveContext) === 'activity_specific' &&
            !themeMatchesContextPrompt(suggestions, effectiveContext)) {
          try {
            const retryInstruction =
              `RETRY — the previous attempt did not return any suggestions matching "${sanitizePromptInput(effectiveContext)}". ` +
              `This is mandatory: at least one of the 3 suggestions MUST directly feature that activity.`;
            const retryPrompt = buildSuggestPrompt({
              userA, userB, freeWindows,
              contextPrompt: [retryInstruction, combinedContext].filter(Boolean).join('\n'),
              maxTravelMinutes: itin.max_travel_minutes, eventTitle: itin.event_title,
              durationMinutes, sharedInterests, organizerFirstName, attendeeFirstName,
              pastHistory, localEvents, activityVenuesBlock,
              locationPreference: itin.location_preference || 'system_choice',
              travelMode: itin.travel_mode || 'local',
              tripDurationDays: itin.trip_duration_days || 1,
              destination: itin.destination || null,
              excludedWindowsBlock: buildExcludedWindowsBlock(itin.manual_busy_blocks || []),
            });
            const retryMsg = await anthropic.messages.create({
              model: CLAUDE_MODEL, max_tokens: 2000,
              system: RENDEZVOUS_SYSTEM_PROMPT,
              messages: [{ role: 'user', content: retryPrompt }],
            });
            const retryRaw = retryMsg.content[0]?.text || '{}';
            const retryParsed = JSON.parse(retryRaw.replace(/```json|```/g, '').trim());
            if (Array.isArray(retryParsed.suggestions) && retryParsed.suggestions.length > 0) {
              suggestions = retryParsed.suggestions;
            }
          } catch (e) {
            console.error('[internal/trigger-reroll] retry failed:', e.message);
          }
        }

        // Window filter
        const beforeFilter = suggestions.slice();
        suggestions = suggestions.filter(s => {
          if (!s.date || !s.time) return true;
          const match = s.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
          if (!match) return true;
          let h = parseInt(match[1]);
          const min = parseInt(match[2]);
          const ampm = match[3].toUpperCase();
          if (ampm === 'PM' && h !== 12) h += 12;
          if (ampm === 'AM' && h === 12) h = 0;
          const [sy, sm, sd] = s.date.split('-').map(Number);
          const utcStart = new Date(Date.UTC(sy, sm - 1, sd, h, min, 0));
          const durMs = (s.durationMinutes || durationMinutes) * 60000;
          const utcEnd = new Date(utcStart.getTime() + durMs);
          return freeWindows.some(w =>
            utcStart < new Date(w.end) && utcEnd > new Date(w.start)
          );
        });

        if (suggestions.length < 3 && beforeFilter.length > suggestions.length) {
          const keptTitles = new Set(suggestions.map(s => s.title));
          for (const fb of beforeFilter.filter(s => !keptTitles.has(s.title))) {
            if (suggestions.length >= 3) break;
            suggestions.push(fb);
          }
        }

        // Venue enrichment
        try {
          const cityCtx = extractCityFromGeoContext(geoContext);
          suggestions = await enrichVenues(suggestions, cityCtx);
        } catch (e) {
          console.error('[internal/trigger-reroll] enrichVenues failed:', e.message);
        }

        // Wrap into days structure
        suggestions = suggestions.map(s => {
          if (s.days && Array.isArray(s.days)) return s;
          return { ...s, days: [{ day: 1, label: null, stops: s.venues || [] }] };
        });

        // Update itinerary
        const { error: updateErr } = await supabase
          .from('itineraries')
          .update({
            suggestions,
            reroll_count: (itin.reroll_count || 0) + 1,
            organizer_status: 'pending',
            attendee_status:  'pending',
            selected_suggestion_id: null,
          })
          .eq('id', itinerary_id);

        if (updateErr) {
          console.error('[internal/trigger-reroll] update failed:', updateErr.message);
          return res.status(500).json({ error: 'Failed to save suggestions.' });
        }

        console.log(`[internal/trigger-reroll] Generated ${suggestions.length} suggestions for ${itinerary_id}`);
        res.json({ ok: true, suggestion_count: suggestions.length });
      } catch (err) {
        console.error('[internal/trigger-reroll] unexpected error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Reroll failed.' });
      }
    });

  } // end requireInternalKey guard

};

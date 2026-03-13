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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_CONTEXT  = 500;  // contextPrompt / feedback chars
// Use Haiku in dev (cheap, fast for testing), Sonnet in production (quality suggestions)
const IS_PROD = process.env.NODE_ENV === 'production';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL
  || (IS_PROD ? 'claude-sonnet-4-5-20250929' : 'claude-haiku-4-5-20251001');

// UUID validation — used throughout this file to reject malformed IDs before
// they reach Supabase.  The same pattern is used in friends.js and users.js;
// keep the regex identical so behaviour is consistent across all routers.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Prompt injection patterns — phrases that attempt to override or escape the system prompt.
// This is not exhaustive, but catches the most common attack vectors. The sanitizer is
// applied to any user-supplied free-text that is interpolated into the Claude prompt
// (contextPrompt, feedback). Matched segments are replaced with [removed].
const INJECTION_RE = /\b(ignore\s+(previous|all|prior)\s+(instructions?|prompts?|context)|system\s*:|assistant\s*:|<\s*\/?\s*(system|assistant|user|prompt)\s*>|disregard\s+(the\s+)?(above|previous|prior)|you\s+are\s+now|new\s+instructions?|override\s+(the\s+)?(above|previous)|forget\s+(everything|all)|jailbreak|do\s+anything\s+now|DAN\b)/gi;

/**
 * Sanitize a user-supplied string before injecting it into the Claude prompt.
 * Strips common prompt-injection patterns and truncates to maxLen characters.
 * @param {string} text    - raw user input
 * @param {number} maxLen  - hard character cap (defaults to MAX_CONTEXT)
 */
function sanitizePromptInput(text, maxLen = MAX_CONTEXT) {
  if (!text || typeof text !== 'string') return '';
  // Replace injection patterns first, then trim whitespace artifacts, then truncate.
  return text.replace(INJECTION_RE, '[removed]').trim().slice(0, maxLen);
}

// Emails exempt from all rate limits — useful for testing in production.
const RATE_LIMIT_EXEMPT = new Set(['aaron.gottesfeld@gmail.com']);
/** Returns true only if s is a well-formed UUID v4 string. */
function isValidUUID(s) { return typeof s === 'string' && UUID_RE.test(s); }

/* ── Helpers ──────────────────────────────────────────────────────── */

/**
 * Creates a fresh Google OAuth2 client, optionally pre-loaded with stored tokens.
 * A new instance is created per-request/per-operation to avoid shared mutable state
 * across concurrent requests.
 */
function createOAuth2Client(tokens) {
  const c = new (require('googleapis').google.auth.OAuth2)(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  if (tokens) c.setCredentials(tokens);
  return c;
}

/**
 * Fetch busy slots for a user. Uses real Google Calendar if tokens exist,
 * otherwise falls back to mock_busy_slots from the profile row (test users).
 *
 * Throws if we have tokens but the Google API call fails — so the caller
 * can surface an error rather than treating a calendar failure as "no busy slots"
 * and generating suggestions against incorrect availability data.
 */
async function fetchBusy(session, startISO, endISO, supabase, userId) {
  // Real calendar path
  if (session?.tokens?.access_token) {
    const auth = createOAuth2Client(session.tokens);
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: startISO,
        timeMax: endISO,
        items: [{ id: 'primary' }],
      },
    });
    return res.data.calendars?.primary?.busy || [];
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
  // No prompt at all → most likely a casual hang at home
  if (!contextPrompt || !contextPrompt.trim()) return 'home_likely';
  const text = contextPrompt.toLowerCase();

  // Single-card reroll patterns: "go to [place]" or "watch [title]" are near-literal
  // instructions — treat as activity_specific so Claude focuses on the named thing.
  // "go to" almost always means a specific venue, even if no venue name follows.
  if (/^\s*go\s+to\b/.test(text)) return 'activity_specific';

  // "watch [something]" in a single-card context means a movie/show at home, not a theater,
  // unless "theater" or "cinema" appears alongside it.
  if (/\bwatch\b/.test(text) && !/\b(theater|cinema|movie theater|imax)\b/.test(text)) {
    return 'home_likely';
  }

  // Keywords that strongly imply going out to a venue
  if (/\b(dinner|lunch|brunch|restaurant|bar|bars|drinks|cocktails|concert|show|museum|gallery|golf|bowling|movie theater|cinema|club|lounge|arcade|escape room|spa|class|workout|gym|hike|beach|park outing|sporting event|game night out|rooftop)\b/.test(text)) {
    return 'activity_specific';
  }

  // Keywords that suggest staying in / home-based hangout
  if (/\b(hang(ing)? out|chill|come over|just hang|at (my|your|the) place|home|house|apartment|cook(ing)?|bake|movie night|netflix|jam(ming)?|game night|board games?|video games?|play(ing)? games?|night in|stay in|order in|take(out|away))\b/.test(text)) {
    return 'home_likely';
  }

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

  const windows = [];
  // Use UTC date construction so the loop is timezone-agnostic on any server.
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59));

  while (cur <= end && windows.length < maxWindows) {
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
        windows.push({ start: wStart.toISOString(), end: wEnd.toISOString() });
        if (windows.length >= maxWindows) break;
      }
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return windows;
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
function buildSuggestPrompt({ userA, userB, freeWindows, contextPrompt, maxTravelMinutes, eventTitle, durationMinutes, sharedInterests, organizerFirstName, attendeeFirstName }) {
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
  const intent = classifyIntent(contextPrompt);
  const orgFirst = organizerFirstName || userA.name?.split(' ')[0] || 'the organizer';
  const attFirst = attendeeFirstName  || userB.name?.split(' ')[0] || 'the attendee';
  const intentBlock = intent === 'home_likely'
    ? `HOME VS. VENUE SPLIT: Generate 2 of the 3 itineraries as home-based plans — one at ${orgFirst}'s place and one at ${attFirst}'s place. Include what they'd do (cook together, watch a game, jam, play games, etc.) based on their shared interests. The 3rd itinerary should be a venue-based option as an alternative. Do not suggest restaurants or bars as the primary activity for home-based agendas. Set location_type to "home" for home plans and "venue" for the venue option.`
    : intent === 'ambiguous'
    ? `HOME VS. VENUE SPLIT: Generate at least 1 of the 3 itineraries as a home-based plan. The others may be venue-based. Set location_type accordingly.`
    : `HOME VS. VENUE SPLIT: All 3 itineraries should be venue-based. Focus on the specific activity requested. Set location_type to "venue" for all.`;

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

  return `You are Rendezvous, an activity planner. Generate exactly 3 itinerary suggestions for two people to meet up.
${geoContext ? `GEOGRAPHIC CONTEXT: ${geoContext}` : ''}
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
}
AVAILABLE TIME WINDOWS (use one per suggestion):
${windowList || 'Flexible — pick reasonable times in the next 2 weeks'}

MAX TRAVEL TIME: ${maxTravelMinutes ? maxTravelMinutes + ' minutes each way' : 'no limit'}
EVENT DURATION: Set durationMinutes based on the actual activity planned (e.g. coffee/drinks=60, lunch=75-90, dinner=90-120, bar night=120, concert/game/show=150-180, hike/full day=240-360). Do not default to 120 for everything — reason about what the activity actually takes.

${intentBlock}
${hardConstraints ? `\nHARD REQUIREMENTS — these are non-negotiable:\n${hardConstraints}` : ''}
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
      "neighborhood": "Neighborhood name",
      "venues": [
        { "name": "Venue Name or Person's Home", "type": "bar|restaurant|activity|venue|home", "address": "123 Main St, City, State (omit for home)" }
      ],
      "narrative": "2-3 sentences. Be specific and direct — name the actual activity and why the spot is good. Skip the flowery adjectives. No 'perfect blend', 'vibrant', or similar filler. Just tell them what they're doing and why it makes sense for both people.",
      "estimatedTravelA": "15 min",
      "estimatedTravelB": "20 min",
      "tags": ["cocktails", "rooftop"]
    }
  ]
}

Rules:
- All venues must be real, currently open establishments
- Spread suggestions across different vibes (e.g. chill, active, social)
- Use different time windows for each suggestion when possible
- Venue variety: do not default to the most popular or highest-rated spots. Mix well-known places with neighborhood spots and less obvious choices. Avoid recommending the same venues repeatedly across sessions.
- Free and public options are valid and often preferred: parks, public courts, piers, plazas, beaches, trails, free museum nights, open-air markets. If the activity is naturally free (spikeball, frisbee, picnic, running), suggest a specific named park or public space — not a paid venue. Do not bias toward paid experiences.
- Cost range across suggestions: aim for a mix — at least one low-cost or free option per set of suggestions when the context allows it. Users should not feel like every plan requires spending money.
- Narrative tone: direct and practical, like a friend who knows the area recommending something. Name specific things about the venues. No marketing language, no "perfect blend of X and Y", no "vibrant" or "iconic". Just what it is and why it works.`;
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
 * Creates a Google Calendar event for a single user.
 * Gracefully no-ops if the user has no valid tokens — calendar write is
 * best-effort and should never block the itinerary lock.
 *
 * Returns the created event ID, or null on failure.
 */
async function createCalendarEventForUser({ session, suggestion, organizer, attendee }) {
  if (!session?.tokens?.access_token) return null;

  try {
    const auth = createOAuth2Client(session.tokens);

    // Refresh token if expired
    const expiry = session.tokens.expiry_date;
    if (expiry && Date.now() > expiry - 60000 && session.tokens.refresh_token) {
      const { credentials } = await auth.refreshAccessToken();
      session.tokens = credentials;
      auth.setCredentials(credentials);
    }

    const calendar = google.calendar({ version: 'v3', auth });

    /**
     * Convert a suggestion's date + time into an RFC 3339 datetime string.
     * Accepts "7:00 PM" style time strings from Claude's JSON output.
     * Logs a warning if the year looks like a past year — this is a signal that
     * buildSuggestPrompt's window strings are missing the year field and Claude
     * defaulted to the wrong year.
     */
    function toRFC3339(dateStr, timeStr) {
      if (!dateStr) return null;
      if (!timeStr) return dateStr; // date-only fallback — calendar event will be all-day
      const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!match) return dateStr;
      let h = parseInt(match[1]);
      const min = match[2];
      const ampm = match[3].toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      const hh = String(h).padStart(2, '0');

      // Safety net: warn if Claude returned a date in the past year.
      // Root cause is usually missing year:'numeric' in buildSuggestPrompt's window list.
      const parsedYear = parseInt((dateStr || '').split('-')[0], 10);
      if (parsedYear && parsedYear < new Date().getFullYear()) {
        console.warn(
          `[toRFC3339] Suggestion date "${dateStr}" is in a past year (${parsedYear}). ` +
          'Check that buildSuggestPrompt includes year in window date strings.'
        );
      }

      return `${dateStr}T${hh}:${min}:00`;
    }

    const startDT = toRFC3339(suggestion.date, suggestion.time);
    const durMs   = (suggestion.durationMinutes || 120) * 60000;
    const endDT   = startDT
      ? new Date(new Date(startDT).getTime() + durMs).toISOString().replace(/\.\d{3}Z$/, '')
      : null;

    if (!startDT) return null;

    // Build venue description
    const venueLines = (suggestion.venues || [])
      .map(v => `${v.name}${v.address ? ' — ' + v.address : ''}`)
      .join('\n');
    const description = [
      suggestion.narrative,
      venueLines ? '\nStops:\n' + venueLines : '',
    ].filter(Boolean).join('\n\n');

    const venueName   = suggestion.venues?.[0]?.name || suggestion.activityType || 'Plans';
    const otherFirst  = (attendee?.full_name || '').split(' ')[0] || 'Friend';
    const location    = suggestion.venues?.[0]?.address || suggestion.neighborhood || '';

    const event = await calendar.events.insert({
      calendarId: 'primary',
      sendUpdates: 'none', // we handle our own notifications
      requestBody: {
        summary: `${venueName} with ${otherFirst}`,
        description,
        location,
        start: { dateTime: startDT, timeZone: 'America/New_York' },
        end:   { dateTime: endDT,   timeZone: 'America/New_York' },
        attendees: [
          { email: organizer.email, displayName: organizer.full_name },
          { email: attendee.email,  displayName: attendee.full_name  },
        ],
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 60 },
            { method: 'email', minutes: 1440 }, // 1 day before
          ],
        },
      },
    });

    return event.data.id || null;
  } catch (err) {
    // Calendar write is best-effort — log but don't throw
    console.warn('createCalendarEventForUser failed:', err.message);
    return null;
  }
}

/**
 * @param {object} sessionStore - { getSessionBySupabaseId } — replaces the old userSessions Map.
 *   getSessionBySupabaseId(supabaseId) is async and queries the Supabase sessions table.
 */
module.exports = function scheduleRouter(app, supabase, requireAuth, sessionStore) {

  /* ── POST /schedule/suggest ──────────────────────────────── */
  app.post('/schedule/suggest', requireAuth, async (req, res) => {
    const { targetUserId, startDate, endDate, timeOfDay, maxTravelMinutes, contextPrompt, eventTitle, timezoneOffsetMinutes, confirmedOrganizerConflict } = req.body;
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

    const today = new Date().toISOString().split('T')[0];
    const start = startDate || today;
    const end   = endDate   || (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().split('T')[0]; })();

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

    const tzOffset = Number(timezoneOffsetMinutes) || 0;

    const durationMinutes = inferDurationMinutes(eventTitle, contextPrompt);

    // Windows where the attendee is free — used to detect if the attendee is simply unavailable.
    const attendeeWindows = findFreeWindows([], busyB, start, end, timeOfDay, 20, tzOffset, durationMinutes);

    // If the attendee is fully booked in the requested window, bail out early.
    if (attendeeWindows.length === 0) {
      return res.status(422).json({
        error: 'No availability found in the selected time window. Try a different date or time of day.',
      });
    }

    // Windows where BOTH organizer and attendee are free — the ideal case.
    // If any exist, use them and skip the organizer entirely (their conflicts are excluded naturally).
    // Only warn the organizer if they are completely blocked across the entire window with no gaps.
    const bothWindows = findFreeWindows(busyA, busyB, start, end, timeOfDay, 20, tzOffset, durationMinutes);
    let freeWindows;
    if (bothWindows.length > 0) {
      // Organizer has some free time — use shared windows, no warning needed.
      freeWindows = bothWindows;
    } else if (!confirmedOrganizerConflict) {
      // Organizer is fully blocked but attendee has availability — ask for confirmation.
      return res.status(200).json({ needsConfirmation: true });
    } else {
      // Organizer confirmed override — schedule across their conflicts using attendee-only windows.
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

    // Call Claude
    // Extract first names so the prompt can reference "at Aaron's place" in home-based agendas.
    const organizerFirstName = (userA.full_name || userA.name || '').split(' ')[0] || '';
    const attendeeFirstName  = (userB.full_name || userB.name || '').split(' ')[0] || '';
    const prompt = buildSuggestPrompt({ userA, userB, freeWindows, contextPrompt: finalSuggestContext, maxTravelMinutes, eventTitle, durationMinutes, sharedInterests, organizerFirstName, attendeeFirstName });
    let suggestions;
    try {
      const msg = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
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

    // Validate Claude's suggestions against the free windows.
    // Claude occasionally picks times that weren't in the provided window list.
    // We reject any suggestion whose local date+time (converted to UTC via the client's
    // timezone offset) doesn't overlap with at least one computed free window.
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
        context_prompt:   contextPrompt || null,
        event_title:      eventTitle?.trim() || null,
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

    // Notify the other person
    const confirmerName = await getProfileName(req.userId, supabase);
    const otherForConfirm = isOrganizer ? itin.attendee_id : itin.organizer_id;
    const confirmMsg = updated?.locked_at
      ? confirmerName + ' accepted — your plan is locked in! 🎉'
      : isSuggestAlternative
        ? confirmerName + ' is suggesting a different option. Take a look.'
        : confirmerName + ' accepted a plan. Waiting for the other person to confirm.';
    const confirmTitle = updated?.locked_at
      ? 'Plan locked in! 🎉'
      : isSuggestAlternative
        ? confirmerName + ' suggested an alternative'
        : confirmerName + ' accepted a plan';
    await supabase.from('notifications').insert({
      user_id: otherForConfirm, type: 'itinerary_accepted',
      title: confirmTitle,
      body: confirmMsg,
      action_url: '/schedule/' + itineraryId, ref_id: itineraryId,
    });

    // If just locked — create Google Calendar events for both users (best-effort)
    let calendarEventId = updated?.calendar_event_id || null;
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

      // Create event using whichever user has valid tokens (organizer preferred)
      const activeSession = organizerSession || attendeeSession;
      if (suggestion && activeSession) {
        calendarEventId = await createCalendarEventForUser({
          session: activeSession,
          suggestion,
          organizer: organizerProfile,
          attendee:  attendeeProfile,
        });

        if (calendarEventId) {
          await supabase.from('itineraries')
            .update({ calendar_event_id: calendarEventId })
            .eq('id', itineraryId);
        }
      }
    }

    res.json({ itinerary: updated, locked: !!updated?.locked_at, calendarEventId });
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
    await supabase.from('notifications').insert({
      user_id: itin.attendee_id, type: 'itinerary_invite',
      title: 'New plan from ' + senderName,
      body: senderName + ' sent you some plans to review.',
      action_url: '/schedule/' + req.params.id, ref_id: req.params.id,
    });

    res.json({ ok: true });
  });

  /* ── POST /schedule/itinerary/:id/decline ────────────────── */
  app.post('/schedule/itinerary/:id/decline', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid itinerary ID.' });

    const { data: itin } = await supabase.from('itineraries').select('organizer_id,attendee_id').eq('id', req.params.id).single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId && itin.attendee_id !== req.userId) return res.status(403).json({ error: 'Not authorized.' });

    const field = itin.organizer_id === req.userId ? 'organizer_status' : 'attendee_status';
    await supabase.from('itineraries').update({ [field]: 'declined' }).eq('id', req.params.id);

    // Notify the other person
    const otherUserId = itin.organizer_id === req.userId ? itin.attendee_id : itin.organizer_id;
    const declinerName = await getProfileName(req.userId, supabase);
    await supabase.from('notifications').insert({
      user_id: otherUserId, type: 'itinerary_declined',
      title: declinerName + ' declined the plan',
      body: declinerName + ' passed on the plans. You can re-roll for new ideas.',
      action_url: '/schedule/' + req.params.id, ref_id: req.params.id,
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
      ? `Generate exactly 1 suggestion (not 3). ${rerollInstructions[rerollType] || rerollInstructions.both} Make it clearly different from these existing options: ${existingTitles.join(', ')}. Return a JSON object with a "suggestions" array containing exactly 1 item.`
      : '';
    // appendMode: generate 3 new suggestions distinct from everything already shown
    const appendNote = appendMode && !isSingleCard
      ? `Generate 3 brand-new suggestions completely different from these already-shown options: ${existingTitles.join(', ')}. Do not repeat any of these.`
      : '';

    // Rebuild free windows from the original date range so reroll respects bounds.
    // Also clamp start to today — no point generating windows in the past.
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
    const rerollWindows = findFreeWindows(rerollBusyA, rerollBusyB, rerollStart, rerollEnd, { type: itin.time_of_day || 'any' }, 20, 0, rerollDuration);

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

    // Extract first names for home-based agenda copy, same as in the suggest route.
    const rerollOrgFirst = (userA.full_name || '').split(' ')[0] || '';
    const rerollAttFirst = (userB.full_name || '').split(' ')[0] || '';

    // Single-card rerolls with a specific contextPrompt or singleCardNote should be
    // treated as near-literal instructions, not preference hints. The user said exactly
    // what they want ("go to Russ & Daughters", "watch a movie", "just hang out") —
    // Claude should match the intent as literally as possible, not substitute something
    // thematically similar. We prepend a hard EXACT MATCH block before anything else
    // so it takes precedence over profile preferences and general rules.
    const safeRerollContext = sanitizePromptInput(contextPrompt);
    const exactMatchBlock = isSingleCard && (safeRerollContext || singleCardNote)
      ? `EXACT MATCH REQUIRED: The user has given a specific instruction for this suggestion: "${safeRerollContext || singleCardNote}". Generate a suggestion that matches this as closely as possible. If it names a specific venue, activity type, or location, use that directly. If it describes an activity at home (e.g. "just hang out", "watch a movie", "come over"), generate a home-based agenda. Do not substitute a thematically similar but different activity — match the intent as literally as possible.`
      : '';

    // If the context prompt names a specific venue, also inject the substitution rule
    // so Claude handles venue unavailability gracefully rather than silently ignoring it.
    const rerollVenueName  = extractVenueName(contextPrompt);
    const rerollVenueBlock = rerollVenueName ? buildVenueSubstitutionBlock(rerollVenueName) : '';

    const prompt = buildSuggestPrompt({
      userA: { ...userA, name: userA.full_name || 'User A' },
      userB: { ...userB, name: userB.full_name || 'User B' },
      freeWindows: rerollWindows,
      // exactMatchBlock and venueBlock go first so they override everything else.
      // singleCardNote / appendNote are server-generated strings — no sanitization needed.
      // safeRerollContext is already sanitized above; feedback is sanitized inline.
      contextPrompt: [
        exactMatchBlock,
        rerollVenueBlock,
        safeRerollContext,
        feedback ? `Feedback: ${sanitizePromptInput(feedback)}` : '',
        singleCardNote,
        appendNote,
      ].filter(Boolean).join('. '),
      maxTravelMinutes: itin.max_travel_minutes || null,
      eventTitle: itin.event_title || null,
      durationMinutes: rerollDuration,
      sharedInterests: rerollSharedInterests,
      organizerFirstName: rerollOrgFirst,
      attendeeFirstName:  rerollAttFirst,
    });

    let newSuggestions;
    try {
      const msg = await anthropic.messages.create({
        model: CLAUDE_MODEL, max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = msg.content[0]?.text || '{}';
      newSuggestions = JSON.parse(raw.replace(/```json|```/g, '').trim()).suggestions || [];
    } catch (e) {
      console.error('Claude reroll error:', e.message);
      return res.status(500).json({ error: 'Could not generate new suggestions. Please try again.' });
    }

    // Filter out any suggestions whose date+time falls outside the computed free windows.
    // Reroll has no client-side tzOffset, so default to 0 (UTC). Reroll windows were built
    // with tzOffset=0, so suggestions generated from them will already be in UTC-relative slots.
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
      const utcStart = new Date(Date.UTC(sy2, sm2 - 1, sd2, h, min, 0));
      const durMs    = (s.durationMinutes || rerollDuration) * 60000;
      const utcEnd   = new Date(utcStart.getTime() + durMs);
      const inWindow = rerollWindows.some(w =>
        utcStart < new Date(w.end) && utcEnd > new Date(w.start)
      );
      if (!inWindow) {
        console.warn(`[reroll] Dropping hallucinated suggestion: ${s.date} ${s.time}`);
      }
      return inWindow;
    });

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
    } else if (isSingleCard) {
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
      reroll_count: (itin.reroll_count || 0) + 1,
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
    await supabase.from('notifications').insert({
      user_id: otherUserId, type: 'itinerary_reroll',
      title: rollerName + ' rolled new suggestions',
      body: rollerName + (isSingleCard ? ' swapped one plan option.' : ' rolled new suggestions for your plan.'),
      action_url: '/schedule/' + itineraryId, ref_id: itineraryId,
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

};

// routes/group-itineraries.js — group itinerary routes
//
// POST  /group-itineraries                    — create itinerary (organizer_draft)
// POST  /group-itineraries/:id/suggest        — generate AI suggestions
// POST  /group-itineraries/:id/send           — organizer sends to group
// PATCH /group-itineraries/:id/vote           — attendee votes on a suggestion
// POST  /group-itineraries/:id/reroll         — organizer requests new suggestions
// GET   /group-itineraries/:id               — get itinerary with member vote status
// POST  /group-itineraries/:id/comments       — add a comment on a suggestion
// GET   /group-itineraries/:id/comments       — paginated comments for an itinerary
//
// Design notes:
//   - quorum_threshold has NO DEFAULT in the DB — computed from attendee count here.
//   - The DB trigger (group_itineraries_lock_check) handles lock/cancel logic on vote.
//     Do NOT replicate trigger logic here.
//   - travel_mode, trip_duration_days, destination are always read from the DB row
//     on reroll — never from the request body.
//   - All member profile data returned is limited to id, full_name, avatar_url.
//   - Service role client bypasses RLS — all auth enforcement is application-layer.

'use strict';

const { randomUUID } = require('crypto');
const { sendPush } = require('../utils/pushNotifications');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const { createCalendarEventForUser } = require('../utils/calendarUtils');
const { enrichVenues, extractCityFromGeoContext } = require('../utils/venueEnrichment');
const { fetchLocalEvents } = require('../utils/events');
const { extractActivityType, fetchActivityVenues, buildActivityVenuesBlock } = require('../utils/activityVenues');
const { classifyRerollIntent } = require('../utils/classifyRerollIntent');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const IS_PROD   = process.env.NODE_ENV === 'production';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL
  || (IS_PROD ? 'claude-sonnet-4-5-20250929' : 'claude-haiku-4-5-20251001');

// Matches schedule.js voice and output contract.
const RENDEZVOUS_SYSTEM_PROMPT =
  "You are Rendezvous, a sharp, well-connected activity planner who knows cities intimately. " +
  "You make plans like a trusted local friend — specific, opinionated, and practical. " +
  "You never use marketing language. You never say 'vibrant', 'perfect blend', 'iconic', or 'unique'. " +
  "You name real places, real activities, and real reasons why something works for a specific group. " +
  "When suggesting home-based plans, you describe what they'll actually do — the specific game, " +
  "the cooking project, the jam session — not just 'hang out at home'. " +
  "Always follow the JSON schema exactly as instructed.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(s) { return typeof s === 'string' && UUID_RE.test(s); }

const MAX_CONTEXT = 500;
const INJECTION_RE = /\b(ignore\s+(previous|all|prior)\s+(instructions?|prompts?|context)|system\s*:|assistant\s*:|<\s*\/?\s*(system|assistant|user|prompt)\s*>|disregard\s+(the\s+)?(above|previous|prior)|you\s+are\s+now|new\s+instructions?|override\s+(the\s+)?(above|previous)|forget\s+(everything|all)|jailbreak|do\s+anything\s+now|DAN\b)/gi;

function sanitizePromptInput(text, maxLen = MAX_CONTEXT) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(INJECTION_RE, '[removed]').trim().slice(0, maxLen);
}

// Month/day name tables — avoids locale-dependent toLocaleDateString across Lambda envs.
const _MONTHS   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function fmtWindowDate(d) {
  const year    = d.getUTCFullYear();
  const month   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day     = String(d.getUTCDate()).padStart(2, '0');
  const weekday = _WEEKDAYS[d.getUTCDay()];
  const monthName = _MONTHS[d.getUTCMonth()];
  let h = d.getUTCHours(), m = d.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12; else if (h === 0) h = 12;
  return `${weekday}, ${year}-${month}-${day} (${monthName} ${d.getUTCDate()}), ${h}:${String(m).padStart(2,'0')} ${ampm}`;
}

function timeOfDayHours(tod) {
  if (!tod || tod === 'any') return [8, 23];
  if (tod === 'morning')     return [8, 12];
  if (tod === 'afternoon')   return [12, 17];
  if (tod === 'evening')     return [17, 23];
  return [8, 23];
}

/**
 * Find windows where ALL members in the busySlots array are free simultaneously.
 * busySlots is an array of [{start, end}] arrays — one per member.
 */
function findFreeWindowsForGroup(busySlots, startDate, endDate, todFilter, maxWindows = 20, timezoneOffsetMinutes = 0, durationMinutes = 120) {
  const [localStart, localEnd] = timeOfDayHours(todFilter);
  const offsetHours  = timezoneOffsetMinutes / 60;
  const utcStart     = Math.max(0,  localStart + offsetHours);
  const utcEnd       = Math.min(47, localEnd   + offsetHours);
  const durationMs   = durationMinutes * 60000;
  const durationHours = durationMinutes / 60;

  // Collect up to 100 candidate windows sequentially, then sample across 3 equal buckets
  // to ensure suggestions are spread across the full date range rather than clustered early.
  const INTERNAL_CAP = 100;
  const allWindows = [];
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59));

  while (cur <= end && allWindows.length < INTERNAL_CAP) {
    for (let h = utcStart; h + durationHours <= utcEnd; h += 1) {
      const wStart = new Date(cur);
      wStart.setUTCHours(h, 0, 0, 0);
      const wEnd = new Date(wStart.getTime() + durationMs);

      const overlaps = (slots) => slots.some(s => {
        const sStart = new Date(s.start);
        const sEnd   = new Date(s.end);
        return sStart < wEnd && sEnd > wStart;
      });

      // Accept window only when no member in the group is busy.
      const anyBusy = busySlots.some(memberBusy => overlaps(memberBusy));
      if (!anyBusy) {
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
 * Fetch busy slots for a user from Google Calendar or their mock_busy_slots profile field.
 * Mirrors schedule.js fetchBusy — per-user, best-effort.
 */
async function fetchBusy(session, startISO, endISO, supabase, userId) {
  if (session?.tokens?.access_token) {
    const auth = new (require('googleapis').google.auth.OAuth2)(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    auth.setCredentials(session.tokens);
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
      console.warn('[group-itineraries] fetchBusy (mock) failed:', e.message);
    }
  }
  return [];
}

/**
 * Build the Claude prompt for a group itinerary.
 * Group-adapted version of buildSuggestPrompt from schedule.js:
 *   - Uses group description + context_prompt as the primary AI signal
 *   - Lists all member names and preferences (not just organizer + attendee)
 *   - Aggregates dietary and mobility restrictions across all members as hard constraints
 *   - Injects group size so Claude can reason about venue capacity
 */
function formatTime12h(t) { // '14:00' → '2:00 PM'
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
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

function buildGroupSuggestPrompt({ groupName, groupDescription, members, freeWindows, contextPrompt, eventTitle, maxTravelMinutes, durationMinutes = 120, pastHistory = [], localEvents = [], activityVenuesBlock = '', locationPreference = 'system_choice', travelMode = 'local', tripDurationDays = 1, destination = null, rerollNote = '', excludedWindowsBlock = '', attendeeBusyNotesBlock = '' }) {
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
${localEvents && localEvents.length > 0
  ? `\nAVAILABLE TIME-SENSITIVE EVENTS\nThe following real events are happening during the requested date range. If any align well with the group's interests and context, you MAY anchor one suggestion around an event. This is optional — only use an event if it genuinely fits.\n` +
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
      "tags": ["cocktails", "rooftop"]
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
 * Fetch past accepted group itineraries as taste signal for Claude.
 * Best-effort — returns [] on any error.
 */
async function fetchGroupHistory(groupId, supabase, limit = 3) {
  if (!groupId) return [];
  try {
    const { data } = await supabase
      .from('group_itineraries')
      .select('id, suggestions, selected_suggestion_id')
      .eq('group_id', groupId)
      .eq('itinerary_status', 'locked')
      .not('locked_at', 'is', null)
      .order('locked_at', { ascending: false })
      .limit(limit);

    if (!data) return [];
    return data.flatMap(itin => {
      const suggestions = itin.suggestions || [];
      const selected = suggestions.find(s => s.id === itin.selected_suggestion_id) || suggestions[0];
      if (!selected) return [];
      return [{
        title:        selected.title || '',
        neighborhood: selected.neighborhood || '',
        venues:       (selected.days?.[0]?.stops ?? selected.venues ?? []).map(v => v.name).filter(Boolean),
        tags:         selected.tags || [],
      }];
    });
  } catch (err) {
    console.warn('[group-itineraries] fetchGroupHistory failed:', err.message);
    return [];
  }
}

/**
 * Insert a notification row. Best-effort — failures never block the primary action.
 */
async function insertNotification(supabase, userId, type, tier, title, body, data, actionUrl) {
  try {
    await supabase.from('notifications').insert({
      user_id:    userId,
      type,
      tier,
      title,
      body,
      data:       data || null,
      action_url: actionUrl || null,
      read:       false,
    });
  } catch (e) {
    console.warn('[group-itineraries] insertNotification failed:', e.message);
  }
}

/**
 * Core suggestion generation logic shared by /suggest and /reroll.
 * Fetches member calendars, finds free windows, calls Claude, enriches venues.
 *
 * @param {object} itin        - group_itineraries row from DB
 * @param {object[]} members   - array of member profile objects with isOrganizer flag
 * @param {string} organizerId - UUID of the organizer
 * @param {object} supabase    - Supabase client
 * @param {object} sessionStore - { getSessionBySupabaseId }
 * @returns {object[]} suggestions array, ready for DB write
 */
async function generateGroupSuggestions(itin, members, organizerId, supabase, sessionStore, { rerollType = 'both', existingSuggestions = [], singleCard = false, targetSuggestion = null, contextPrompt: rerollContextPrompt = '' } = {}) {
  const start = itin.date_range_start;
  const end   = itin.date_range_end;
  const startISO = new Date(start + 'T00:00:00').toISOString();
  const endISO   = new Date(end   + 'T23:59:59').toISOString();

  // Fetch calendar sessions for all members concurrently.
  const memberIds     = members.map(m => m.id);
  const sessionPromises = memberIds.map(id => sessionStore.getSessionBySupabaseId(id));
  const memberSessions  = await Promise.all(sessionPromises);

  // Fetch busy slots for all members concurrently. Best-effort per member.
  const busyPromises = members.map((m, i) =>
    fetchBusy(memberSessions[i], startISO, endISO, supabase, m.id).catch(e => {
      console.warn(`[group-itineraries] fetchBusy failed for ${m.id}:`, e.message);
      return [];
    })
  );
  const allBusySlots = await Promise.all(busyPromises); // one entry per member

  const durationMinutes = 120; // default; groups don't infer from title yet

  // Find windows where ALL members are free.
  const windowFloorMs = Date.now() + 60 * 60 * 1000; // +1hr buffer
  let freeWindows = findFreeWindowsForGroup(
    allBusySlots, start, end, itin.time_of_day, 20, 0, durationMinutes
  ).filter(w => new Date(w.start).getTime() >= windowFloorMs);

  // If strict-all-members yields no windows, fall back to organizer-only availability
  // so generation doesn't fail entirely — this mirrors the confirmedOrganizerConflict
  // path in schedule.js. Log the fallback so it's observable.
  if (freeWindows.length === 0) {
    console.warn('[group-itineraries] No shared-all windows found; falling back to organizer-only windows');
    const organizerIdx  = members.findIndex(m => m.id === organizerId);
    const organizerBusy = organizerIdx >= 0 ? allBusySlots[organizerIdx] : [];
    freeWindows = findFreeWindowsForGroup(
      [organizerBusy], start, end, itin.time_of_day, 20, 0, durationMinutes
    ).filter(w => new Date(w.start).getTime() >= windowFloorMs);
  }

  // Derive geo context for live events and activity venues.
  const locations = members.map(m => m.location).filter(Boolean);
  const geoContext = locations.length ? locations[0] : '';
  const cityCtx    = extractCityFromGeoContext(geoContext);

  // Fetch live events. Best-effort.
  let localEvents = [];
  try {
    const allPrefs = members.flatMap(m => m.activity_preferences || []);
    localEvents = await fetchLocalEvents(geoContext, start, end, allPrefs);
  } catch (e) {
    console.error('[group-itineraries] fetchLocalEvents failed:', e.message);
  }

  // Activity venue discovery. Best-effort.
  let activityVenuesBlock = '';
  const safeContext = sanitizePromptInput(itin.context_prompt || '');
  try {
    const activityType = extractActivityType(safeContext);
    if (activityType) {
      const venues = await fetchActivityVenues(activityType, cityCtx);
      activityVenuesBlock = buildActivityVenuesBlock(activityType, venues);
    }
  } catch (e) {
    console.error('[group-itineraries] activityVenues failed:', e.message);
  }

  // Fetch past group history as taste signal.
  const pastHistory = await fetchGroupHistory(itin.group_id, supabase);

  // Fetch group details (name, description, default_activities) if group_id is set.
  let groupName = 'Group';
  let groupDescription = '';
  let groupDefaultActivities = [];
  if (itin.group_id) {
    const { data: grp } = await supabase
      .from('groups')
      .select('name, description, default_activities')
      .eq('id', itin.group_id)
      .maybeSingle();
    if (grp) {
      groupName              = sanitizePromptInput(grp.name || 'Group', 100);
      groupDescription       = sanitizePromptInput(grp.description || '', 300);
      // Group's default activities — used as AI fallback context when no event-specific
      // prompt is provided. Only applied when context_prompt is absent.
      groupDefaultActivities = Array.isArray(grp.default_activities) ? grp.default_activities : [];
    }
  }

  // Use the event-specific context prompt if set; fall back to the group's default
  // activities as a soft signal so Claude has something to anchor on.
  const effectiveContext = safeContext ||
    (groupDefaultActivities.length
      ? groupDefaultActivities.map(a => sanitizePromptInput(a, 100)).join(', ')
      : '');

  // Build a reroll instruction note so Claude knows what to vary vs. preserve.
  // For single-card reroll, exclude the target from existingTitles so dedup ignores it.
  const existingTitles = existingSuggestions
    .filter(s => !targetSuggestion || s.id !== targetSuggestion.id)
    .map(s => s.title).filter(Boolean);
  const avoidClause = existingTitles.length ? ` Avoid repeating these existing options: ${existingTitles.join(', ')}.` : '';

  const vibeAddendum = rerollContextPrompt ? ` User's specific request: "${rerollContextPrompt}".` : '';

  // Micro-adjustment detection — same classification as schedule.js, applied to the
  // user's reroll input only (rerollContextPrompt). Falls back to full_replace for
  // ambiguous or empty inputs.
  const rerollIntentClass = classifyRerollIntent(rerollContextPrompt);
  if (rerollIntentClass === 'ambiguous') {
    console.warn('[group-itineraries] classifyRerollIntent returned ambiguous — falling back to full_replace');
  }

  const microAdjustBlock = rerollIntentClass === 'micro_adjust'
    ? `MICRO-ADJUSTMENT MODE: The user has requested a small modification to the previous suggestions, not a full replacement.
You MUST preserve the overall structure, venue sequence, activity types, and general vibe of the prior itinerary.
Only modify the specific dimension the user called out.
Do NOT introduce entirely new venues or activity categories unless the user explicitly asks.
The user's modification request is: "${rerollContextPrompt}"`
    : '';

  const priorSuggestionsBlock = rerollIntentClass === 'micro_adjust' && existingSuggestions?.length > 0
    ? `PRIOR SUGGESTIONS (for reference — preserve structure unless instructed otherwise):
${JSON.stringify(
  existingSuggestions.map(s => ({
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

  let rerollNote;
  if (singleCard && targetSuggestion) {
    const singleCardInstructions = {
      timing:   `Keep the same activity concept and venues as "${targetSuggestion.title || 'this option'}". Only change the date and time — find a different time slot. Do not change the venues, activity type, or narrative theme.`,
      activity: `Keep the same date and time as "${targetSuggestion.title || 'this option'}" (${targetSuggestion.date || ''} at ${targetSuggestion.time || ''}). Suggest a completely different activity and venues. The vibe should be noticeably different.${vibeAddendum}`,
      both:     `Replace "${targetSuggestion.title || 'this option'}" with a fresh alternative — different activity and different time.${vibeAddendum}`,
    };
    rerollNote = `Generate exactly 1 suggestion (not 3). ${singleCardInstructions[rerollType] || singleCardInstructions.both}${avoidClause} Return a JSON object with a "suggestions" array containing exactly 1 item. You are replacing a single card, not a full set. You are not bound by the cross-card no-duplicate venue rule — if the user's request references or implies a venue shown on another card, use it.`;
  } else {
    const rerollNoteMap = {
      timing:   `Generate 3 suggestions with DIFFERENT dates/times than before — keep the same activity types and neighborhood vibes but find new time windows.${avoidClause}`,
      activity: `Generate 3 suggestions with DIFFERENT activities and venues — keep the same time windows from the availability list but suggest completely different things to do and different neighborhoods. The vibe should be noticeably different.${avoidClause}`,
      both:     existingTitles.length ? `Generate 3 brand-new suggestions completely different from these already-shown options: ${existingTitles.join(', ')}. Different activities, different times, different vibes.` : '',
    };
    rerollNote = rerollNoteMap[rerollType] || '';
  }

  const prompt = buildGroupSuggestPrompt({
    groupName,
    groupDescription,
    members,
    freeWindows,
    contextPrompt:    effectiveContext,
    eventTitle:       itin.event_title,
    maxTravelMinutes: itin.max_travel_minutes,
    durationMinutes,
    pastHistory,
    localEvents,
    activityVenuesBlock,
    locationPreference: itin.location_preference  || 'system_choice',
    travelMode:         itin.travel_mode          || 'local',
    tripDurationDays:   itin.trip_duration_days   || 1,
    destination:        itin.destination          || null,
    rerollNote: [microAdjustBlock, priorSuggestionsBlock, rerollNote].filter(Boolean).join('\n'),
    excludedWindowsBlock:  buildExcludedWindowsBlock(itin.manual_busy_blocks || []),
    attendeeBusyNotesBlock: buildGroupAttendeeNotesBlock(itin.attendee_busy_notes || {}),
  });

  let suggestions;
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    system: RENDEZVOUS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw    = msg.content[0]?.text || '{}';
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  suggestions  = (parsed.suggestions || []).map(s => ({ ...s, id: randomUUID() }));

  // Enrich venues via Google Places. Best-effort.
  try {
    suggestions = await enrichVenues(suggestions, cityCtx);
  } catch (e) {
    console.error('[group-itineraries] enrichVenues failed:', e.message);
  }

  // Wrap single-day venue arrays into the unified days structure (Step 5 schema).
  suggestions = suggestions.map(s => {
    if (s.days && Array.isArray(s.days)) return s;
    return { ...s, days: [{ day: 1, label: null, stops: s.venues || [] }] };
  });

  return suggestions;
}

module.exports = function groupItinerariesRouter(app, supabase, requireAuth, sessionStore) {

  /* ── POST /group-itineraries ──────────────────────────────────────────── */
  // Creates a new group itinerary in organizer_draft state. Suggestions are NOT
  // generated here — call /suggest after creation to generate AI suggestions.
  app.post('/group-itineraries', requireAuth, async (req, res) => {
    const {
      group_id,
      attendee_user_ids,
      date_range_start,
      date_range_end,
      time_of_day,
      max_travel_minutes,
      context_prompt,
      event_title,
      travel_mode: rawTravelMode,
      location_preference: rawLocationPref,
      destination: rawDestination,
      trip_duration_days: rawTripDays,
      nudge_after_hours: rawNudgeHours,
      tie_behavior: rawTieBehavior,
      manual_busy_blocks: rawBusyBlocks,
    } = req.body;

    // Validate required fields.
    if (!date_range_start || !date_range_end) {
      return res.status(400).json({ error: 'date_range_start and date_range_end are required.' });
    }
    if (!Array.isArray(attendee_user_ids) || attendee_user_ids.length === 0) {
      return res.status(400).json({ error: 'attendee_user_ids must be a non-empty array.' });
    }
    if (attendee_user_ids.some(id => !isValidUUID(id))) {
      return res.status(400).json({ error: 'All attendee_user_ids must be valid UUIDs.' });
    }
    if (attendee_user_ids.includes(req.userId)) {
      return res.status(400).json({ error: 'attendee_user_ids must not include the organizer.' });
    }
    if (group_id && !isValidUUID(group_id)) {
      return res.status(400).json({ error: 'group_id must be a valid UUID if provided.' });
    }

    const VALID_LOCATION_PREFS = new Set(['closer_to_organizer', 'closer_to_attendee', 'system_choice', 'destination']);
    const VALID_TRAVEL_MODES   = new Set(['local', 'travel', 'remote']);
    const VALID_TIE_BEHAVIORS  = new Set(['schedule', 'decline']);
    const VALID_NUDGE_HOURS    = new Set([24, 48, 72, 168]);

    // manual_busy_blocks: array of { date: 'YYYY-MM-DD', label?: string }. Cap at 20 entries.
    const manualBusyBlocks = Array.isArray(rawBusyBlocks)
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
      : [];

    const travelMode       = VALID_TRAVEL_MODES.has(rawTravelMode)   ? rawTravelMode  : 'local';
    const locationPref     = VALID_LOCATION_PREFS.has(rawLocationPref) ? rawLocationPref : 'system_choice';
    const tieBehavior      = VALID_TIE_BEHAVIORS.has(rawTieBehavior) ? rawTieBehavior : 'schedule';
    const tripDurationDays = Math.max(1, Math.min(30, parseInt(rawTripDays) || 1));
    const nudgeAfterHours  = VALID_NUDGE_HOURS.has(parseInt(rawNudgeHours)) ? parseInt(rawNudgeHours) : 48;
    const destination      = (travelMode === 'travel' && typeof rawDestination === 'string')
      ? rawDestination.trim().slice(0, 100) || null
      : null;

    // Build attendee_statuses JSONB map: { user_id: 'pending' } for each attendee.
    const attendeeStatuses = Object.fromEntries(attendee_user_ids.map(id => [id, 'pending']));

    // quorum_threshold: majority quorum. No DEFAULT in DB — must always be supplied.
    // Accept an explicit override from the request body if within valid range.
    const attendeeCount     = attendee_user_ids.length;
    const defaultThreshold  = Math.ceil(attendeeCount / 2);
    const rawThreshold      = parseInt(req.body.quorum_threshold);
    const quorumThreshold   = (!isNaN(rawThreshold) && rawThreshold >= 1 && rawThreshold <= attendeeCount)
      ? rawThreshold
      : defaultThreshold;

    const { data: itin, error: insertErr } = await supabase
      .from('group_itineraries')
      .insert({
        group_id:           group_id || null,
        organizer_id:       req.userId,
        attendee_statuses:  attendeeStatuses,
        quorum_threshold:   quorumThreshold,  // NO DEFAULT in DB — must supply here
        tie_behavior:       tieBehavior,
        itinerary_status:   'organizer_draft',
        date_range_start,
        date_range_end,
        time_of_day:        time_of_day || 'any',
        max_travel_minutes: max_travel_minutes || null,
        context_prompt:     sanitizePromptInput(context_prompt || ''),
        event_title:        typeof event_title === 'string' ? event_title.trim().slice(0, 200) : null,
        travel_mode:        travelMode,
        location_preference: locationPref,
        destination,
        trip_duration_days: tripDurationDays,
        nudge_after_hours:  nudgeAfterHours,
        manual_busy_blocks: manualBusyBlocks,
        suggestions:        [],
        changelog:          [],
        reroll_count:       0,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('[group-itineraries] create error:', insertErr.message);
      return res.status(500).json({ error: 'Could not create group itinerary.' });
    }

    res.status(201).json({ itineraryId: itin.id });
  });

  /* ── POST /group-itineraries/:id/suggest ─────────────────────────────── */
  // Generates AI suggestions and writes them to the itinerary's suggestions column.
  // Itinerary stays in organizer_draft — organizer reviews before sending to group.
  app.post('/group-itineraries/:id/suggest', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ error: 'Invalid itinerary ID.' });
    }

    const { data: itin, error: fetchErr } = await supabase
      .from('group_itineraries')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId) return res.status(403).json({ error: 'Not authorized.' });
    if (itin.itinerary_status !== 'organizer_draft') {
      return res.status(400).json({ error: 'Suggestions can only be generated in organizer_draft status.' });
    }

    // Load all member profiles (organizer + all attendees).
    const attendeeIds = Object.keys(itin.attendee_statuses || {});
    const allMemberIds = [req.userId, ...attendeeIds];

    const { data: profiles, error: profileErr } = await supabase
      .from('profiles')
      .select('id, full_name, location, activity_preferences, dietary_restrictions, mobility_restrictions')
      .in('id', allMemberIds);

    if (profileErr || !profiles) {
      return res.status(500).json({ error: 'Could not load member profiles.' });
    }

    const members = profiles.map(p => ({
      ...p,
      isOrganizer: p.id === req.userId,
    }));

    let suggestions;
    try {
      suggestions = await generateGroupSuggestions(itin, members, req.userId, supabase, sessionStore);
    } catch (e) {
      console.error('[group-itineraries] generateGroupSuggestions failed:', e.message);
      return res.status(500).json({ error: 'Could not generate suggestions. Please try again.' });
    }

    const { error: updateErr } = await supabase
      .from('group_itineraries')
      .update({ suggestions })
      .eq('id', req.params.id);

    if (updateErr) {
      console.error('[group-itineraries] suggest update error:', updateErr.message);
      return res.status(500).json({ error: 'Could not save suggestions.' });
    }

    res.json({ suggestions });
  });

  /* ── POST /group-itineraries/:id/send ────────────────────────────────── */
  // Organizer sends the itinerary to all attendees.
  // Transitions itinerary_status: organizer_draft → awaiting_responses.
  // Creates a Tier 1 notification for each attendee.
  app.post('/group-itineraries/:id/send', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ error: 'Invalid itinerary ID.' });
    }

    const { data: itin } = await supabase
      .from('group_itineraries')
      .select('organizer_id, itinerary_status, attendee_statuses, event_title, suggestions')
      .eq('id', req.params.id)
      .single();

    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId) return res.status(403).json({ error: 'Not authorized.' });
    if (itin.itinerary_status !== 'organizer_draft') {
      return res.status(400).json({ error: 'Can only send an itinerary that is in organizer_draft status.' });
    }
    if (!Array.isArray(itin.suggestions) || itin.suggestions.length === 0) {
      return res.status(400).json({ error: 'Generate suggestions before sending the itinerary.' });
    }

    // Optional: organizer can specify which suggestion they're recommending.
    // Validated against the itinerary's suggestions array. Defaults to first suggestion.
    const { suggestion_id } = req.body;
    let selectedSuggestionId = itin.suggestions[0]?.id || null;
    if (suggestion_id) {
      const validIds = itin.suggestions.map(s => s.id);
      if (!validIds.includes(suggestion_id)) {
        return res.status(400).json({ error: 'suggestion_id does not match any suggestion in this itinerary.' });
      }
      selectedSuggestionId = suggestion_id;
    }

    // Record the organizer's implied acceptance in attendee_suggestion_map so per-card
    // vote tallies include their preference. Do NOT add them to attendee_statuses — that
    // map drives the quorum trigger and the organizer is the planner, not a quorum voter.
    const currentSuggestionMap  = itin.attendee_suggestion_map || {};
    const updatedSuggestionMap  = { ...currentSuggestionMap, [req.userId]: selectedSuggestionId };

    const { error: updateErr } = await supabase
      .from('group_itineraries')
      .update({
        itinerary_status:             'awaiting_responses',
        selected_suggestion_id:       selectedSuggestionId,
        organizer_recommendation_id:  selectedSuggestionId, // never overwritten by attendee votes
        attendee_suggestion_map:      updatedSuggestionMap,
      })
      .eq('id', req.params.id);

    if (updateErr) {
      console.error('[group-itineraries] send error:', updateErr.message);
      return res.status(500).json({ error: 'Could not send itinerary.' });
    }

    // Notify all attendees — Tier 1 (action required).
    const organizerName = req.userSession.name || 'Someone';
    const eventName     = itin.event_title || 'a plan';
    const attendeeIds   = Object.keys(itin.attendee_statuses || {});

    await Promise.all(attendeeIds.map(attendeeId =>
      insertNotification(
        supabase,
        attendeeId,
        'group_event_invite',
        1,
        `${organizerName} wants to plan ${eventName}`,
        `${organizerName} sent you some plans to review. Tap to vote.`,
        { group_itinerary_id: req.params.id },
        `/group-itineraries/${req.params.id}`,
      )
    ));
    attendeeIds.forEach(attendeeId =>
      sendPush(supabase, attendeeId, {
        title: `${organizerName} wants to plan ${eventName}`,
        body: `${organizerName} sent you some plans to review. Tap to vote.`,
        actionUrl: `/group-itineraries/${req.params.id}`,
      })
    );

    res.json({ message: 'Itinerary sent to group.' });
  });

  /* ── PATCH /group-itineraries/:id/vote ───────────────────────────────── */
  // Attendee records their vote. Updates the caller's key in attendee_statuses.
  // The DB trigger (group_itineraries_lock_check) evaluates quorum — do NOT replicate
  // that logic here. The trigger runs BEFORE UPDATE on attendee_statuses changes.
  app.patch('/group-itineraries/:id/vote', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ error: 'Invalid itinerary ID.' });
    }

    const { selected_suggestion_id, vote, busy_notes: rawBusyNotes } = req.body;

    const VALID_VOTES = new Set(['accepted', 'declined', 'abstained']);
    if (!VALID_VOTES.has(vote)) {
      return res.status(400).json({ error: 'vote must be one of: accepted, declined, abstained.' });
    }
    if (!selected_suggestion_id || typeof selected_suggestion_id !== 'string') {
      return res.status(400).json({ error: 'selected_suggestion_id is required.' });
    }

    const { data: itin } = await supabase
      .from('group_itineraries')
      .select('organizer_id, organizer_recommendation_id, itinerary_status, attendee_statuses, attendee_suggestion_map, suggestions, event_title, group_id, attendee_busy_notes')
      .eq('id', req.params.id)
      .single();

    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });

    if (itin.itinerary_status !== 'awaiting_responses') {
      return res.status(400).json({ error: 'Voting is only open when itinerary is awaiting_responses.' });
    }

    // Verify caller is an attendee (not the organizer).
    const attendeeStatuses = itin.attendee_statuses || {};
    if (!(req.userId in attendeeStatuses)) {
      return res.status(403).json({ error: 'Not authorized to vote on this itinerary.' });
    }

    // Validate that the selected suggestion ID exists in this itinerary.
    const validIds = (itin.suggestions || []).map(s => s.id);
    if (!validIds.includes(selected_suggestion_id)) {
      return res.status(400).json({ error: 'selected_suggestion_id does not match any suggestion.' });
    }

    // Update attendee_statuses and attendee_suggestion_map.
    const updatedStatuses = { ...attendeeStatuses, [req.userId]: vote };
    const updatedSuggestionMap = { ...(itin.attendee_suggestion_map || {}), [req.userId]: selected_suggestion_id };

    // Compute the most-voted card among accepted attendees so the DB trigger
    // locks with the correct winner in selected_suggestion_id.
    const acceptedUids = Object.entries(updatedStatuses).filter(([, v]) => v === 'accepted').map(([uid]) => uid);
    const voteCounts   = {};
    acceptedUids.forEach(uid => {
      const sid = updatedSuggestionMap[uid];
      if (sid) voteCounts[sid] = (voteCounts[sid] || 0) + 1;
    });
    const winnerCard = Object.entries(voteCounts).sort(([, a], [, b]) => b - a)[0]?.[0]
      || itin.organizer_recommendation_id
      || selected_suggestion_id;

    // If the attendee is declining and left busy notes, merge into attendee_busy_notes jsonb map.
    const voteUpdate = {
      attendee_statuses:       updatedStatuses,
      attendee_suggestion_map: updatedSuggestionMap,
      selected_suggestion_id:  winnerCard,
    };
    if (vote === 'declined' && rawBusyNotes && typeof rawBusyNotes === 'string') {
      const sanitizedNotes = sanitizePromptInput(rawBusyNotes.trim().slice(0, 300));
      if (sanitizedNotes) {
        const existingNotes = itin.attendee_busy_notes || {};
        voteUpdate.attendee_busy_notes = { ...existingNotes, [req.userId]: sanitizedNotes };
      }
    }

    const { data: updated, error: updateErr } = await supabase
      .from('group_itineraries')
      .update(voteUpdate)
      .eq('id', req.params.id)
      .select('itinerary_status, locked_at')
      .single();

    if (updateErr) {
      console.error('[group-itineraries] vote error:', updateErr.message);
      return res.status(500).json({ error: 'Could not record vote.' });
    }

    // Notify others when attendee counter-proposes (votes for a non-recommendation card).
    const isCounterProposal = vote === 'accepted' && selected_suggestion_id !== itin.organizer_recommendation_id;
    if (isCounterProposal) {
      const counterCard    = (itin.suggestions || []).find(s => s.id === selected_suggestion_id);
      const counterTitle   = counterCard?.title || 'an alternative';
      const voterName      = req.userSession?.name || 'Someone';
      const eventName      = itin.event_title || 'your group event';
      const notifyIds      = [
        itin.organizer_id,
        ...Object.keys(attendeeStatuses).filter(uid => uid !== req.userId),
      ];
      await Promise.all(notifyIds.map(uid =>
        insertNotification(
          supabase, uid,
          'group_event_counter_proposal', 2,
          `${voterName} suggested "${counterTitle}"`,
          `${voterName} voted for a different option in ${eventName}. Review it and update your vote if you like it.`,
          { group_itinerary_id: req.params.id },
          `/group-itineraries/${req.params.id}`,
        )
      ));
      for (const uid of notifyIds) {
        sendPush(supabase, uid, {
          title: `${voterName} suggested "${counterTitle}"`,
          body: `${voterName} voted for a different option in ${eventName}.`,
          actionUrl: `/group-itineraries/${req.params.id}`,
        });
      }
    }

    // Notify all members when voting triggers a lock.
    if (updated.itinerary_status === 'locked') {
      // Resolve the group name for the notification body.
      let groupName = itin.event_title || 'Group event';
      if (itin.group_id) {
        const { data: groupRow } = await supabase
          .from('groups')
          .select('name')
          .eq('id', itin.group_id)
          .single();
        if (groupRow?.name) groupName = groupRow.name;
      }

      const notifyIds = [
        itin.organizer_id,
        ...Object.keys(itin.attendee_statuses || {}),
      ];
      await Promise.all(notifyIds.map(uid =>
        insertNotification(
          supabase, uid,
          'itinerary_locked', 1,
          'Group plans confirmed',
          `${groupName} plans are locked in. Calendar invites for group events are coming soon — add it to your calendar manually from the event view for now.`,
          { group_itinerary_id: req.params.id },
          `/group-itineraries/${req.params.id}`,
        )
      ));
    }

    res.json({
      message:          'Vote recorded.',
      itinerary_status: updated.itinerary_status,
      locked_at:        updated.locked_at,
    });
  });

  /* ── POST /group-itineraries/:id/finalize-lock ───────────────────────── */
  // Creates Google Calendar events for all group members once an itinerary locks.
  // Idempotent — if calendar_event_id is already set, returns immediately.
  // Best-effort: members without valid OAuth tokens are silently skipped.
  app.post('/group-itineraries/:id/finalize-lock', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ error: 'Invalid itinerary ID.' });
    }

    const { data: itin, error: fetchErr } = await supabase
      .from('group_itineraries')
      .select('id, itinerary_status, locked_at, attendee_statuses, organizer_id, suggestions, selected_suggestion_id, event_title, calendar_event_id, calendar_event_url')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !itin) return res.status(404).json({ error: 'Itinerary not found.' });

    if (itin.itinerary_status !== 'locked' || !itin.locked_at) {
      return res.status(400).json({ error: 'Itinerary is not locked.' });
    }

    if (itin.calendar_event_id) {
      return res.status(200).json({ message: 'Calendar events already created.', alreadyDone: true });
    }

    const isOrganizer = req.userId === itin.organizer_id;
    const isAttendee  = req.userId in (itin.attendee_statuses || {});
    if (!isOrganizer && !isAttendee) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    // Resolve selected suggestion
    const suggestion = (itin.suggestions || []).find(s => s.id === itin.selected_suggestion_id)
      || itin.suggestions?.[0];

    // All member IDs: organizer + every attendee
    const memberIds = [itin.organizer_id, ...Object.keys(itin.attendee_statuses || {})];

    // Fetch profiles for all members
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', memberIds);
    const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    // Build calendar write promises for each member
    const calendarPromises = memberIds.map(async (memberId) => {
      const session = await sessionStore.getSessionBySupabaseId(memberId);
      if (!session?.tokens?.access_token) {
        console.warn(`[finalize-lock] No tokens for member ${memberId} — skipping calendar write.`);
        return null;
      }
      return createCalendarEventForUser({
        session,
        suggestion,
        organizer: profileMap[itin.organizer_id] || { email: '', full_name: 'Organizer' },
        attendee: { full_name: itin.event_title || 'Group Event', email: '' },
        itineraryId: itin.id,
      });
    });

    const results = await Promise.allSettled(calendarPromises);

    // Log failures
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(`[finalize-lock] Calendar write rejected for member ${memberIds[i]}:`, r.reason);
      }
    });

    // Collect successes
    const fulfilled = results
      .filter(r => r.status === 'fulfilled' && r.value?.id)
      .map(r => r.value);

    let calendarEventUrl = null;
    if (fulfilled.length > 0) {
      const first = fulfilled[0];
      calendarEventUrl = first.htmlLink || null;
      await supabase
        .from('group_itineraries')
        .update({ calendar_event_id: first.id, calendar_event_url: calendarEventUrl })
        .eq('id', itin.id);
    }

    return res.json({
      message: 'Calendar events created.',
      successCount: fulfilled.length,
      totalMembers: memberIds.length,
      calendar_event_url: calendarEventUrl,
    });
  });

  /* ── POST /group-itineraries/:id/reroll ──────────────────────────────── */
  // Organizer requests new suggestions.
  //   - Appends current suggestions to changelog
  //   - Increments reroll_count
  //   - Re-generates suggestions (reads travel_mode/destination from DB, never request body)
  //   - Resets all attendee_statuses back to 'pending'
  //   - Keeps itinerary_status as awaiting_responses if already there
  app.post('/group-itineraries/:id/reroll', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ error: 'Invalid itinerary ID.' });
    }

    const { data: itin } = await supabase
      .from('group_itineraries')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    const isOrganizerReroll = itin.organizer_id === req.userId;
    const isAttendeeReroll  = req.userId in (itin.attendee_statuses || {});
    if (!isOrganizerReroll && !isAttendeeReroll) return res.status(403).json({ error: 'Not authorized.' });
    // Attendees may only reroll individual cards (not full sets) in awaiting_responses.
    if (!isOrganizerReroll && !req.body.replaceSuggestionId) {
      return res.status(403).json({ error: 'Attendees can only re-roll individual suggestions.' });
    }
    if (!['organizer_draft', 'awaiting_responses'].includes(itin.itinerary_status)) {
      return res.status(400).json({ error: 'Can only reroll an itinerary in organizer_draft or awaiting_responses status.' });
    }
    if (itin.locked_at) {
      return res.status(400).json({ error: 'Cannot reroll a locked itinerary.' });
    }

    // Load member profiles.
    const attendeeIds  = Object.keys(itin.attendee_statuses || {});
    const allMemberIds = [req.userId, ...attendeeIds];

    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, location, activity_preferences, dietary_restrictions, mobility_restrictions')
      .in('id', allMemberIds);

    const members = (profiles || []).map(p => ({
      ...p,
      isOrganizer: p.id === req.userId,
    }));

    const VALID_REROLL_TYPES = new Set(['timing', 'activity', 'both']);
    const rerollType = VALID_REROLL_TYPES.has(req.body.rerollType) ? req.body.rerollType : 'both';
    const rerollContextPrompt = sanitizePromptInput(req.body.contextPrompt || '', 500);

    // Single-card reroll: replace one specific suggestion in-place.
    const { replaceSuggestionId } = req.body;
    const existingSuggestions = itin.suggestions || [];
    const targetSuggestion = replaceSuggestionId
      ? existingSuggestions.find(s => s.id === replaceSuggestionId) || null
      : null;
    if (replaceSuggestionId && !targetSuggestion) {
      return res.status(400).json({ error: 'replaceSuggestionId does not match any suggestion.' });
    }
    const isSingleCard = !!targetSuggestion;

    let newSuggestions;
    try {
      newSuggestions = await generateGroupSuggestions(itin, members, req.userId, supabase, sessionStore, {
        rerollType,
        existingSuggestions,
        singleCard:       isSingleCard,
        targetSuggestion: targetSuggestion,
        contextPrompt:    rerollContextPrompt,
      });
    } catch (e) {
      console.error('[group-itineraries] reroll generateGroupSuggestions failed:', e.message);
      return res.status(500).json({ error: 'Could not generate suggestions. Please try again.' });
    }

    // Append old suggestions to changelog with a timestamp entry.
    const changelogEntry = {
      reroll_number: (itin.reroll_count || 0) + 1,
      timestamp:     new Date().toISOString(),
      suggestions:   isSingleCard ? [targetSuggestion] : existingSuggestions,
    };
    const updatedChangelog = [...(itin.changelog || []), changelogEntry];

    // Reset all attendee_statuses back to 'pending' — votes referenced the old card(s).
    const resetStatuses = Object.fromEntries(
      Object.keys(itin.attendee_statuses || {}).map(id => [id, 'pending'])
    );

    let mergedSuggestions;
    if (isSingleCard) {
      // Splice the 1 new suggestion in-place with a guaranteed-unique UUID.
      // newSuggestions[0] already has a UUID from generateGroupSuggestions, use it.
      const replacement = { ...newSuggestions[0] };
      mergedSuggestions = existingSuggestions.map(s => s.id === replaceSuggestionId ? replacement : s);
    } else {
      // Full reroll: in awaiting_responses append (cap at 6); in draft replace entirely.
      const MAX_SUGGESTIONS = 6;
      mergedSuggestions = itin.itinerary_status === 'awaiting_responses'
        ? [...existingSuggestions, ...newSuggestions].slice(0, MAX_SUGGESTIONS)
        : newSuggestions;
    }

    // Clear selected_suggestion_id only if it pointed to the replaced card (or full reroll).
    // Always keep organizer_recommendation_id intact — it never changes after send.
    const clearSelected = !isSingleCard || itin.selected_suggestion_id === replaceSuggestionId;

    // Reset attendee_suggestion_map — votes referencing old/replaced cards are stale.
    const resetSuggestionMap = isSingleCard
      ? Object.fromEntries(Object.entries(itin.attendee_suggestion_map || {}).filter(([, sid]) => sid !== replaceSuggestionId))
      : {};

    const { error: updateErr } = await supabase
      .from('group_itineraries')
      .update({
        suggestions:             mergedSuggestions,
        changelog:               updatedChangelog,
        reroll_count:            (itin.reroll_count || 0) + 1,
        attendee_statuses:       resetStatuses,
        attendee_suggestion_map: resetSuggestionMap,
        ...(clearSelected ? { selected_suggestion_id: itin.organizer_recommendation_id || null } : {}),
      })
      .eq('id', req.params.id);

    if (updateErr) {
      console.error('[group-itineraries] reroll update error:', updateErr.message);
      return res.status(500).json({ error: 'Could not save reroll.' });
    }

    res.json({ suggestions: mergedSuggestions });
  });

  /* ── GET /group-itineraries ───────────────────────────────────────────── */
  // Returns all group itineraries where the caller is organizer OR attendee.
  // Organizer sees all statuses (organizer_draft, awaiting_responses, locked, cancelled).
  // Attendees only see awaiting_responses, locked (not draft — not sent to them yet).
  app.get('/group-itineraries', requireAuth, async (req, res) => {
    const SELECT_COLS = 'id, event_title, itinerary_status, suggestions, quorum_threshold, locked_at, created_at, organizer_id, attendee_statuses, selected_suggestion_id, group_id';

    // Fetch as organizer
    const { data: asOrganizer } = await supabase
      .from('group_itineraries')
      .select(SELECT_COLS)
      .eq('organizer_id', req.userId)
      .order('created_at', { ascending: false });

    // Fetch as attendee — fetch all rows in relevant statuses not organized by this user,
    // then filter in JS for those where the caller's ID is a key in attendee_statuses.
    const { data: potentialAttendee } = await supabase
      .from('group_itineraries')
      .select(SELECT_COLS)
      .in('itinerary_status', ['awaiting_responses', 'locked'])
      .neq('organizer_id', req.userId)
      .order('created_at', { ascending: false });
    const asAttendee = (potentialAttendee || []).filter(r => req.userId in (r.attendee_statuses || {}));

    // Merge and deduplicate (shouldn't overlap but be safe).
    const all = [...(asOrganizer || [])];
    for (const row of (asAttendee || [])) {
      if (!all.find(r => r.id === row.id)) all.push(row);
    }

    // Load organizer profiles for display.
    const organizerIds = [...new Set(all.map(r => r.organizer_id))];
    const { data: profiles } = organizerIds.length
      ? await supabase.from('profiles').select('id, full_name, avatar_url').in('id', organizerIds)
      : { data: [] };
    const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    // Load group names for display.
    const groupIds = [...new Set(all.map(r => r.group_id).filter(Boolean))];
    const { data: groups } = groupIds.length
      ? await supabase.from('groups').select('id, name').in('id', groupIds)
      : { data: [] };
    const groupMap = Object.fromEntries((groups || []).map(g => [g.id, g.name]));

    const itineraries = all.map(itin => ({
      ...itin,
      is_organizer: itin.organizer_id === req.userId,
      organizer: profileMap[itin.organizer_id]
        ? { id: profileMap[itin.organizer_id].id, full_name: profileMap[itin.organizer_id].full_name }
        : { id: itin.organizer_id },
      my_vote: itin.organizer_id !== req.userId
        ? (itin.attendee_statuses?.[req.userId] || 'pending')
        : null,
      group_name: itin.group_id ? (groupMap[itin.group_id] || null) : null,
    }));

    res.json({ itineraries });
  });

  /* ── DELETE /group-itineraries/:id ───────────────────────────────────── */
  // Hard-deletes an organizer_draft itinerary. Organizer-only.
  // Cannot delete once sent (awaiting_responses) or locked.
  app.delete('/group-itineraries/:id', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid itinerary ID.' });

    const { data: itin } = await supabase
      .from('group_itineraries')
      .select('organizer_id, itinerary_status')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId) return res.status(403).json({ error: 'Not authorized.' });
    if (itin.itinerary_status !== 'organizer_draft') {
      return res.status(400).json({ error: 'Only unsent drafts can be deleted.' });
    }

    const { error } = await supabase.from('group_itineraries').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Could not delete itinerary.' });
    res.json({ ok: true });
  });

  /* ── GET /group-itineraries/:id ───────────────────────────────────────── */
  // Returns the full itinerary with suggestions and member vote status.
  // Only accessible by the organizer or attendees in attendee_statuses.
  app.get('/group-itineraries/:id', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ error: 'Invalid itinerary ID.' });
    }

    const { data: itin, error: fetchErr } = await supabase
      .from('group_itineraries')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !itin) return res.status(404).json({ error: 'Itinerary not found.' });

    const isOrganizer = itin.organizer_id === req.userId;
    const isAttendee  = req.userId in (itin.attendee_statuses || {});

    if (!isOrganizer && !isAttendee) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    // Normalize suggestion IDs: old rows may have "s1"/"s2"/"s3" or missing IDs from before
    // the UUID fix was deployed. Assign stable UUIDs in-place and persist back to the DB so
    // re-roll single-card targeting never silently falls through to a full reroll.
    const normalizedSuggestions = (itin.suggestions || []).map(s =>
      (s && s.id && s.id.length > 4) ? s : { ...s, id: randomUUID() }
    );
    const hadLegacyIds = (itin.suggestions || []).some(s => !s?.id || s.id.length <= 4);
    if (hadLegacyIds) {
      await supabase
        .from('group_itineraries')
        .update({ suggestions: normalizedSuggestions })
        .eq('id', req.params.id);
      itin.suggestions = normalizedSuggestions;
    }

    // Load minimal member profiles for display.
    const attendeeIds  = Object.keys(itin.attendee_statuses || {});
    const allMemberIds = [...new Set([itin.organizer_id, ...attendeeIds])];

    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, avatar_url')
      .in('id', allMemberIds);

    const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    // Build vote status map: { user_id: { vote, profile, is_organizer? } }
    // Attendees are sourced from attendee_statuses. The organizer is injected separately
    // so clients can display their implied acceptance without counting them toward quorum.
    const voteStatus = Object.fromEntries(
      attendeeIds.map(id => [
        id,
        {
          vote:    itin.attendee_statuses[id],
          profile: profileMap[id]
            ? { id: profileMap[id].id, full_name: profileMap[id].full_name, avatar_url: profileMap[id].avatar_url }
            : null,
        },
      ])
    );

    // If the organizer has sent their recommendation, include them in vote_status so the
    // client can show them as having accepted. is_organizer: true lets the UI badge them.
    if (itin.organizer_recommendation_id) {
      const orgProfile = profileMap[itin.organizer_id];
      voteStatus[itin.organizer_id] = {
        vote:         'accepted',
        is_organizer: true,
        profile: orgProfile
          ? { id: orgProfile.id, full_name: orgProfile.full_name, avatar_url: orgProfile.avatar_url }
          : { id: itin.organizer_id },
      };
    }

    // Fetch the group name so the client can display "[Group Name] — [Event Title]".
    let groupName = null;
    if (itin.group_id) {
      const { data: grp } = await supabase
        .from('groups')
        .select('name')
        .eq('id', itin.group_id)
        .maybeSingle();
      if (grp) groupName = grp.name;
    }

    res.json({
      ...itin,
      organizer: profileMap[itin.organizer_id]
        ? { id: profileMap[itin.organizer_id].id, full_name: profileMap[itin.organizer_id].full_name, avatar_url: profileMap[itin.organizer_id].avatar_url }
        : { id: itin.organizer_id },
      vote_status:  voteStatus,
      is_organizer: isOrganizer,
      group_name:   groupName,
    });
  });

  /* ── POST /group-itineraries/:id/comments ────────────────────────────── */
  // Adds a comment on a specific suggestion in a group itinerary.
  // Membership check: caller must be organizer or in attendee_statuses.
  app.post('/group-itineraries/:id/comments', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ error: 'Invalid itinerary ID.' });
    }

    const { suggestion_id, body: commentBody } = req.body;

    if (!suggestion_id || typeof suggestion_id !== 'string') {
      return res.status(400).json({ error: 'suggestion_id is required.' });
    }
    if (!commentBody || typeof commentBody !== 'string' || !commentBody.trim()) {
      return res.status(400).json({ error: 'body is required.' });
    }
    if (commentBody.length > 2000) {
      return res.status(400).json({ error: 'Comment body must be 2000 characters or fewer.' });
    }

    const { data: itin } = await supabase
      .from('group_itineraries')
      .select('organizer_id, attendee_statuses, suggestions')
      .eq('id', req.params.id)
      .single();

    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });

    const isOrganizer = itin.organizer_id === req.userId;
    const isAttendee  = req.userId in (itin.attendee_statuses || {});
    if (!isOrganizer && !isAttendee) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    // Verify suggestion_id exists in this itinerary.
    const validIds = (itin.suggestions || []).map(s => s.id);
    if (!validIds.includes(suggestion_id)) {
      return res.status(400).json({ error: 'suggestion_id does not match any suggestion in this itinerary.' });
    }

    const { data: comment, error: insertErr } = await supabase
      .from('group_comments')
      .insert({
        itinerary_id:  req.params.id,
        suggestion_id,
        user_id:       req.userId,
        body:          commentBody.trim(),
      })
      .select('id, suggestion_id, user_id, body, created_at')
      .single();

    if (insertErr) {
      console.error('[group-itineraries] comment insert error:', insertErr.message);
      return res.status(500).json({ error: 'Could not add comment.' });
    }

    res.status(201).json({ comment });
  });

  /* ── GET /group-itineraries/:id/comments ─────────────────────────────── */
  // Returns paginated comments for an itinerary.
  // Defaults to 50 per page. Supports ?page= query param (1-indexed).
  // Membership check: same as POST /comments above.
  app.get('/group-itineraries/:id/comments', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ error: 'Invalid itinerary ID.' });
    }

    const { data: itin } = await supabase
      .from('group_itineraries')
      .select('organizer_id, attendee_statuses')
      .eq('id', req.params.id)
      .single();

    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });

    const isOrganizer = itin.organizer_id === req.userId;
    const isAttendee  = req.userId in (itin.attendee_statuses || {});
    if (!isOrganizer && !isAttendee) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    const PAGE_SIZE = 50;
    const page      = Math.max(1, parseInt(req.query.page) || 1);
    const offset    = (page - 1) * PAGE_SIZE;

    // Optional filter by suggestion_id.
    const suggestionId = req.query.suggestion_id;

    let query = supabase
      .from('group_comments')
      .select('id, suggestion_id, user_id, body, created_at', { count: 'exact' })
      .eq('itinerary_id', req.params.id)
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (suggestionId && typeof suggestionId === 'string') {
      query = query.eq('suggestion_id', suggestionId);
    }

    const { data: comments, count, error: fetchErr } = await query;

    if (fetchErr) {
      console.error('[group-itineraries] comments fetch error:', fetchErr.message);
      return res.status(500).json({ error: 'Could not fetch comments.' });
    }

    // Enrich with minimal profile data.
    const userIds = [...new Set((comments || []).map(c => c.user_id))];
    const { data: profiles } = userIds.length
      ? await supabase.from('profiles').select('id, full_name, avatar_url').in('id', userIds)
      : { data: [] };

    const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    res.json({
      comments: (comments || []).map(c => ({
        ...c,
        author: profileMap[c.user_id]
          ? { id: profileMap[c.user_id].id, full_name: profileMap[c.user_id].full_name, avatar_url: profileMap[c.user_id].avatar_url }
          : { id: c.user_id },
      })),
      pagination: {
        page,
        page_size: PAGE_SIZE,
        total: count || 0,
        has_more: offset + PAGE_SIZE < (count || 0),
      },
    });
  });

};

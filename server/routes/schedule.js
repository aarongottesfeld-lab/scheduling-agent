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
const { enrichVenues, extractCityFromGeoContext } = require('../utils/venueEnrichment');
const { fetchLocalEvents } = require('../utils/events');
const { extractActivityType, fetchActivityVenues, buildActivityVenuesBlock } = require('../utils/activityVenues');
const { classifyRerollIntent } = require('../utils/classifyRerollIntent');
const { dispatchNotification } = require('../utils/notificationDispatch');
const { extractCulturalSignal } = require('../utils/extractCulturalSignal');
const fetchCulturalEvent = require('../utils/fetchCulturalEvent');
const { UUID_RE, isValidUUID, INJECTION_RE, sanitizePromptInput } = require('../utils/validation');
const { RATE_LIMIT_EXEMPT } = require('../utils/rateLimitExempt');
const { timeOfDayHours, findFreeWindows, fmtWindowDate, formatTime12h, splitMidnightBlocks, fetchBusy, inferDurationMinutes } = require('../utils/availability');
const { RENDEZVOUS_SYSTEM_PROMPT, CLAUDE_MODEL, THEME_FILLER, themeMatchesContextPrompt, classifyIntent, extractVenueName, buildVenueSubstitutionBlock, buildExcludedWindowsBlock, buildAttendeeNotesBlock, deriveGeoContext, buildSuggestPrompt, getProfileName, fetchAcceptedPairHistory } = require('../utils/promptBuilder');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_CONTEXT  = 500;  // contextPrompt / feedback chars

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
        mode:             'pair',
        organizer_id:     req.userId,
        attendee_id:      targetUserId,
        organizer_status: 'pending',
        attendee_status:  'pending',
        itinerary_status: 'organizer_draft',
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
          updates.itinerary_status = 'locked';
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

    // Transition to awaiting_responses when organizer sends the itinerary.
    await supabase.from('itineraries').update({ itinerary_status: 'awaiting_responses' }).eq('id', req.params.id);

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
    const declineUpdate = { [field]: 'declined', itinerary_status: 'cancelled' };
    // If the attendee left busy notes, store them so the organizer sees them on the next reroll.
    if (isAttendeeDecline && req.body.attendee_busy_notes && typeof req.body.attendee_busy_notes === 'string') {
      const sanitizedNotes = sanitizePromptInput(req.body.attendee_busy_notes.trim().slice(0, 300));
      if (sanitizedNotes) declineUpdate.attendee_busy_notes = { [itin.attendee_id]: sanitizedNotes };
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

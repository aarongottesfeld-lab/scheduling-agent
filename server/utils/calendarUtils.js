// utils/calendarUtils.js — shared Google Calendar helpers
//
// Extracted from routes/schedule.js so both schedule.js and group-itineraries.js
// can create calendar events without duplicating the OAuth2 setup or event-write logic.
//
// Exports:
//   createOAuth2Client(tokens)           — builds a fresh OAuth2 client per-request
//   createCalendarEventForUser(options)  — writes one event to a user's primary calendar

'use strict';

const { google } = require('googleapis');
const getPrimaryCalendarTokens    = require('./getPrimaryCalendarTokens');
const { createAppleCalendarEvent } = require('./appleCalendarUtils');

/**
 * Creates a fresh Google OAuth2 client, optionally pre-loaded with stored tokens.
 * A new instance is created per-request/per-operation to avoid shared mutable state
 * across concurrent requests.
 */
function createOAuth2Client(tokens) {
  const c = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  if (tokens) c.setCredentials(tokens);
  return c;
}

/**
 * Write a single Google Calendar event for a user whose session contains valid tokens.
 * Best-effort — never throws; returns { id, htmlLink } on success or null on failure.
 *
 * @param {object} options
 * @param {object} options.session        - session object with .tokens.access_token
 * @param {object} options.suggestion     - suggestion object from Claude (date, time, venues, etc.)
 * @param {object} options.organizer      - { email, full_name } of the organizer
 * @param {object} options.attendee       - { email, full_name } of the attendee (or group label)
 * @param {string} options.itineraryId    - used in the event description for deep-linking
 * @param {object} [options.supabase]     - Supabase client; when provided with userId, resolves
 *                                         the user's is_primary calendar_connections row first
 * @param {string} [options.userId]       - Supabase UUID; paired with supabase for token lookup
 */
async function createCalendarEventForUser({ session, suggestion, organizer, attendee, itineraryId, supabase, userId }) {
  if (!session?.tokens?.access_token) return null;

  try {
    // Resolve which connection to use for the write.
    // When supabase + userId are provided, prefer the is_primary calendar_connections row.
    // Falls back to { tokens: session.tokens, provider: 'google' } on any error or absence.
    const { tokens, provider } = (supabase && userId)
      ? await getPrimaryCalendarTokens(supabase, userId, session.tokens)
      : { tokens: session.tokens, provider: 'google' };

    // ── Apple CalDAV path ─────────────────────────────────────────────────
    if (provider === 'apple') {
      return createAppleCalendarEvent({
        email:       tokens.email,
        password:    tokens.password,
        suggestion,
        organizer,
        attendee,
        itineraryId,
      });
    }

    // ── Google Calendar path (default) ────────────────────────────────────
    const auth = createOAuth2Client(tokens);

    // Refresh token if expired
    const expiry = tokens.expiry_date;
    if (expiry && Date.now() > expiry - 60000 && tokens.refresh_token) {
      const { credentials } = await auth.refreshAccessToken();
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
      const parsedYear = parseInt((dateStr || '').split('-')[0], 10);
      if (parsedYear && parsedYear < new Date().getFullYear()) {
        console.warn(
          `[toRFC3339] Suggestion date "${dateStr}" is in a past year (${parsedYear}). ` +
          'Check that buildSuggestPrompt includes year in window date strings.'
        );
      }

      return `${dateStr}T${hh}:${min}:00`;
    }

    // For multi-day trips, create an all-day event spanning the full trip.
    // GCal all-day events use { date: 'YYYY-MM-DD' }; the end date is exclusive.
    const isMultiDay = suggestion.days?.length > 1;
    let eventStart, eventEnd;
    if (isMultiDay) {
      const startDate = suggestion.days[0]?.date ?? suggestion.date;
      if (!startDate) return null;
      const lastDayDate = suggestion.days[suggestion.days.length - 1]?.date ?? startDate;
      const [ey, em, ed] = lastDayDate.split('-').map(Number);
      const exclusiveEnd = new Date(ey, em - 1, ed + 1);
      const endDateStr = `${exclusiveEnd.getFullYear()}-${String(exclusiveEnd.getMonth()+1).padStart(2,'0')}-${String(exclusiveEnd.getDate()).padStart(2,'0')}`;
      eventStart = { date: startDate };
      eventEnd   = { date: endDateStr };
    } else {
      const startDT = toRFC3339(suggestion.date, suggestion.time);
      if (!startDT) return null;
      const durMs = (suggestion.durationMinutes || 120) * 60000;
      const endDT = new Date(new Date(startDT).getTime() + durMs).toISOString().replace(/\.\d{3}Z$/, '');
      eventStart = { dateTime: startDT, timeZone: 'America/New_York' };
      eventEnd   = { dateTime: endDT,   timeZone: 'America/New_York' };
    }

    // Build venue description
    const venueLines = (suggestion.venues || [])
      .map(v => `${v.name}${v.address ? ' — ' + v.address : ''}`)
      .join('\n');
    const description = [
      suggestion.narrative,
      venueLines ? '\nStops:\n' + venueLines : '',
      itineraryId ? `\nRendezvous itinerary ID: ${itineraryId}` : '',
    ].filter(Boolean).join('\n\n');

    const venueName  = suggestion.venues?.[0]?.name || suggestion.activityType || 'Plans';
    const otherFirst = (attendee?.full_name || '').split(' ')[0] || 'Friend';
    const location   = suggestion.venues?.[0]?.address || suggestion.neighborhood || '';

    const event = await calendar.events.insert({
      calendarId: 'primary',
      sendUpdates: 'none', // we handle our own notifications
      requestBody: {
        summary: `${venueName} with ${otherFirst}`,
        description,
        location,
        start: eventStart,
        end:   eventEnd,
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

    return { id: event.data.id || null, htmlLink: event.data.htmlLink || null };
  } catch (err) {
    // Calendar write is best-effort — log but don't throw
    console.warn('createCalendarEventForUser failed:', err.message);
    return null;
  }
}

module.exports = { createOAuth2Client, createCalendarEventForUser };

'use strict';

// utils/appleCalendarUtils.js — Apple CalDAV helpers
//
// Uses tsdav (https://tsdav.vercel.app) with Basic auth against Apple's CalDAV
// endpoint at https://caldav.icloud.com. Authentication is iCloud email +
// app-specific password — no OAuth.
//
// Security: the app-specific password must NEVER appear in any log output.
// All logging uses only the iCloud email address.

const { DAVClient } = require('tsdav');
const { randomUUID } = require('crypto');

const APPLE_CALDAV_URL = 'https://caldav.icloud.com';

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Parse a DTSTART or DTEND value from an ICS property line into an ISO string.
 * Handles the three forms Apple CalDAV produces:
 *   DTSTART:20260315T190000Z          → UTC datetime
 *   DTSTART;TZID=America/New_York:20260315T190000  → local datetime (treated as UTC for busy calcs)
 *   DTSTART;VALUE=DATE:20260315       → all-day date
 *
 * @param {string} propValue  - everything after the first colon on the property line
 * @returns {string|null}     - ISO 8601 string or null if unparseable
 */
function parseDTtoISO(propValue) {
  if (!propValue) return null;
  const val = propValue.trim();

  // All-day: YYYYMMDD
  if (/^\d{8}$/.test(val)) {
    return `${val.slice(0,4)}-${val.slice(4,6)}-${val.slice(6,8)}T00:00:00.000Z`;
  }

  // Datetime: YYYYMMDDTHHMMSSz or YYYYMMDDTHHMMSS
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
}

/**
 * Extract a DT property value from a raw ICS string.
 * Handles both plain and parameterized forms (e.g. DTSTART;TZID=...:value).
 *
 * @param {string} icsStr  - raw VEVENT ICS block
 * @param {string} field   - 'DTSTART' or 'DTEND'
 * @returns {string|null}  - the raw value after the colon, or null
 */
function extractDT(icsStr, field) {
  // Match "FIELD" optionally followed by params, then ":" then value until EOL
  const re = new RegExp(`^${field}(?:;[^:]*)?:([^\r\n]+)`, 'm');
  const match = icsStr.match(re);
  if (!match) return null;
  // The value may include a TZID prefix like "TZID=America/New_York" before the colon
  // — but the colon in the regex above captures everything after the last colon.
  // For DTSTART;TZID=America/New_York:20260315T190000 the captured group is "20260315T190000".
  return match[1].trim();
}

/**
 * Convert a suggestion's date+time (Claude output format) into an ICS YYYYMMDDTHHMMSSZ string.
 * Treats the time as UTC (Z suffix) — mirrors the "best-effort" approach used throughout
 * the calendar write paths. Returns a fallback of midnight UTC if time is missing.
 *
 * @param {string} dateStr  - "YYYY-MM-DD"
 * @param {string} timeStr  - "7:00 PM" style
 * @returns {string|null}
 */
function toICSDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const datePart = dateStr.replace(/-/g, '');
  if (!timeStr) return `${datePart}T000000Z`;
  const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return `${datePart}T000000Z`;
  let h = parseInt(match[1], 10);
  const min = match[2];
  const ampm = match[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${datePart}T${String(h).padStart(2, '0')}${min}00Z`;
}

/**
 * Returns the current timestamp in ICS DTSTAMP format: YYYYMMDDTHHMMSSZ
 */
function nowICS() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Fold long ICS lines per RFC 5545 (max 75 octets, continuation with CRLF+SPACE).
 * Apple's CalDAV accepts unfolded ICS but this keeps us spec-compliant.
 */
function foldLine(line) {
  if (line.length <= 75) return line;
  const chunks = [];
  chunks.push(line.slice(0, 75));
  let i = 75;
  while (i < line.length) {
    chunks.push(' ' + line.slice(i, i + 74));
    i += 74;
  }
  return chunks.join('\r\n');
}

/**
 * Build a minimal ICS string for a single calendar event.
 * Uses CRLF line endings as required by RFC 5545.
 */
function buildICS({ uid, dtstamp, dtstart, dtend, isAllDay, summary, description, location }) {
  const startLine = isAllDay ? `DTSTART;VALUE=DATE:${dtstart}` : `DTSTART:${dtstart}`;
  const endLine   = isAllDay ? `DTEND;VALUE=DATE:${dtend}`   : `DTEND:${dtend}`;
  // Escape special ICS characters in text fields (RFC 5545 §3.3.11)
  const esc = s => (s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rendezvous//EN',
    'BEGIN:VEVENT',
    `UID:${uid}@rendezvous`,
    `DTSTAMP:${dtstamp}`,
    startLine,
    endLine,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    location     ? `LOCATION:${esc(location)}`      : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).map(foldLine);

  return lines.join('\r\n') + '\r\n';
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Creates and returns an authenticated tsdav DAVClient for Apple CalDAV.
 * Calls client.login() to validate credentials and discover the home set.
 * Throws if credentials are invalid or the server is unreachable.
 * Never logs the password.
 *
 * @param {string} email     - iCloud email address
 * @param {string} password  - app-specific password (never logged)
 * @returns {Promise<DAVClient>}
 */
async function createAppleDAVClient(email, password) {
  const client = new DAVClient({
    serverUrl:          APPLE_CALDAV_URL,
    credentials:        { username: email, password },
    authMethod:         'Basic',
    defaultAccountType: 'caldav',
  });
  await client.login();
  return client;
}

/**
 * Fetch busy periods from an Apple CalDAV account for a given time range.
 * Returns a flat array of { start, end } ISO strings — same shape as Google
 * freebusy results so it drops straight into fetchBusyAggregated.
 *
 * Never throws — returns [] on any error.
 * Logs errors with the email address only (never the password).
 *
 * @param {string}   email       - iCloud email
 * @param {string}   password    - app-specific password (never logged)
 * @param {string[]} calendarIds - array of calendar URLs to filter; empty = all
 * @param {string}   startISO    - range start (ISO 8601)
 * @param {string}   endISO      - range end (ISO 8601)
 * @returns {Promise<Array<{start:string,end:string}>>}
 */
async function fetchAppleBusy(email, password, calendarIds, startISO, endISO) {
  try {
    const client    = await createAppleDAVClient(email, password);
    let   calendars = await client.fetchCalendars();

    // Filter to specific calendar URLs when calendarIds is non-empty
    if (calendarIds && calendarIds.length > 0) {
      calendars = calendars.filter(cal => calendarIds.includes(cal.url));
    }

    const busy = [];
    await Promise.all(calendars.map(async (cal) => {
      try {
        const objects = await client.fetchCalendarObjects({
          calendar:  cal,
          timeRange: { start: startISO, end: endISO },
        });
        for (const obj of objects) {
          const ics = obj.data;
          if (!ics) continue;
          const rawStart = extractDT(ics, 'DTSTART');
          const rawEnd   = extractDT(ics, 'DTEND');
          const start    = rawStart ? parseDTtoISO(rawStart) : null;
          const end      = rawEnd   ? parseDTtoISO(rawEnd)   : null;
          if (start && end) busy.push({ start, end });
        }
      } catch (calErr) {
        console.warn(`[fetchAppleBusy] calendar fetch failed for ${email}, calendar ${cal.url}:`, calErr.message);
      }
    }));

    return busy;
  } catch (err) {
    console.warn(`[fetchAppleBusy] failed for ${email}:`, err.message);
    return [];
  }
}

/**
 * Write a single calendar event to an Apple CalDAV account.
 * Best-effort — never throws; returns { uid } on success or null on failure.
 * Never logs the password.
 *
 * @param {object} options
 * @param {string} options.email        - iCloud email
 * @param {string} options.password     - app-specific password (never logged)
 * @param {object} options.suggestion   - Claude suggestion object
 * @param {object} options.organizer    - { email, full_name }
 * @param {object} options.attendee     - { email, full_name }
 * @param {string} options.itineraryId  - for the event description deep-link
 * @returns {Promise<{uid:string}|null>}
 */
async function createAppleCalendarEvent({ email, password, suggestion, organizer, attendee, itineraryId }) {
  try {
    const client    = await createAppleDAVClient(email, password);
    const calendars = await client.fetchCalendars();
    if (!calendars || calendars.length === 0) return null;

    // Prefer a writable calendar; fall back to the first one if read-only status
    // is unavailable (components array may not always be populated by the server).
    const writable = calendars.find(cal =>
      !cal.components || cal.components.includes('VEVENT')
    ) || calendars[0];

    const uid      = randomUUID();
    const dtstamp  = nowICS();
    const venueName  = suggestion.venues?.[0]?.name || suggestion.activityType || 'Plans';
    const otherFirst = (attendee?.full_name || '').split(' ')[0] || 'Friend';
    const location   = suggestion.venues?.[0]?.address || suggestion.neighborhood || '';
    const venueLines = (suggestion.venues || [])
      .map(v => `${v.name}${v.address ? ' — ' + v.address : ''}`)
      .join('\n');
    const description = [
      suggestion.narrative,
      venueLines ? '\nStops:\n' + venueLines : '',
      itineraryId ? `\nRendezvous itinerary ID: ${itineraryId}` : '',
    ].filter(Boolean).join('\n\n');

    const isMultiDay = suggestion.days?.length > 1;
    let dtstart, dtend, isAllDay;

    if (isMultiDay) {
      const startDate   = suggestion.days[0]?.date ?? suggestion.date;
      if (!startDate) return null;
      const lastDayDate = suggestion.days[suggestion.days.length - 1]?.date ?? startDate;
      const [ey, em, ed] = lastDayDate.split('-').map(Number);
      const exclusiveEnd  = new Date(ey, em - 1, ed + 1);
      const endDateStr    = `${exclusiveEnd.getFullYear()}${String(exclusiveEnd.getMonth()+1).padStart(2,'0')}${String(exclusiveEnd.getDate()).padStart(2,'0')}`;
      dtstart   = startDate.replace(/-/g, '');
      dtend     = endDateStr;
      isAllDay  = true;
    } else {
      dtstart = toICSDateTime(suggestion.date, suggestion.time);
      if (!dtstart) return null;
      const durMs = (suggestion.durationMinutes || 120) * 60000;
      // Parse the UTC ms from the ICS datetime string
      const startMs = new Date(
        dtstart.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')
      ).getTime();
      const endDate = new Date(startMs + durMs);
      dtend    = endDate.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      isAllDay = false;
    }

    const iCalString = buildICS({
      uid, dtstamp, dtstart, dtend, isAllDay,
      summary:     `${venueName} with ${otherFirst}`,
      description,
      location,
    });

    await client.createCalendarObject({
      calendar:    writable,
      iCalString,
      filename:    `${uid}.ics`,
    });

    return { uid };
  } catch (err) {
    console.warn(`[createAppleCalendarEvent] failed for ${email}:`, err.message);
    return null;
  }
}

module.exports = { createAppleDAVClient, fetchAppleBusy, createAppleCalendarEvent };

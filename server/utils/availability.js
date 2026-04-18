'use strict';

const fetchBusyAggregated = require('./fetchBusyAggregated');

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

module.exports = {
  timeOfDayHours,
  findFreeWindows,
  findFreeWindowsForGroup,
  fmtWindowDate,
  formatTime12h,
  splitMidnightBlocks,
  fetchBusy,
  inferDurationMinutes,
};

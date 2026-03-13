// server/utils/events.js
//
// Live events integration — fetches time-sensitive events from Ticketmaster
// and Eventbrite for a given city and date range, scores them by relevance
// to user interests, and returns the top results for Claude to consider when
// building itinerary suggestions.
//
// Privacy: only city name and date range are ever sent to external APIs.
// No user IDs, names, emails, or preference strings leave the server —
// interest scoring happens locally after the data is returned.
//
// Cache: results are cached in-process for 60 minutes per city+date combo
// to avoid redundant API calls on rerolls and concurrent requests.

'use strict';

// ── In-process cache ──────────────────────────────────────────────────────────
// Map<cacheKey, { data: Event[], expiresAt: number }>
// Cache key: "${city}|${dateStart}|${dateEnd}" (all city-level, no user data).
// TTL: 60 minutes — event lineups change daily at most, so this is safe.
const eventCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

// ── City alias table ──────────────────────────────────────────────────────────
// Maps user-typed neighborhood / shorthand strings to canonical city names
// that the Ticketmaster and Eventbrite APIs reliably understand.
// Entries are lowercase to allow case-insensitive matching.
const CITY_ALIASES = {
  'nyc':               'New York City',
  'new york city':     'New York City',
  'new york':          'New York City',
  'manhattan':         'New York City',
  'brooklyn':          'Brooklyn',
  'queens':            'Queens',
  'bronx':             'Bronx',
  'staten island':     'Staten Island',
  'los angeles':       'Los Angeles',
  'la':                'Los Angeles',
  'san francisco':     'San Francisco',
  'sf':                'San Francisco',
  'chicago':           'Chicago',
  'washington dc':     'Washington DC',
  'washington d.c':    'Washington DC',
  'dc':                'Washington DC',
  'miami':             'Miami',
  'boston':            'Boston',
  'seattle':           'Seattle',
  'austin':            'Austin',
  'denver':            'Denver',
  'atlanta':           'Atlanta',
  'dallas':            'Dallas',
  'houston':           'Houston',
  'philadelphia':      'Philadelphia',
  'portland':          'Portland',
  'nashville':         'Nashville',
  'las vegas':         'Las Vegas',
  'phoenix':           'Phoenix',
};

/**
 * Parse a raw location string or deriveGeoContext() output into a city name
 * suitable for Ticketmaster and Eventbrite API queries.
 *
 * Handles inputs like:
 *   "Upper West Side, NYC"        → "New York City"
 *   "Brooklyn Heights, NYC"       → "New York City"  (Brooklyn as alias too)
 *   "Chelsea, New York"           → "New York City"
 *   "Chicago, IL"                 → "Chicago"
 *   "Both users are based in X."  → extracted via "based in" pattern
 *
 * @param {string} locationString - raw user location or geoContext string
 * @returns {string} canonical city name, or '' if unparseable
 */
function extractCityFromLocation(locationString) {
  if (!locationString || !locationString.trim()) return '';

  // deriveGeoContext() wraps locations in "based in …" — strip that wrapper first
  const basedInMatch = locationString.match(/based in ([^;.]+)/i);
  const raw = basedInMatch ? basedInMatch[1].trim() : locationString.trim();

  // Split "Upper West Side, NYC" → ["Upper West Side", "NYC"]
  // Work backwards through comma parts — city is usually the last part
  const parts = raw.split(',').map(p => p.trim().replace(/\.$/,''));
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts[i].toLowerCase();
    if (CITY_ALIASES[candidate]) return CITY_ALIASES[candidate];
  }

  // Try the whole string as an alias (e.g. "New York", "NYC")
  const fullLower = raw.toLowerCase().replace(/\.$/,'');
  if (CITY_ALIASES[fullLower]) return CITY_ALIASES[fullLower];

  // Last resort: return the last comma-part (most likely the city), or the full string
  return parts[parts.length - 1] || raw;
}

/**
 * Normalize an event title for deduplication.
 * Strips all non-alphanumeric characters and lowercases so that
 * "Jazz at Lincoln Center" and "Jazz At Lincoln Center!" match.
 *
 * @param {string} title
 * @returns {string}
 */
function normalizeTitle(title) {
  return (title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Score an event's relevance to the user pair's combined interests.
 * Splits each interest into individual words and checks how many appear
 * in the event's title + category string. Returns a count — higher = more relevant.
 *
 * If no interests are supplied, every event scores 1 (include all, rank unchanged).
 *
 * @param {{ title: string, category: string }} event
 * @param {string[]} interests - combined activity preferences of both users
 * @returns {number}
 */
function scoreRelevance(event, interests) {
  if (!interests || interests.length === 0) return 1;
  const haystack = `${event.title} ${event.category}`.toLowerCase();
  return interests.reduce((score, interest) => {
    // Multi-word interests ("craft beer") split into individual keywords
    const keywords = interest.toLowerCase().split(/\s+/);
    return score + keywords.filter(kw => kw.length > 2 && haystack.includes(kw)).length;
  }, 0);
}

/**
 * Fetch and normalize events from the Ticketmaster Discovery API.
 * Only sends city + date range — no user data.
 * Returns [] on any error (network, bad API key, rate limit, etc.).
 *
 * Ticketmaster docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
 *
 * @param {string} city           - canonical city name, e.g. "New York City"
 * @param {string} dateRangeStart - YYYY-MM-DD
 * @param {string} dateRangeEnd   - YYYY-MM-DD
 * @returns {Promise<Array>}
 */
async function fetchTicketmaster(city, dateRangeStart, dateRangeEnd) {
  if (!process.env.TICKETMASTER_API_KEY) return [];
  try {
    const params = new URLSearchParams({
      apikey:        process.env.TICKETMASTER_API_KEY,
      city,
      startDateTime: `${dateRangeStart}T00:00:00Z`,
      endDateTime:   `${dateRangeEnd}T23:59:59Z`,
      size:          '20',
      sort:          'relevance,desc',
    });
    const r    = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
    const json = await r.json();
    const events = json._embedded?.events || [];

    return events.map(ev => {
      const venue = ev._embedded?.venues?.[0];

      // Parse Ticketmaster's local date/time into human-readable strings
      const localDate = ev.dates?.start?.localDate || '';  // "2026-03-15"
      const localTime = ev.dates?.start?.localTime || '';  // "19:30:00"

      let displayDate = localDate;
      if (localDate) {
        try {
          const [y, m, d] = localDate.split('-').map(Number);
          // Use local Date constructor (no UTC) to avoid off-by-one-day shifts
          displayDate = new Date(y, m - 1, d).toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric',
          });
        } catch (_) { /* leave raw date string */ }
      }

      let displayTime = localTime;
      if (localTime) {
        try {
          const [h, min] = localTime.split(':').map(Number);
          const ampm = h >= 12 ? 'PM' : 'AM';
          displayTime  = `${h % 12 || 12}:${String(min).padStart(2, '0')} ${ampm}`;
        } catch (_) { /* leave raw time string */ }
      }

      return {
        title:         ev.name || '',
        venue_name:    venue?.name || '',
        venue_address: [venue?.address?.line1, venue?.city?.name].filter(Boolean).join(', '),
        date:          displayDate,
        time:          displayTime,
        url:           ev.url || '',
        source:        'ticketmaster',
        // Prefer segment name (e.g. "Sports") then genre (e.g. "Basketball")
        category:      ev.classifications?.[0]?.segment?.name
                    || ev.classifications?.[0]?.genre?.name
                    || '',
      };
    }).filter(ev => ev.title && ev.url); // drop malformed entries without a name or link
  } catch (err) {
    console.error('[events] Ticketmaster fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch and normalize events from the Eventbrite API.
 *
 * ── API STATUS (last verified: March 2026) ──────────────────────────────────
 * The city-wide event search endpoint (GET /v3/events/search/) was deprecated
 * by Eventbrite in December 2019 and permanently shut down on February 20, 2020.
 * As of 2026 there is NO public replacement for platform-wide event search by
 * city and date range. The only current listing endpoint is:
 *   GET /v3/organizations/:organization_id/events/
 * …which requires an org ID known in advance and cannot serve discovery use cases.
 *
 * Auth format (Bearer <token>) was correct and would still be correct if a
 * usable endpoint existed. The EVENTBRITE_API_KEY env var is intentionally
 * unused until a replacement API becomes available.
 *
 * Re-enable this function if Eventbrite restores public event search access.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * @param {string} city           - canonical city name, e.g. "New York City"
 * @param {string} dateRangeStart - YYYY-MM-DD
 * @param {string} dateRangeEnd   - YYYY-MM-DD
 * @returns {Promise<Array>}
 */
async function fetchEventbrite(city, dateRangeStart, dateRangeEnd) { // eslint-disable-line no-unused-vars
  // No viable public endpoint — return empty rather than making a doomed API call.
  return [];
}

/**
 * Fetch live events for a city + date range from both Ticketmaster and Eventbrite.
 * Deduplicates by normalized title, scores by interest relevance, and returns
 * the top 5–8 results for injection into the Claude suggestion prompt.
 *
 * Never throws — returns [] on any top-level failure so event enrichment never
 * blocks itinerary generation. Individual source failures are silently [] inside
 * fetchTicketmaster / fetchEventbrite.
 *
 * @param {string}   location       - geoContext string or user location (city extracted internally)
 * @param {string}   dateRangeStart - YYYY-MM-DD start of the scheduling window
 * @param {string}   dateRangeEnd   - YYYY-MM-DD end of the scheduling window
 * @param {string[]} interests      - combined activity_preferences of both users (local filter only)
 * @returns {Promise<Array>} top events, each shaped as { title, venue_name, venue_address,
 *                           date, time, url, source, category }
 */
async function fetchLocalEvents(location, dateRangeStart, dateRangeEnd, interests = []) {
  try {
    const city = extractCityFromLocation(location);
    if (!city) return []; // no usable city — skip API calls entirely

    // Sort date values so the cache key is deterministic even if caller passes them inverted
    const [d1, d2] = [dateRangeStart, dateRangeEnd].sort();
    const cacheKey = `${city}|${d1}|${d2}`;

    const cached = eventCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    // Run both sources concurrently; a failure in one doesn't block the other
    const [tmResult, ebResult] = await Promise.allSettled([
      fetchTicketmaster(city, d1, d2),
      fetchEventbrite(city, d1, d2),
    ]);

    const allEvents = [
      // Ticketmaster first so its entries win deduplication (generally higher fidelity)
      ...(tmResult.status === 'fulfilled' ? tmResult.value : []),
      ...(ebResult.status === 'fulfilled' ? ebResult.value : []),
    ];

    // Deduplicate by normalized title — keep first occurrence
    const seen = new Set();
    const deduped = allEvents.filter(ev => {
      const key = normalizeTitle(ev.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Score by interest relevance and sort descending; ties preserve source order
    const scored = deduped
      .map(ev => ({ ev, score: scoreRelevance(ev, interests) }))
      .sort((a, b) => b.score - a.score);

    // Cap at 8 results — enough for Claude to pick from without overwhelming the prompt
    const top = scored.slice(0, 8).map(s => s.ev);

    eventCache.set(cacheKey, { data: top, expiresAt: Date.now() + CACHE_TTL_MS });
    return top;
  } catch (err) {
    console.error('[events] fetchLocalEvents top-level error:', err.message);
    return [];
  }
}

module.exports = { fetchLocalEvents };

// server/utils/venueEnrichment.js
//
// Venue enrichment layer — takes Claude's raw venue suggestions and attaches real
// data from the Google Places Text Search API (place_id, formatted_address, rating,
// price_level, user_ratings_total).
//
// Design constraints:
//   - Never throws: all errors are caught and surface as venue_verified: false
//   - Never sends user data to Places API: only venue name + city are sent
//   - Home venues are skipped entirely (no address to look up)
//   - Suggestions are processed sequentially to avoid parallel API bursts;
//     individual venue lookups within each suggestion run concurrently
//   - Results are cached in-process for 60 minutes to avoid redundant API calls
//     across rerolls for the same venue in the same city

'use strict';

// ── Cache ────────────────────────────────────────────────────────────────────
// Module-scoped Map so the cache persists across requests within the same
// server process. Key: "${venue.name}|${cityContext}" (case-sensitive as-is).
// Entry: { data: {place_id, formatted_address, ...}, expiresAt: number (ms) }
// TTL: 60 minutes — venue data (hours, ratings) changes slowly enough that
// this doesn't meaningfully degrade accuracy, and cuts API spend on rerolls.
const venueCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes in milliseconds

// ── City alias table ──────────────────────────────────────────────────────────
// Maps common free-text city inputs (from user profiles) to canonical forms
// the Places API reliably understands. Lowercase keys, any-case values.
const CITY_ALIASES = {
  'new york':       'New York, NY',
  'new york city':  'New York, NY',
  'nyc':            'New York, NY',
  'manhattan':      'New York, NY',
  'brooklyn':       'New York, NY',
  'queens':         'New York, NY',
  'bronx':          'New York, NY',
  'staten island':  'New York, NY',
  'los angeles':    'Los Angeles, CA',
  'la':             'Los Angeles, CA',
  'san francisco':  'San Francisco, CA',
  'sf':             'San Francisco, CA',
  'chicago':        'Chicago, IL',
  'washington dc':  'Washington, DC',
  'washington d.c': 'Washington, DC',
  'dc':             'Washington, DC',
  'miami':          'Miami, FL',
  'boston':         'Boston, MA',
  'seattle':        'Seattle, WA',
  'austin':         'Austin, TX',
  'denver':         'Denver, CO',
  'atlanta':        'Atlanta, GA',
  'dallas':         'Dallas, TX',
  'houston':        'Houston, TX',
  'philadelphia':   'Philadelphia, PA',
  'portland':       'Portland, OR',
  'nashville':      'Nashville, TN',
  'las vegas':      'Las Vegas, NV',
  'phoenix':        'Phoenix, AZ',
};

/**
 * Parse the string output of deriveGeoContext() into a city string suitable
 * for use in Google Places Text Search queries.
 *
 * deriveGeoContext() produces strings like:
 *   "Both users are based in Chelsea, New York."
 *   "Aaron is based in Chelsea, New York; Jamie is based in Brooklyn Heights, NYC."
 *   "Both users are based in Chicago, IL."
 *   ""
 *
 * Strategy:
 *   1. Extract the first location segment (after "based in", before ";" or ".")
 *   2. Split by comma; check if the last part is a 2-letter US state code
 *   3. If yes → "City, ST" (Places API canonical form)
 *   4. If no → check alias table on the whole raw string and on the last part
 *   5. Fallback: return the extracted string as-is (better than empty for Places)
 *
 * @param {string} geoContext - output of deriveGeoContext()
 * @returns {string} city string for Places API, e.g. "New York, NY" or ""
 */
function extractCityFromGeoContext(geoContext) {
  if (!geoContext || !geoContext.trim()) return '';

  // Pull the first location segment: the text after "based in" up to ";" or "."
  const match = geoContext.match(/based in ([^;.]+)/i);
  if (!match) {
    // geoContext didn't match the expected pattern — return it as a fallback
    return geoContext.trim();
  }

  const locationSegment = match[1].trim();
  const parts = locationSegment.split(',').map(p => p.trim());
  const lastPart = parts[parts.length - 1];

  // If the last comma-segment is a 2-letter US state code (e.g. "IL", "CA"),
  // the string is already in "City, ST" form — return it verbatim.
  if (/^[A-Z]{2}$/.test(lastPart)) {
    return locationSegment;
  }

  // Check alias table on the full extracted location (covers "New York", "NYC", etc.)
  const aliasKey = locationSegment.toLowerCase().replace(/[.,]$/, '');
  if (CITY_ALIASES[aliasKey]) return CITY_ALIASES[aliasKey];

  // If there are multiple comma parts, the last part is likely the city (e.g. "Chelsea, New York")
  // Check alias table on the city part alone.
  if (parts.length >= 2) {
    const cityKey = lastPart.toLowerCase();
    if (CITY_ALIASES[cityKey]) return CITY_ALIASES[cityKey];
    // Return the last two comma-parts as "Neighborhood, City" fallback
    return parts.slice(-2).join(', ');
  }

  // Single-part location (e.g. "Paris", "Chicago") — check alias then return as-is
  const singleKey = locationSegment.toLowerCase();
  if (CITY_ALIASES[singleKey]) return CITY_ALIASES[singleKey];
  return locationSegment;
}

/**
 * Enrich a set of Claude-generated suggestions with real venue data from the
 * Google Places Text Search API.
 *
 * For each venue in each suggestion (where venue.type !== 'home'):
 *   - Checks the in-memory cache first (60-min TTL)
 *   - On cache miss: calls Places Text Search with "venue.name cityContext"
 *   - Attaches place_id, formatted_address, rating, user_ratings_total, price_level
 *     and sets venue_verified: true on success
 *   - Sets venue_verified: false on any error or no-result — never throws
 *
 * Suggestions are processed sequentially (not in parallel) to avoid spiking
 * the Places API quota. Within each suggestion, venue lookups run concurrently
 * via Promise.allSettled so one slow lookup doesn't serialize the others.
 *
 * The entire function is wrapped in try/catch — returns suggestions unmodified
 * on any top-level error so enrichment never blocks the route.
 *
 * @param {Array}  suggestions  - Claude suggestion objects, each with a venues[]
 * @param {string} cityContext  - city string for anchoring queries, e.g. "New York, NY"
 * @returns {Promise<Array>} - same shape as suggestions, with venues enriched in place
 */
async function enrichVenues(suggestions, cityContext) {
  // Skip entirely if the API key is missing — avoids misleading errors in dev
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.warn('[enrichVenues] GOOGLE_MAPS_API_KEY not set — skipping enrichment');
    return suggestions;
  }

  // Skip if we have no city to anchor the query — a bare venue name like "The Smith"
  // without a city produces low-quality or wrong Places results.
  if (!cityContext || !cityContext.trim()) {
    return suggestions;
  }

  try {
    const enrichedSuggestions = [];

    // Process suggestions one at a time to avoid parallel API bursts.
    for (const suggestion of suggestions) {
      const venues = suggestion.venues || [];

      // Within each suggestion, look up all venues concurrently.
      // Promise.allSettled ensures one failure doesn't prevent the others from completing.
      const settledVenues = await Promise.allSettled(
        venues.map(venue => lookupVenue(venue, cityContext))
      );

      // Collect results — any rejected promise (shouldn't happen since lookupVenue
      // catches internally) falls back to the original venue with venue_verified: false.
      const enrichedVenues = settledVenues.map((result, i) => {
        if (result.status === 'fulfilled') return result.value;
        // Safety fallback: lookupVenue threw despite its own try/catch
        console.warn('[enrichVenues] unexpected rejection for venue:', venues[i]?.name);
        return { ...venues[i], venue_verified: false };
      });

      enrichedSuggestions.push({ ...suggestion, venues: enrichedVenues });
    }

    return enrichedSuggestions;
  } catch (err) {
    // Top-level guard — return suggestions unmodified so the route always succeeds
    console.warn('[enrichVenues] top-level error, returning unenriched suggestions:', err.message);
    return suggestions;
  }
}

/**
 * Look up a single venue in the Places Text Search API and return the enriched
 * venue object. Never throws — returns the original venue with venue_verified: false
 * on any error or no-result.
 *
 * Home venues are skipped (venue.type === 'home') because they have no real address
 * to look up — passing "Aaron's Apartment New York, NY" to Places would return garbage.
 *
 * @param {object} venue       - single venue object from Claude's suggestions
 * @param {string} cityContext - city string appended to the query, e.g. "New York, NY"
 * @returns {Promise<object>}  - enriched venue, or original with venue_verified: false
 */
async function lookupVenue(venue, cityContext) {
  try {
    // Home venues have no real address — skip Places lookup entirely.
    // venue_verified: false signals to the client that no lookup was attempted,
    // not that the venue failed — the client can interpret this correctly.
    if (venue.type === 'home') {
      return { ...venue, venue_verified: false };
    }

    const cacheKey = `${venue.name}|${cityContext}`;

    // Return cached result if it exists and hasn't expired
    const cached = venueCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return { ...venue, ...cached.data, venue_verified: true };
    }

    // Build the Text Search URL. We only send venue name + city — never user names,
    // preferences, or any profile data.
    const query = encodeURIComponent(`${venue.name} ${cityContext}`);
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${process.env.GOOGLE_MAPS_API_KEY}`;

    const r    = await fetch(url);
    const json = await r.json();

    // Text Search returns an array; take the first (best-match) result.
    const result = json.results?.[0];
    if (!result) {
      return { ...venue, venue_verified: false };
    }

    // Build the enrichment payload — only attach fields that are actually present
    // in the result so we don't pollute the venue object with undefined values.
    const enrichmentData = {
      place_id:           result.place_id,
      formatted_address:  result.formatted_address,
      ...(result.rating              !== undefined && { rating:              result.rating }),
      ...(result.user_ratings_total  !== undefined && { user_ratings_total:  result.user_ratings_total }),
      ...(result.price_level         !== undefined && { price_level:         result.price_level }),
    };

    // Write to cache with TTL so subsequent rerolls for the same venue skip the API call
    venueCache.set(cacheKey, {
      data:      enrichmentData,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return { ...venue, ...enrichmentData, venue_verified: true };
  } catch (err) {
    // Any network error, JSON parse failure, etc. — mark unverified and continue
    console.warn(`[enrichVenues] lookup failed for "${venue.name}":`, err.message);
    return { ...venue, venue_verified: false };
  }
}

module.exports = { enrichVenues, extractCityFromGeoContext };

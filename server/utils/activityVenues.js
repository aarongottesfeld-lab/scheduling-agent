// server/utils/activityVenues.js
//
// Activity and hobby-specific venue discovery.
//
// When a user's context prompt mentions a specific physical activity or hobby
// (tennis, pottery, board games, escape rooms, etc.), this module proactively
// fetches real nearby venues from the Google Places Text Search API and returns
// a formatted prompt block that Claude can use to anchor suggestions to verified
// real-world locations — before generation, not after.
//
// This is the "fourth content source" alongside past history, live events, and
// the general venue enrichment pass. It differs from venueEnrichment.js in that:
//   - It runs BEFORE Claude generates (proactive), not after (reactive)
//   - It's activity-scoped: searches for a venue type, not a specific name
//   - It fetches website URLs via a follow-up Place Details call so Claude can
//     include a booking/reserve link in the suggestion
//
// Design constraints (same as venueEnrichment.js):
//   - Never throws: all errors return [] / ''
//   - Never sends user data to Places API: only activity type + city string
//   - Module-scoped 60-minute cache per (activityType, cityContext)
//   - Place Details calls (for website) run concurrently via Promise.allSettled

'use strict';

// ── Cache ─────────────────────────────────────────────────────────────────────
// Module-scoped so it persists across requests within the same server process.
// Key: "${activityType}|${cityContext}" — city-level only, no user data.
// Entry: { data: VenueResult[], expiresAt: number (ms) }
// TTL: 60 minutes — venue availability changes slowly; safe for rerolls.
const activityVenueCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

// ── Activity config ───────────────────────────────────────────────────────────
// Maps every supported activity type to a Places API Text Search query string.
// The query is appended with "in {cityContext}" at call time.
// type is retained for documentation; Text Search doesn't use it directly —
// the query string carries enough signal for reliable results.
const ACTIVITY_CONFIG = {
  // ── Sports & fitness ────────────────────────────────────────────────────────
  tennis:        { query: 'tennis courts',               label: 'TENNIS COURTS' },
  golf:          { query: 'golf course',                 label: 'GOLF COURSES' },
  pickleball:    { query: 'pickleball courts',           label: 'PICKLEBALL COURTS' },
  bowling:       { query: 'bowling alley',               label: 'BOWLING ALLEYS' },
  climbing:      { query: 'rock climbing gym',           label: 'CLIMBING GYMS' },
  ice_skating:   { query: 'ice skating rink',            label: 'ICE SKATING RINKS' },
  mini_golf:     { query: 'mini golf',                   label: 'MINI GOLF' },
  skiing:        { query: 'ski resort',                  label: 'SKI RESORTS' },
  swimming:      { query: 'public swimming pool',        label: 'SWIMMING POOLS' },
  basketball:    { query: 'basketball court',            label: 'BASKETBALL COURTS' },
  soccer:        { query: 'soccer field',                label: 'SOCCER FIELDS' },
  baseball:      { query: 'batting cage baseball',       label: 'BATTING CAGES' },
  yoga:          { query: 'yoga studio',                 label: 'YOGA STUDIOS' },
  cycling:       { query: 'cycling studio spin class',   label: 'CYCLING STUDIOS' },
  boxing:        { query: 'boxing gym',                  label: 'BOXING GYMS' },
  // ── Arts & creative ─────────────────────────────────────────────────────────
  pottery:       { query: 'pottery studio ceramics class',    label: 'POTTERY STUDIOS' },
  painting:      { query: 'painting class paint and sip',     label: 'PAINTING CLASSES' },
  photography:   { query: 'photography studio',               label: 'PHOTOGRAPHY STUDIOS' },
  drawing:       { query: 'drawing class art studio',         label: 'DRAWING & ART STUDIOS' },
  cooking:       { query: 'cooking class culinary studio',    label: 'COOKING CLASSES' },
  dance:         { query: 'dance studio',                     label: 'DANCE STUDIOS' },
  music_lessons: { query: 'music school lessons studio',      label: 'MUSIC LESSON STUDIOS' },
  // ── Social & entertainment ───────────────────────────────────────────────────
  board_games:   { query: 'board game café',             label: 'BOARD GAME CAFÉS' },
  escape_room:   { query: 'escape room',                 label: 'ESCAPE ROOMS' },
  karaoke:       { query: 'karaoke bar',                 label: 'KARAOKE BARS' },
  arcade:        { query: 'arcade',                      label: 'ARCADES' },
  axe_throwing:  { query: 'axe throwing',                label: 'AXE THROWING VENUES' },
  trivia:        { query: 'trivia night pub quiz bar',   label: 'TRIVIA & PUB QUIZ VENUES' },
  comedy:        { query: 'comedy club stand-up',        label: 'COMEDY CLUBS' },
  // ── Outdoors & nature ───────────────────────────────────────────────────────
  hiking:        { query: 'hiking trail park',           label: 'HIKING TRAILS & PARKS' },
  kayaking:      { query: 'kayak rental paddleboard',    label: 'KAYAK & PADDLEBOARD RENTALS' },
  biking:        { query: 'bike rental trail',           label: 'BIKE RENTALS & TRAILS' },
  birdwatching:  { query: 'nature reserve birdwatching', label: 'NATURE RESERVES' },
};

// ── Keyword → activity type map ───────────────────────────────────────────────
// Used by extractActivityType() to detect activity intent in free-text prompts.
// Ordered within each category from most-specific to most-general so that
// "rock climbing" matches 'climbing' before a broader keyword could match something else.
// Each entry: [keyword_pattern_string, activityType]
// Patterns are matched case-insensitively against the full prompt string.
const KEYWORD_MAP = [
  // Sports & fitness
  ['tennis',             'tennis'],
  ['pickleball',         'pickleball'],
  ['bowling',            'bowling'],
  ['bouldering',         'climbing'],
  ['rock climbing',      'climbing'],
  ['climbing',           'climbing'],
  ['ice skating',        'ice_skating'],
  ['skating rink',       'ice_skating'],
  ['mini golf',          'mini_golf'],
  ['putt-putt',          'mini_golf'],
  ['putt putt',          'mini_golf'],
  ['driving range',      'golf'],
  ['hit balls',          'golf'],
  ['golfing',            'golf'],
  ['golf',               'golf'],
  ['skiing',             'skiing'],
  ['snowboard',          'skiing'],
  ['ski slopes',         'skiing'],
  ['the slopes',         'skiing'],
  ['ski ',               'skiing'],   // trailing space prevents matching "basketball"
  ['swim laps',          'swimming'],
  ['swimming',           'swimming'],
  ['pool',               'swimming'],
  ['shoot hoops',        'basketball'],
  ['basketball',         'basketball'],
  ['football pitch',     'soccer'],
  ['soccer',             'soccer'],
  ['batting cage',       'baseball'],
  ['baseball',           'baseball'],
  ['yoga class',         'yoga'],
  ['yoga',               'yoga'],
  ['spin class',         'cycling'],
  ['spinning',           'cycling'],
  ['kickboxing',         'boxing'],
  ['boxing',             'boxing'],
  // Arts & creative
  ['ceramics',           'pottery'],
  ['pottery',            'pottery'],
  ['paint and sip',      'painting'],
  ['paint night',        'painting'],
  ['painting class',     'painting'],
  ['photo walk',         'photography'],
  ['photography',        'photography'],
  ['figure drawing',     'drawing'],
  ['drawing class',      'drawing'],
  ['culinary class',     'cooking'],
  ['cooking class',      'cooking'],
  ['ballroom',           'dance'],
  ['salsa',              'dance'],
  ['dance class',        'dance'],
  ['guitar lesson',      'music_lessons'],
  ['piano lesson',       'music_lessons'],
  ['music class',        'music_lessons'],
  // Social & entertainment
  ['board game café',    'board_games'],
  ['board game cafe',    'board_games'],
  ['board games',        'board_games'],
  ['escape room',        'escape_room'],
  ['karaoke',            'karaoke'],
  ['arcade',             'arcade'],
  ['axe throwing',       'axe_throwing'],
  ['pub quiz',           'trivia'],
  ['trivia night',       'trivia'],
  ['trivia',             'trivia'],
  ['stand-up',           'comedy'],
  ['stand up comedy',    'comedy'],
  ['comedy show',        'comedy'],
  // Outdoors & nature
  ['birdwatching',       'birdwatching'],
  ['bird watching',      'birdwatching'],
  ['paddleboard',        'kayaking'],
  ['kayaking',           'kayaking'],
  ['kayak',              'kayaking'],
  ['cycling trail',      'biking'],
  ['bike ride',          'biking'],
  ['hiking',             'hiking'],
  ['hike',               'hiking'],
  ['trail',              'hiking'],
];

/**
 * Parse a context prompt string and return the first matching activity type key,
 * or null if no supported activity is detected.
 *
 * Iterates KEYWORD_MAP in order (most-specific first) so longer/more-specific
 * phrases take precedence over single-word keywords.
 *
 * @param {string} contextPrompt - user-supplied context string (already sanitized)
 * @returns {string|null} activity type key (e.g. 'tennis', 'pottery') or null
 */
function extractActivityType(contextPrompt) {
  if (!contextPrompt || !contextPrompt.trim()) return null;
  const lower = contextPrompt.toLowerCase();
  for (const [keyword, activityType] of KEYWORD_MAP) {
    if (lower.includes(keyword)) return activityType;
  }
  return null;
}

/**
 * Fetch the website URL for a single place_id via the Places Details API.
 * Returns null on any failure — website is best-effort, not required.
 *
 * @param {string} placeId - Google Places place_id
 * @returns {Promise<string|null>}
 */
async function fetchPlaceWebsite(placeId) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=website&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const r    = await fetch(url);
    const json = await r.json();
    return json.result?.website || null;
  } catch (_) {
    return null;
  }
}

/**
 * Fetch the top 5 real venues for a given activity type and city context
 * from the Google Places Text Search API.
 *
 * Query format: "{activity query} in {cityContext}"
 * e.g. "pottery studio ceramics class in New York, NY"
 *
 * After getting the top 5 results, fetches each venue's website URL concurrently
 * via the Places Details API (best-effort — null on failure).
 *
 * Results are cached in-process for 60 minutes per (activityType, cityContext).
 *
 * @param {string} activityType - key from ACTIVITY_CONFIG (e.g. 'tennis', 'pottery')
 * @param {string} cityContext  - city string from extractCityFromGeoContext(), e.g. "New York, NY"
 * @returns {Promise<Array<{name, address, rating, user_ratings_total, website, place_id}>>}
 */
async function fetchActivityVenues(activityType, cityContext) {
  // Guard: API key required; activity type must be in config
  if (!process.env.GOOGLE_MAPS_API_KEY) return [];
  if (!ACTIVITY_CONFIG[activityType]) return [];
  if (!cityContext || !cityContext.trim()) return [];

  const cacheKey = `${activityType}|${cityContext}`;

  // Return cached results if still fresh
  const cached = activityVenueCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const config = ACTIVITY_CONFIG[activityType];
    // Append city to the query so Places Text Search anchors results geographically.
    // Only activity type + city sent to the API — no user names, preferences, or IDs.
    const query = encodeURIComponent(`${config.query} in ${cityContext}`);
    const url   = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${process.env.GOOGLE_MAPS_API_KEY}`;

    const r    = await fetch(url);
    const json = await r.json();

    // Take the top 5 results; fewer is fine if Places returns less
    const results = (json.results || []).slice(0, 5);
    if (results.length === 0) return [];

    // Fetch website for each result concurrently — one Details API call per place_id.
    // Promise.allSettled so a single slow/failing lookup doesn't block the rest.
    const websiteSettled = await Promise.allSettled(
      results.map(r => fetchPlaceWebsite(r.place_id))
    );

    // Combine Places Search results with their website lookups
    const venues = results.map((result, i) => ({
      name:               result.name || '',
      address:            result.formatted_address || '',
      rating:             result.rating             ?? null,
      user_ratings_total: result.user_ratings_total ?? null,
      place_id:           result.place_id           || '',
      // website: fulfilled = string or null; rejected (shouldn't happen) = null
      website:            websiteSettled[i].status === 'fulfilled'
                            ? websiteSettled[i].value
                            : null,
    })).filter(v => v.name && v.place_id); // drop any malformed entries

    // Write to cache with TTL
    activityVenueCache.set(cacheKey, {
      data:      venues,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return venues;
  } catch (err) {
    console.error(`[activityVenues] fetchActivityVenues failed for "${activityType}" in "${cityContext}":`, err.message);
    return [];
  }
}

/**
 * Build the prompt injection block that tells Claude about real nearby venues
 * for the detected activity type.
 *
 * Returns an empty string when venues is empty (no block injected into the prompt).
 * Never throws — a malformed venue entry is simply skipped.
 *
 * Format:
 *   NEARBY {ACTIVITY LABEL} VENUES
 *   The following real venues exist near the users' location...
 *   - Venue Name — address (rated X.X, N reviews) — website or 'no website found'
 *   ...
 *   Use one of these venues as the anchor for at least one suggestion...
 *
 * @param {string} activityType - key from ACTIVITY_CONFIG
 * @param {Array}  venues       - result from fetchActivityVenues()
 * @returns {string}
 */
function buildActivityVenuesBlock(activityType, venues) {
  if (!venues || venues.length === 0) return '';

  const config = ACTIVITY_CONFIG[activityType];
  // Fallback label if activityType is somehow not in config (shouldn't happen in practice)
  const label  = config?.label || activityType.toUpperCase().replace(/_/g, ' ');

  const lines = venues.map(v => {
    const ratingStr = v.rating != null
      ? `rated ${v.rating}${v.user_ratings_total != null ? `, ${v.user_ratings_total} reviews` : ''}`
      : 'no rating';
    const siteStr = v.website || 'no website found';
    return `- ${v.name} — ${v.address || 'address unavailable'} (${ratingStr}) — ${siteStr}`;
  }).join('\n');

  return (
    `\nNEARBY ${label}\n` +
    `The following real venues exist near the users' location. If the context prompt requests this activity or hobby, anchor at least one suggestion to one of these venues. Prefer higher-rated venues with more reviews as a quality signal, but don't exclude lower-rated options if they're the only fit.\n` +
    `${lines}\n` +
    `Use one of these venues as the anchor for at least one suggestion when the activity matches. ` +
    `If you anchor a suggestion to one of these venues, set "activity_source": "places_activity", ` +
    `"activity_type": "${activityType}", and include the venue's website in "venue_url" (omit if no website).`
  );
}

module.exports = { extractActivityType, fetchActivityVenues, buildActivityVenuesBlock };

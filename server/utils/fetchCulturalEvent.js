'use strict';

// server/utils/fetchCulturalEvent.js
//
// Resolves a cultural signal (sports game or awards ceremony) to a concrete
// { title, date, time, venue, description } object for the scheduling window.
//
// Used by the /schedule/suggest and /group-itineraries/:id/suggest routes to
// inject a PRIORITY EVENT block into the Claude prompt when the user's context
// references a real-world timed event.
//
// Data sources:
//   Sports:  ESPN public scoreboard API (no API key required)
//   Awards:  MediaWiki Action API + Wikipedia (no API key required)
//
// Privacy: no user data (IDs, names, emails, preferences) is ever sent to ESPN
// or Wikipedia.  Only the entity string (team name / ceremony name) and the
// date range leave the server.  Team name matching happens locally on the
// returned JSON.
//
// Never throws — returns null on all errors so a lookup failure never blocks
// itinerary generation.

// ── In-process cache ─────────────────────────────────────────────────────────────
// Map<cacheKey, { data: EventResult|null, expiresAt: number }>
// Key: "${type}|${entity}|${dateRangeStart}|${dateRangeEnd}"
// TTL: 4 hours — event schedules are stable within a generation session.
const culturalEventCache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ── League lookup ──────────────────────────────────────────────────────────────────
// Primary map: team → single league.  Multi-league teams are handled via
// MULTI_LEAGUE_TEAMS below.

const TEAM_LEAGUE = {
  // NBA
  knicks: 'nba', lakers: 'nba', celtics: 'nba', warriors: 'nba', bulls: 'nba',
  nets: 'nba', heat: 'nba', bucks: 'nba', sixers: 'nba', suns: 'nba',
  nuggets: 'nba', cavaliers: 'nba', thunder: 'nba', clippers: 'nba',
  mavericks: 'nba', rockets: 'nba', hawks: 'nba', raptors: 'nba',
  spurs: 'nba', grizzlies: 'nba', timberwolves: 'nba', pacers: 'nba',
  magic: 'nba', pistons: 'nba', hornets: 'nba', wizards: 'nba',
  kings: 'nba', blazers: 'nba', pelicans: 'nba', jazz: 'nba',
  // MLB
  yankees: 'mlb', mets: 'mlb', 'red sox': 'mlb', dodgers: 'mlb', cubs: 'mlb',
  astros: 'mlb', braves: 'mlb', phillies: 'mlb',
  padres: 'mlb', brewers: 'mlb', pirates: 'mlb', reds: 'mlb', tigers: 'mlb',
  orioles: 'mlb', 'blue jays': 'mlb', rays: 'mlb', twins: 'mlb',
  'white sox': 'mlb', royals: 'mlb', mariners: 'mlb', athletics: 'mlb',
  rockies: 'mlb', angels: 'mlb', marlins: 'mlb', nationals: 'mlb',
  // NFL
  jets: 'nfl', patriots: 'nfl', bills: 'nfl', eagles: 'nfl', cowboys: 'nfl',
  bears: 'nfl', packers: 'nfl', vikings: 'nfl', lions: 'nfl', seahawks: 'nfl',
  rams: 'nfl', chiefs: 'nfl', ravens: 'nfl', steelers: 'nfl', browns: 'nfl',
  bengals: 'nfl', broncos: 'nfl', raiders: 'nfl', chargers: 'nfl', dolphins: 'nfl',
  texans: 'nfl', colts: 'nfl', titans: 'nfl', jaguars: 'nfl', saints: 'nfl',
  falcons: 'nfl', buccaneers: 'nfl', commanders: 'nfl',
  // NHL
  islanders: 'nhl', devils: 'nhl', flyers: 'nhl', bruins: 'nhl', canadiens: 'nhl',
  'maple leafs': 'nhl', senators: 'nhl', sabres: 'nhl', penguins: 'nhl',
  capitals: 'nhl', hurricanes: 'nhl', lightning: 'nhl', 'red wings': 'nhl',
  blackhawks: 'nhl', blues: 'nhl', predators: 'nhl', stars: 'nhl', wild: 'nhl',
  avalanche: 'nhl', sharks: 'nhl', ducks: 'nhl', canucks: 'nhl', flames: 'nhl',
  oilers: 'nhl', coyotes: 'nhl', kraken: 'nhl', 'golden knights': 'nhl',
  'utah hockey club': 'nhl',
  // MLS
  nycfc: 'mls', 'red bulls': 'mls', fire: 'mls', galaxy: 'mls', sounders: 'mls',
  timbers: 'mls', 'toronto fc': 'mls', montreal: 'mls', nyrb: 'mls',
};

// Teams that appear in more than one league — queried across all matching leagues.
const MULTI_LEAGUE_TEAMS = {
  giants:    ['mlb', 'nfl'],   // SF Giants (MLB) + NY Giants (NFL)
  rangers:   ['mlb', 'nhl'],   // Texas Rangers (MLB) + NY Rangers (NHL)
  panthers:  ['nfl', 'nhl'],   // Carolina Panthers (NFL) + Florida Panthers (NHL)
  cardinals: ['mlb', 'nfl'],   // St. Louis Cardinals (MLB) + Arizona Cardinals (NFL)
};

// ESPN public scoreboard endpoint — no API key required.
const ESPN_ENDPOINTS = {
  nba: 'basketball/nba',
  mlb: 'baseball/mlb',
  nfl: 'football/nfl',
  nhl: 'hockey/nhl',
  mls: 'soccer/usa.1',
};

// ── Awards search map ─────────────────────────────────────────────────────────────
const AWARDS_SEARCH = {
  'oscars':           'Academy Awards',
  'academy awards':   'Academy Awards',
  'grammys':          'Grammy Awards',
  'grammy awards':    'Grammy Awards',
  'emmys':            'Emmy Awards',
  'emmy awards':      'Emmy Awards',
  'golden globes':    'Golden Globe Awards',
  'tony awards':      'Tony Awards',
  'tonys':            'Tony Awards',
  'sag awards':       'Screen Actors Guild Awards',
  'bafta':            'BAFTA Film Awards',
  'mtv awards':       'MTV Movie & TV Awards',
  'vmas':             'MTV Video Music Awards',
  'billboard awards': 'Billboard Music Awards',
};

// ── Helpers ───────────────────────────────────────────────────────────────────────

/** Format a Date as "March 18, 2026" using local (America/New_York) timezone. */
function formatDateET(d) {
  return d.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'America/New_York',
  });
}

/** Format a Date as "7:30 PM ET". */
function formatTimeET(d) {
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/New_York',
  });
  return `${time} ET`;
}

/** Format a Date as "YYYYMMDD" in local (wall-clock) terms. */
function toYYYYMMDD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// ── Sports handler ────────────────────────────────────────────────────────────────

/**
 * Look up a sports game for the given team in the scheduling window.
 * Queries ESPN scoreboard for each date in the range (max 14) across all
 * matching leagues concurrently.  Returns the first game where a competitor's
 * name includes the entity string, or null if none found.
 *
 * @param {string} entity        - team name, e.g. "knicks"
 * @param {string} dateRangeStart - YYYY-MM-DD
 * @param {string} dateRangeEnd   - YYYY-MM-DD
 * @returns {Promise<object|null>}
 */
async function fetchSportsEvent(entity, dateRangeStart, dateRangeEnd) {
  // Resolve leagues for this entity
  const leagues = MULTI_LEAGUE_TEAMS[entity] ||
    (TEAM_LEAGUE[entity] ? [TEAM_LEAGUE[entity]] : null);

  if (!leagues) {
    console.warn(`[fetchCulturalEvent] No league mapping for sports entity "${entity}"`);
    return null;
  }

  // Generate date list (max 14 days)
  const dates = [];
  const startD = new Date(dateRangeStart + 'T00:00:00');
  const endD   = new Date(dateRangeEnd   + 'T00:00:00');
  for (let d = new Date(startD), i = 0; d <= endD && i < 14; d.setDate(d.getDate() + 1), i++) {
    dates.push(toYYYYMMDD(new Date(d)));
  }

  if (dates.length === 0) return null;

  // Build all (league, date) fetch calls concurrently
  const calls = [];
  for (const league of leagues) {
    const leaguePath = ESPN_ENDPOINTS[league];
    if (!leaguePath) continue;
    for (const date of dates) {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${leaguePath}/scoreboard?dates=${date}`;
      calls.push({ league, date, url });
    }
  }

  if (calls.length === 0) return null;

  const results = await Promise.allSettled(
    calls.map(c => fetch(c.url).then(r => r.json()))
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status !== 'fulfilled') continue;
    const json   = results[i].value;
    const events = json.events || [];

    for (const event of events) {
      const competitors = event.competitions?.[0]?.competitors || [];
      const teamNames   = competitors.map(c =>
        (c.team?.displayName || c.team?.shortDisplayName || c.team?.name || '').toLowerCase()
      );
      if (!teamNames.some(name => name.includes(entity))) continue;

      // Found a matching game
      const eventDate   = new Date(event.date);
      const teamA       = competitors[0]?.team?.displayName || '';
      const teamB       = competitors[1]?.team?.displayName || '';
      const venue       = event.competitions?.[0]?.venue?.fullName || '';
      const league      = calls[i].league;

      return {
        title:       `${teamA} vs. ${teamB}`,
        date:        formatDateET(eventDate),
        time:        formatTimeET(eventDate),
        venue,
        description: `${league.toUpperCase()} game`,
      };
    }
  }

  return null;
}

// ── Awards handler ────────────────────────────────────────────────────────────────

/**
 * Look up an awards ceremony date via the MediaWiki Action API.
 * Searches for the current year's edition, parses the date from the intro
 * extract, and validates that it falls within the scheduling window.
 *
 * Sends User-Agent header per Wikimedia's courtesy requirements.
 *
 * @param {string} entity        - ceremony key, e.g. "oscars"
 * @param {string} dateRangeStart - YYYY-MM-DD
 * @param {string} dateRangeEnd   - YYYY-MM-DD
 * @returns {Promise<object|null>}
 */
async function fetchAwardsEvent(entity, dateRangeStart, dateRangeEnd) {
  const searchName = AWARDS_SEARCH[entity];
  if (!searchName) {
    console.warn(`[fetchCulturalEvent] No awards mapping for entity "${entity}"`);
    return null;
  }

  const headers     = { 'User-Agent': 'Rendezvous/1.0 (contact@rendezvous.app)' };
  const currentYear = new Date().getFullYear();
  const searchTerm  = `${currentYear} ${searchName}`;

  // Step 1 — opensearch for current-year article title
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(searchTerm)}&limit=3&format=json&namespace=0`;
  const searchRes  = await fetch(searchUrl, { headers });
  if (!searchRes.ok) {
    console.warn(`[fetchCulturalEvent] Wikipedia opensearch HTTP ${searchRes.status} for "${entity}"`);
    return null;
  }
  const searchJson = await searchRes.json();

  // opensearch returns [searchTerm, [titles...], [descriptions...], [urls...]]
  const titles = searchJson[1] || [];
  let pageTitle = titles.find(t => t.includes(String(currentYear)));
  if (!pageTitle) pageTitle = titles[0];
  if (!pageTitle) {
    console.warn(`[fetchCulturalEvent] No Wikipedia article found for "${entity}" (${currentYear})`);
    return null;
  }

  // Step 2 — fetch page extract
  const extractUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=extracts&exintro=1&explaintext=1&format=json&formatversion=2`;
  const extractRes  = await fetch(extractUrl, { headers });
  if (!extractRes.ok) {
    console.warn(`[fetchCulturalEvent] Wikipedia extract HTTP ${extractRes.status} for "${pageTitle}"`);
    return null;
  }
  const extractJson = await extractRes.json();
  const extract     = extractJson.query?.pages?.[0]?.extract || '';

  if (!extract) {
    console.warn(`[fetchCulturalEvent] Empty extract for "${pageTitle}"`);
    return null;
  }

  // Step 3 — parse date from extract
  const MONTH_MAP = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const dateRegex = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/gi;

  let foundDate = null;
  let match;
  while ((match = dateRegex.exec(extract)) !== null) {
    const year = parseInt(match[3], 10);
    if (year === currentYear || year === currentYear + 1) {
      const month = MONTH_MAP[match[1].toLowerCase()];
      const day   = parseInt(match[2], 10);
      foundDate   = new Date(year, month - 1, day);
      break;
    }
  }

  if (!foundDate) {
    console.warn(`[fetchCulturalEvent] No current/next-year date in extract for "${pageTitle}"`);
    return null;
  }

  // Check that the date falls within the scheduling window
  const rangeStart = new Date(dateRangeStart + 'T00:00:00');
  const rangeEnd   = new Date(dateRangeEnd   + 'T23:59:59');
  if (foundDate < rangeStart || foundDate > rangeEnd) {
    // Ceremony exists but is outside the user's scheduling window — don't inject
    return null;
  }

  // Step 4 — parse venue from extract
  const venueMatch = extract.match(/at (?:the )?([A-Z][^\.\n,]{3,60})(?:\s+in|\s+on|\.|,)/);
  const venue      = venueMatch ? venueMatch[1].trim() : '';

  return {
    title:       pageTitle,
    date:        foundDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    time:        '8:00 PM ET', // fixed default — air time is not in the intro extract
    venue,
    description: 'Awards ceremony',
  };
}

// ── Main export ───────────────────────────────────────────────────────────────────

/**
 * Resolve a cultural signal to a concrete event within the scheduling window.
 *
 * In-process cache keyed by (type, entity, dateRangeStart, dateRangeEnd) with a
 * 4-hour TTL so concurrent requests on the same signal share the same lookup.
 *
 * Never throws — returns null on any error (network, parse, date out of range).
 *
 * @param {'sports'|'awards'} type
 * @param {string}            entity         - team or ceremony key (lowercase)
 * @param {string}            dateRangeStart - YYYY-MM-DD
 * @param {string}            dateRangeEnd   - YYYY-MM-DD
 * @returns {Promise<{ title, date, time, venue, description }|null>}
 */
async function fetchCulturalEvent(type, entity, dateRangeStart, dateRangeEnd) {
  const cacheKey = `${type}|${entity}|${dateRangeStart}|${dateRangeEnd}`;

  const cached = culturalEventCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  let result = null;
  try {
    if (type === 'sports') {
      result = await fetchSportsEvent(entity, dateRangeStart, dateRangeEnd);
    } else if (type === 'awards') {
      result = await fetchAwardsEvent(entity, dateRangeStart, dateRangeEnd);
    }
  } catch (err) {
    console.warn(`[fetchCulturalEvent] Error for ${type}/${entity}:`, err.message);
    result = null;
  }

  culturalEventCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

module.exports = fetchCulturalEvent;

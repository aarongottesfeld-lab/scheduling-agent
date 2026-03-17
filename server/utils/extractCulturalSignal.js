'use strict';

// server/utils/extractCulturalSignal.js
//
// Scans a context prompt (and optional activity preferences) for a cultural signal
// that maps to a real-world timed event — a sports game or an awards ceremony.
//
// Used by the /schedule/suggest and /group-itineraries/:id/suggest routes to detect
// intent-driven temporal anchoring before calling Claude.  The result is passed to
// fetchCulturalEvent which resolves the actual game/ceremony date and injects a
// PRIORITY EVENT block into the Claude prompt.
//
// Privacy: only the lowercased text is scanned locally.  No user data is sent anywhere.
// Never throws — returns null on any error so a detection failure never blocks scheduling.

// ── Sports team sets ───────────────────────────────────────────────────────────────
// Multi-word names must come before single-word names in the scan loop (sorted below).

const SPORTS_TEAMS = [
  // NBA
  'knicks', 'lakers', 'celtics', 'warriors', 'bulls', 'nets', 'heat', 'bucks',
  'sixers', 'suns', 'nuggets', 'cavaliers', 'thunder', 'clippers', 'mavericks',
  'rockets', 'hawks', 'raptors', 'spurs', 'grizzlies', 'timberwolves', 'pacers',
  'magic', 'pistons', 'hornets', 'wizards', 'kings', 'blazers', 'pelicans', 'jazz',
  // MLB
  'yankees', 'mets', 'red sox', 'dodgers', 'cubs', 'cardinals', 'astros', 'braves',
  'giants', 'phillies', 'padres', 'brewers', 'pirates', 'reds', 'tigers', 'orioles',
  'blue jays', 'rays', 'twins', 'white sox', 'royals', 'mariners', 'athletics',
  'rangers', 'rockies', 'angels', 'marlins', 'nationals',
  // NFL
  'jets', 'patriots', 'bills', 'eagles', 'cowboys', 'bears', 'packers',
  'vikings', 'lions', '49ers', 'seahawks', 'rams', 'chiefs', 'ravens', 'steelers',
  'browns', 'bengals', 'broncos', 'raiders', 'chargers', 'dolphins', 'texans',
  'colts', 'titans', 'jaguars', 'saints', 'falcons', 'panthers', 'buccaneers',
  'commanders',
  // NHL
  'islanders', 'devils', 'flyers', 'bruins', 'canadiens', 'maple leafs',
  'senators', 'sabres', 'penguins', 'capitals', 'hurricanes', 'lightning',
  'red wings', 'blackhawks', 'blues', 'predators', 'stars', 'wild', 'avalanche',
  'sharks', 'ducks', 'canucks', 'flames', 'oilers', 'coyotes', 'kraken',
  'golden knights', 'utah hockey club',
  // MLS
  'nycfc', 'red bulls', 'fire', 'galaxy', 'sounders', 'timbers', 'toronto fc',
  'montreal', 'nyrb',
  // Generic game phrases (no specific team — fetchCulturalEvent will return null for these)
  'the game', 'the match', 'watch the game', 'catch the game',
];

// Sort longest first so multi-word names (e.g. "maple leafs") match before single words.
const SORTED_SPORTS_TEAMS = [...SPORTS_TEAMS].sort((a, b) => b.length - a.length);

// ── Awards keywords ────────────────────────────────────────────────────────────────
const AWARDS_KEYWORDS = [
  'academy awards', // must come before 'oscars' so the longer string wins
  'grammy awards',
  'emmy awards',
  'golden globes',
  'tony awards',
  'sag awards',
  'mtv awards',
  'billboard awards',
  'oscars',
  'grammys',
  'emmys',
  'tonys',
  'bafta',
  'vmas',
];

/**
 * Detect a cultural signal in a context prompt.
 *
 * Only the explicit context prompt is scanned — activity preferences are NOT
 * included.  A member liking "yankees games" in their profile should not cause
 * every itinerary to anchor to the next Yankees game; the user must mention the
 * team/event in their scheduling prompt for temporal anchoring to kick in.
 *
 * Detection order (return on first match):
 *   1. Awards ceremonies — checked first because they are unambiguous.
 *   2. Sports team names — checked longest-string-first to avoid partial matches.
 *
 * @param {string}   contextPrompt        - free-text user context (e.g. "watch the Knicks")
 * @param {string[]} _activityPreferences - DEPRECATED, ignored. Kept for call-site compat.
 * @returns {{ type: 'sports'|'awards', entity: string } | null}
 */
function extractCulturalSignal(contextPrompt, _activityPreferences = []) {
  try {
    const promptLower = (contextPrompt || '').toLowerCase();

    // ── 1. Awards ──────────────────────────────────────────────────────────────
    for (const keyword of AWARDS_KEYWORDS) {
      if (promptLower.includes(keyword)) {
        return { type: 'awards', entity: keyword };
      }
    }

    // ── 2. Sports ──────────────────────────────────────────────────────────────
    for (const team of SORTED_SPORTS_TEAMS) {
      if (promptLower.includes(team)) {
        return { type: 'sports', entity: team };
      }
    }

    return null;
  } catch {
    return null;
  }
}

module.exports = { extractCulturalSignal };

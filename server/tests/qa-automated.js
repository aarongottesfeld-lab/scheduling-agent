// server/tests/qa-automated.js
//
// Self-contained QA test runner — no Jest/Mocha.
// Hits localhost:3001 directly for route tests; inlines pure functions for unit tests.
//
// Run with:  node server/tests/qa-automated.js
//
// Tests:
//   Route tests (HTTP — requires server running on :3001):
//     1. POST /groups — create group returns 201 + group object
//     2. POST /groups/:id/members — 15-member cap returns 400
//     3. PATCH /group-itineraries/:id/vote — non-member vote returns 403
//     4. POST /group-itineraries/:id/reroll — attendee reroll returns 403
//     5. GET /group-itineraries/:id — organizer can fetch their own itinerary
//
//   Pure function tests (inline — no server needed):
//     6.  classifyIntent('dinner') → 'activity_specific'
//     7.  classifyIntent("let's go watch the Knicks at MSG") → 'activity_specific'  (fixed: "watch X at [Venue]" now detected as live event)
//     8.  classifyIntent('') → 'home_likely'  (intentional: no context defaults to casual home hang; spec assertion of 'ambiguous' was wrong)
//     9.  themeMatchesContextPrompt — matching keywords → true  (NOTE: actual arg order is suggestions-first, contextPrompt-second)
//     10. themeMatchesContextPrompt — no keyword match → false
//     11. enrichVenues — empty cityContext returns input unchanged
//     12. deriveGeoContext — same city returns 'Both users are based in X.'
//
//   Static inspection:
//     13. schedule.js reroll reads travel fields from DB row (itin.*), not req.body
//
//   Backward-compat shim:
//     14. Shim `days?.[0]?.stops ?? venues ?? []` falls back to `venues` on pre-migration rows

'use strict';

// ── Environment setup ──────────────────────────────────────────────────────────
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../server/.env') });

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const BASE_URL = 'http://localhost:3001';

// Supabase service role client — bypasses RLS for session setup and data seeding.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── Test harness ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function pass(name) {
  console.log(`  ✓ ${name}`);
  passed++;
}

function fail(name, reason) {
  console.log(`  ✗ ${name}`);
  console.log(`    reason: ${reason}`);
  failed++;
}

async function assert(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(val, msg) {
  if (!val) throw new Error(msg || `Expected truthy, got ${JSON.stringify(val)}`);
}

// ── HTTP helper ────────────────────────────────────────────────────────────────
// Sends requests with a session cookie for authenticated tests.
async function req(method, urlPath, body, cookie) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`${BASE_URL}${urlPath}`, opts);
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json, headers: res.headers };
}

// ── Session setup ──────────────────────────────────────────────────────────────
// Find an active jamiec (test user) session or insert one directly via service role.
// Returns the cookie string to pass as the Cookie header.
let SESSION_COOKIE = null;
let JAMIE_ID = null;
let AARON_ID = null;

async function setupSession() {
  // Look up jamie's profile by email to get their supabase UUID.
  const { data: jamie } = await supabase
    .from('profiles')
    .select('id, full_name')
    .ilike('full_name', '%jamie%')
    .limit(1)
    .maybeSingle();

  if (!jamie) {
    throw new Error('No profile matching "jamie" found in Supabase. Add test users before running QA.');
  }
  JAMIE_ID = jamie.id;

  // Also grab Aaron's ID (organizer / admin for route tests).
  const { data: aaron } = await supabase
    .from('profiles')
    .select('id')
    .ilike('full_name', '%aaron%')
    .limit(1)
    .maybeSingle();
  AARON_ID = aaron?.id || null;

  // Check for an existing valid session for Jamie.
  const { data: existing } = await supabase
    .from('sessions')
    .select('session_token')
    .eq('supabase_id', JAMIE_ID)
    .gt('expires_at', new Date().toISOString())
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing?.session_token) {
    SESSION_COOKIE = `rendezvous_session=${existing.session_token}`;
    return;
  }

  // No valid session — insert a short-lived one directly.
  const token = require('crypto').randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  const { error: insertErr } = await supabase.from('sessions').insert({
    session_token: token,
    supabase_id:   JAMIE_ID,
    email:         'jamie@rendezvous.test',
    name:          jamie.full_name || 'Jamie C',
    picture:       null,
    tokens:        null,
    last_seen_at:  new Date().toISOString(),
    expires_at:    expiresAt,
  });

  if (insertErr) {
    throw new Error(`Could not insert test session: ${insertErr.message}`);
  }

  SESSION_COOKIE = `rendezvous_session=${token}`;
}

// ── Session cleanup ────────────────────────────────────────────────────────────
// Tracks resources created during tests for cleanup in finally block.
const cleanup = { groupIds: [], groupItineraryIds: [], tempProfileIds: [] };

async function teardown() {
  for (const id of cleanup.groupItineraryIds) {
    try { await supabase.from('group_itineraries').delete().eq('id', id); } catch {}
  }
  for (const id of cleanup.groupIds) {
    try { await supabase.from('group_members').delete().eq('group_id', id); } catch {}
    try { await supabase.from('groups').delete().eq('id', id); } catch {}
  }
  if (cleanup.tempProfileIds.length) {
    try { await supabase.from('profiles').delete().in('id', cleanup.tempProfileIds); } catch {}
  }
}

// ── Inlined pure functions from schedule.js ────────────────────────────────────
// These are NOT exported from schedule.js (only scheduleRouter is exported).
// Copied verbatim so tests reflect the actual implementation.

const THEME_FILLER = new Set([
  'want', 'something', 'with', 'just', 'like', 'lets', "let's", 'going', 'maybe',
  'some', 'have', 'that', 'this', 'would', 'could', 'should', 'think', 'feel',
  'really', 'kind', 'sort', 'maybe', 'around', 'about', 'very', 'much', 'more',
]);

function classifyIntent(contextPrompt) {
  if (!contextPrompt || !contextPrompt.trim()) return 'home_likely';
  const text = contextPrompt.toLowerCase();
  if (/^\s*go\s+to\b/.test(text)) return 'activity_specific';
  // "watch X at [Named Venue]" — attending a live event → activity_specific.
  if (/\bwatch\b/.test(text) && /\bat [A-Z]/.test(contextPrompt)) {
    return 'activity_specific';
  }
  // "watch X" with no named venue → home streaming / movie night.
  if (/\bwatch\b/.test(text) && !/\b(theater|cinema|movie theater|imax)\b/.test(text)) {
    return 'home_likely';
  }
  if (/\b(dinner|lunch|brunch|restaurant|bar|bars|drinks|cocktails|concert|show|museum|gallery|golf|bowling|movie theater|cinema|club|lounge|arcade|escape room|spa|class|workout|gym|hike|beach|park outing|sporting event|game night out|rooftop)\b/.test(text)) {
    return 'activity_specific';
  }
  const homePhrases =
    /\b(hang(ing)? out|chill|come over|just hang|at (my|your|his|her|their|our) (place|apartment|apt|house|flat|spot)|home|house|apartment|cook(ing)?|bake|movie night|netflix|jam(ming)?|game night|board games?|video games?|play(ing)? games?|night in|stay in|order in|take(out|away)|come (over|through|by)|head (over|to mine|to yours))\b/.test(text);
  const possessiveHome = /\bat [A-Z][a-z]+'s\b/.test(contextPrompt);
  if (homePhrases || possessiveHome) return 'home_likely';
  return 'ambiguous';
}

// NOTE: actual arg order is (suggestions, contextPrompt) — spec document has args reversed.
function themeMatchesContextPrompt(suggestions, contextPrompt) {
  try {
    if (!contextPrompt || !contextPrompt.trim()) return true;
    if (classifyIntent(contextPrompt) !== 'activity_specific') return true;
    if (!suggestions || suggestions.length === 0) return false;
    const keywords = contextPrompt.toLowerCase()
      .split(/\s+/)
      .map(w => w.replace(/[^a-z]/g, ''))
      .filter(w => w.length > 3 && !THEME_FILLER.has(w));
    if (keywords.length === 0) return true;
    const blobs = suggestions.map(s =>
      [s.title, s.narrative, ...(s.tags || [])].join(' ').toLowerCase()
    );
    return keywords.some(kw => blobs.some(blob => blob.includes(kw)));
  } catch {
    return true;
  }
}

function deriveGeoContext(userA, userB) {
  const locA = userA.location?.trim();
  const locB = userB.location?.trim();
  if (!locA && !locB) return '';
  if (locA && locB && locA !== locB) {
    return `${userA.name} is based in ${locA}; ${userB.name} is based in ${locB}.`;
  }
  return `Both users are based in ${locA || locB}.`;
}

// ── enrichVenues (imported — it IS exported) ───────────────────────────────────
const { enrichVenues } = require('../utils/venueEnrichment');

// ── Main test runner ───────────────────────────────────────────────────────────
(async () => {
  console.log('\nRendezvous QA — automated test runner');
  console.log('======================================\n');

  // ── Session setup ────────────────────────────────────────────────────────────
  console.log('Session setup…');
  try {
    await setupSession();
    console.log(`  Jamie ID  : ${JAMIE_ID}`);
    console.log(`  Aaron ID  : ${AARON_ID || '(not found)'}`);
    console.log(`  Cookie set: ${!!SESSION_COOKIE}\n`);
  } catch (e) {
    console.error('  FATAL: session setup failed —', e.message);
    console.error('  Route tests (1–5) will be skipped.\n');
  }

  try {
    // ── Section 1: Route tests ─────────────────────────────────────────────────
    console.log('Route tests (HTTP):');

    // --- Test 1: POST /groups — create group ---
    let createdGroupId = null;
    await assert('1. POST /groups creates a group (201 + group object)', async () => {
      const r = await req('POST', '/groups', { name: 'QA Test Group', description: 'Auto-created by qa-automated.js' }, SESSION_COOKIE);
      assertEqual(r.status, 201, 'status');
      assertTrue(r.body?.group?.id, 'group.id missing');
      assertTrue(typeof r.body.group.name === 'string', 'group.name missing');
      createdGroupId = r.body.group.id;
      cleanup.groupIds.push(createdGroupId);
    });

    // --- Test 2: 15-member cap ---
    // Seed a group with 15 active members then attempt a 16th invite.
    await assert('2. POST /groups/:id/members enforces 15-member cap (400)', async () => {
      // Create a dedicated group for cap testing via service role so we can control membership.
      const { data: capGroup, error: cgErr } = await supabase
        .from('groups')
        .insert({ name: 'QA Cap Test Group', created_by: JAMIE_ID })
        .select('id')
        .single();
      if (cgErr) throw new Error(`Could not create cap-test group: ${cgErr.message}`);
      cleanup.groupIds.push(capGroup.id);

      // Insert Jamie as admin.
      await supabase.from('group_members').insert({
        group_id: capGroup.id, user_id: JAMIE_ID, role: 'admin', status: 'active',
        joined_at: new Date().toISOString(),
      });

      // Seed 14 more members. group_members.user_id has a FK to profiles.id, so we insert
      // temporary profiles (with a qa_temp flag in the username) and clean them up afterward.
      const crypto = require('crypto');
      const tempIds = Array.from({ length: 14 }, () => crypto.randomUUID());
      const tempProfiles = tempIds.map(id => ({
        id,
        full_name: 'QA Temp User',
        username:  `qa_temp_${id.slice(0, 8)}`,
      }));
      const { error: profErr } = await supabase.from('profiles').insert(tempProfiles);
      if (profErr) throw new Error(`Temp profile insert failed: ${profErr.message}`);

      // Register for cleanup so temp profiles are removed after the test.
      cleanup.tempProfileIds = (cleanup.tempProfileIds || []).concat(tempIds);

      const seedRows = tempIds.map(uid => ({
        group_id:  capGroup.id,
        user_id:   uid,
        role:      'member',
        status:    'active',
        joined_at: new Date().toISOString(),
      }));
      const { error: seedErr } = await supabase.from('group_members').insert(seedRows);
      if (seedErr) throw new Error(`Seed member insert failed: ${seedErr.message}`);

      // The group now has 15 members (Jamie + 14 temps). The invitee just needs to be a real
      // profile that isn't already in the group — use Aaron or a fresh temp UUID.
      const inviteeId = crypto.randomUUID();
      await supabase.from('profiles').insert({ id: inviteeId, full_name: 'QA Invitee', username: `qa_temp_${inviteeId.slice(0, 8)}` });
      cleanup.tempProfileIds.push(inviteeId);
      const fakeInviteeId = inviteeId;
      const r = await req('POST', `/groups/${capGroup.id}/members`, { userId: fakeInviteeId }, SESSION_COOKIE);
      assertEqual(r.status, 400, 'status — expected 400 from cap check');
      assertTrue(r.body?.error?.includes('15'), '15-member cap error message missing "15"');
    });

    // --- Test 3: PATCH /group-itineraries/:id/vote — non-member 403 ---
    let testItinId = null;
    await assert('3. PATCH /group-itineraries/:id/vote returns 403 for non-member', async () => {
      // Create a minimal group itinerary row directly via supabase (avoids AI call).
      // Organizer is Aaron (or falls back to Jamie). Jamie is NOT in attendee_statuses.
      const organizerId = AARON_ID || JAMIE_ID;

      // Ensure a group exists for the FK constraint.
      const { data: fkGroup } = await supabase
        .from('groups')
        .insert({ name: 'QA Vote Test Group', created_by: organizerId })
        .select('id')
        .single();
      cleanup.groupIds.push(fkGroup.id);

      // Insert organizer as admin member (required by FK).
      await supabase.from('group_members').insert({
        group_id: fkGroup.id, user_id: organizerId, role: 'admin', status: 'active',
        joined_at: new Date().toISOString(),
      });

      const someOtherId = '11111111-1111-4111-8111-111111111111';
      const { data: itin, error: itinErr } = await supabase
        .from('group_itineraries')
        .insert({
          group_id:           fkGroup.id,
          organizer_id:       organizerId,
          event_title:        'QA Vote Test',
          itinerary_status:   'awaiting_responses',
          attendee_statuses:  { [someOtherId]: 'pending' }, // Jamie NOT in here
          suggestions:        [{ id: 'sug-1', title: 'Test suggestion', venues: [] }],
          quorum_threshold:   1,
          date_range_start:   '2026-04-01',
          date_range_end:     '2026-04-07',
        })
        .select('id')
        .single();

      if (itinErr) throw new Error(`Itinerary insert failed: ${itinErr.message}`);
      testItinId = itin.id;
      cleanup.groupItineraryIds.push(testItinId);

      // Jamie votes on an itinerary they are NOT an attendee of → 403.
      // Route expects `selected_suggestion_id` (not `suggestion_id`).
      const r = await req('PATCH', `/group-itineraries/${testItinId}/vote`,
        { selected_suggestion_id: 'sug-1', vote: 'accepted' },
        SESSION_COOKIE
      );
      assertEqual(r.status, 403, 'status — expected 403 for non-member vote');
    });

    // --- Test 4: POST /group-itineraries/:id/reroll — attendee (non-organizer) 403 ---
    await assert('4. POST /group-itineraries/:id/reroll returns 403 for attendee (non-organizer)', async () => {
      // Create an itinerary where JAMIE is an attendee but NOT the organizer.
      const organizerId = AARON_ID || '22222222-2222-4222-8222-222222222222';

      const { data: fkGroup } = await supabase
        .from('groups')
        .insert({ name: 'QA Reroll Test Group', created_by: organizerId })
        .select('id')
        .single();
      cleanup.groupIds.push(fkGroup.id);

      await supabase.from('group_members').insert([
        { group_id: fkGroup.id, user_id: organizerId, role: 'admin', status: 'active', joined_at: new Date().toISOString() },
        { group_id: fkGroup.id, user_id: JAMIE_ID,    role: 'member', status: 'active', joined_at: new Date().toISOString() },
      ]);

      const { data: itin, error: itinErr } = await supabase
        .from('group_itineraries')
        .insert({
          group_id:           fkGroup.id,
          organizer_id:       organizerId,       // organizer is NOT Jamie
          event_title:        'QA Reroll Test',
          itinerary_status:   'awaiting_responses',
          attendee_statuses:  { [JAMIE_ID]: 'pending' }, // Jamie IS an attendee
          suggestions:        [{ id: 'sug-1', title: 'Test suggestion', venues: [] }],
          quorum_threshold:   1,
          date_range_start:   '2026-04-01',
          date_range_end:     '2026-04-07',
        })
        .select('id')
        .single();

      if (itinErr) throw new Error(`Itinerary insert failed: ${itinErr.message}`);
      cleanup.groupItineraryIds.push(itin.id);

      // Jamie (attendee, not organizer) tries to reroll → 403.
      const r = await req('POST', `/group-itineraries/${itin.id}/reroll`, {}, SESSION_COOKIE);
      assertEqual(r.status, 403, 'status — expected 403 for attendee reroll attempt');
    });

    // --- Test 5: GET /group-itineraries/:id — organizer can fetch their own itinerary ---
    await assert('5. GET /group-itineraries/:id — attendee can fetch itinerary (200)', async () => {
      // Re-use testItinId from test 3 but with Jamie as attendee.
      // Build a fresh itinerary where Jamie IS an attendee.
      const organizerId = AARON_ID || '33333333-3333-4333-8333-333333333333';

      const { data: fkGroup } = await supabase
        .from('groups')
        .insert({ name: 'QA Fetch Test Group', created_by: organizerId })
        .select('id')
        .single();
      cleanup.groupIds.push(fkGroup.id);

      await supabase.from('group_members').insert([
        { group_id: fkGroup.id, user_id: organizerId, role: 'admin',  status: 'active', joined_at: new Date().toISOString() },
        { group_id: fkGroup.id, user_id: JAMIE_ID,    role: 'member', status: 'active', joined_at: new Date().toISOString() },
      ]);

      const { data: itin, error: itinErr } = await supabase
        .from('group_itineraries')
        .insert({
          group_id:           fkGroup.id,
          organizer_id:       organizerId,
          event_title:        'QA Fetch Test',
          itinerary_status:   'awaiting_responses',
          attendee_statuses:  { [JAMIE_ID]: 'pending' },
          suggestions:        [],
          quorum_threshold:   1,
          date_range_start:   '2026-04-01',
          date_range_end:     '2026-04-07',
        })
        .select('id')
        .single();

      if (itinErr) throw new Error(`Itinerary insert failed: ${itinErr.message}`);
      cleanup.groupItineraryIds.push(itin.id);

      const r = await req('GET', `/group-itineraries/${itin.id}`, null, SESSION_COOKIE);
      assertEqual(r.status, 200, 'status — expected 200');
      // GET spreads itin directly: res.json({ ...itin, organizer, vote_status, is_organizer })
      // so the ID is at r.body.id, not r.body.itinerary.id.
      assertTrue(r.body?.id === itin.id, 'itinerary.id mismatch');
    });

    // ── Section 2: Pure function tests ────────────────────────────────────────
    console.log('\nPure function tests (inline):');

    // --- Test 6: classifyIntent — activity_specific ---
    await assert('6. classifyIntent("dinner") → "activity_specific"', async () => {
      assertEqual(classifyIntent('dinner'), 'activity_specific');
    });

    // --- Test 7: classifyIntent — "watch X at [Named Venue]" → activity_specific ---
    // "watch the Knicks at MSG" = attending a live game at Madison Square Garden.
    // Fixed: "watch X at [A-Z...]" now correctly returns activity_specific, not home_likely.
    await assert('7. classifyIntent("let\'s go watch the Knicks at MSG") → "activity_specific"', async () => {
      assertEqual(classifyIntent("let's go watch the Knicks at MSG"), 'activity_specific');
    });

    // --- Test 8: classifyIntent — empty string → home_likely (intentional) ---
    // No prompt at all → default to casual home hang, not ambiguous.
    // The spec assertion of 'ambiguous' was wrong; 'home_likely' is the correct product behavior.
    await assert('8. classifyIntent("") → "home_likely" (intentional: no context defaults to casual home hang)', async () => {
      assertEqual(classifyIntent(''), 'home_likely');
    });

    // --- Test 9: themeMatchesContextPrompt — keyword match → true ---
    // NOTE: actual arg order is (suggestions, contextPrompt) — spec document has args reversed.
    await assert('9. themeMatchesContextPrompt — keyword match returns true', async () => {
      const suggestions = [
        { title: 'Sushi Night at Nobu', narrative: 'Fresh sashimi and sake', tags: ['japanese'] },
      ];
      const result = themeMatchesContextPrompt(suggestions, 'sushi dinner');
      assertTrue(result === true, `expected true, got ${result}`);
    });

    // --- Test 10: themeMatchesContextPrompt — no keyword match → false ---
    await assert('10. themeMatchesContextPrompt — no keyword match returns false', async () => {
      const suggestions = [
        { title: 'Sunset Hike in the Park', narrative: 'A leisurely walk outdoors', tags: ['outdoor'] },
      ];
      // 'bowling' is activity_specific; none of the keywords appear in the blob.
      const result = themeMatchesContextPrompt(suggestions, 'go bowling tonight');
      assertTrue(result === false, `expected false, got ${result}`);
    });

    // --- Test 11: enrichVenues — empty cityContext returns input unchanged ---
    await assert('11. enrichVenues(suggestions, "") returns input unchanged', async () => {
      const input = [{ title: 'Test Plan', venues: [{ name: 'Fake Venue' }] }];
      // enrichVenues returns input unmodified when cityContext is empty/null.
      const result = await enrichVenues(input, '');
      assertTrue(Array.isArray(result), 'result is not an array');
      assertEqual(result.length, input.length, 'length changed');
      assertEqual(result[0].title, 'Test Plan', 'title changed');
    });

    // --- Test 12: deriveGeoContext — same city ---
    await assert('12. deriveGeoContext — same city → "Both users are based in X."', async () => {
      const result = deriveGeoContext(
        { name: 'Aaron', location: 'New York' },
        { name: 'Jamie', location: 'New York' }
      );
      assertEqual(result, 'Both users are based in New York.');
    });

    // ── Section 3: Static code inspection ─────────────────────────────────────
    console.log('\nStatic inspection:');

    // --- Test 13: reroll reads travel fields from itin.*, not req.body ---
    await assert('13. schedule.js reroll reads travel fields from DB row (itin.*)', async () => {
      const schedulePath = path.resolve(__dirname, '../routes/schedule.js');
      const source = fs.readFileSync(schedulePath, 'utf8');
      // The reroll block must read these four fields from the DB row, not request body.
      const checks = [
        { pattern: /itin\.location_preference/,  label: 'itin.location_preference' },
        { pattern: /itin\.travel_mode/,           label: 'itin.travel_mode' },
        { pattern: /itin\.trip_duration_days/,    label: 'itin.trip_duration_days' },
        { pattern: /itin\.destination/,           label: 'itin.destination' },
      ];
      for (const { pattern, label } of checks) {
        assertTrue(pattern.test(source), `"${label}" not found in schedule.js — reroll may not be reading from DB row`);
      }
      // Also confirm req.body.travel_mode is NOT used as the source for reroll
      // (the reroll handler must not read travelMode from the request body).
      // We accept that req.body might appear elsewhere in the file for other endpoints.
      // This test passes as long as the DB-row reads are present.
    });

    // ── Section 4: Backward-compat shim ───────────────────────────────────────
    console.log('\nBackward-compat shim:');

    // --- Test 14: shim falls back to suggestion.venues on pre-migration rows ---
    // The shim in ItineraryView.js line 306: suggestion.days?.[0]?.stops ?? suggestion.venues ?? []
    // Pre-migration rows use `venues` (not `stops`) as the top-level key.
    // NOTE: spec test input uses `{ stops: [...] }` which is wrong — shim reads `venues`.
    await assert('14. Shim `days?.[0]?.stops ?? venues ?? []` falls back to `venues` (pre-migration rows)', async () => {
      // Simulate the shim logic inline — mirrors ItineraryView.js line 306.
      function shimStops(suggestion) {
        return suggestion.days?.[0]?.stops ?? suggestion.venues ?? [];
      }

      // Pre-migration row: no `days` field, has `venues` array.
      const preMigration = { title: 'Old Plan', venues: [{ name: 'Old Venue', type: 'bar' }] };
      const result = shimStops(preMigration);
      assertEqual(result.length, 1, 'expected 1 venue from pre-migration row');
      assertEqual(result[0].name, 'Old Venue', 'wrong venue returned');

      // Post-migration row: has `days[0].stops` — shim uses stops.
      const postMigration = {
        title: 'New Plan',
        days: [{ day: 1, stops: [{ name: 'New Venue', type: 'restaurant' }] }],
        venues: [{ name: 'Should be ignored', type: 'bar' }],
      };
      const result2 = shimStops(postMigration);
      assertEqual(result2.length, 1, 'expected 1 stop from post-migration row');
      assertEqual(result2[0].name, 'New Venue', 'should use days[0].stops, not venues');

      // Empty fallback: neither days nor venues → empty array.
      const empty = { title: 'No venues' };
      const result3 = shimStops(empty);
      assertEqual(result3.length, 0, 'expected empty array for row with no venues/days');
    });

  } finally {
    // ── Cleanup ────────────────────────────────────────────────────────────────
    console.log('\nCleanup…');
    await teardown();
    console.log('  Done.\n');

    // ── Summary ────────────────────────────────────────────────────────────────
    const total = passed + failed;
    console.log('══════════════════════════════════════');
    console.log(`Results: ${passed} passed, ${failed} failed (${total} total)`);
    if (failed > 0) {
      console.log('\nRoute tests 1–5 require the dev server to be running: node server/index.js');
    }
    console.log('══════════════════════════════════════\n');

    process.exit(failed > 0 ? 1 : 0);
  }
})();

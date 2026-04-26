'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendFounderFriendRequest } = require('./founderFriend');

const originalFounderId = process.env.FOUNDER_USER_ID;
test.afterEach(() => {
  if (originalFounderId === undefined) delete process.env.FOUNDER_USER_ID;
  else process.env.FOUNDER_USER_ID = originalFounderId;
});

const FOUNDER = '11111111-1111-1111-1111-111111111111';
const TARGET  = '22222222-2222-2222-2222-222222222222';

function makeFakeSupabase(state) {
  state.profiles      = state.profiles      || [];
  state.friendships   = state.friendships   || [];
  state.notifications = state.notifications || [];

  function from(table) {
    const filters = [];
    const builder = {
      select() { return builder; },
      eq(col, val) { filters.push((r) => r[col] === val); return builder; },
      not(col, op, val) {
        if (op === 'is' && val === null) filters.push((r) => r[col] != null);
        else if (op === 'is') filters.push((r) => r[col] !== val);
        else throw new Error(`fake supabase: unsupported not(${op})`);
        return builder;
      },
      is(col, val) {
        if (val === null) filters.push((r) => r[col] == null);
        else filters.push((r) => r[col] === val);
        return builder;
      },
      maybeSingle() {
        const rows = state[table].filter(r => filters.every(f => f(r)));
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      single() {
        const rows = state[table].filter(r => filters.every(f => f(r)));
        if (rows.length === 0) return Promise.resolve({ data: null, error: { message: 'not found' } });
        return Promise.resolve({ data: rows[0], error: null });
      },
      // Awaiting the builder directly (no .single/.maybeSingle) returns the filtered list.
      then(onResolve, onReject) {
        const rows = state[table].filter(r => filters.every(f => f(r)));
        return Promise.resolve({ data: rows, error: null }).then(onResolve, onReject);
      },
      insert(row) {
        const rows = Array.isArray(row) ? row : [row];
        rows.forEach(r => state[table].push({ ...r }));
        return Promise.resolve({ data: null, error: null });
      },
      update(updates) {
        const f0 = [...filters];
        return {
          eq(col, val) {
            const all = [...f0, (r) => r[col] === val];
            state[table].forEach(r => {
              if (all.every(f => f(r))) Object.assign(r, updates);
            });
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };
    return builder;
  }
  return { from };
}

test('returns skipped when FOUNDER_USER_ID is unset', async () => {
  delete process.env.FOUNDER_USER_ID;
  const supabase = makeFakeSupabase({});
  const result = await sendFounderFriendRequest(supabase, TARGET);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no_founder_configured');
});

test('returns skipped when target is the founder', async () => {
  process.env.FOUNDER_USER_ID = FOUNDER;
  const supabase = makeFakeSupabase({});
  const result = await sendFounderFriendRequest(supabase, FOUNDER);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'target_is_founder');
});

test('returns skipped when welcome_friend_request_sent_at is already set', async () => {
  process.env.FOUNDER_USER_ID = FOUNDER;
  const supabase = makeFakeSupabase({
    profiles: [{ id: TARGET, welcome_friend_request_sent_at: '2026-01-01T00:00:00Z' }],
  });
  const result = await sendFounderFriendRequest(supabase, TARGET);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'already_sent');
});

test('returns skipped when friendship exists founder -> target', async () => {
  process.env.FOUNDER_USER_ID = FOUNDER;
  const supabase = makeFakeSupabase({
    profiles:    [{ id: TARGET, welcome_friend_request_sent_at: null }],
    friendships: [{ id: 'f1', user_id: FOUNDER, friend_id: TARGET, status: 'pending' }],
  });
  const result = await sendFounderFriendRequest(supabase, TARGET);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'friendship_exists');
});

test('returns skipped when friendship exists target -> founder', async () => {
  process.env.FOUNDER_USER_ID = FOUNDER;
  const supabase = makeFakeSupabase({
    profiles:    [{ id: TARGET, welcome_friend_request_sent_at: null }],
    friendships: [{ id: 'f1', user_id: TARGET, friend_id: FOUNDER, status: 'accepted' }],
  });
  const result = await sendFounderFriendRequest(supabase, TARGET);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'friendship_exists');
});

test('returns skipped when blocked friendship exists in either direction', async () => {
  process.env.FOUNDER_USER_ID = FOUNDER;
  const supabase = makeFakeSupabase({
    profiles:    [{ id: TARGET, welcome_friend_request_sent_at: null }],
    friendships: [{ id: 'f1', user_id: TARGET, friend_id: FOUNDER, status: 'blocked' }],
  });
  const result = await sendFounderFriendRequest(supabase, TARGET);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'friendship_exists');
});

test('happy path: inserts pending friendship, sets timestamp, returns sent', async () => {
  process.env.FOUNDER_USER_ID = FOUNDER;
  const state = {
    profiles:    [{ id: TARGET, welcome_friend_request_sent_at: null, notification_settings: {} }],
    friendships: [],
  };
  const supabase = makeFakeSupabase(state);

  const result = await sendFounderFriendRequest(supabase, TARGET);

  assert.equal(result.status, 'sent');
  assert.equal(state.friendships.length, 1);
  assert.deepEqual(
    { user_id: state.friendships[0].user_id, friend_id: state.friendships[0].friend_id, status: state.friendships[0].status },
    { user_id: FOUNDER, friend_id: TARGET, status: 'pending' },
  );
  assert.ok(state.profiles[0].welcome_friend_request_sent_at, 'timestamp was set');
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].user_id, TARGET);
  assert.equal(state.notifications[0].type, 'friend_request');
});

test('happy path: notification dispatch failure does not roll back friendship', async () => {
  process.env.FOUNDER_USER_ID = FOUNDER;
  const state = {
    profiles:    [{ id: TARGET, welcome_friend_request_sent_at: null, notification_settings: {} }],
    friendships: [],
  };
  const supabase = makeFakeSupabase(state);
  // Make the notifications insert blow up.
  const originalFrom = supabase.from.bind(supabase);
  supabase.from = (t) => {
    if (t === 'notifications') {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        single() { return Promise.resolve({ data: null, error: null }); },
        insert() { throw new Error('notifications insert exploded'); },
      };
    }
    return originalFrom(t);
  };

  const result = await sendFounderFriendRequest(supabase, TARGET);

  assert.equal(result.status, 'sent');
  assert.equal(state.friendships.length, 1, 'friendship still inserted');
  assert.ok(state.profiles[0].welcome_friend_request_sent_at, 'timestamp still set');
});

const { backfillFounderRequests } = require('./founderFriend');

test('backfill: counts sent, skipped, failed correctly across mixed batch', async () => {
  process.env.FOUNDER_USER_ID = FOUNDER;
  const T1 = '33333333-3333-3333-3333-333333333333';
  const T2 = '44444444-4444-4444-4444-444444444444';
  const T3 = '55555555-5555-5555-5555-555555555555';
  const T4 = '66666666-6666-6666-6666-666666666666';
  const state = {
    profiles: [
      // T1 is eligible (will be sent)
      { id: T1, onboarding_completed_at: '2026-01-01', welcome_friend_request_sent_at: null, notification_settings: {} },
      // T2 already had request sent — should be excluded by query, not even visited
      { id: T2, onboarding_completed_at: '2026-01-01', welcome_friend_request_sent_at: '2026-02-01' },
      // T3 has not completed onboarding — excluded by query
      { id: T3, onboarding_completed_at: null, welcome_friend_request_sent_at: null },
      // T4 is eligible per query but already has a friendship row (will be skipped by guard)
      { id: T4, onboarding_completed_at: '2026-01-01', welcome_friend_request_sent_at: null, notification_settings: {} },
      // Founder profile — would be excluded if it appeared, but test that the guard catches it
      { id: FOUNDER, onboarding_completed_at: '2026-01-01', welcome_friend_request_sent_at: null, notification_settings: {} },
    ],
    friendships: [
      { id: 'pre1', user_id: FOUNDER, friend_id: T4, status: 'accepted' },
    ],
  };
  const supabase = makeFakeSupabase(state);

  const result = await backfillFounderRequests(supabase);

  assert.equal(result.sent, 1, 'one user (T1) gets the request');
  assert.equal(result.skipped, 2, 'T4 (existing friendship) and FOUNDER (target_is_founder) are skipped');
  assert.equal(result.failed, 0);
  assert.equal(state.friendships.length, 2, 'one new friendship added');
  assert.equal(state.friendships[1].friend_id, T1);
});

test('backfill: returns 0/0/0 when no eligible profiles', async () => {
  process.env.FOUNDER_USER_ID = FOUNDER;
  const supabase = makeFakeSupabase({ profiles: [], friendships: [] });
  const result = await backfillFounderRequests(supabase);
  assert.deepEqual(
    { sent: result.sent, skipped: result.skipped, failed: result.failed },
    { sent: 0, skipped: 0, failed: 0 },
  );
});

test('backfill: skips entirely when FOUNDER_USER_ID is unset', async () => {
  delete process.env.FOUNDER_USER_ID;
  const state = {
    profiles: [
      { id: TARGET, onboarding_completed_at: '2026-01-01', welcome_friend_request_sent_at: null },
    ],
    friendships: [],
  };
  const supabase = makeFakeSupabase(state);
  const result = await backfillFounderRequests(supabase);
  assert.equal(result.sent, 0);
  assert.equal(state.friendships.length, 0);
});

test('happy path: insert failure leaves timestamp untouched (no permanent lockout)', async () => {
  process.env.FOUNDER_USER_ID = FOUNDER;
  const state = {
    profiles:    [{ id: TARGET, welcome_friend_request_sent_at: null, notification_settings: {} }],
    friendships: [],
  };
  const supabase = makeFakeSupabase(state);
  // Make the friendships insert fail.
  const originalFrom = supabase.from.bind(supabase);
  supabase.from = (t) => {
    if (t === 'friendships') {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert() { return Promise.resolve({ data: null, error: { message: 'simulated insert failure' } }); },
      };
    }
    return originalFrom(t);
  };

  const result = await sendFounderFriendRequest(supabase, TARGET);

  assert.equal(result.status, 'failed');
  assert.equal(state.friendships.length, 0, 'no friendship row inserted');
  assert.equal(state.profiles[0].welcome_friend_request_sent_at, null, 'timestamp NOT set — user can be retried');
});

module.exports = { makeFakeSupabase, FOUNDER, TARGET };

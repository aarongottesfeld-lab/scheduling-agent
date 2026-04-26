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

// Minimal fake Supabase client. Each test builds its own state.
// Supports the methods sendFounderFriendRequest needs:
//   from(t).select(c).eq(col, val).maybeSingle()
//   from(t).select(c).eq(col, val).single()
//   from(t).insert(row)
//   from(t).update(updates).eq(col, val)
function makeFakeSupabase(state) {
  state.profiles      = state.profiles      || [];
  state.friendships   = state.friendships   || [];
  state.notifications = state.notifications || [];

  function from(table) {
    let filters = [];
    return {
      select() { return this; },
      eq(col, val) { filters.push({ col, val }); return this; },
      maybeSingle() {
        const rows = state[table].filter(r => filters.every(f => r[f.col] === f.val));
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      single() {
        const rows = state[table].filter(r => filters.every(f => r[f.col] === f.val));
        if (rows.length === 0) return Promise.resolve({ data: null, error: { message: 'not found' } });
        return Promise.resolve({ data: rows[0], error: null });
      },
      insert(row) {
        const rows = Array.isArray(row) ? row : [row];
        rows.forEach(r => state[table].push({ ...r }));
        return Promise.resolve({ data: null, error: null });
      },
      update(updates) {
        const f0 = filters;
        return {
          eq(col, val) {
            const all = [...f0, { col, val }];
            state[table].forEach(r => {
              if (all.every(f => r[f.col] === f.val)) Object.assign(r, updates);
            });
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };
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

module.exports = { makeFakeSupabase, FOUNDER, TARGET };

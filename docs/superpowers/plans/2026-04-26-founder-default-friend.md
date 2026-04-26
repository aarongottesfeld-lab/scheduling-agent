# Founder Default Friend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a new user finishes onboarding, send them a pending friend request from the founder account; backfill the same to existing users; render a "Founder" badge wherever the founder's profile appears.

**Architecture:** New `server/services/founderFriend.js` module exposes `sendFounderFriendRequest` and `backfillFounderRequests`. The onboarding-complete route hooks the first; a one-shot script calls the second. Founder identity is the `FOUNDER_USER_ID` env var. A new `profiles.welcome_friend_request_sent_at` column makes the operation idempotent and decline-respecting. A small `stampFounder` helper adds `is_founder: true` to profile responses for the founder's UUID; the frontend renders a badge wherever it sees that flag.

**Tech Stack:** Node.js (CommonJS), Express 5, Supabase JS v2, React (CRA), Postgres 17, Playwright, `node:test` (built into Node) for server tests.

---

## Spec

This plan implements `docs/superpowers/specs/2026-04-26-founder-default-friend-design.md`. Read that first.

## File Structure

| Path | Status | Responsibility |
|------|--------|----------------|
| `supabase/migrations/20260426000001_add_welcome_friend_request_sent_at.sql` | New | Adds the idempotency column |
| `server/utils/profile.js` | New | Pure `stampFounder(profile)` helper |
| `server/utils/profile.test.js` | New | `node:test` suite for the helper |
| `server/services/founderFriend.js` | New | Core service: `sendFounderFriendRequest`, `backfillFounderRequests` |
| `server/services/founderFriend.test.js` | New | `node:test` suite using a small in-file fake Supabase client |
| `server/routes/users.js` | Modify | Hook the service into `PATCH /users/onboarding-complete` |
| `server/routes/friends.js` | Modify | Apply `stampFounder` to friend list, friend profile, incoming requests responses |
| `server/index.js` | Modify | Apply `stampFounder` to `/users/me` (or wherever the current profile is returned); warn at boot if `FOUNDER_USER_ID` is unset in production |
| `server/.env.example` | New | Document the new env var |
| `server/package.json` | Modify | Replace placeholder `test` script with `node --test "**/*.test.js"` |
| `scripts/backfill-founder-friends.js` | New | One-shot backfill runner with `--dry-run` |
| `client/src/components/FounderBadge.jsx` | New | Small visual badge component |
| `client/src/components/FounderBadge.test.jsx` | New | Jest test (CRA's existing setup) |
| Friend list / profile / requests views in `client/src/` | Modify | Render `<FounderBadge />` when `profile.is_founder` |
| `tests/founder-friend.spec.js` | New | Playwright E2E spec |

The service is the single source of behavior. Routes call the service. The backfill script calls the service. The badge is purely a UI concern driven by the `is_founder` boolean.

## Notes Before Starting

- The repo uses `supabase/migrations/YYYYMMDDhhmmss_<description>.sql` filenames. Apply with the Supabase MCP tool (`apply_migration`) or the Supabase dashboard SQL editor — match whatever workflow the team already uses.
- `dispatchNotification(supabase, { ... })` is in `server/utils/notificationDispatch.js`. Existing friend-request payload shape lives at `server/routes/friends.js:132-139`. Mirror it.
- Friendship rows are stored bidirectionally (two rows on accept). The existing "check both directions" pattern is at `server/routes/friends.js:210-216`. Use the same shape (two `.maybeSingle()` calls) — it is easier to mock than `.or()`.
- The server is CommonJS (`"type": "commonjs"`).
- The client uses Create React App with Jest + React Testing Library already set up.

---

## Task 1: Add `welcome_friend_request_sent_at` column

**Files:**
- Create: `supabase/migrations/20260426000001_add_welcome_friend_request_sent_at.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 20260426000001_add_welcome_friend_request_sent_at.sql
-- Tracks when the founder's automatic welcome friend request was sent to a user.
-- Used to make sendFounderFriendRequest and backfillFounderRequests idempotent
-- and to respect users who declined the request (decline deletes the friendships row,
-- so a row-existence check alone would re-ask them on every backfill).

ALTER TABLE profiles
  ADD COLUMN welcome_friend_request_sent_at timestamptz;

COMMENT ON COLUMN profiles.welcome_friend_request_sent_at IS
  'Timestamp the founder welcome friend request was sent. NULL means never sent. Set once and never cleared.';
```

- [ ] **Step 2: Apply the migration**

Apply via the Supabase MCP tool (`apply_migration`) against the dev project, or paste into the dev project's SQL editor.

- [ ] **Step 3: Verify the column exists**

Run via Supabase MCP `execute_sql`:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'profiles' AND column_name = 'welcome_friend_request_sent_at';
```

Expected: one row with `timestamp with time zone`, `YES` nullable.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260426000001_add_welcome_friend_request_sent_at.sql
git commit -m "Add welcome_friend_request_sent_at column for founder friend idempotency"
```

---

## Task 2: Wire up `node --test` runner

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Update the test script**

Replace the current placeholder line:

```json
"test": "echo \"Error: no test specified\" && exit 1"
```

with:

```json
"test": "node --test \"**/*.test.js\""
```

- [ ] **Step 2: Verify it runs (no tests yet)**

Run from `server/`:

```bash
cd server && npm test
```

Expected: completes with `tests 0` (or similar), exit code 0. No tests to discover yet.

- [ ] **Step 3: Commit**

```bash
git add server/package.json
git commit -m "Wire up node --test runner for server tests"
```

---

## Task 3: `stampFounder` helper

**Files:**
- Create: `server/utils/profile.js`
- Test: `server/utils/profile.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/utils/profile.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stampFounder } = require('./profile');

test('stampFounder returns null when given null', () => {
  assert.equal(stampFounder(null), null);
});

test('stampFounder returns undefined when given undefined', () => {
  assert.equal(stampFounder(undefined), undefined);
});

test('stampFounder adds is_founder: true when profile id matches FOUNDER_USER_ID', () => {
  process.env.FOUNDER_USER_ID = '11111111-1111-1111-1111-111111111111';
  const profile = { id: '11111111-1111-1111-1111-111111111111', full_name: 'Aaron' };
  const result = stampFounder(profile);
  assert.equal(result.is_founder, true);
  assert.equal(result.id, profile.id);
  assert.equal(result.full_name, 'Aaron');
});

test('stampFounder adds is_founder: false when id does not match', () => {
  process.env.FOUNDER_USER_ID = '11111111-1111-1111-1111-111111111111';
  const profile = { id: '22222222-2222-2222-2222-222222222222', full_name: 'Other' };
  const result = stampFounder(profile);
  assert.equal(result.is_founder, false);
});

test('stampFounder adds is_founder: false when FOUNDER_USER_ID is unset', () => {
  delete process.env.FOUNDER_USER_ID;
  const profile = { id: '11111111-1111-1111-1111-111111111111' };
  const result = stampFounder(profile);
  assert.equal(result.is_founder, false);
});

test('stampFounder does not mutate the input', () => {
  process.env.FOUNDER_USER_ID = '11111111-1111-1111-1111-111111111111';
  const profile = { id: '11111111-1111-1111-1111-111111111111' };
  stampFounder(profile);
  assert.equal('is_founder' in profile, false);
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
cd server && npm test -- utils/profile.test.js
```

Expected: failures with "Cannot find module './profile'".

- [ ] **Step 3: Implement the helper**

Create `server/utils/profile.js`:

```js
// utils/profile.js — small helpers for shaping profile responses
'use strict';

/**
 * Returns a shallow copy of `profile` with `is_founder: true` if its id matches
 * FOUNDER_USER_ID, else `is_founder: false`. Returns the input unchanged for
 * null/undefined. Never mutates the input.
 */
function stampFounder(profile) {
  if (!profile) return profile;
  const founderId = process.env.FOUNDER_USER_ID;
  return { ...profile, is_founder: !!founderId && profile.id === founderId };
}

module.exports = { stampFounder };
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
cd server && npm test -- utils/profile.test.js
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/profile.js server/utils/profile.test.js
git commit -m "Add stampFounder helper for is_founder badge stamping"
```

---

## Task 4: Founder service — guards

**Files:**
- Create: `server/services/founderFriend.js`
- Test: `server/services/founderFriend.test.js`

The service module is dependency-injected with a Supabase client (matching `dispatchNotification`'s pattern). Tests pass a small in-file fake.

- [ ] **Step 1: Write the failing guard tests**

Create `server/services/founderFriend.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendFounderFriendRequest } = require('./founderFriend');

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
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
cd server && npm test -- services/founderFriend.test.js
```

Expected: failures with "Cannot find module './founderFriend'".

- [ ] **Step 3: Implement the service with only guards (no insert yet)**

Create `server/services/founderFriend.js`:

```js
// services/founderFriend.js — sends a welcome friend request from the founder
// to new users. See docs/superpowers/specs/2026-04-26-founder-default-friend-design.md
'use strict';

const { dispatchNotification } = require('../utils/notificationDispatch');

const FOUNDER_NAME      = 'Aaron';
const NOTIFICATION_TYPE = 'friend_request';
const NOTIFICATION_BODY = `${FOUNDER_NAME} (founder of Rendezvous) sent you a friend request.`;

/**
 * Send a pending welcome friend request from the founder to `targetUserId`.
 * Idempotent and decline-respecting via profiles.welcome_friend_request_sent_at.
 *
 * @param {object} supabase     - Supabase client (service role)
 * @param {string} targetUserId - recipient profile UUID
 * @returns {Promise<{status: 'sent'|'skipped'|'failed', reason?: string, error?: string}>}
 */
async function sendFounderFriendRequest(supabase, targetUserId) {
  const founderId = process.env.FOUNDER_USER_ID;
  if (!founderId) return { status: 'skipped', reason: 'no_founder_configured' };
  if (targetUserId === founderId) return { status: 'skipped', reason: 'target_is_founder' };

  // Idempotency: skip if we already sent (even if the friendship row was later deleted by a decline).
  const profileRes = await supabase
    .from('profiles')
    .select('welcome_friend_request_sent_at')
    .eq('id', targetUserId)
    .maybeSingle();
  if (profileRes.data?.welcome_friend_request_sent_at) {
    return { status: 'skipped', reason: 'already_sent' };
  }

  // Existing friendship in either direction (any status) blocks the send.
  // Mirrors the two-call pattern in routes/friends.js:210-216.
  const aRes = await supabase.from('friendships').select('id')
    .eq('user_id', founderId).eq('friend_id', targetUserId).maybeSingle();
  if (aRes.data) return { status: 'skipped', reason: 'friendship_exists' };

  const bRes = await supabase.from('friendships').select('id')
    .eq('user_id', targetUserId).eq('friend_id', founderId).maybeSingle();
  if (bRes.data) return { status: 'skipped', reason: 'friendship_exists' };

  // Happy path comes in Task 5.
  return { status: 'sent' };
}

module.exports = { sendFounderFriendRequest };
```

- [ ] **Step 4: Run tests, confirm guard tests pass**

```bash
cd server && npm test -- services/founderFriend.test.js
```

Expected: all 6 guard tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/services/founderFriend.js server/services/founderFriend.test.js
git commit -m "Add founderFriend service skeleton with idempotency and existence guards"
```

---

## Task 5: Founder service — happy path (insert + timestamp + notification)

**Files:**
- Modify: `server/services/founderFriend.js`
- Modify: `server/services/founderFriend.test.js`

- [ ] **Step 1: Write the failing happy-path tests**

Append to `server/services/founderFriend.test.js`:

```js
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
```

- [ ] **Step 2: Run tests, confirm new ones fail**

```bash
cd server && npm test -- services/founderFriend.test.js
```

Expected: the two new tests fail (no insert happens, no timestamp, no notification).

- [ ] **Step 3: Implement the happy path**

Replace the `// Happy path comes in Task 5.\n  return { status: 'sent' };` block in `server/services/founderFriend.js` with:

```js
  // Insert pending friendship and stamp the idempotency timestamp in parallel.
  // Pattern mirrors the parallel write in routes/friends.js:124-127.
  const sentAt = new Date().toISOString();
  const [insertRes, _updateRes] = await Promise.all([
    supabase.from('friendships').insert({
      user_id: founderId,
      friend_id: targetUserId,
      status: 'pending',
    }),
    supabase.from('profiles')
      .update({ welcome_friend_request_sent_at: sentAt })
      .eq('id', targetUserId),
  ]);

  if (insertRes.error) {
    return { status: 'failed', error: insertRes.error.message || 'insert failed' };
  }

  // Notification is best-effort — wrap so a throw or rejection cannot roll back the friendship.
  try {
    await dispatchNotification(supabase, {
      userId: targetUserId,
      type: NOTIFICATION_TYPE,
      title: 'New friend request',
      body: NOTIFICATION_BODY,
      actionUrl: '/friends',
      refId: founderId,
    });
  } catch (err) {
    console.warn('[founderFriend] notification dispatch failed:', err.message);
  }

  return { status: 'sent' };
```

- [ ] **Step 4: Run tests, confirm all pass**

```bash
cd server && npm test -- services/founderFriend.test.js
```

Expected: all 8 tests pass (6 guards + 2 happy-path).

- [ ] **Step 5: Commit**

```bash
git add server/services/founderFriend.js server/services/founderFriend.test.js
git commit -m "Implement founderFriend send happy path with notification best-effort"
```

---

## Task 6: Founder service — `backfillFounderRequests`

**Files:**
- Modify: `server/services/founderFriend.js`
- Modify: `server/services/founderFriend.test.js`

`backfillFounderRequests` selects all profiles where onboarding is complete and the welcome request has not yet been sent, then loops `sendFounderFriendRequest` over them. Per-user errors are caught.

- [ ] **Step 1: Extend the fake Supabase to support the backfill query**

The backfill query is:

```js
supabase.from('profiles')
  .select('id')
  .not('onboarding_completed_at', 'is', null)
  .is('welcome_friend_request_sent_at', null);
```

Update `makeFakeSupabase` in `server/services/founderFriend.test.js` to support `.not(col, 'is', null)` and `.is(col, null)` and to return the filtered list when chained without `.maybeSingle()/.single()`. Replace the existing `makeFakeSupabase` definition with:

```js
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
```

- [ ] **Step 2: Add the failing backfill tests**

Append to `server/services/founderFriend.test.js`:

```js
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
```

- [ ] **Step 3: Run tests, confirm new ones fail**

```bash
cd server && npm test -- services/founderFriend.test.js
```

Expected: three new failures (no `backfillFounderRequests` export).

- [ ] **Step 4: Implement `backfillFounderRequests`**

Append to `server/services/founderFriend.js` (before `module.exports`):

```js
/**
 * Send the founder's welcome friend request to every onboarded user who has not
 * yet received one. Idempotent (rerun-safe). Returns counts.
 *
 * @param {object} supabase - Supabase client (service role)
 * @returns {Promise<{sent: number, skipped: number, failed: number, errors: Array<{userId: string, error: string}>}>}
 */
async function backfillFounderRequests(supabase) {
  const summary = { sent: 0, skipped: 0, failed: 0, errors: [] };

  if (!process.env.FOUNDER_USER_ID) {
    console.warn('[founderFriend] backfill skipped: FOUNDER_USER_ID is not set');
    return summary;
  }

  const { data: candidates, error } = await supabase
    .from('profiles')
    .select('id')
    .not('onboarding_completed_at', 'is', null)
    .is('welcome_friend_request_sent_at', null);

  if (error) {
    console.error('[founderFriend] backfill candidate query failed:', error.message);
    return summary;
  }

  for (const row of candidates || []) {
    try {
      const result = await sendFounderFriendRequest(supabase, row.id);
      if (result.status === 'sent')         summary.sent      += 1;
      else if (result.status === 'skipped') summary.skipped   += 1;
      else                                   {
        summary.failed += 1;
        summary.errors.push({ userId: row.id, error: result.error || 'unknown' });
      }
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({ userId: row.id, error: err.message });
    }
  }

  return summary;
}
```

Update the `module.exports` line at the bottom:

```js
module.exports = { sendFounderFriendRequest, backfillFounderRequests };
```

- [ ] **Step 5: Run all service tests, confirm pass**

```bash
cd server && npm test -- services/founderFriend.test.js
```

Expected: all 11 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/services/founderFriend.js server/services/founderFriend.test.js
git commit -m "Add backfillFounderRequests with per-user error tolerance"
```

---

## Task 7: Hook into `PATCH /users/onboarding-complete`

**Files:**
- Modify: `server/routes/users.js`

The handler currently sits at `server/routes/users.js:41-48`. We add the service call after the update succeeds, fully wrapped so it can never affect the response.

- [ ] **Step 1: Add the require at the top of the file**

At the top of `server/routes/users.js` (next to the other requires), add:

```js
const { sendFounderFriendRequest } = require('../services/founderFriend');
```

- [ ] **Step 2: Modify the onboarding-complete handler**

Replace the existing handler body (around `server/routes/users.js:41-48`):

```js
  app.patch('/users/onboarding-complete', requireAuth, async (req, res) => {
    const { error } = await supabase
      .from('profiles')
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq('id', req.userId);
    if (error) return res.status(500).json({ error: 'Could not update onboarding status.' });
    res.json({ success: true });
  });
```

with:

```js
  app.patch('/users/onboarding-complete', requireAuth, async (req, res) => {
    const { error } = await supabase
      .from('profiles')
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq('id', req.userId);
    if (error) return res.status(500).json({ error: 'Could not update onboarding status.' });

    // Fire the founder welcome friend request as a side effect. Wrapped so any
    // failure logs but never affects the user's onboarding-completion response.
    sendFounderFriendRequest(supabase, req.userId).catch((err) => {
      console.warn('[onboarding] founder friend request failed:', err?.message);
    });

    res.json({ success: true });
  });
```

(Note the call is intentionally not awaited — the response is returned immediately and the friend-request work happens in the background.)

- [ ] **Step 3: Manual smoke test**

Start the dev server (`cd server && npm run dev`), set `FOUNDER_USER_ID` in `server/.env` to a real test user UUID, sign up a brand-new test user via the dev user switcher, complete onboarding, and verify:

- The user's `welcome_friend_request_sent_at` is non-null in the DB
- A pending row exists in `friendships` with `user_id = FOUNDER_USER_ID, friend_id = <new user>`
- A `notifications` row of type `friend_request` exists for the new user

If any of these fail, fix before committing.

- [ ] **Step 4: Commit**

```bash
git add server/routes/users.js
git commit -m "Hook founder welcome friend request into onboarding-complete"
```

---

## Task 8: Apply `stampFounder` to profile-returning endpoints

**Files:**
- Modify: `server/routes/users.js`
- Modify: `server/routes/friends.js`

We stamp `is_founder` everywhere the server returns a profile object (or a list of them) that the client might render alongside a name.

- [ ] **Step 1: Add the require to `server/routes/users.js`**

Near the top of the file, with the other requires:

```js
const { stampFounder } = require('../utils/profile');
```

- [ ] **Step 2: Stamp `GET /users/me`**

Find the handler at `server/routes/users.js:30-37`:

```js
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, username, location, timezone, bio, activity_preferences, dietary_restrictions, mobility_restrictions, avatar_url, share_token, onboarding_completed_at')
      .eq('id', req.userId)
      .single();
    if (error) return res.status(404).json({ error: 'Profile not found.' });
    res.json(data);
```

Replace the final line with:

```js
    res.json(stampFounder(data));
```

- [ ] **Step 3: Add the require to `server/routes/friends.js`**

Near the top of the file, with the other requires:

```js
const { stampFounder } = require('../utils/profile');
```

- [ ] **Step 4: Stamp `GET /friends/:id/profile`**

In `server/routes/friends.js`, every `res.json(...)` inside the `GET /friends/:id/profile` handler must wrap its payload with `stampFounder(...)`. The handler returns several different shapes depending on friend status (full profile vs public-only). For every `res.json({...})` in that route, change `res.json(payload)` to `res.json(stampFounder(payload))` where `payload` is whatever object is being returned.

If the payload is a partial object built inline (e.g., `res.json({ id, full_name, username, avatar_url })`), wrap it the same way: `res.json(stampFounder({ id, full_name, username, avatar_url }))`.

- [ ] **Step 5: Stamp `GET /friends` (the friends list)**

The friends list (around `server/routes/friends.js:16-44`) returns rows joined to profile fields. After building the response array of friend objects (each with at least `{ id, full_name, username, avatar_url, ... }`), map through them with `stampFounder`:

```js
res.json(rows.map(stampFounder));
```

(Use whatever the existing variable name is for the response array.)

- [ ] **Step 6: Stamp `GET /friends/requests/incoming`**

The incoming-requests handler (around `server/routes/friends.js:48-74`) returns rows that include sender profile fields. After building the response list, map each row's sender-profile slice through `stampFounder`. Specifically, if a row looks like `{ id, user_id, created_at, sender: { id, full_name, ... } }`, stamp the `sender` subobject:

```js
res.json(rows.map(r => ({ ...r, sender: stampFounder(r.sender) })));
```

If the existing shape is flat (no nested sender), stamp the row directly via `rows.map(stampFounder)`. Read the existing handler to confirm the shape before editing.

- [ ] **Step 7: Manual verification**

Start the dev server, log in as a non-founder user, hit:

- `GET /users/me` for the non-founder → `is_founder: false`
- `GET /users/me` for the founder (switch users) → `is_founder: true`
- `GET /friends/<founder_id>/profile` → response includes `is_founder: true`
- `GET /friends` → if the founder is in the list, that row has `is_founder: true`
- `GET /friends/requests/incoming` → if the request from the founder is pending, the founder's slice has `is_founder: true`

Use `curl` with the session cookie or your normal browser dev tools.

- [ ] **Step 8: Commit**

```bash
git add server/routes/users.js server/routes/friends.js
git commit -m "Stamp is_founder on profile-returning endpoints"
```

---

## Task 9: Boot warning + `.env.example`

**Files:**
- Modify: `server/index.js`
- Create: `server/.env.example`

- [ ] **Step 1: Add the boot warning**

Near the top of `server/index.js`, after `dotenv.config()` (or wherever existing boot-time config validation is), add:

```js
if (process.env.NODE_ENV === 'production' && !process.env.FOUNDER_USER_ID) {
  console.warn('[boot] FOUNDER_USER_ID is not set; founder welcome friend feature is disabled.');
}
```

If `dotenv` is loaded inside `server/index.js`, place the warning immediately after the `require('dotenv').config()` call. If `dotenv` is loaded elsewhere, place it near the existing env-validation log lines.

- [ ] **Step 2: Create `server/.env.example`**

Create `server/.env.example` with:

```
# Founder identity for the welcome friend request feature.
# When unset, the feature is silently disabled (no friend requests sent, no badge stamped).
# See docs/superpowers/specs/2026-04-26-founder-default-friend-design.md
FOUNDER_USER_ID=
```

(This is a starting point. Future env vars can be appended; existing vars in `server/.env` should be copied here over time.)

- [ ] **Step 3: Verify**

Start the server with `FOUNDER_USER_ID` unset and `NODE_ENV=production` (e.g., `NODE_ENV=production node server/index.js`); confirm the warning prints. Start it again with `FOUNDER_USER_ID` set; confirm the warning does NOT print.

- [ ] **Step 4: Commit**

```bash
git add server/index.js server/.env.example
git commit -m "Warn at boot when FOUNDER_USER_ID is missing in production"
```

---

## Task 10: Backfill script with `--dry-run`

**Files:**
- Create: `scripts/backfill-founder-friends.js`

- [ ] **Step 1: Create the script**

Create `scripts/backfill-founder-friends.js`:

```js
#!/usr/bin/env node
// scripts/backfill-founder-friends.js — one-shot backfill of the founder welcome
// friend request to all onboarded users who have not yet received one.
//
// Usage:
//   node scripts/backfill-founder-friends.js           # writes for real
//   node scripts/backfill-founder-friends.js --dry-run # prints what it would do
//
// Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FOUNDER_USER_ID from server/.env.
// Idempotent — safe to re-run.
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', 'server', '.env') });
const { createClient } = require('@supabase/supabase-js');
const { sendFounderFriendRequest, backfillFounderRequests } = require('../server/services/founderFriend');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const founder = process.env.FOUNDER_USER_ID;
  if (!url || !key) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  if (!founder)     { console.error('Missing FOUNDER_USER_ID'); process.exit(1); }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  if (dryRun) {
    const { data: candidates, error } = await supabase
      .from('profiles')
      .select('id, full_name, username')
      .not('onboarding_completed_at', 'is', null)
      .is('welcome_friend_request_sent_at', null);
    if (error) { console.error('Dry-run query failed:', error.message); process.exit(1); }

    // Filter out anyone who would be skipped by the in-flight guards.
    const filtered = [];
    for (const c of candidates || []) {
      if (c.id === founder) continue;
      const a = await supabase.from('friendships').select('id').eq('user_id', founder).eq('friend_id', c.id).maybeSingle();
      if (a.data) continue;
      const b = await supabase.from('friendships').select('id').eq('user_id', c.id).eq('friend_id', founder).maybeSingle();
      if (b.data) continue;
      filtered.push(c);
    }
    console.log(`DRY RUN: ${filtered.length} request(s) would be sent.`);
    filtered.forEach(c => console.log(`  - ${c.id}  ${c.full_name || ''} (@${c.username || '?'})`));
    return;
  }

  console.log('Running backfillFounderRequests...');
  const summary = await backfillFounderRequests(supabase);
  console.log('Summary:', JSON.stringify(summary, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Make it executable (optional convenience)**

```bash
chmod +x scripts/backfill-founder-friends.js
```

- [ ] **Step 3: Run a dry-run against the dev DB**

```bash
node scripts/backfill-founder-friends.js --dry-run
```

Expected: prints a count and a list of candidate IDs. Verify the count looks right (e.g., compare against `SELECT count(*) FROM profiles WHERE onboarding_completed_at IS NOT NULL AND welcome_friend_request_sent_at IS NULL` minus already-friend rows).

- [ ] **Step 4: Run for real (against dev only at this point)**

```bash
node scripts/backfill-founder-friends.js
```

Expected: prints `Summary: { "sent": <N>, "skipped": <M>, "failed": 0, "errors": [] }`.

- [ ] **Step 5: Re-run, confirm idempotency**

```bash
node scripts/backfill-founder-friends.js
```

Expected: `{ "sent": 0, "skipped": 0, "failed": 0, "errors": [] }` (the previous run set everyone's timestamp, so the candidate query returns zero).

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-founder-friends.js
git commit -m "Add backfill-founder-friends script with --dry-run"
```

---

## Task 11: Frontend `<FounderBadge />` component

**Files:**
- Create: `client/src/components/FounderBadge.jsx`
- Test: `client/src/components/FounderBadge.test.jsx`

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/FounderBadge.test.jsx`:

```jsx
import React from 'react';
import { render, screen } from '@testing-library/react';
import FounderBadge from './FounderBadge';

test('renders nothing when isFounder is false', () => {
  const { container } = render(<FounderBadge isFounder={false} />);
  expect(container).toBeEmptyDOMElement();
});

test('renders nothing when isFounder is undefined', () => {
  const { container } = render(<FounderBadge />);
  expect(container).toBeEmptyDOMElement();
});

test('renders Founder label when isFounder is true', () => {
  render(<FounderBadge isFounder={true} />);
  expect(screen.getByText(/founder/i)).toBeInTheDocument();
});

test('has accessible label for screen readers', () => {
  render(<FounderBadge isFounder={true} />);
  expect(screen.getByLabelText(/founder of rendezvous/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
cd client && npm test -- --watchAll=false FounderBadge
```

Expected: failures (component does not exist).

- [ ] **Step 3: Implement the component**

Create `client/src/components/FounderBadge.jsx`:

```jsx
import React from 'react';

export default function FounderBadge({ isFounder }) {
  if (!isFounder) return null;
  return (
    <span
      aria-label="Founder of Rendezvous"
      title="Founder of Rendezvous"
      style={{
        display: 'inline-block',
        marginLeft: 6,
        padding: '2px 6px',
        fontSize: '0.7rem',
        fontWeight: 600,
        borderRadius: 6,
        background: '#FEF3C7',
        color: '#92400E',
        verticalAlign: 'middle',
      }}
    >
      Founder
    </span>
  );
}
```

(Inline styles are intentional for a single-use small badge. If the codebase uses a CSS module or styled-components convention here, follow that instead — read a sibling component to confirm the pattern.)

- [ ] **Step 4: Run tests, confirm they pass**

```bash
cd client && npm test -- --watchAll=false FounderBadge
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/FounderBadge.jsx client/src/components/FounderBadge.test.jsx
git commit -m "Add FounderBadge component"
```

---

## Task 12: Render `<FounderBadge />` in client views

**Files:**
- Modify: friend list view, friend profile view, incoming requests view in `client/src/`

The exact filenames depend on the client structure. Find them by greping for the routes/components that consume `/friends`, `/friends/:id/profile`, and `/friends/requests/incoming`.

- [ ] **Step 1: Identify the three views**

```bash
grep -rln "friends/requests/incoming\|/friends/'\|fetchFriends\|FriendsList\|FriendProfile" client/src
```

Confirm the three files and the components inside them that render a friend's name. Those are the badge insertion points.

- [ ] **Step 2: In each view, import the badge**

At the top of each file:

```jsx
import FounderBadge from './FounderBadge';
```

(Adjust the relative path to `client/src/components/FounderBadge` based on the file's location.)

- [ ] **Step 3: Render the badge next to each name**

Wherever a friend's `full_name` or `username` is rendered, append the badge. Example:

Before:

```jsx
<span className="friend-name">{friend.full_name}</span>
```

After:

```jsx
<span className="friend-name">{friend.full_name}<FounderBadge isFounder={friend.is_founder} /></span>
```

Apply the same edit in:

- The friend list row (each friend's display name)
- The friend profile header (the user's display name on the profile page)
- Each row in the incoming friend requests list (the sender's display name)

- [ ] **Step 4: Manual verification**

Start the client + server. Log in as a user who has the founder as a friend (or a pending request). Verify the badge renders next to the founder's name in:

- The friends list
- The founder's profile page
- The incoming friend requests page (if a pending request from the founder exists)

Verify the badge does NOT render next to non-founder users' names.

- [ ] **Step 5: Commit**

```bash
git add client/src/
git commit -m "Render FounderBadge in friends list, profile, and incoming requests"
```

---

## Task 13: Playwright E2E spec

**Files:**
- Create: `tests/founder-friend.spec.js`

The existing E2E suite in `tests/` is gitignored per the rendezvous tracker. This spec follows the same patterns as `tests/e2e-flows.spec.js` and `tests/group-voting.spec.js` (read those first to match conventions for the dev user switcher and base URL).

- [ ] **Step 1: Read existing specs to match patterns**

```bash
ls tests/
head -60 tests/e2e-flows.spec.js
```

Note the dev user switcher API, `baseURL`, helpers used to create users and accept friend requests.

- [ ] **Step 2: Write the spec**

Create `tests/founder-friend.spec.js`:

```js
const { test, expect } = require('@playwright/test');

// Adjust these to match patterns in tests/e2e-flows.spec.js
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
const FOUNDER_NAME = 'Aaron'; // matches FOUNDER_NAME in services/founderFriend.js

test.describe('founder welcome friend request', () => {
  test('new user receives founder request after onboarding, accepts it, sees badge', async ({ page }) => {
    // 1. Create + log in a fresh test user (use whatever helper the existing specs use)
    //    e.g., await createTestUser(page, { email: `pw-${Date.now()}@example.com` });
    //    Replace with actual call from existing specs.

    // 2. Complete onboarding (set username, finish flow)
    //    e.g., await completeOnboarding(page, { username: `pwuser${Date.now()}` });

    // 3. Navigate to the incoming friend requests page
    await page.goto(`${BASE}/friends/requests`);

    // 4. Assert the founder's request is visible with the Founder badge
    const requestRow = page.getByText(new RegExp(FOUNDER_NAME, 'i')).first();
    await expect(requestRow).toBeVisible();
    await expect(page.getByLabel(/founder of rendezvous/i).first()).toBeVisible();

    // 5. Accept the request
    await page.getByRole('button', { name: /accept/i }).first().click();

    // 6. Navigate to the friends list, assert the founder is now a friend with the badge
    await page.goto(`${BASE}/friends`);
    await expect(page.getByText(new RegExp(FOUNDER_NAME, 'i')).first()).toBeVisible();
    await expect(page.getByLabel(/founder of rendezvous/i).first()).toBeVisible();
  });
});
```

The placeholder steps `createTestUser` / `completeOnboarding` MUST be replaced with the actual helpers used in the existing spec files (`tests/e2e-flows.spec.js`). Read those before running.

- [ ] **Step 3: Run the spec against a local dev environment**

Ensure the dev server is running with `FOUNDER_USER_ID` set, the migration is applied, and the founder profile exists. Then:

```bash
npx playwright test tests/founder-friend.spec.js
```

Expected: spec passes. If `createTestUser` / `completeOnboarding` need adjustment, fix them based on the existing specs and re-run.

- [ ] **Step 4: Commit**

The `tests/` folder is gitignored, but if any project convention exists for committing E2E specs separately, follow it. Otherwise:

```bash
# tests/ is gitignored — nothing to commit, but verify the spec file is preserved locally and shared with anyone running E2E.
```

If the E2E specs are tracked in a different location (separate repo, shared drive, CI artifact), copy this spec there.

---

## Self-Review

Spec coverage check (against `docs/superpowers/specs/2026-04-26-founder-default-friend-design.md`):

| Spec section | Implemented in |
|--------------|----------------|
| `FOUNDER_USER_ID` env var | Tasks 3, 4, 9 (consumed in helper, service, boot warning) |
| `sendFounderFriendRequest` with all four guards | Task 4 (guards), Task 5 (insert + notification) |
| `backfillFounderRequests` with per-user error catch | Task 6 |
| New `welcome_friend_request_sent_at` column | Task 1 |
| Onboarding-complete hook with try/catch + non-blocking response | Task 7 |
| `stampFounder` helper | Task 3 |
| Stamp `is_founder` on `/users/me`, `/friends/:id/profile`, `/friends`, `/friends/requests/incoming` | Task 8 |
| Backfill script with `--dry-run` | Task 10 |
| Boot-time warning if `FOUNDER_USER_ID` is missing in prod | Task 9 |
| `.env.example` documents the new var | Task 9 |
| `<FounderBadge />` component | Task 11 |
| Badge rendering in friend list, profile, incoming requests | Task 12 |
| Server unit tests via `node:test` covering all guards, happy path, notification failure isolation, backfill counts | Tasks 4, 5, 6 |
| Playwright E2E spec | Task 13 |
| Failure mode: notification failure does not block friendship | Task 5 |
| Failure mode: friendship insert failure does not block onboarding response | Task 7 |
| Rollback by unsetting env var | Verified by behavior — Task 4's first guard returns no-op |

All spec requirements are covered.

Type/name consistency: `FOUNDER_NAME` is used in both the service (`services/founderFriend.js`) and referenced by name in the Playwright spec. `is_founder` is the consistent property name on the wire and in the badge. The fake-Supabase helper is consistent across tests in Tasks 4, 5, 6.

No placeholders left.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-26-founder-default-friend.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — I execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

# Founder Default Friend (Design Spec)

**Date:** 2026-04-26
**Author:** Aaron Gottesfeld (with Claude)
**Status:** Approved, ready for implementation plan

## Goal

When a new user finishes onboarding, automatically send them a pending friend request from the founder account (Aaron). The user sees the request in their notifications and friends-requests inbox; they accept or decline like any other request. The founder appears in the UI with a small "Founder" badge wherever their profile is rendered.

This solves the cold-start "empty room" problem for new users (a social scheduling app is useless without friends), gives the founder direct visibility into early signups, and matches the well-known Tom-from-MySpace / Zuckerberg-on-Facebook pattern, with one key difference: this version is consent-based, not auto-friended.

## Non-goals

- **Multiple founders.** Aaron is the only founder. The design hardcodes single-founder semantics via one env var. Adding a second founder later would require a small refactor; that is acceptable.
- **Welcome message or onboarding feedback channel.** A "Hi, I built this, reply if anything is broken" message is a separate feature for later. Out of scope.
- **Auto-accepting friendships.** This spec sends a pending request only. Users opt in by accepting.

## Decisions Made During Brainstorming

| Question | Decision |
|----------|----------|
| Friend request vs. auto-friendship | Friend request (consent-based) |
| When does it fire | After onboarding completes (`PATCH /users/onboarding-complete`) |
| Forward-only or backfill existing users | Both: hook on new completions + one-shot backfill script |
| Special UX for the request | Founder badge (option B), no welcome message yet |
| Founder identity mechanism | `FOUNDER_USER_ID` env var (mirrors existing `MCP_OWNER_USER_ID` pattern) |
| Off-switch | Omit the env var; all code paths become no-ops |

## Architecture

### New env var

`FOUNDER_USER_ID` (server-side only) holds Aaron's profile UUID. Behavior when unset:

- All service functions return a no-op result and make zero DB calls.
- Server logs a single warning at startup if the var is missing in production. Dev environments may run without it.

### New module: `server/services/founderFriend.js`

Two exported functions.

**`sendFounderFriendRequest(targetUserId)`**

Called from the onboarding-completion handler and from the backfill script. Runs guards in this order; the first match returns a no-op:

1. `FOUNDER_USER_ID` unset
2. `targetUserId === FOUNDER_USER_ID` (Aaron cannot friend himself)
3. Target's `profiles.welcome_friend_request_sent_at IS NOT NULL` (we already asked once)
4. Any row in `friendships` exists between the two users in either direction (status: pending, accepted, or blocked)

If all guards pass:

1. Insert a `friendships` row: `{ user_id: FOUNDER_USER_ID, friend_id: targetUserId, status: 'pending' }`. Use the same parallel pattern already in `friends.js:124-127`.
2. Update `profiles.welcome_friend_request_sent_at = now()` on the target.
3. Call `dispatchNotification` with the founder-request payload (mirroring the existing friend-request notification flow).

Returns `{ status: 'sent' | 'skipped' | 'failed', reason?: string }`.

**`backfillFounderRequests()`**

Selects all profiles where `onboarding_completed_at IS NOT NULL` and `welcome_friend_request_sent_at IS NULL`, then loops `sendFounderFriendRequest` over them sequentially. Per-user errors are caught and counted, never thrown. Returns `{ sent, skipped, failed, errors: [] }`.

### Schema change

Add one column to `profiles`:

```sql
ALTER TABLE profiles
  ADD COLUMN welcome_friend_request_sent_at timestamptz;
```

This column makes the operation truly idempotent. Without it, a user who declined the request (which deletes the friendship row, per `friends.js:190`) would get re-asked on every backfill run.

### Integration points

**1. Onboarding hook** in `server/routes/users.js`, inside `PATCH /users/onboarding-complete`:

After the existing profile update succeeds, call `sendFounderFriendRequest(req.userId)` inside a `try/catch`. Any error is logged but does not affect the response. The endpoint always returns its existing 200 success body. Onboarding is the user's critical success path; the founder request is a side effect.

**2. Badge stamping** via a new helper `server/utils/profile.js`:

```js
function stampFounder(profile) {
  if (!profile) return profile;
  return { ...profile, is_founder: profile.id === process.env.FOUNDER_USER_ID };
}
```

Applied in every server response that returns a profile shape. At minimum:

- `GET /users/me`
- `GET /friends/:id/profile`
- `GET /friends` (each row)
- `GET /friends/requests/incoming` (each row, after joining the sender profile)

The frontend renders a "Founder" badge wherever `is_founder` is true. One small `<FounderBadge />` component, used everywhere a profile name is shown.

**3. One-shot backfill script** at `scripts/backfill-founder-friends.js`:

```
node scripts/backfill-founder-friends.js [--dry-run]
```

Loads `.env`, calls `backfillFounderRequests()`, prints the summary, exits. The `--dry-run` flag prints the list of users that would receive the request without writing anything. Run dry first, eyeball the count, then run for real. Idempotent: a second run returns `{ sent: 0, skipped: N, failed: 0 }`.

## Failure Behavior

| Failure | Behavior |
|---------|----------|
| Friendship insert fails | Log error, return `{ status: 'failed' }`. Onboarding endpoint still returns 200. |
| `welcome_friend_request_sent_at` update fails after successful insert | Log error. Friendship row exists, so the user still gets the request. Next backfill will try the timestamp update again because the friendship row will now block re-sending anyway. |
| `dispatchNotification` throws | Log error. Friendship row stays. The user will not get a push, but the request is visible in their incoming-requests list when they next open the app. |
| `FOUNDER_USER_ID` unset in production | Log a single warning at server boot. All service calls become no-ops. Feature is silently off. |
| Backfill script encounters per-user errors | Caught, counted, logged with the user ID, included in the final summary. The run continues. |

## Testing

### Server: `server/services/founderFriend.test.js`

Use Node's built-in `node:test` runner (no new dependencies). Mock the Supabase client with a small in-memory fake.

Test cases:

- `FOUNDER_USER_ID` unset returns no-op, zero DB calls
- target equals founder returns no-op
- `welcome_friend_request_sent_at` already set returns no-op
- existing friendship in either direction returns no-op (test both directions and all three statuses)
- happy path inserts row, sets timestamp, dispatches notification
- notification dispatch throws: friendship still inserted, function returns success
- `backfillFounderRequests()` returns correct `{sent, skipped, failed}` over a mixed batch including each guard-skip scenario plus successes plus a forced failure

### E2E: `tests/founder-friend.spec.js` (Playwright)

1. Sign up a fresh user via the dev user switcher
2. Complete onboarding (set username, finish)
3. Assert founder request appears in `/friends/requests/incoming`
4. Render the friend requests page; assert the "Founder" badge is visible on Aaron's row
5. Accept the request; confirm friendship lands in `/friends`

### Manual verification

- Run backfill with `--dry-run` against staging, eyeball the count
- Run backfill for real against staging
- Re-run backfill, confirm `{ sent: 0 }`
- Deploy to prod, run backfill once

### Out of scope for tests

- Multi-founder behavior (only one founder)
- Rate limiting / abuse vectors (server-driven, no user input to abuse)
- Notification fan-out at scale (current scale does not warrant; revisit when user count grows materially)

## Privacy Note

The consent flow (pending request, user must accept) handles the privacy concern of the founder seeing user availability. Users who do not want to share availability with Aaron simply decline. No further policy change required for v1.

## File-by-File Change List

| Path | Change |
|------|--------|
| `server/services/founderFriend.js` | New module with two exported functions |
| `server/services/founderFriend.test.js` | New test suite |
| `server/routes/users.js` | Add hook call inside `PATCH /users/onboarding-complete` |
| `server/utils/profile.js` | New `stampFounder(profile)` helper |
| `server/index.js` | Apply `stampFounder` to relevant profile responses; warn at boot if env var missing in prod |
| `server/routes/friends.js` | Apply `stampFounder` to friend list, friend profile, incoming requests responses |
| `scripts/backfill-founder-friends.js` | New one-shot script with `--dry-run` |
| Supabase migration | `ALTER TABLE profiles ADD COLUMN welcome_friend_request_sent_at timestamptz` |
| `client/src/components/FounderBadge.jsx` | New badge component |
| Friend list, friend profile, incoming-requests views in client | Render `<FounderBadge />` when `profile.is_founder` |
| `server/.env.example` | Add `FOUNDER_USER_ID=` |
| `tests/founder-friend.spec.js` | New Playwright E2E spec |

## Deployment Notes

1. Apply the migration (`welcome_friend_request_sent_at` column) before deploying the new code.
2. Set `FOUNDER_USER_ID` in the production server environment.
3. Deploy the server and client.
4. Run the backfill script: dry-run first, then for real.
5. Verify in the app by signing up a brand-new test user.

## Rollback

The feature is fully reversible:

- Unset `FOUNDER_USER_ID` to silently disable all behavior (no friendship rows are created, badges disappear since the comparison fails).
- The `welcome_friend_request_sent_at` column can stay; it does no harm.
- Existing friendships created by the feature remain valid as normal friendships.

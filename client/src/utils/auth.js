// auth.js — client-side session state
//
// Stores non-sensitive display info (supabaseId, name, picture) in both
// module-level variables (fast synchronous reads) and sessionStorage
// (survives in-page navigation and page refreshes; cleared when the tab closes).
//
// The actual session token lives ONLY in the HTTP-only `rendezvous_session` cookie.
// JavaScript cannot read that cookie — it is sent automatically by the browser on
// every cross-origin request to the API when `withCredentials: true` is set.
// The client never sees, stores, or sends the session token directly.
//
// Auth flow:
//   1. OAuth redirect lands at /?name=...&picture=...&new=1
//   2. App.js calls initSessionFromUrl() synchronously — captures name/picture/new
//   3. App.js calls GET /auth/me — server reads cookie, returns { userId, name, picture }
//   4. App.js calls setSessionFromApi() — populates supabaseId in module state + sessionStorage
//   5. isAuthenticated() returns true; ProtectedRoute renders the requested page
//
// Returning user (no URL params):
//   1. initSessionFromUrl() finds nothing in URL → restores from sessionStorage
//   2. /auth/me confirms the cookie is still valid; setSessionFromApi refreshes state
//   3. If /auth/me returns 401, App.js calls clearSession() and the user sees Login

let _supabaseId          = null;  // Supabase UUID — stable user identifier for DB comparisons (isOrganizer etc.)
let _userName            = null;  // display name shown in NavBar and greeting
let _avatarUrl           = null;  // avatar URL (uploaded photo or Google picture)
let _isNewUser           = false; // true on first login, before profile setup is complete
let _onboardingCompleted = null;  // null=unknown, true=done, false=not yet done

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Restores session state from sessionStorage on module init.
 * Called lazily by the public getters so they work without an explicit init call.
 * Guards against running twice if module state is already populated.
 */
function restoreFromSession() {
  if (_supabaseId) return; // already loaded — skip
  try {
    const stored = sessionStorage.getItem('rv_session');
    if (stored) {
      const { supabaseId, userName, avatarUrl, onboardingCompleted } = JSON.parse(stored);
      _supabaseId          = supabaseId          || null;
      _userName            = userName            || '';
      _avatarUrl           = avatarUrl           || null;
      _onboardingCompleted = onboardingCompleted ?? null;
    }
  } catch { /* ignore parse errors — corrupted storage is treated as empty */ }
}

/**
 * Writes current session state to sessionStorage so it survives page refreshes.
 * Never stores the session token — that lives in the HTTP-only cookie only.
 */
function persistToSession() {
  try {
    sessionStorage.setItem('rv_session', JSON.stringify({
      supabaseId:          _supabaseId,
      userName:            _userName,
      avatarUrl:           _avatarUrl,
      onboardingCompleted: _onboardingCompleted,
    }));
  } catch { /* ignore QuotaExceededError */ }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads display info (name, picture, new flag) from the OAuth redirect URL.
 * Cleans the query params from the URL via history.replaceState so they don't
 * appear in the browser address bar or leak through Referer headers.
 *
 * Called synchronously in App.js before any render so that name/picture are
 * available immediately while the /auth/me round-trip is in flight.
 *
 * supabaseId is NOT in the URL anymore — it comes from /auth/me (setSessionFromApi).
 */
export function initSessionFromUrl() {
  const params  = new URLSearchParams(window.location.search);
  const name    = params.get('name');
  const picture = params.get('picture');

  if (name) {
    // New URL params present — this is an OAuth redirect (or dev switcher redirect)
    _userName  = name;
    _avatarUrl = picture || null;
    _isNewUser = params.get('new') === '1';
    persistToSession();
    // Remove query params from URL so they don't pollute browser history or get
    // accidentally shared as links by the user
    window.history.replaceState({}, document.title, window.location.pathname);
  } else {
    // No URL params — returning user; restore from sessionStorage
    restoreFromSession();
  }
}

/**
 * Called by App.js after a successful /auth/me response.
 * Populates supabaseId (the primary key for all DB comparisons) and optionally
 * refreshes name/picture if they weren't already set from the URL.
 *
 * @param {string} supabaseId - Supabase UUID from /auth/me response
 * @param {string} name       - display name
 * @param {string} picture    - avatar URL
 */
export function setSessionFromApi(supabaseId, name, picture) {
  _supabaseId = supabaseId || null;
  // Only overwrite display fields if they aren't already set from the URL redirect.
  // On OAuth redirect, initSessionFromUrl sets them first; on returning visits,
  // sessionStorage may have them. Prefer URL > API > nothing.
  if (name)    _userName  = name;
  if (picture) _avatarUrl = picture;
  persistToSession();
}

// Supabase UUID — use when comparing against organizer_id, attendee_id, etc.
// The server also computes isOrganizer server-side, so direct comparisons are
// increasingly rare — prefer itin.isOrganizer where available.
export function getSupabaseId() { restoreFromSession(); return _supabaseId; }
export function getUserName()   { restoreFromSession(); return _userName; }
export function getAvatarUrl()  { restoreFromSession(); return _avatarUrl; }

/** Updates the stored avatar URL after a successful upload. */
export function setAvatarUrl(url) {
  _avatarUrl = url;
  persistToSession();
}

export function isNewUser()    { return _isNewUser; }
export function clearNewUser() { _isNewUser = false; }

/**
 * Sets the onboarding completion state. Called by App.js after fetching /users/me,
 * and by Onboarding.js when the user completes the flow.
 * @param {boolean} val - true if onboarding_completed_at is set, false if null
 */
export function setOnboardingCompleted(val) {
  _onboardingCompleted = val;
  persistToSession();
}

/**
 * Returns the known onboarding completion state.
 *   null  — not yet determined (App.js auth check still in flight)
 *   true  — user has completed onboarding
 *   false — user has NOT completed onboarding (redirect to /onboarding)
 */
export function isOnboardingCompleted() { restoreFromSession(); return _onboardingCompleted; }

/**
 * Returns true if we have a supabaseId — meaning /auth/me has confirmed a valid
 * cookie at least once in this tab's lifetime. Used by ProtectedRoute.
 */
export function isAuthenticated() { restoreFromSession(); return !!_supabaseId; }

/**
 * Clears all client-side session state.
 * Called on logout (NavBar) or when /auth/me returns 401 (App.js).
 * Does NOT clear the server-side session row or the cookie — the server
 * handles that on POST /auth/logout (which also calls res.clearCookie).
 */
export function clearSession() {
  _supabaseId          = null;
  _userName            = null;
  _avatarUrl           = null;
  _isNewUser           = false;
  _onboardingCompleted = null;
  try { sessionStorage.removeItem('rv_session'); } catch { /* ignore */ }
}

// auth.js — session helpers
// Primary: in-memory store (most secure, clears on refresh)
// Bridge: sessionStorage (survives in-page navigation, clears when tab closes)
// Production path: swap for HTTP-only cookies + Supabase sessions table

let _userId      = null;  // session token (used as x-user-id header)
let _supabaseId  = null;  // real Supabase UUID (used to compare against DB fields)
let _userName    = null;
let _avatarUrl   = null;
let _isNewUser   = false;

function restoreFromSession() {
  if (_userId) return;
  try {
    const stored = sessionStorage.getItem('rv_session');
    if (stored) {
      const { userId, supabaseId, userName, avatarUrl } = JSON.parse(stored);
      _userId     = userId     || null;
      _supabaseId = supabaseId || null;
      _userName   = userName   || '';
      _avatarUrl  = avatarUrl  || null;
    }
  } catch { /* ignore parse errors */ }
}

function persistToSession() {
  try {
    sessionStorage.setItem('rv_session', JSON.stringify({
      userId:     _userId,
      supabaseId: _supabaseId,
      userName:   _userName,
      avatarUrl:  _avatarUrl,
    }));
  } catch { /* ignore quota errors */ }
}

export function initSessionFromUrl() {
  const params     = new URLSearchParams(window.location.search);
  const userId     = params.get('userId');
  const supabaseId = params.get('supabaseId');
  const name       = params.get('name');
  const picture    = params.get('picture');

  if (userId) {
    _userId     = userId;
    _supabaseId = supabaseId || null;
    _userName   = name    || '';
    _avatarUrl  = picture || null;
    _isNewUser  = params.get('new') === '1';
    persistToSession();
    window.history.replaceState({}, document.title, window.location.pathname);
  } else {
    restoreFromSession();
  }
}

// Session token — used as x-user-id header for API calls
export function getUserId()     { restoreFromSession(); return _userId; }
// Supabase UUID — use this when comparing against organizer_id, attendee_id, etc.
export function getSupabaseId() { restoreFromSession(); return _supabaseId; }
export function getUserName()   { restoreFromSession(); return _userName; }
export function getAvatarUrl()  { restoreFromSession(); return _avatarUrl; }

export function setAvatarUrl(url) {
  _avatarUrl = url;
  persistToSession();
}

export function isNewUser()    { return _isNewUser; }
export function clearNewUser() { _isNewUser = false; }

export function isAuthenticated() { restoreFromSession(); return !!_userId; }

export function clearSession() {
  _userId     = null;
  _supabaseId = null;
  _userName   = null;
  _avatarUrl  = null;
  _isNewUser  = false;
  try { sessionStorage.removeItem('rv_session'); } catch { /* ignore */ }
}

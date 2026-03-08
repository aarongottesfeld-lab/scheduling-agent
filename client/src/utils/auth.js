// auth.js — session helpers
// Stores userId in memory only (not localStorage) for security.
// Session is lost on page refresh in POC — production would use HTTP-only cookies.

let _userId    = null;
let _userName  = null;
let _avatarUrl = null;
let _isNewUser = false;

// On app load, check if userId was passed back from OAuth redirect
export function initSessionFromUrl() {
  const params  = new URLSearchParams(window.location.search);
  const userId  = params.get('userId');
  const name    = params.get('name');
  const picture = params.get('picture');

  if (userId) {
    _userId    = userId;
    _userName  = name    || '';
    _avatarUrl = picture || null;
    _isNewUser = params.get('new') === '1';
    // Clean the URL so session data isn't visible or bookmarkable
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

export function getUserId()    { return _userId; }
export function getUserName()  { return _userName; }
export function getAvatarUrl() { return _avatarUrl; }

export function setAvatarUrl(url) { _avatarUrl = url; }
export function isNewUser()   { return _isNewUser; }
export function clearNewUser() { _isNewUser = false; }

export function isAuthenticated() { return !!_userId; }

export function clearSession() {
  _userId    = null;
  _userName  = null;
  _avatarUrl = null;
  _isNewUser = false;
}

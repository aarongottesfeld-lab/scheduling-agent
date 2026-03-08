// auth.js — session helpers
// Stores userId in memory only (not localStorage) for security.
// Session is lost on page refresh in POC — production would use HTTP-only cookies.

let _userId = null;
let _userName = null;

// On app load, check if userId was passed back from OAuth redirect
export function initSessionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const userId = params.get('userId');
  const name = params.get('name');

  if (userId) {
    _userId = userId;
    _userName = name || '';
    // Clean the URL so the userId isn't visible or bookmarkable
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

export function getUserId() {
  return _userId;
}

export function getUserName() {
  return _userName;
}

export function isAuthenticated() {
  return !!_userId;
}

export function clearSession() {
  _userId = null;
  _userName = null;
}

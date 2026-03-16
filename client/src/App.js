// App.js — root component
// Privacy: only supabaseId sent to PostHog — no PII, no health data, no calendar content
//
// Responsibilities:
//   1. Read display info (name, picture, new flag) from the OAuth redirect URL
//   2. Call /auth/me to verify the session cookie and retrieve supabaseId
//   3. Block route rendering behind an auth-ready gate to prevent ProtectedRoute
//      from flash-redirecting to /login before the cookie check completes
//   4. Set up all client-side routes via React Router
//   5. Identify the user in PostHog (supabaseId only) and fire pageview events on route change
//
// Auth flow (first load after OAuth):
//   Browser lands at /?name=...&picture=...&new=1
//   → initSessionFromUrl() captures display info, cleans URL
//   → /auth/me confirms cookie, returns supabaseId
//   → setSessionFromApi() populates module state
//   → authReady = true, routes render, Login redirects to /home or /profile/setup
//
// Auth flow (returning user, valid cookie):
//   Browser lands at /home (or any route)
//   → initSessionFromUrl() finds no URL params, restores from sessionStorage
//   → /auth/me confirms cookie still valid
//   → authReady = true, ProtectedRoute passes
//
// Auth flow (expired or missing cookie):
//   → /auth/me returns 401
//   → clearSession() wipes sessionStorage
//   → authReady = true, ProtectedRoute fails → /login

import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import posthog from 'posthog-js';

import { initSessionFromUrl, setSessionFromApi, clearSession, setOnboardingCompleted, isOnboardingCompleted } from './utils/auth';
import client from './utils/client';
import useTheme from './utils/useTheme';
import { messaging, getToken, onMessage } from './firebase';
import { registerPushToken } from './utils/api';
import ProtectedRoute from './components/ProtectedRoute';

import Login               from './pages/Login';
import ProfileSetup        from './pages/ProfileSetup';
import Home                from './pages/Home';
import Friends             from './pages/Friends';
import FriendProfile       from './pages/FriendProfile';
import NewEvent            from './pages/NewEvent';
import ItineraryView       from './pages/ItineraryView';
import MyProfile           from './pages/MyProfile';
import Notifications       from './pages/Notifications';
import Groups              from './pages/Groups';
import GroupDetail         from './pages/GroupDetail';
import NewGroupEvent       from './pages/NewGroupEvent';
import GroupItineraryView  from './pages/GroupItineraryView';
import Onboarding          from './pages/Onboarding';
import SharedProfile       from './pages/SharedProfile';
import Settings            from './pages/Settings';
import BugReportButton     from './components/BugReportButton';

/**
 * Fires a PostHog $pageview event on every route change.
 * Must live inside <BrowserRouter> so useLocation() has a Router context.
 * Renders nothing — purely a side-effect component.
 */
function PageViewTracker() {
  const location = useLocation();
  useEffect(() => {
    try { posthog.capture('$pageview'); } catch {}
  }, [location.pathname]);
  return null;
}

/**
 * Redirects to /onboarding when the user has not completed onboarding.
 * Must live inside <BrowserRouter> so useNavigate/useLocation are available.
 * Only fires when isOnboardingCompleted() === false (not null/unknown).
 * Does not redirect if already on /onboarding — prevents infinite loop.
 */
function OnboardingRedirector() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (isOnboardingCompleted() === false && location.pathname !== '/onboarding') {
      navigate('/onboarding', { replace: true });
    }
  }, [location.pathname, navigate]);
  return null;
}

export default function App() {
  // Apply dark mode data-theme attribute on <html> based on localStorage / OS preference.
  // The return values are consumed independently by MyProfile's appearance toggle.
  useTheme();

  // authReady: false while the /auth/me round-trip is in flight.
  // Keeps routes from rendering (and ProtectedRoute from redirecting) before
  // we know whether the user has a valid session.
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    // Step 1: synchronously capture display info from URL and clean query params.
    // Must happen before /auth/me so name/picture are ready for NavBar on first render.
    initSessionFromUrl();

    // Step 2: verify the session cookie with the server.
    // withCredentials in client.js ensures the cookie is sent automatically.
    // On success, /auth/me returns { userId (supabaseId), name, picture }.
    // On 401, the cookie is missing/expired — clear stale sessionStorage data.
    client.get('/auth/me')
      .then(async res => {
        const supabaseId = res.data.userId;
        setSessionFromApi(supabaseId, res.data.name, res.data.picture);
        // Identify the user in PostHog using their stable Supabase UUID only.
        // Never send name, email, avatar, or any other PII.
        try { posthog.identify(supabaseId); } catch {}
        // Fetch profile to determine onboarding status before routes render.
        // Must complete before setAuthReady(true) so OnboardingRedirector has
        // the correct value on first render and avoids a flash to /home.
        try {
          const profileRes = await client.get('/users/me');
          setOnboardingCompleted(!!profileRes.data.onboarding_completed_at);
        } catch {
          // Fail open — don't force onboarding on a transient /users/me error.
          setOnboardingCompleted(true);
        }

        // Silently re-register FCM token on every authenticated load.
        // Ensures users who completed onboarding before push was wired get registered
        // without going through onboarding again. Entirely fire-and-forget — never
        // blocks app load or surfaces errors to the user.
        if (
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted' &&
          'serviceWorker' in navigator
        ) {
          navigator.serviceWorker
            .register('/firebase-messaging-sw.js')
            .then(registration =>
              getToken(messaging, {
                vapidKey: process.env.REACT_APP_FIREBASE_VAPID_KEY,
                serviceWorkerRegistration: registration,
              })
            )
            .then(token => { if (token) registerPushToken(token); })
            .catch(err => console.warn('[push] background re-registration failed:', err.message));

          // Show a native notification when a push arrives while the tab is in the foreground.
          // Without this, FCM silently delivers to onMessage and the user sees nothing.
          onMessage(messaging, (payload) => {
            const { title, body } = payload.notification || {};
            const actionUrl = payload.data?.actionUrl || '/';
            if (title && Notification.permission === 'granted') {
              const n = new Notification(title, {
                body: body || '',
                icon: '/logo192.png',
                data: { actionUrl },
              });
              n.onclick = () => { window.focus(); window.location.href = actionUrl; n.close(); };
            }
          });
        }
      })
      .catch(() => {
        // No valid cookie — wipe any stale sessionStorage so isAuthenticated()
        // returns false and ProtectedRoute redirects to /login correctly.
        clearSession();
      })
      .finally(() => setAuthReady(true));
  }, []); // run once on mount — the session doesn't change during the app lifecycle

  // Show a centered spinner while the auth check is in flight.
  // This prevents a flash of the login page for users with a valid cookie.
  if (!authReady) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div className="spinner spinner--lg" />
      </div>
    );
  }

  return (
    <BrowserRouter>
      {/* Fires $pageview on every pathname change — must be inside BrowserRouter */}
      <PageViewTracker />
      {/* Redirects to /onboarding when onboarding_completed_at is null */}
      <OnboardingRedirector />
      {/* Floating feedback + bug report buttons — renders on all logged-in pages */}
      <BugReportButton />
      <Routes>
        {/* Public — Login redirects to /home if already authenticated */}
        <Route path="/" element={<Login />} />

        {/* Public shareable profile — not ProtectedRoute; auth check is inside SharedProfile */}
        <Route path="/u/:username" element={<SharedProfile />} />

        {/* Onboarding — not wrapped in ProtectedRoute; Onboarding.js handles its own
            auth redirect. Part of the auth completion flow, not a protected feature. */}
        <Route path="/onboarding" element={<Onboarding />} />

        {/* Protected — requireAuth on the server also enforces auth on all API calls */}
        <Route path="/profile/setup" element={
          <ProtectedRoute><ProfileSetup /></ProtectedRoute>
        } />
        <Route path="/home" element={
          <ProtectedRoute><Home /></ProtectedRoute>
        } />
        <Route path="/friends" element={
          <ProtectedRoute><Friends /></ProtectedRoute>
        } />
        <Route path="/friends/:friendId" element={
          <ProtectedRoute><FriendProfile /></ProtectedRoute>
        } />
        <Route path="/schedule/new" element={
          <ProtectedRoute><NewEvent /></ProtectedRoute>
        } />
        <Route path="/profile" element={
          <ProtectedRoute><MyProfile /></ProtectedRoute>
        } />
        <Route path="/settings" element={
          <ProtectedRoute><Settings /></ProtectedRoute>
        } />
        <Route path="/schedule/:id" element={
          <ProtectedRoute><ItineraryView /></ProtectedRoute>
        } />
        <Route path="/notifications" element={
          <ProtectedRoute><Notifications /></ProtectedRoute>
        } />
        {/* Group mode routes */}
        <Route path="/groups" element={
          <ProtectedRoute><Groups /></ProtectedRoute>
        } />
        <Route path="/groups/:id" element={
          <ProtectedRoute><GroupDetail /></ProtectedRoute>
        } />
        {/* NewGroupEvent — entry from GroupDetail (groupId pre-filled) or home screen (picker) */}
        <Route path="/groups/:groupId/new-event" element={
          <ProtectedRoute><NewGroupEvent /></ProtectedRoute>
        } />
        <Route path="/group-event/new" element={
          <ProtectedRoute><NewGroupEvent /></ProtectedRoute>
        } />
        <Route path="/group-itineraries/:id" element={
          <ProtectedRoute><GroupItineraryView /></ProtectedRoute>
        } />
      </Routes>
    </BrowserRouter>
  );
}

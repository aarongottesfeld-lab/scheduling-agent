// App.js — root component
//
// Responsibilities:
//   1. Read display info (name, picture, new flag) from the OAuth redirect URL
//   2. Call /auth/me to verify the session cookie and retrieve supabaseId
//   3. Block route rendering behind an auth-ready gate to prevent ProtectedRoute
//      from flash-redirecting to /login before the cookie check completes
//   4. Set up all client-side routes via React Router
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
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import { initSessionFromUrl, setSessionFromApi, clearSession } from './utils/auth';
import client from './utils/client';
import ProtectedRoute from './components/ProtectedRoute';

import Login         from './pages/Login';
import ProfileSetup  from './pages/ProfileSetup';
import Home          from './pages/Home';
import Friends       from './pages/Friends';
import FriendProfile from './pages/FriendProfile';
import NewEvent      from './pages/NewEvent';
import ItineraryView from './pages/ItineraryView';
import MyProfile     from './pages/MyProfile';
import Notifications from './pages/Notifications';

export default function App() {
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
      .then(res => {
        setSessionFromApi(res.data.userId, res.data.name, res.data.picture);
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
      <Routes>
        {/* Public — Login redirects to /home if already authenticated */}
        <Route path="/" element={<Login />} />

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
        <Route path="/schedule/:id" element={
          <ProtectedRoute><ItineraryView /></ProtectedRoute>
        } />
        <Route path="/notifications" element={
          <ProtectedRoute><Notifications /></ProtectedRoute>
        } />
      </Routes>
    </BrowserRouter>
  );
}

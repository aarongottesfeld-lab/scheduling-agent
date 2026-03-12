// App.js
// Root component: initializes the session from the OAuth redirect URL params,
// then sets up all client-side routes via React Router v7.

import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import { initSessionFromUrl } from './utils/auth';
import ProtectedRoute from './components/ProtectedRoute';

import Login from './pages/Login';
import ProfileSetup from './pages/ProfileSetup';
import Home from './pages/Home';
import Friends from './pages/Friends';
import FriendProfile from './pages/FriendProfile';
import NewEvent from './pages/NewEvent';
import ItineraryView from './pages/ItineraryView';
import MyProfile from './pages/MyProfile';
import Notifications from './pages/Notifications';

// Call synchronously before the first render so that isAuthenticated() is
// correct on the very first route evaluation — no flash to the login page
// after an OAuth redirect.
initSessionFromUrl();

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/" element={<Login />} />

        {/* Protected — ProfileSetup requires auth so unauthenticated users
            cannot POST to /users/profile without a valid session */}
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

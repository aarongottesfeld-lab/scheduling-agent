// 1/10 — ProtectedRoute
// Wraps any route that requires an authenticated session.
// If isAuthenticated() returns false, redirects to the login page.

import React from 'react';
import { Navigate } from 'react-router-dom';
import { isAuthenticated } from '../utils/auth';

export default function ProtectedRoute({ children }) {
  if (!isAuthenticated()) {
    return <Navigate to="/" replace />;
  }
  return children;
}

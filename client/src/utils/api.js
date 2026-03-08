// api.js — all server calls in one place
// Every function that talks to the Express server lives here.
// This makes it easy to find, update, and mock for testing later.

import axios from 'axios';
import { getUserId } from './auth';

const BASE_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:3001';

// Attach userId header to every request automatically
const client = axios.create({ baseURL: BASE_URL });

client.interceptors.request.use((config) => {
  const userId = getUserId();
  if (userId) config.headers['x-user-id'] = userId;
  return config;
});

// ── Auth ──────────────────────────────────────────────────────────────────────

export function getGoogleAuthUrl() {
  return `${BASE_URL}/auth/google`;
}

export async function getMe() {
  const res = await client.get('/auth/me');
  return res.data;
}

export async function logout() {
  const res = await client.post('/auth/logout');
  return res.data;
}

// ── Calendar ──────────────────────────────────────────────────────────────────

export async function getAvailability({ timeMin, timeMax, calendarId = 'primary' }) {
  const res = await client.get('/calendar/availability', {
    params: { timeMin, timeMax, calendarId },
  });
  return res.data;
}

// ── Users / Profiles ──────────────────────────────────────────────────────────

export async function searchUserByEmail(email) {
  const res = await client.get('/users/search', { params: { email } });
  return res.data;
}

export async function saveProfile(profile) {
  const res = await client.post('/users/profile', profile);
  return res.data;
}

// ── Scheduling ────────────────────────────────────────────────────────────────

export async function getSuggestions({ targetUserId, daysAhead = 7 }) {
  const res = await client.post('/schedule/suggest', { targetUserId, daysAhead });
  return res.data;
}

export async function confirmSuggestion(suggestionId) {
  const res = await client.post('/schedule/confirm', { suggestionId });
  return res.data;
}

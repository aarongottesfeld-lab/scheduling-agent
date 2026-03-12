// api.js — all server calls in one place
// Every function that talks to the Express server lives here.
// Uses the shared authenticated client from client.js so that auth behavior,
// error normalization, and interceptors stay in one place.

import client from './client';

const BASE_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:3001';

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

export async function getSuggestions({ targetUserId, daysAhead = 7, startDate, endDate, timeOfDay, maxTravelMinutes, contextPrompt, eventTitle, timezoneOffsetMinutes }) {
  const res = await client.post('/schedule/suggest', { targetUserId, daysAhead, startDate, endDate, timeOfDay, maxTravelMinutes, contextPrompt, eventTitle, timezoneOffsetMinutes });
  return res.data;
}

/**
 * Accepts or counter-proposes a suggestion within an itinerary.
 * Both parameters are required — the server validates that the caller
 * is a participant in the itinerary before accepting the confirmation.
 *
 * @param {string} itineraryId  - UUID of the itinerary being acted on
 * @param {string} suggestionId - ID of the suggestion being selected (e.g. "s1")
 */
export async function confirmSuggestion(itineraryId, suggestionId) {
  // The server requires itineraryId to look up the itinerary and verify
  // that the caller is the organizer or attendee before saving the status.
  const res = await client.post('/schedule/confirm', { itineraryId, suggestionId });
  return res.data;
}

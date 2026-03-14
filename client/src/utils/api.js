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

export async function getSuggestions({ targetUserId, daysAhead = 7, startDate, endDate, timeOfDay, maxTravelMinutes, contextPrompt, eventTitle, timezoneOffsetMinutes, confirmedOrganizerConflict, locationPreference, travel_mode, trip_duration_days, destination }) {
  const res = await client.post('/schedule/suggest', { targetUserId, daysAhead, startDate, endDate, timeOfDay, maxTravelMinutes, contextPrompt, eventTitle, timezoneOffsetMinutes, confirmedOrganizerConflict, locationPreference, travel_mode, trip_duration_days, destination });
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

// ── Groups ─────────────────────────────────────────────────────────────────

/** Create a new group. Returns { group: { id, name, description, default_activities, created_by, created_at } }. */
export async function createGroup(name, description, defaultActivities = []) {
  const res = await client.post('/groups', { name, description, default_activities: defaultActivities });
  return res.data;
}

/** List all groups the current user is an active member of. Returns { groups: [...] }. */
export async function getGroups() {
  const res = await client.get('/groups');
  return res.data;
}

/** Get group detail + member list. Returns { group, my_role, members }. */
export async function getGroup(groupId) {
  const res = await client.get(`/groups/${groupId}`);
  return res.data;
}

/**
 * Admin-only: update group name, description, and/or default_activities.
 * Returns { group: updated row }.
 */
export async function updateGroup(groupId, { name, description, defaultActivities }) {
  const payload = {};
  if (name !== undefined) payload.name = name;
  if (description !== undefined) payload.description = description;
  if (defaultActivities !== undefined) payload.default_activities = defaultActivities;
  const res = await client.patch(`/groups/${groupId}`, payload);
  return res.data;
}

/**
 * Admin-only: invite a user to a group by their Supabase userId.
 * Returns { message: 'Invitation sent.' }.
 */
export async function inviteMember(groupId, userId) {
  const res = await client.post(`/groups/${groupId}/members`, { userId });
  return res.data;
}

/**
 * Update the current user's own membership status.
 * status: 'active' (accept invite), 'declined', or 'left'.
 * Returns { message: 'Membership updated.' }.
 */
export async function updateMembership(groupId, userId, status) {
  const res = await client.patch(`/groups/${groupId}/members/${userId}`, { status });
  return res.data;
}

/** Admin-only: hard-remove a member from the group. Returns { message: 'Member removed.' }. */
export async function removeMember(groupId, userId) {
  const res = await client.delete(`/groups/${groupId}/members/${userId}`);
  return res.data;
}

// ── Group Itineraries ───────────────────────────────────────────────────────

/**
 * Create a new group itinerary in organizer_draft state.
 * Returns { itineraryId: uuid }.
 * Call generateGroupSuggestions() after this to generate AI suggestions.
 */
export async function createGroupItinerary(payload) {
  const res = await client.post('/group-itineraries', payload);
  return res.data;
}

/**
 * Trigger AI suggestion generation for an organizer_draft itinerary.
 * Organizer-only. Returns { suggestions: [...] }.
 * Itinerary stays in organizer_draft after this — organizer reviews before sending.
 */
export async function generateGroupSuggestions(itineraryId) {
  const res = await client.post(`/group-itineraries/${itineraryId}/suggest`);
  return res.data;
}

/**
 * Organizer sends the itinerary to all attendees.
 * Transitions status: organizer_draft → awaiting_responses.
 * Returns { message: 'Itinerary sent to group.' }.
 */
export async function sendGroupItinerary(itineraryId, suggestionId) {
  const body = suggestionId ? { suggestion_id: suggestionId } : {};
  const res = await client.post(`/group-itineraries/${itineraryId}/send`, body);
  return res.data;
}

/**
 * Attendee records their vote on a suggestion.
 * vote: 'accepted' | 'declined' | 'abstained'
 * Returns { message, itinerary_status, locked_at }.
 * The DB trigger handles quorum evaluation — do not replicate that logic here.
 */
export async function voteOnGroupItinerary(itineraryId, selectedSuggestionId, vote) {
  const res = await client.patch(`/group-itineraries/${itineraryId}/vote`, {
    selected_suggestion_id: selectedSuggestionId,
    vote,
  });
  return res.data;
}

/**
 * Organizer requests a fresh set of AI suggestions.
 * Appends current suggestions to changelog, resets attendee_statuses to 'pending'.
 * Returns { suggestions: [...] }.
 */
export async function rerollGroupItinerary(itineraryId, rerollType = 'both') {
  const res = await client.post(`/group-itineraries/${itineraryId}/reroll`, { rerollType });
  return res.data;
}

/**
 * Get a group itinerary with vote_status map and organizer profile.
 * Returns the full row plus { organizer, vote_status, is_organizer }.
 */
export async function getGroupItinerary(itineraryId) {
  const res = await client.get(`/group-itineraries/${itineraryId}`);
  return res.data;
}

/**
 * Add a comment on a specific suggestion.
 * body is capped at 2000 chars (enforced in UI and server).
 * Returns { comment: { id, suggestion_id, user_id, body, created_at } }.
 */
export async function addGroupComment(itineraryId, suggestionId, body) {
  const res = await client.post(`/group-itineraries/${itineraryId}/comments`, {
    suggestion_id: suggestionId,
    body,
  });
  return res.data;
}

/**
 * Fetch paginated comments for an itinerary.
 * params: { page?, suggestion_id? }
 * Returns { comments: [...], total, page, pages }.
 */
export async function getGroupComments(itineraryId, params = {}) {
  const res = await client.get(`/group-itineraries/${itineraryId}/comments`, { params });
  return res.data;
}

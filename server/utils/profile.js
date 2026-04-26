// utils/profile.js — small helpers for shaping profile responses
'use strict';

/**
 * Returns a shallow copy of `profile` with `is_founder: true` if its id matches
 * FOUNDER_USER_ID, else `is_founder: false`. Returns the input unchanged for
 * null/undefined. Never mutates the input.
 */
function stampFounder(profile) {
  if (!profile) return profile;
  const founderId = process.env.FOUNDER_USER_ID;
  return { ...profile, is_founder: !!founderId && profile.id === founderId };
}

module.exports = { stampFounder };

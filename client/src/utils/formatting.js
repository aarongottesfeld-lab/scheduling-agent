// Shared UI formatting utilities.

/**
 * Returns 1-2 character initials from a display name.
 */
export function getInitials(name = '') {
  return name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

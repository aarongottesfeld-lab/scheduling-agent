'use strict';

// Email addresses exempt from AI generation rate limits.
// Set RATE_LIMIT_EXEMPT_EMAILS as a comma-separated list in .env
// and Vercel dashboard. Never hardcode personal emails in source.
const RATE_LIMIT_EXEMPT = new Set(
  (process.env.RATE_LIMIT_EXEMPT_EMAILS || '')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean)
);

module.exports = { RATE_LIMIT_EXEMPT };

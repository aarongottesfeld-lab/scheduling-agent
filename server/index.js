'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Validate required environment variables at startup
// ---------------------------------------------------------------------------
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
];

const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error('Missing required environment variables:', missingEnv.join(', '));
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '3001', 10);
const IS_PROD = process.env.NODE_ENV === 'production';
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Supabase (service role — never expose to client)
// ---------------------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------------------------------------------------------
// Google OAuth helpers
// ---------------------------------------------------------------------------
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

/** Create a fresh OAuth2 client (avoids shared mutable state across requests). */
function createOAuth2Client(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  if (tokens) client.setCredentials(tokens);
  return client;
}

// ---------------------------------------------------------------------------
// In-memory stores (replace with Redis / Supabase in production)
// ---------------------------------------------------------------------------

/**
 * CSRF state tokens: Map<state, { createdAt: number }>
 * Expired automatically every 5 minutes.
 */
const oauthStates = new Map();

/**
 * User sessions: Map<userId, { tokens, email, name, picture }>
 * TODO: persist in Supabase for production multi-instance deployments.
 */
const userSessions = new Map();

// Purge OAuth states older than 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, data] of oauthStates.entries()) {
    if (data.createdAt < cutoff) oauthStates.delete(state);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.disable('x-powered-by');

app.use(
  cors({
    origin: IS_PROD ? CLIENT_URL : true,
    credentials: true,
  })
);

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const userId = req.headers['x-user-id'];
  if (!userId || !userSessions.has(userId)) {
    return res.status(401).json({ error: 'Unauthorized. Authenticate via /auth/google first.' });
  }
  req.userId = userId;
  req.userSession = userSessions.get(userId);
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /health
 * Basic liveness check. Does not expose internal details in production.
 */
app.get('/health', async (req, res) => {
  const payload = {
    status: 'ok',
    timestamp: new Date().toISOString(),
  };

  if (!IS_PROD) {
    payload.env = process.env.NODE_ENV || 'development';

    // Optional: surface Supabase reachability in dev
    try {
      const { error } = await supabase.from('profiles').select('id').limit(1);
      payload.supabase = error ? 'unreachable' : 'ok';
    } catch {
      payload.supabase = 'unreachable';
    }
  }

  res.json(payload);
});

/**
 * GET /auth/google
 * Kicks off the Google OAuth2 consent flow.
 */
app.get('/auth/google', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, { createdAt: Date.now() });

  const authUrl = createOAuth2Client().generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    state,
    prompt: 'consent', // ensures refresh_token is issued
  });

  res.redirect(authUrl);
});

/**
 * GET /auth/google/callback
 * Handles the redirect from Google after user consent.
 * Exchanges the authorization code for tokens, fetches the user profile,
 * and redirects the client with a session identifier.
 */
app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Google OAuth error:', error);
    return res.redirect(
      `${CLIENT_URL}?error=${encodeURIComponent('Google authorization was denied')}`
    );
  }

  // Validate CSRF state
  if (!state || !oauthStates.has(state)) {
    return res.status(400).json({ error: 'Invalid or expired OAuth state' });
  }
  oauthStates.delete(state);

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    const client = createOAuth2Client();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Fetch basic profile info
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: profile } = await oauth2.userinfo.get();

    const userId = crypto.randomBytes(16).toString('hex');
    userSessions.set(userId, {
      tokens,
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    });

    // TODO (production): upsert user + encrypted tokens into Supabase
    // await supabase.from('users').upsert({
    //   google_id: profile.id,
    //   email: profile.email,
    //   name: profile.name,
    //   tokens: encryptTokens(tokens),
    // });

    // NOTE: passing userId in URL is acceptable for an SPA dev flow.
    // In production prefer an HTTP-only cookie (requires cookie-parser + sameSite config).
    res.redirect(
      `${CLIENT_URL}?userId=${userId}&name=${encodeURIComponent(profile.name || '')}`
    );
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect(
      `${CLIENT_URL}?error=${encodeURIComponent('Authentication failed. Please try again.')}`
    );
  }
});

/**
 * GET /auth/me
 * Returns the authenticated user's profile.
 */
app.get('/auth/me', requireAuth, (req, res) => {
  const { email, name, picture } = req.userSession;
  res.json({ userId: req.userId, email, name, picture });
});

/**
 * POST /auth/logout
 * Clears the server-side session.
 */
app.post('/auth/logout', requireAuth, (req, res) => {
  userSessions.delete(req.userId);
  res.json({ message: 'Logged out successfully' });
});

/**
 * GET /calendar/availability
 * Returns events and free/busy slots for the authenticated user.
 *
 * Query params:
 *   timeMin    {string} ISO 8601 — range start (required)
 *   timeMax    {string} ISO 8601 — range end (required)
 *   calendarId {string} Calendar ID (default: 'primary')
 */
app.get('/calendar/availability', requireAuth, async (req, res) => {
  const { timeMin, timeMax, calendarId = 'primary' } = req.query;

  if (!timeMin || !timeMax) {
    return res.status(400).json({
      error: 'timeMin and timeMax are required query parameters (ISO 8601)',
    });
  }

  const start = new Date(timeMin);
  const end = new Date(timeMax);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return res.status(400).json({ error: 'Invalid date format. Use ISO 8601.' });
  }

  if (start >= end) {
    return res.status(400).json({ error: 'timeMin must be before timeMax' });
  }

  const MS_30_DAYS = 30 * 24 * 60 * 60 * 1000;
  if (end - start > MS_30_DAYS) {
    return res.status(400).json({ error: 'Date range cannot exceed 30 days' });
  }

  // Sanitize calendarId — allow 'primary' or email-like strings only
  if (!/^(primary|[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})$/.test(calendarId)) {
    return res.status(400).json({ error: 'Invalid calendarId' });
  }

  try {
    const client = createOAuth2Client(req.userSession.tokens);

    // Proactively refresh if the access token is within 60 seconds of expiry
    const { expiry_date } = req.userSession.tokens;
    if (expiry_date && expiry_date - Date.now() < 60 * 1000) {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      req.userSession.tokens = credentials;
      userSessions.set(req.userId, req.userSession);
    }

    const calendar = google.calendar({ version: 'v3', auth: client });

    const [eventsRes, freeBusyRes] = await Promise.all([
      calendar.events.list({
        calendarId,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
        // Only fetch fields we actually need
        fields: 'items(id,summary,start,end,status,transparency)',
      }),
      calendar.freebusy.query({
        requestBody: {
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          items: [{ id: calendarId }],
        },
      }),
    ]);

    const events = (eventsRes.data.items || []).map((e) => ({
      id: e.id,
      summary: e.summary || '(No title)',
      start: e.start,
      end: e.end,
      status: e.status,
      transparent: e.transparency === 'transparent',
    }));

    const busySlots = freeBusyRes.data.calendars?.[calendarId]?.busy || [];

    res.json({
      user: { email: req.userSession.email, name: req.userSession.name },
      range: { timeMin: start.toISOString(), timeMax: end.toISOString() },
      events,
      busySlots,
    });
  } catch (err) {
    console.error('Calendar fetch error:', err.message);

    const status = err.code ?? err.status;
    if (status === 401) {
      return res
        .status(401)
        .json({ error: 'Calendar token expired or revoked. Please re-authenticate.' });
    }
    if (status === 403) {
      return res.status(403).json({ error: 'Insufficient calendar permissions.' });
    }

    res.status(500).json({ error: 'Failed to fetch calendar data' });
  }
});

// ---------------------------------------------------------------------------
// 404 + global error handlers
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Express 5 requires the error handler to have exactly 4 params
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = app;

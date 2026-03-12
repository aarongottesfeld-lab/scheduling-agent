// server/index.js — Express application entry point
//
// Responsibilities:
//   - Environment validation and Supabase client initialization
//   - Google OAuth2 flow (login, callback, logout)
//   - HTTP-only cookie-based session management backed by Supabase `sessions` table
//   - requireAuth middleware (reads cookie → DB lookup → populates req.userId)
//   - Calendar availability endpoint
//   - Mounts all feature routers (users, friends, nudges, schedule, notifications)
//   - Dev-only user switcher for testing without full OAuth
//
// Session model:
//   Sessions are persisted in the `sessions` table in Supabase.
//   The session token lives in an HTTP-only cookie called `rendezvous_session`.
//   requireAuth reads the cookie, queries the DB, and rejects expired sessions.
//   The in-memory userSessions Map is GONE — safe across serverless restarts.
//
// Serverless / local-dev dual-mode:
//   When run directly (`node server/index.js`) app.listen() starts a local server.
//   When imported as a module (Vercel serverless runtime), app.listen() is skipped
//   and the exported `app` is invoked per-request instead.
//   The `require.main === module` guard at the bottom controls which path runs.
//
// /api path-strip middleware:
//   In production on Vercel, all API calls are prefixed with /api (e.g. GET /api/auth/me)
//   so vercel.json can route them to this function instead of the React SPA fallback.
//   A middleware registered just before the feature routers strips the /api prefix so
//   all route handlers can continue using their plain paths (/auth/me, /friends, etc.)
//   without modification.  In local dev REACT_APP_SERVER_URL points directly to
//   localhost:3001 with no prefix, so this middleware is a no-op there.
//
// CORS — CLIENT_URL env var:
//   In production, cors() only accepts requests from CLIENT_URL.
//   Set CLIENT_URL in Vercel's environment variables dashboard to the deployed
//   frontend URL (e.g. https://rendezvous.vercel.app) before the first deploy.

'use strict';

require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');
const { google }   = require('googleapis');
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

const PORT      = parseInt(process.env.PORT || '3001', 10);
const IS_PROD   = process.env.NODE_ENV === 'production';
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
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

/**
 * Creates a fresh Google OAuth2 client per-request.
 * Never share a single client across requests — setCredentials mutates state.
 * Optionally pre-loads stored tokens (e.g. from the sessions table).
 */
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
// CSRF state tokens (in-memory — ephemeral by design)
// These only live for the 1–2 seconds of the OAuth redirect flow.
// Losing them on a cold start is harmless (user just has to click "Login" again).
// ---------------------------------------------------------------------------

/**
 * CSRF state tokens: Map<state, { createdAt: number }>
 * Tokens are deleted immediately on use. This interval cleans up any orphans
 * (e.g. user navigated away before completing OAuth).
 */
const oauthStates = new Map();

// Purge OAuth states older than 10 minutes to prevent unbounded growth
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, data] of oauthStates.entries()) {
    if (data.createdAt < cutoff) oauthStates.delete(state);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Supabase session helpers
// ---------------------------------------------------------------------------
// Sessions are stored in the `sessions` table. The session token is a 64-char
// hex string (32 random bytes) that lives in an HTTP-only cookie on the client.
// The server never returns the token to the client via JSON — only via Set-Cookie.

/**
 * Creates a new session row in Supabase and returns the session token.
 * Called after successful OAuth (createSession) and in the dev switcher.
 *
 * @param {object} params
 * @param {string} params.supabaseId  - Supabase UUID of the user
 * @param {string} params.email       - Google email (null for dev users)
 * @param {string} params.name        - Display name
 * @param {string} params.picture     - Avatar URL (Google picture or uploaded)
 * @param {object} params.tokens      - Google OAuth tokens (null for dev users)
 * @returns {string} sessionToken
 */
async function createSession({ supabaseId, email, name, picture, tokens }) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const { error } = await supabase.from('sessions').insert({
    session_token: sessionToken,
    supabase_id:   supabaseId,
    email,
    name,
    picture,
    tokens,
    last_seen_at: new Date().toISOString(),
  });
  if (error) throw new Error('Failed to create session: ' + error.message);
  return sessionToken;
}

/**
 * Looks up a session by its token. Returns the full row or null.
 * Only returns rows that haven't expired (expires_at > now).
 *
 * @param {string} sessionToken
 * @returns {object|null} session row or null if not found / expired
 */
async function getSession(sessionToken) {
  if (!sessionToken) return null;
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('session_token', sessionToken)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) return null;
  return data;
}

/**
 * Looks up the most recently active non-expired session for a given Supabase user ID.
 * Used by the schedule router to access Google Calendar tokens for calendar lookups
 * and event creation on behalf of the organizer or attendee.
 *
 * @param {string} supabaseId - Supabase UUID to look up
 * @returns {object|null} session-like object { tokens, email, name, picture, supabaseId }
 */
async function getSessionBySupabaseId(supabaseId) {
  const { data } = await supabase
    .from('sessions')
    .select('tokens, email, name, picture, supabase_id')
    .eq('supabase_id', supabaseId)
    .gt('expires_at', new Date().toISOString())
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  // Return shape compatible with what schedule.js expects from a session object
  return {
    tokens:     data.tokens,
    email:      data.email,
    name:       data.name,
    picture:    data.picture,
    supabaseId: data.supabase_id,
  };
}

/**
 * Updates the OAuth tokens on an existing session (called after token refresh).
 * Also bumps last_seen_at so the session appears recently active.
 *
 * @param {string} sessionToken
 * @param {object} tokens - new Google OAuth credentials
 */
async function updateSessionTokens(sessionToken, tokens) {
  await supabase
    .from('sessions')
    .update({ tokens, last_seen_at: new Date().toISOString() })
    .eq('session_token', sessionToken);
}

/**
 * Deletes a session row by token (called on logout).
 * @param {string} sessionToken
 */
async function deleteSession(sessionToken) {
  await supabase.from('sessions').delete().eq('session_token', sessionToken);
}

// ---------------------------------------------------------------------------
// Cookie options
// ---------------------------------------------------------------------------
// HTTP-only: JS cannot read this cookie — immune to XSS token theft.
// secure: HTTPS-only in production (Vercel always uses HTTPS).
// sameSite: 'none' in production for cross-origin Vercel deploys;
//           'lax' in dev (client and server both on localhost).
// maxAge: 30 days (matches the sessions table expires_at default).

/**
 * Returns the Set-Cookie options for the session cookie.
 * Accepts an optional override for shorter-lived dev sessions.
 */
function cookieOptions(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
  return {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
    maxAge:   maxAgeMs,
    path:     '/',
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.disable('x-powered-by');

app.use(
  cors({
    // In dev, reflect the request's Origin header (supports localhost:3000).
    // In production, lock to CLIENT_URL only.
    origin: IS_PROD ? CLIENT_URL : true,
    credentials: true, // required for cookie-based cross-origin requests
  })
);

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// Must come after express.json — parses Cookie header into req.cookies
app.use(cookieParser());

// ---------------------------------------------------------------------------
// /api path-strip middleware (Vercel production only)
// ---------------------------------------------------------------------------
// Must be registered BEFORE any route handlers so that every route sees the
// stripped path from the very first evaluation.
// In production on Vercel, all API calls are prefixed with /api so vercel.json
// can route them to this function. This middleware strips that prefix so the
// route handlers below use their plain paths (/auth/me, /friends, etc.).
// In local dev REACT_APP_SERVER_URL points to localhost:3001 with no prefix,
// so this middleware is a no-op there.
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/')) {
    req.url = req.url.slice(4); // '/api/auth/me' → '/auth/me'
  }
  next();
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

/**
 * Protects routes that require a valid session.
 * Reads the session token from the HTTP-only cookie (all environments) or,
 * in development only, from the x-user-id request header (curl / test tooling).
 *
 * Security note on the header fallback:
 *   The HTTP-only cookie is immune to XSS — JavaScript cannot read it.
 *   Accepting the same token via a plain header in production would defeat
 *   that guarantee: any script that exfiltrates the header could replay requests.
 *   The header fallback is therefore gated strictly to !IS_PROD so it is
 *   compiled out of the deployed binary.
 *
 * Populates:
 *   req.sessionToken  — the raw session token (used for logout / token refresh)
 *   req.userSession   — { tokens, email, name, picture, supabaseId }
 *   req.userId        — Supabase UUID (used for all DB queries)
 */
async function requireAuth(req, res, next) {
  // Always prefer the HTTP-only cookie — it is the production auth mechanism.
  let sessionToken = req.cookies?.rendezvous_session;

  if (!IS_PROD) {
    // Dev-only fallback: allow the session token to arrive via the x-user-id header
    // so curl commands and automated tests can authenticate without a real browser
    // cookie jar.  This branch is never reached in production.
    sessionToken = sessionToken || req.headers['x-user-id'];
  }

  if (!sessionToken) {
    return res.status(401).json({ error: 'Unauthorized. Authenticate via /auth/google first.' });
  }

  let session;
  try {
    session = await getSession(sessionToken);
  } catch (e) {
    console.error('requireAuth: session lookup failed:', e.message);
    return res.status(500).json({ error: 'Session lookup failed. Please try again.' });
  }

  if (!session) {
    return res.status(401).json({ error: 'Session expired or invalid. Please re-authenticate.' });
  }

  req.sessionToken = sessionToken;
  req.userSession  = {
    tokens:     session.tokens,
    email:      session.email,
    name:       session.name,
    picture:    session.picture,
    supabaseId: session.supabase_id,
  };
  req.userId = session.supabase_id;
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
  const payload = { status: 'ok', timestamp: new Date().toISOString() };

  if (!IS_PROD) {
    payload.env = process.env.NODE_ENV || 'development';
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
 * Generates and stores a CSRF state token, then redirects to Google.
 */
app.get('/auth/google', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, { createdAt: Date.now() });

  const authUrl = createOAuth2Client().generateAuthUrl({
    access_type: 'offline',
    scope:       GOOGLE_SCOPES,
    state,
    prompt: 'consent', // ensures refresh_token is always issued
  });

  res.redirect(authUrl);
});

/**
 * GET /auth/google/callback
 * Handles the redirect from Google after user consent.
 * Exchanges the authorization code for tokens, upserts the user profile,
 * creates a session row in Supabase, and sets an HTTP-only session cookie.
 *
 * The redirect to CLIENT_URL no longer carries the session token or supabaseId
 * in the URL — only non-sensitive display params (name, picture, new flag).
 */
app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Google OAuth error:', error);
    return res.redirect(`${CLIENT_URL}?error=${encodeURIComponent('Google authorization was denied')}`);
  }

  // Validate CSRF state — reject if missing or unknown
  if (!state || !oauthStates.has(state)) {
    return res.status(400).json({ error: 'Invalid or expired OAuth state' });
  }
  oauthStates.delete(state); // consume the state token (one-time use)

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    const client = createOAuth2Client();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Fetch user profile from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: profile } = await oauth2.userinfo.get();

    // Find or create the Supabase profile row.
    // We manage auth ourselves (not Supabase Auth) so we generate UUIDs here.
    let supabaseId;
    const { data: existing } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', profile.email)
      .maybeSingle();

    if (existing?.id) {
      supabaseId = existing.id;
    } else {
      const newId = crypto.randomUUID();
      const { data: created, error: createErr } = await supabase
        .from('profiles')
        .insert({ id: newId, email: profile.email, full_name: profile.name })
        .select('id')
        .single();
      if (createErr || !created?.id) {
        console.error('Supabase profile create failed:', createErr?.message);
        return res.redirect(`${CLIENT_URL}?error=${encodeURIComponent('Account setup failed. Please try again.')}`);
      }
      supabaseId = created.id;
    }

    // Persist the session to Supabase and set the HTTP-only cookie
    const sessionToken = await createSession({
      supabaseId,
      email:   profile.email,
      name:    profile.name,
      picture: profile.picture,
      tokens,
    });

    res.cookie('rendezvous_session', sessionToken, cookieOptions());

    // Check if brand-new user (no username yet) to trigger onboarding redirect
    const { data: freshProfile } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', supabaseId)
      .single();
    const isNew = !freshProfile?.username;

    // name and picture are non-sensitive display params — safe to put in the URL.
    // sessionToken and supabaseId are no longer in the redirect URL.
    const pictureParam = profile.picture ? `&picture=${encodeURIComponent(profile.picture)}` : '';
    const newParam     = isNew ? '&new=1' : '';
    res.redirect(`${CLIENT_URL}?name=${encodeURIComponent(profile.name || '')}${pictureParam}${newParam}`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect(`${CLIENT_URL}?error=${encodeURIComponent('Authentication failed. Please try again.')}`);
  }
});

/**
 * GET /auth/me
 * Returns the authenticated user's display info and supabaseId.
 * The client calls this on app load to confirm the cookie is still valid
 * and to get the supabaseId (which is never stored client-side after the URL change).
 */
app.get('/auth/me', requireAuth, (req, res) => {
  const { email, name, picture } = req.userSession;
  // userId here is the Supabase UUID — the client uses it for role comparisons (isOrganizer etc.)
  res.json({ userId: req.userId, email, name, picture });
});

/**
 * POST /auth/logout
 * Deletes the server-side session row and clears the cookie.
 */
app.post('/auth/logout', requireAuth, async (req, res) => {
  await deleteSession(req.sessionToken);
  // Clear the cookie on the client
  res.clearCookie('rendezvous_session', { path: '/' });
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
    return res.status(400).json({ error: 'timeMin and timeMax are required query parameters (ISO 8601)' });
  }

  const start = new Date(timeMin);
  const end   = new Date(timeMax);

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

    // Proactively refresh the access token if it expires within 60 seconds.
    // Persist the new credentials back to the DB so subsequent requests work
    // without re-authenticating.
    const { expiry_date } = req.userSession.tokens;
    if (expiry_date && expiry_date - Date.now() < 60 * 1000) {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      await updateSessionTokens(req.sessionToken, credentials);
      req.userSession.tokens = credentials;
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
        // Only fetch fields we actually need — reduces response size
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
      id:          e.id,
      summary:     e.summary || '(No title)',
      start:       e.start,
      end:         e.end,
      status:      e.status,
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
    if (status === 401) return res.status(401).json({ error: 'Calendar token expired or revoked. Please re-authenticate.' });
    if (status === 403) return res.status(403).json({ error: 'Insufficient calendar permissions.' });
    res.status(500).json({ error: 'Failed to fetch calendar data' });
  }
});

// ---------------------------------------------------------------------------
// Feature routes
// ---------------------------------------------------------------------------
require('./routes/users')(app, supabase, requireAuth);
require('./routes/friends')(app, supabase, requireAuth);
require('./routes/nudges')(app, supabase, requireAuth);
// Pass getSessionBySupabaseId so the schedule router can look up calendar tokens
// for other users (friend's calendar, organizer/attendee event creation).
require('./routes/schedule')(app, supabase, requireAuth, { getSessionBySupabaseId });
require('./routes/notifications')(app, supabase, requireAuth);

// ---------------------------------------------------------------------------
// Dev-only: user switcher — impersonate any test user without OAuth
// ONLY available when NODE_ENV !== production
// ---------------------------------------------------------------------------
if (!IS_PROD) {
  const DEV_USERS = {
    'jamiec':  '11111111-1111-1111-1111-111111111111',
    'mrivera': '22222222-2222-2222-2222-222222222222',
    'tkim':    '33333333-3333-3333-3333-333333333333',
    'alexp':   '44444444-4444-4444-4444-444444444444',
  };

  /**
   * GET /dev/switch-user/:username
   * Creates a real session row in Supabase for the given dev user and sets a
   * short-lived session cookie. Redirects to CLIENT_URL with only the name param.
   * No OAuth flow required — useful for switching between test accounts.
   */
  app.get('/dev/switch-user/:username', async (req, res) => {
    const supabaseId = DEV_USERS[req.params.username];
    if (!supabaseId) {
      return res.status(404).json({ error: 'Unknown dev user. Options: ' + Object.keys(DEV_USERS).join(', ') });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, avatar_url')
      .eq('id', supabaseId)
      .single();

    const name      = profile?.full_name || req.params.username;
    const avatarUrl = profile?.avatar_url || null;

    // Dev sessions: no tokens (no real Google OAuth), 1-day expiry
    const sessionToken = await createSession({
      supabaseId,
      email:   null,
      name,
      picture: avatarUrl,
      tokens:  null,
    });

    // Short-lived dev cookie — no HTTPS requirement (dev only)
    res.cookie('rendezvous_session', sessionToken, cookieOptions(24 * 60 * 60 * 1000));

    const picParam = avatarUrl ? `&picture=${encodeURIComponent(avatarUrl)}` : '';
    res.redirect(`${CLIENT_URL}?name=${encodeURIComponent(name)}${picParam}`);
  });

  /**
   * GET /dev/users
   * Lists available dev test users and their switch URLs.
   */
  app.get('/dev/users', (req, res) => {
    res.json({
      users: Object.keys(DEV_USERS).map(u => ({
        username: u,
        id:  DEV_USERS[u],
        url: `/dev/switch-user/${u}`,
      })),
    });
  });
}

// ---------------------------------------------------------------------------
// 404 + global error handlers
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Express 5 async error handler — must have exactly 4 params
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start — local dev vs serverless dual-mode
// ---------------------------------------------------------------------------
// require.main === module is true when this file is run directly:
//   node server/index.js   → starts a local HTTP server on PORT
//
// When Vercel imports this file as a serverless function module, require.main
// is the Vercel runtime module (not this file), so app.listen() is skipped.
// Vercel instead calls the exported `app` directly per-request.
//
// Never call app.listen() in a serverless environment — each invocation is
// stateless and there is no persistent process to accept connections.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });
}

// Export the Express app so Vercel's @vercel/node runtime can invoke it as a
// serverless function.  Also used by integration tests that import the app
// directly without starting a real HTTP server.
module.exports = app;

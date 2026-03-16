// mcp/auth.js — OAuth 2.0 authorization server + API key auth for MCP
//
// Two auth modes:
//   1. OAuth 2.0: AI client redirects user → consent → code exchange → Bearer token
//   2. MCP_API_KEY: static dev key that maps to MCP_OWNER_USER_ID (dev only, logs warning)
//
// Token storage: mcp_tokens table in Supabase (24h expiry, auto-cleanup on validate).

'use strict';

const crypto = require('crypto');
const express = require('express');

// In-memory store for pending OAuth authorization codes (short-lived, <10 min).
// Safe for a single-process persistent server (not serverless).
const pendingCodes = new Map();

// Clean up expired codes every 5 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pendingCodes) {
    if (now > entry.expiresAt) pendingCodes.delete(code);
  }
}, 5 * 60 * 1000);

/**
 * Mount OAuth routes on the Express app.
 * @param {object} app      - Express app
 * @param {object} supabase - Supabase client (service role)
 */
function mountOAuthRoutes(app, supabase) {
  const RENDEZVOUS_APP_URL = process.env.RENDEZVOUS_APP_URL || 'http://localhost:3000';
  const MCP_SERVER_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : (process.env.MCP_SERVER_URL || 'http://localhost:3002');

  // GET / — service info (prevents 404 on probe)
  app.get('/', (_req, res) => {
    res.json({
      service: 'Rendezvous MCP Server',
      version: '1.0.0',
      docs: 'https://rendezvous-gamma.vercel.app/help',
    });
  });

  // GET /.well-known/oauth-authorization-server — RFC 8414
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: MCP_SERVER_URL,
      authorization_endpoint: `${MCP_SERVER_URL}/oauth/authorize`,
      token_endpoint: `${MCP_SERVER_URL}/oauth/token`,
      registration_endpoint: `${MCP_SERVER_URL}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  // GET /.well-known/oauth-protected-resource — RFC 9728
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: MCP_SERVER_URL,
      authorization_servers: [MCP_SERVER_URL],
      bearer_methods_supported: ['header'],
      resource_documentation: `${MCP_SERVER_URL}/docs`,
    });
  });

  // POST /register — Dynamic client registration (RFC 7591)
  app.post('/register', express.json(), async (req, res) => {
    const { redirect_uris, client_name } = req.body;

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({ error: 'redirect_uris must be a non-empty array.' });
    }

    for (const uri of redirect_uris) {
      if (typeof uri !== 'string') {
        return res.status(400).json({ error: 'Each redirect_uri must be a string.' });
      }
      // Allow http:// only for localhost (dev)
      if (!uri.startsWith('https://') && !uri.match(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/)) {
        return res.status(400).json({ error: `Invalid redirect_uri: ${uri}. Must use https:// (http:// allowed only for localhost).` });
      }
    }

    const generatedClientId = crypto.randomBytes(16).toString('hex');
    const resolvedName = client_name || 'Unknown Client';

    // Persist in Supabase so the consent page can look up the friendly name
    // even after a server restart.
    const { error: insertErr } = await supabase
      .from('mcp_client_registrations')
      .insert({
        client_id: generatedClientId,
        client_name: resolvedName,
        redirect_uris,
      });

    if (insertErr) {
      console.error('[mcp/auth] client registration insert failed:', insertErr.message);
      // Non-fatal — consent page will fall back to showing the raw client_id.
    }

    res.status(201).json({
      client_id: generatedClientId,
      client_name: resolvedName,
      redirect_uris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  // GET /oauth/client-info — look up friendly client name for consent page
  app.get('/oauth/client-info', async (req, res) => {
    const { client_id } = req.query;
    if (!client_id) return res.json({ client_name: null });

    const { data } = await supabase
      .from('mcp_client_registrations')
      .select('client_name')
      .eq('client_id', client_id)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    // Best-effort cleanup of expired rows (fire-and-forget).
    supabase
      .from('mcp_client_registrations')
      .delete()
      .lt('expires_at', new Date().toISOString())
      .then(() => {})
      .catch(() => {});

    res.json({ client_name: data?.client_name || null });
  });

  // GET /oauth/authorize — AI client redirects user here
  app.get('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, response_type, state, scope } = req.query;

    if (response_type !== 'code') {
      return res.status(400).json({ error: 'Only response_type=code is supported.' });
    }
    if (!client_id || !redirect_uri || !state) {
      return res.status(400).json({ error: 'client_id, redirect_uri, and state are required.' });
    }

    // Store the authorization request params and redirect to Rendezvous consent screen.
    const authRequestId = crypto.randomBytes(16).toString('hex');
    const challengeToken = crypto.randomBytes(16).toString('hex');
    pendingCodes.set(authRequestId, {
      clientId:       client_id,
      redirectUri:    redirect_uri,
      state,
      scope:          scope || 'read_write',
      challengeToken,
      expiresAt:      Date.now() + 10 * 60 * 1000,
    });

    // Redirect to the main Rendezvous app's MCP consent page.
    // The challenge_token must be echoed back via /oauth/callback to prove the caller
    // received it from this authorization flow (prevents forged callback requests).
    const consentUrl = `${RENDEZVOUS_APP_URL}/mcp-auth?auth_request_id=${authRequestId}&client_id=${encodeURIComponent(client_id)}&scope=${encodeURIComponent(scope || 'read_write')}&challenge_token=${challengeToken}&mcp_server_url=${encodeURIComponent(MCP_SERVER_URL)}`;
    res.redirect(consentUrl);
  });

  // GET /oauth/callback — Rendezvous app calls this after user approves consent
  app.get('/oauth/callback', async (req, res) => {
    const { auth_request_id, user_id, challenge_token } = req.query;

    if (!auth_request_id || !user_id || !challenge_token) {
      return res.status(400).json({ error: 'auth_request_id, user_id, and challenge_token are required.' });
    }

    const pending = pendingCodes.get(auth_request_id);
    if (!pending) {
      return res.status(400).json({ error: 'Authorization request expired or not found.' });
    }

    // Validate challenge_token — ensures the callback came from a caller that received
    // the original /oauth/authorize redirect (not a forged request with a guessed user_id).
    if (challenge_token !== pending.challengeToken) {
      return res.status(400).json({ error: 'Invalid challenge_token.' });
    }

    pendingCodes.delete(auth_request_id);

    // Generate a short-lived authorization code.
    const code = crypto.randomBytes(32).toString('hex');
    pendingCodes.set(`code:${code}`, {
      userId:      user_id,
      clientId:    pending.clientId,
      redirectUri: pending.redirectUri,
      scope:       pending.scope,
      expiresAt:   Date.now() + 5 * 60 * 1000, // 5 min
    });

    // Redirect back to AI client with the authorization code.
    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set('code', code);
    redirectUrl.searchParams.set('state', pending.state);
    res.redirect(redirectUrl.toString());
  });

  // POST /oauth/token — AI client exchanges code for access token
  // RFC 6749 §4.1.3 requires application/x-www-form-urlencoded; also accept JSON for flexibility.
  app.post('/oauth/token', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
    const { code, grant_type, client_id, redirect_uri } = req.body;

    if (grant_type !== 'authorization_code') {
      return res.status(400).json({ error: 'Only grant_type=authorization_code is supported.' });
    }
    if (!code) {
      return res.status(400).json({ error: 'code is required.' });
    }

    const pending = pendingCodes.get(`code:${code}`);
    if (!pending) {
      return res.status(400).json({ error: 'Invalid or expired authorization code.' });
    }
    pendingCodes.delete(`code:${code}`);

    // Validate client_id and redirect_uri match.
    if (client_id && client_id !== pending.clientId) {
      return res.status(400).json({ error: 'client_id mismatch.' });
    }
    if (redirect_uri && redirect_uri !== pending.redirectUri) {
      return res.status(400).json({ error: 'redirect_uri mismatch.' });
    }

    // Generate access token and store in Supabase.
    const accessToken = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { error } = await supabase.from('mcp_tokens').insert({
      user_id:      pending.userId,
      access_token: accessToken,
      client_id:    pending.clientId,
      scope:        pending.scope,
      expires_at:   expiresAt,
    });

    if (error) {
      console.error('[mcp/auth] token insert failed:', error.message);
      return res.status(500).json({ error: 'Could not create access token.' });
    }

    res.json({
      access_token: accessToken,
      token_type:   'Bearer',
      expires_in:   86400,
      scope:        pending.scope,
    });
  });
}

/**
 * Middleware: validates Bearer token from Authorization header.
 * Supports two modes:
 *   1. MCP_API_KEY match → use MCP_OWNER_USER_ID (dev shortcut, logs warning)
 *   2. Supabase mcp_tokens lookup → validates expiry, populates req.userId
 */
function requireMcpAuth(supabase) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
    }

    const token = authHeader.slice(7);

    // Mode 1: Static API key (dev shortcut)
    if (process.env.MCP_API_KEY && token === process.env.MCP_API_KEY) {
      if (!process.env.MCP_OWNER_USER_ID) {
        return res.status(500).json({ error: 'MCP_OWNER_USER_ID not configured.' });
      }
      console.warn('[mcp/auth] WARNING: Request authenticated via MCP_API_KEY — do not use in production.');
      req.userId = process.env.MCP_OWNER_USER_ID;
      return next();
    }

    // Mode 2: OAuth token lookup
    try {
      const { data: tokenRow, error } = await supabase
        .from('mcp_tokens')
        .select('user_id, expires_at')
        .eq('access_token', token)
        .maybeSingle();

      if (error || !tokenRow) {
        return res.status(401).json({ error: 'Invalid access token.' });
      }

      if (new Date(tokenRow.expires_at) < new Date()) {
        // Clean up expired token.
        await supabase.from('mcp_tokens').delete().eq('access_token', token);
        return res.status(401).json({ error: 'Access token expired. Please re-authorize.' });
      }

      // Bump last_used_at (fire-and-forget).
      supabase.from('mcp_tokens')
        .update({ last_used_at: new Date().toISOString() })
        .eq('access_token', token)
        .then(() => {})
        .catch(() => {});

      req.userId = tokenRow.user_id;
      next();
    } catch (err) {
      console.error('[mcp/auth] token validation error:', err.message);
      return res.status(500).json({ error: 'Token validation failed.' });
    }
  };
}

module.exports = { mountOAuthRoutes, requireMcpAuth };

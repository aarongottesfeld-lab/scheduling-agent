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
    pendingCodes.set(authRequestId, {
      clientId:    client_id,
      redirectUri: redirect_uri,
      state,
      scope:       scope || 'read_write',
      expiresAt:   Date.now() + 10 * 60 * 1000,
    });

    // Redirect to the main Rendezvous app's MCP consent page.
    const consentUrl = `${RENDEZVOUS_APP_URL}/mcp-auth?auth_request_id=${authRequestId}&client_id=${encodeURIComponent(client_id)}&scope=${encodeURIComponent(scope || 'read_write')}`;
    res.redirect(consentUrl);
  });

  // GET /oauth/callback — Rendezvous app calls this after user approves consent
  app.get('/oauth/callback', async (req, res) => {
    const { auth_request_id, user_id } = req.query;

    if (!auth_request_id || !user_id) {
      return res.status(400).json({ error: 'auth_request_id and user_id are required.' });
    }

    const pending = pendingCodes.get(auth_request_id);
    if (!pending) {
      return res.status(400).json({ error: 'Authorization request expired or not found.' });
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
  app.post('/oauth/token', express.json(), async (req, res) => {
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

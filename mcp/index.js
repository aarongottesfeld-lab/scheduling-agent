// mcp/index.js — Rendezvous MCP server entry point
//
// Supports two transport modes:
//
// 1. stdio (Claude Desktop) — launched as a subprocess, communicates via
//    stdin/stdout JSON-RPC. Detected automatically when stdout is not a TTY.
//    Override with MCP_FORCE_HTTP=1 to use SSE even when piped.
//
// 2. SSE/HTTP (Claude.ai, ChatGPT, etc.) — persistent Express server with
//    GET /sse and POST /messages endpoints. Requires Bearer token auth.
//
// Auth:
//   - stdio mode: MCP_OWNER_USER_ID (required) — single-user, no HTTP auth
//   - SSE mode:   MCP_API_KEY (dev) or OAuth tokens in mcp_tokens table
//
// Architecture: one McpServer instance per connection. Tool callbacks close
// over the authenticated userId so every DB query is scoped to the correct user.
//
// Does NOT share runtime with server/ — imports shared utilities via relative paths.

'use strict';

// Suppress dotenv v17's verbose stdout banner — breaks MCP client stdio transport.
const _stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
require('dotenv').config();
process.stdout.write = _stdoutWrite;

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Validate required environment variables
// ---------------------------------------------------------------------------
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error('Missing required environment variables:', missingEnv.join(', '));
  process.exit(1);
}

const PORT = parseInt(process.env.MCP_PORT || '3002', 10);
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Transport mode detection
// ---------------------------------------------------------------------------
// stdio: Claude Desktop launches this as a subprocess — stdout is piped, not a TTY.
// SSE:   standalone HTTP server (npm run dev, production deploy).
// MCP_FORCE_HTTP=1 overrides to SSE mode even when stdout is piped (useful for
// running behind a process manager that captures stdout).
const isStdio = !process.stdout.isTTY && !process.env.MCP_FORCE_HTTP;

// ---------------------------------------------------------------------------
// Supabase client (service role — never expose to client)
// ---------------------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------------------------------------------------------
// Session store — look up Google Calendar tokens for a user
// ---------------------------------------------------------------------------
async function getSessionBySupabaseId(supabaseId) {
  const { data } = await supabase
    .from('sessions')
    .select('tokens, email, name, picture, supabase_id')
    .eq('supabase_id', supabaseId)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    tokens: data.tokens,
    email: data.email,
    name: data.name,
    picture: data.picture,
    supabaseId: data.supabase_id,
  };
}

const config = { getSessionBySupabaseId };

// ---------------------------------------------------------------------------
// Create a per-connection McpServer with tools scoped to userId
// ---------------------------------------------------------------------------
function createMcpServerForUser(userId) {
  const server = new McpServer({
    name: 'rendezvous',
    version: '1.0.0',
  });

  // Each tool module's registerTools receives userId so callbacks can scope queries.
  require('./tools/friends').registerTools(server, supabase, config, userId);
  require('./tools/availability').registerTools(server, supabase, config, userId);
  require('./tools/itineraries').registerTools(server, supabase, config, userId);
  require('./tools/generate').registerTools(server, supabase, config, userId);
  require('./tools/groups').registerTools(server, supabase, config, userId);

  return server;
}

// ===========================================================================
// stdio mode — Claude Desktop subprocess
// ===========================================================================
if (isStdio) {
  const userId = process.env.MCP_OWNER_USER_ID;
  if (!userId) {
    console.error('MCP_OWNER_USER_ID is required for stdio mode.');
    process.exit(1);
  }

  (async () => {
    const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
    const transport = new StdioServerTransport();
    const mcpServer = createMcpServerForUser(userId);
    await mcpServer.connect(transport);
    // Server now communicates via stdin/stdout JSON-RPC — no HTTP needed.
  })().catch(err => {
    console.error('stdio transport failed:', err.message);
    process.exit(1);
  });

} else {
  // =========================================================================
  // SSE/HTTP mode — standalone Express server
  // =========================================================================
  const express = require('express');
  const cors = require('cors');
  const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
  const { mountOAuthRoutes, requireMcpAuth } = require('./auth');

  const app = express();
  app.disable('x-powered-by');

  // CORS — allow configured origins in production, reflect in dev
  const allowedOrigins = process.env.MCP_ALLOWED_ORIGINS
    ? process.env.MCP_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  app.use(cors({
    origin: IS_PROD
      ? (origin, cb) => {
          if (!origin || allowedOrigins.includes(origin)) cb(null, true);
          else cb(new Error('CORS not allowed'));
        }
      : true,
    credentials: true,
  }));

  // Parse JSON for POST /messages and form-encoded for OAuth token exchange (RFC 6749 §4.1.3)
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // ── Rate limiting — 60 requests/min per userId (in-memory sliding window) ──
  const rateLimitWindow = new Map();
  const RATE_LIMIT = 60;
  const RATE_WINDOW_MS = 60 * 1000;

  function checkRateLimit(userId) {
    const now = Date.now();
    const timestamps = rateLimitWindow.get(userId) || [];
    const recent = timestamps.filter(t => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) return false;
    recent.push(now);
    rateLimitWindow.set(userId, recent);
    return true;
  }

  // Clean up old entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [userId, timestamps] of rateLimitWindow) {
      const recent = timestamps.filter(t => now - t < RATE_WINDOW_MS);
      if (recent.length === 0) rateLimitWindow.delete(userId);
      else rateLimitWindow.set(userId, recent);
    }
  }, 5 * 60 * 1000);

  // ── Auth middleware ──
  const authMiddleware = requireMcpAuth(supabase);

  // ── Health check — no auth required ──
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'rendezvous-mcp', timestamp: new Date().toISOString() });
  });

  // ── OAuth routes ──
  mountOAuthRoutes(app, supabase);

  // ── SSE transport — multi-session support ──
  const sessions = {};

  app.get('/sse', authMiddleware, async (req, res) => {
    if (!checkRateLimit(req.userId)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Max 60 requests per minute.' });
    }

    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    const mcpServer = createMcpServerForUser(req.userId);

    sessions[sessionId] = { transport, userId: req.userId, mcpServer };

    res.on('close', () => {
      delete sessions[sessionId];
    });

    await mcpServer.connect(transport);
  });

  app.post('/messages', authMiddleware, async (req, res) => {
    const sessionId = req.query.sessionId;
    const session = sessions[sessionId];

    if (!session) {
      return res.status(400).json({ error: 'Unknown session. Connect via /sse first.' });
    }

    if (session.userId !== req.userId) {
      return res.status(403).json({ error: 'Session does not belong to this user.' });
    }

    if (!checkRateLimit(req.userId)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Max 60 requests per minute.' });
    }

    await session.transport.handlePostMessage(req, res);
  });

  // ── 404 + error handlers ──
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // ── Start server ──
  app.listen(PORT, () => {
    if (process.stdout.isTTY) {
      console.log(`Rendezvous MCP server listening on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
      console.log(`  SSE endpoint: http://localhost:${PORT}/sse`);
      console.log(`  Health check: http://localhost:${PORT}/health`);
      if (process.env.MCP_API_KEY) {
        console.log('  WARNING: MCP_API_KEY is set — dev auth shortcut is active');
      }
    }
  });
}

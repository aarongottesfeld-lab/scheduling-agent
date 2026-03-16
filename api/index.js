// api/index.js
// Vercel serverless entry point for all /api/* requests.
//
// Vercel rewrites /api/auth/google to /api/index?__path=auth/google.
// The rewrite changes req.url to /api/index, losing the original path.
// This wrapper reconstructs the full /api/... URL from the __path query param
// BEFORE handing off to Express, so the path-strip middleware and all route
// handlers see the correct path.

const { parse } = require('url');
const app = require('../server/index.js');

const handler = (req, res) => {
  // Reconstruct original path from the __path param injected by the rewrite:
  //   { source: "/api/:path*", destination: "/api/index?__path=:path*" }
  // Without this, req.url would be /api/index and Express would 404.
  const { query } = parse(req.url, true);
  if (query.__path) {
    req.url = '/api/' + query.__path;
  }
  app(req, res);
};

// Allow up to 60s for long-running requests (e.g. AI generation pipeline).
handler.maxDuration = 60;

module.exports = handler;

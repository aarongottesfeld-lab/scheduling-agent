// api/[...path].js
// Vercel serverless catch-all entry point — handles all /api/* requests.
// The [...path] filename tells Vercel's file-system router to invoke this
// function for any path under /api/ without rewriting the URL.

const app = require('../server/index.js');

// Wrap the Express app to log the incoming URL for debugging.
module.exports = (req, res) => {
  console.log('[api/[...path].js] req.url =', req.url);
  app(req, res);
};

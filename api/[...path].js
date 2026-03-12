// api/[...path].js
// Vercel serverless catch-all entry point — handles all /api/* requests.
// The [...path] filename tells Vercel's file-system router to invoke this
// function for any path under /api/ without rewriting the URL.

const app = require('../server/index.js');

module.exports = app;

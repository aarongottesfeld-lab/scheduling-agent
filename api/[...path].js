// api/index.js
// Vercel serverless entry point — imports the Express app from server/index.js
// and exports it as the default handler for all /api/* requests.

const app = require('../server/index.js');

module.exports = app;

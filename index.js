// Vercel auto-detects an Express entry point at one of a fixed set of
// locations (index.js, app.js, server.js, or the same under src/) and
// deploys it as a single Vercel Function — no vercel.json function config
// needed. Static files in public/** are served separately by Vercel's CDN
// (express.static() is ignored entirely on Vercel), so this file exports
// only the API routes, with no app.listen() call.
//
// For local development, run `npm start` instead, which uses
// server/index.js (adds app.listen() and serves public/ via Express,
// since there's no CDN/static layer when running plain Node locally).
module.exports = require('./server/app');

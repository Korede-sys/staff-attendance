// Local development entry point: runs the Express app as a normal
// long-running server. On Vercel, the root-level index.js exports the
// same app without calling listen() — Vercel's runtime handles that part,
// and serves public/ separately via its CDN rather than express.static().
const path = require('path');
const express = require('express');
const app = require('./app');

const PORT = process.env.PORT || 3000;

// Serve the kiosk/admin static frontends when running locally. On Vercel
// these are served directly from /public by the platform instead.
app.use('/kiosk', express.static(path.join(__dirname, '..', 'public', 'kiosk')));
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.get('/', (req, res) => res.redirect('/kiosk'));

app.listen(PORT, () => {
  console.log(`Staff attendance server running on http://localhost:${PORT}`);
  console.log(`  Kiosk screen: http://localhost:${PORT}/kiosk`);
  console.log(`  Admin dashboard: http://localhost:${PORT}/admin`);
});

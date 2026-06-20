const express = require('express');
const crypto = require('crypto');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// Maintenance mode — MUST be first middleware (before JSON parsing, sessions, etc.)
app.use(require('./middleware/maintenance'));

// Initialize DB pool (non-fatal if DATABASE_URL missing)
require('./db/index');

app.use(express.json());

// Lightweight cookie-session for admin auth (no extra deps)
const sessions = new Map();
app.use((req, res, next) => {
  const SID_COOKIE = 'ff_sid';
  let sid = (req.headers.cookie || '').split(';').map(c => c.trim())
    .find(c => c.startsWith(SID_COOKIE + '='));
  sid = sid ? sid.split('=')[1] : null;
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, {});
    res.setHeader('Set-Cookie', `${SID_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  }
  req.session = sessions.get(sid);
  next();
});

// EJS view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Health check (required for Render — no DB query to allow Neon auto-suspend)
app.get('/health', (_req, res) => {
  res.json({ status: 'healthy' });
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use(express.static(path.join(__dirname, 'blackbox-3d-replay', 'dist'), { index: false }));

// Landing page
const { getPlatformStats } = require('./db/stats');
app.get('/', async (_req, res) => {
  const stats = await getPlatformStats();
  res.render('layout', { stats });
});

// Routes
app.use('/analyze', require('./routes/analyze'));
app.use('/advisor', require('./routes/advisor'));
app.use('/api/advisor', require('./routes/advisor'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/payments', require('./routes/payments'));
app.use('/payment', require('./routes/payments'));
app.use('/admin/feedback', require('./routes/admin'));

// Legacy /pricing route — redirect to homepage (all features are free now)
app.get('/pricing', (_req, res) => {
  res.redirect('/');
});

// Flight Replay — serve the new browser-only 3D replay prototype.
app.get('/replay', (_req, res) => {
  res.sendFile(path.join(__dirname, 'blackbox-3d-replay', 'dist', 'index.html'));
});

// Legacy replay kept for fallback while the new prototype is being folded in.
app.get('/replay-legacy', (_req, res) => {
  res.render('replay');
});

// Privacy policy
app.get('/privacy', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Privacy Policy - FlightForge</title></head><body style="background:#0d0d0f;color:#e8edf2;font-family:'Space Mono',monospace;max-width:680px;margin:40px auto;padding:0 24px;line-height:1.8"><h1 style="font-family:sans-serif;color:#00d4ff">Privacy Policy</h1><p>FlightForge does not require user accounts. Uploaded .BBL files are processed in-memory and are not stored on our servers. The AI Advisor runs entirely in your browser &mdash; no data is sent to any server.</p><p>We use anonymous analytics (page views only, no personal data). Payment processing is handled by Stripe.</p><p>Contact: via the in-app feedback form.</p><p><a href="/" style="color:#00d4ff">&larr; Back to FlightForge</a></p></body></html>`);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

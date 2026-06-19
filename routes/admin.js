/**
 * Admin feedback dashboard routes.
 * Owns: /admin/feedback page rendering, feedback CRUD API (status, priority, notes, bulk ops).
 * Does NOT own: feedback submission (see routes/feedback.js), database queries (see db/feedback.js).
 */
const express = require('express');
const crypto = require('crypto');
const {
  getStatusCounts, listFeedback, getFeedbackById,
  updateFeedbackStatus, updateFeedbackPriority, updateAdminNotes, bulkUpdateStatus,
} = require('../db/feedback');

const router = express.Router();

// Fallback password if env var not set — previous deploys failed to write ADMIN_PASSWORD to Render
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ff-admin-2026';
const VALID_STATUSES = ['new', 'in_progress', 'resolved', 'ignored'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (req.session && req.session.adminAuth) return next();
  // Check for API key in header (for AJAX calls)
  const authHeader = req.headers['x-admin-token'];
  if (authHeader && ADMIN_PASSWORD && authHeader === ADMIN_PASSWORD) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/admin/feedback/login');
}

// --- CSRF token helpers ---
function generateCsrf(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

function verifyCsrf(req, res, next) {
  const token = req.body._csrf || req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- Login page ---
router.get('/login', (_req, res) => {
  res.type('html').send(loginPage());
});

router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) return res.type('html').send(loginPage('Admin password not configured'));
  if (password !== ADMIN_PASSWORD) return res.type('html').send(loginPage('Wrong password'));
  req.session.adminAuth = true;
  res.redirect('/admin/feedback');
});

router.get('/logout', (req, res) => {
  req.session.adminAuth = false;
  res.redirect('/admin/feedback/login');
});

// --- Dashboard page ---
router.get('/', requireAuth, async (req, res) => {
  try {
    const csrf = generateCsrf(req);
    const counts = await getStatusCounts();
    res.render('admin-feedback', { counts, csrf });
  } catch (err) {
    console.error('[admin] Dashboard error:', err.message);
    res.status(500).send('Internal error');
  }
});

// --- API: list feedback (paginated, filterable) ---
router.get('/api/list', requireAuth, async (req, res) => {
  try {
    const status = req.query.status || 'all';
    const search = (req.query.search || '').trim().slice(0, 200);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const sort = req.query.sort === 'asc' ? 'asc' : 'desc';
    const result = await listFeedback({ status, search, page, limit: 20, sort });
    // Escape user content for safe rendering
    result.items = result.items.map(item => ({
      ...item,
      content: escapeHtml(item.content),
      contact_info: escapeHtml(item.contact_info),
      admin_notes: item.admin_notes, // admin-authored, not escaped
      source_page: escapeHtml(item.source_page),
    }));
    res.json(result);
  } catch (err) {
    console.error('[admin] List error:', err.message);
    res.status(500).json({ error: 'Failed to load feedback' });
  }
});

// --- API: get single feedback detail ---
router.get('/api/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
    const item = await getFeedbackById(id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    item.content = escapeHtml(item.content);
    item.contact_info = escapeHtml(item.contact_info);
    item.source_page = escapeHtml(item.source_page);
    res.json(item);
  } catch (err) {
    console.error('[admin] Detail error:', err.message);
    res.status(500).json({ error: 'Failed to load feedback' });
  }
});

// --- API: update status ---
router.patch('/api/:id/status', requireAuth, verifyCsrf, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await updateFeedbackStatus(id, status);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin] Status update error:', err.message);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// --- API: update priority ---
router.patch('/api/:id/priority', requireAuth, verifyCsrf, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { priority } = req.body;
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
    if (!VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
    await updateFeedbackPriority(id, priority);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin] Priority update error:', err.message);
    res.status(500).json({ error: 'Failed to update priority' });
  }
});

// --- API: update admin notes ---
router.patch('/api/:id/notes', requireAuth, verifyCsrf, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const notes = (req.body.notes || '').slice(0, 5000);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
    await updateAdminNotes(id, notes);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin] Notes update error:', err.message);
    res.status(500).json({ error: 'Failed to update notes' });
  }
});

// --- API: bulk status update ---
router.post('/api/bulk-status', requireAuth, verifyCsrf, async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
      return res.status(400).json({ error: 'Provide 1-100 IDs' });
    }
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const intIds = ids.map(i => parseInt(i, 10)).filter(i => !isNaN(i));
    const updated = await bulkUpdateStatus(intIds, status);
    res.json({ ok: true, updated });
  } catch (err) {
    console.error('[admin] Bulk update error:', err.message);
    res.status(500).json({ error: 'Failed to bulk update' });
  }
});

// --- Login page HTML (inline, minimal) ---
function loginPage(error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Login - FlightForge</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/theme.css">
<style>
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.login-card{background:var(--bg-card);border:1px solid rgba(255,255,255,.06);border-radius:var(--radius);padding:40px 32px;max-width:380px;width:100%}
.login-card h1{font-family:var(--font-display);font-size:1.4rem;color:#fff;margin-bottom:8px}
.login-card p{font-size:.85rem;color:var(--fg-muted);margin-bottom:24px}
.login-card label{display:block;font-size:.8rem;color:var(--fg-dim);margin-bottom:6px;font-family:var(--font-mono)}
.login-card input{width:100%;padding:10px 14px;background:var(--bg-elevated);border:1px solid rgba(255,255,255,.1);border-radius:var(--radius-sm);color:var(--fg);font-size:.9rem;outline:none}
.login-card input:focus{border-color:var(--accent)}
.login-card button{margin-top:16px;width:100%;padding:12px;background:var(--accent);color:var(--bg);font-family:var(--font-display);font-weight:600;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:.9rem}
.login-card button:hover{background:#33dfff}
.login-err{background:rgba(255,107,53,.1);border:1px solid rgba(255,107,53,.3);color:var(--danger);padding:10px 14px;border-radius:var(--radius-sm);font-size:.8rem;margin-bottom:16px}
</style></head><body>
<div class="login-wrap"><div class="login-card">
<h1>Admin Dashboard</h1><p>FlightForge Feedback Management</p>
${error ? `<div class="login-err">${escapeHtml(error)}</div>` : ''}
<form method="POST" action="/admin/feedback/login">
<label for="pw">Password</label>
<input type="password" id="pw" name="password" required autofocus>
<button type="submit">Login</button>
</form>
</div></div></body></html>`;
}

module.exports = router;

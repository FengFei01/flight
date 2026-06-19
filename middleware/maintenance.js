// Maintenance-mode middleware — returns 503 for ALL routes when MAINTENANCE_MODE=true.
// Does NOT own: health checks (/health bypasses this), route logic, database access.

const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FlightForge - Maintenance</title>
  <link rel="icon" href="https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/generated-images/company_180433/52541d5c-87e1-4ba1-bc01-56b0c8c34128.jpg">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0d0d0f;
      color: #e8edf2;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 24px;
    }
    .container {
      max-width: 520px;
    }
    .logo {
      font-family: 'Syne', sans-serif;
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      margin-bottom: 32px;
    }
    .logo .accent { color: #00d4ff; }
    .logo .warm { color: #ff6b35; }
    .icon {
      font-size: 3rem;
      margin-bottom: 24px;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 12px;
      color: #e8edf2;
    }
    p {
      color: #8899aa;
      font-size: 0.95rem;
      line-height: 1.7;
      margin-bottom: 8px;
    }
    .divider {
      width: 48px;
      height: 2px;
      background: rgba(0,212,255,0.3);
      margin: 20px auto;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo"><span class="accent">Flight</span><span class="warm">Forge</span></div>
    <div class="icon">\u{1F6E0}\u{FE0F}</div>
    <h1>Scheduled Maintenance</h1>
    <p>We're performing scheduled maintenance and will be back shortly.</p>
    <div class="divider"></div>
    <p>\u{1F4CB} \u7CFB\u7EDF\u7EF4\u62A4\u4E2D\uFF0C\u5373\u5C06\u6062\u590D\u670D\u52A1\u3002\u8BF7\u7A0D\u540E\u518D\u8BBF\u95EE\u3002</p>
  </div>
</body>
</html>`;

/**
 * Express middleware: when MAINTENANCE_MODE env is "true", responds 503 to
 * every request except /health (which Render needs for uptime checks).
 * Checks process.env on each request — no restart needed after ENV change
 * (Render restarts on env change anyway, but this is defensive).
 */
function maintenanceMode(req, res, next) {
  if (process.env.MAINTENANCE_MODE !== 'true') return next();

  // Always let health checks through so Render doesn't kill the service
  if (req.path === '/health') return next();

  res.status(503)
    .set('Retry-After', '600')
    .set('Content-Type', 'text/html; charset=utf-8')
    .send(MAINTENANCE_HTML);
}

module.exports = maintenanceMode;

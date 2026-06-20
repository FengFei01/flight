#as FlightForge

## What this app does
Web-based blackbox log analyzer for FPV drone pilots. Upload a .BBL file, get optimized PID recommendations and copyable Betaflight CLI commands. Replaces the discontinued PIDtoolbox.

## Stack
Express.js + EJS + PostgreSQL (Neon) on Render. No frontend framework — vanilla JS.

## Directory map
- `server.js` — Entry point. Middleware, route mounts, static files, app.listen.
- `middleware/` — Express middleware. `maintenance.js` (ENV-toggled 503 maintenance page).
- `routes/` — Express routers. `analyze.js` (file upload + results), `advisor.js` (AI advisor page + POST /chat API), `payments.js` (Stripe checkout sessions + payment verification + subscription status + usage tracking), `feedback.js` (user feedback submission), `admin.js` (admin feedback dashboard + CRUD API).
- `services/` — Business logic. `bbl-parser.js` (BBL file parsing), `pid-analyzer.js` (PID recommendation engine + Chinese tuning notes), `advisor-inference.js` (server-side LLM inference + rule-based fallback).
- `tests/` — Unit tests (`pid-analyzer.test.js`, `msp-parsing.test.js`, `fft-spectrum.test.js`, `speedybee-f405-compat.test.js`, `speedybee-f405-board-validation.test.js`, `checkout-flow.test.js`). Run via `npm test`.
- `db/` — Database connection pool (`index.js`), query helpers (`feedback.js`, `usage.js`, `advisor-events.js`).
- `views/` — EJS templates. `layout.ejs` (landing page), `analyze.ejs` (upload), `results.ejs` (PID results), `advisor.ejs` (AI advisor), `replay.ejs` (flight replay page), `admin-feedback.ejs` (admin dashboard), `pricing.ejs` (legacy, /pricing redirects to /), `payment-success.ejs` (post-purchase confirmation, legacy).
- `views/partials/` — Legacy landing page sections (unused after 2026-06-05 homepage rebuild).
- `public/css/` — `theme.css` (landing page design tokens), `app.css` (app page styles), `admin.css` (admin dashboard styles).
- `public/js/` — Client-side JS. `usage-tracker.js` (user ID management + usage badge, no paywall), `advisor-analytics.js` (advisor event tracking), `flight-replay.js` (Canvas 2D replay renderer), `bbl-replay-worker.js` (Web Worker BBL parser for replay), `hero-replay-demo.js` (hero background Canvas animation with demo data), `fc-connection-manager.js`, `fc-transport.js`, `msp-client.js`, `fc-pid-reader.js`, `fc-notch-writer.js`, `ble-connector.js`, `fft.js`, `spectrum-analyzer.js`, `fft-chart.js`, `webllm-engine.js`, `pid-knowledge.js`, `advisor-chat.js`.
- `lib/` — Shared utilities. `landing-context.js` builds EJS render context.
- `migrations/` — SQL migration files (timestamp-prefixed).

## Database
- `users` — End-user accounts with Stripe subscription fields and analysis_credits.
- `motor_health_usage` — Per-user analysis usage tracking (user_identifier, analysis_type, timestamp).
- `purchases` — Stripe payment records (session_id, purchase_type, credits_added).
- `feedback` — User feedback submissions with admin status/priority/notes tracking.
- `advisor_events` — AI Advisor analytics events (session_id, event_type, event_data JSONB).
- `_migrations` — Migration tracking table.

## External integrations
- Stripe (Polsia Connect) — payment routes still exist but all pricing UI removed. App is positioned as fully free.
- Web Bluetooth / Web Serial API — connects to Betaflight FC for live PID reading/writing.
- Chart.js (CDN) — FFT noise spectrum charts.
- WebLLM (CDN) — browser-side LLM for PID tuning advisor.
- Polsia AI proxy (OpenAI-compatible) — server-side LLM inference fallback for advisor chat.

## Recent changes
- 2026-06-18: Nav rename + remove all pricing — Renamed "Auto Flight Editor" to "飞行回放 / Flight Replay" with link to /replay. Removed pricing section, Pro nav button, footer pricing link, paywall overlay, Pro/credits badge styles. /pricing now redirects to /. FlightForge positioned as fully free. Modified: `views/layout.ejs`, `views/results.ejs`, `public/js/usage-tracker.js`, `server.js`, `AGENTS.md`.
- 2026-06-18: BBL Flight Replay — Browser-side BBL parsing via Web Worker, Canvas 2D flight replay page at /replay with quad attitude, motor output, gyro/throttle curves, playback controls (play/pause, seek, 0.5x-4x speed). Hero section replaced Pexels video with live Canvas flight animation using demo data. Mobile <768px degrades to gradient background. Modified: `public/js/bbl-replay-worker.js`, `public/js/flight-replay.js`, `public/js/hero-replay-demo.js`, `views/replay.ejs`, `views/layout.ejs`, `server.js`, `AGENTS.md`.
- 2026-06-18: Betaflight CLI Export — Diff-only CLI export panel on results page. Generates `set` commands only for parameters that differ from current values. Collapsible panel with dark code block, copy button, and "no changes" state. Updates on flight style switch and BF version change. Modified: `public/js/bf-version-map.js`, `services/pid-analyzer.js`, `routes/analyze.js`, `views/results.ejs`, `public/css/app.css`, `AGENTS.md`.
- 2026-06-18: SpeedBee F405 cross-board validation — 31-test suite comparing SpeedBee F405 PID/filter recommendations against Matek F405-STD and F7 reference boards. Validates recommendation parity, filter calibration, flight score consistency, CLI output, and V3/V4 sub-variant consistency. Modified: `tests/speedybee-f405-board-validation.test.js`, `AGENTS.md`.
- 2026-06-17: Frontend checkout flow wired up — Pricing page and paywall buttons now call POST /api/payments/create-checkout-session API with client_reference_id instead of linking to static Stripe URLs. Modified: `routes/payments.js`, `views/pricing.ejs`, `views/layout.ejs`, `public/js/usage-tracker.js`, `tests/checkout-flow.test.js`, `AGENTS.md`.

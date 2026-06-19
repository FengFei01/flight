/**
 * Advisor event tracking queries.
 * Owns: advisor_events table reads/writes for analytics.
 * Does NOT own: advisor inference logic, chat UI, or WebLLM engine state.
 */
const { pool } = require('./index');

/**
 * Record an advisor analytics event.
 * @param {string} sessionId - Client-generated session ID
 * @param {string} eventType - Event type (e.g. 'page_visit', 'model_load', 'message_sent')
 * @param {object} eventData - Structured event properties
 */
async function recordEvent(sessionId, eventType, eventData) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO advisor_events (session_id, event_type, event_data)
       VALUES ($1, $2, $3)`,
      [sessionId, eventType, JSON.stringify(eventData || {})]
    );
  } catch (err) {
    // Non-fatal — analytics should never block the user
    console.error('[advisor-events] Insert error:', err.message);
  }
}

/**
 * Get aggregated advisor stats for admin/analytics dashboard.
 */
async function getAdvisorStats(sinceDays) {
  if (!pool) return null;
  const days = sinceDays || 30;
  const { rows } = await pool.query(
    `SELECT
       event_type,
       COUNT(*) AS event_count,
       COUNT(DISTINCT session_id) AS unique_sessions
     FROM advisor_events
     WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
     GROUP BY event_type
     ORDER BY event_count DESC`,
    [String(days)]
  );
  return rows;
}

module.exports = { recordEvent, getAdvisorStats };

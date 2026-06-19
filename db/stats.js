const { pool } = require('./index');

async function getPlatformStats() {
  if (!pool) return { pilotCount: 0, logCount: 0, motorCount: 0, countryCount: 0 };
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(DISTINCT user_identifier) AS pilot_count,
        COUNT(*) AS log_count,
        COUNT(DISTINCT country_code) FILTER (WHERE country_code IS NOT NULL) AS country_count
      FROM motor_health_usage
    `);
    const pilotCount = parseInt(rows[0].pilot_count, 10);
    const logCount = parseInt(rows[0].log_count, 10);
    const motorCount = logCount * 4;
    const countryCount = parseInt(rows[0].country_count, 10);
    return { pilotCount, logCount, motorCount, countryCount };
  } catch (err) {
    console.error('[stats] Query error:', err.message);
    return { pilotCount: 0, logCount: 0, motorCount: 0, countryCount: 0 };
  }
}

module.exports = { getPlatformStats };

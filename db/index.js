/**
 * Database connection pool.
 * Owns: creating and exporting the shared pg Pool instance.
 * Does NOT own: query logic (see db/<entity>.js files) or schema (see migrations/).
 */
const { Pool } = require('pg');

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  // Neon closes idle connections (auto-suspend). Log and continue —
  // the pool reconnects on the next query.
  pool.on('error', (err) => {
    console.error('[pg pool] idle client error (non-fatal):', err && err.message);
  });
} else {
  console.warn('[db] DATABASE_URL not set — database features disabled');
}

module.exports = { pool };

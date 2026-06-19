/**
 * Feedback database layer.
 * Owns: all queries on the `feedback` table (insert, list, update, stats).
 * Does NOT own: HTTP handling, auth, or email notifications (see routes/feedback.js, routes/admin.js).
 */
const { pool } = require('./index');

async function insertFeedback(content, contactInfo, screenshotUrl, type, userAgent, sourcePage) {
  const result = await pool.query(
    `INSERT INTO feedback (content, contact_info, screenshot_url, type, user_agent, source_page)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [content, contactInfo || null, screenshotUrl || null, type || null, userAgent || null, sourcePage || null]
  );
  return result.rows[0];
}

/** Status counts for dashboard header cards */
async function getStatusCounts() {
  if (!pool) return { new: 0, in_progress: 0, resolved: 0, ignored: 0 };
  const { rows } = await pool.query(`
    SELECT status, COUNT(*)::int AS count FROM feedback GROUP BY status
  `);
  const counts = { new: 0, in_progress: 0, resolved: 0, ignored: 0 };
  for (const r of rows) {
    if (r.status in counts) counts[r.status] = r.count;
    else counts.new += r.count; // treat null/unknown as new
  }
  return counts;
}

/**
 * Paginated feedback list with optional status filter and text search.
 * @param {Object} opts - { status, search, page, limit, sort }
 */
async function listFeedback({ status, search, page = 1, limit = 20, sort = 'desc' } = {}) {
  const params = [];
  const where = [];
  let idx = 1;

  if (status && status !== 'all') {
    where.push(`status = $${idx++}`);
    params.push(status);
  }

  if (search) {
    where.push(`(content ILIKE $${idx} OR contact_info ILIKE $${idx} OR admin_notes ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderDir = sort === 'asc' ? 'ASC' : 'DESC';

  // Count total
  const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM feedback ${whereClause}`, params);
  const total = countRes.rows[0].total;

  // Fetch page
  const offset = (page - 1) * limit;
  const dataParams = [...params, limit, offset];
  const dataRes = await pool.query(
    `SELECT id, created_at, updated_at, content, contact_info, type, status, priority,
            admin_notes, user_agent, source_page, screenshot_url
     FROM feedback ${whereClause}
     ORDER BY created_at ${orderDir}
     LIMIT $${idx++} OFFSET $${idx++}`,
    dataParams
  );

  return { items: dataRes.rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

/** Get single feedback by id */
async function getFeedbackById(id) {
  const { rows } = await pool.query('SELECT * FROM feedback WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Update status for one feedback */
async function updateFeedbackStatus(id, status) {
  await pool.query(
    'UPDATE feedback SET status = $1, updated_at = NOW() WHERE id = $2',
    [status, id]
  );
}

/** Update priority for one feedback */
async function updateFeedbackPriority(id, priority) {
  await pool.query(
    'UPDATE feedback SET priority = $1, updated_at = NOW() WHERE id = $2',
    [priority, id]
  );
}

/** Update admin notes for one feedback */
async function updateAdminNotes(id, notes) {
  await pool.query(
    'UPDATE feedback SET admin_notes = $1, updated_at = NOW() WHERE id = $2',
    [notes, id]
  );
}

/** Bulk update status for multiple feedback ids */
async function bulkUpdateStatus(ids, status) {
  if (!ids.length) return 0;
  const { rowCount } = await pool.query(
    'UPDATE feedback SET status = $1, updated_at = NOW() WHERE id = ANY($2::int[])',
    [status, ids]
  );
  return rowCount;
}

module.exports = {
  insertFeedback,
  getStatusCounts,
  listFeedback,
  getFeedbackById,
  updateFeedbackStatus,
  updateFeedbackPriority,
  updateAdminNotes,
  bulkUpdateStatus,
};

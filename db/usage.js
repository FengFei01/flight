/**
 * Usage tracking queries.
 * Owns: motor_health_usage reads/writes, credit balance lookups, subscription checks.
 * Does NOT own: payment processing or Stripe verification.
 */
const { pool } = require('./index');

const CREDITS_PER_PACK = 5;
const FREE_MONTHLY_ANALYSES = 2;

async function recordUsage(ipHash, countryCode) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO motor_health_usage (user_identifier, ip_hash, analysis_type, country_code)
     VALUES ($1, $2, 'free', $3)`,
    [ipHash || 'anonymous', ipHash || null, countryCode || null]
  );
}

/**
 * Count analyses this calendar month for a user identifier.
 */
async function getMonthlyUsageCount(userIdentifier) {
  if (!pool) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM motor_health_usage
     WHERE user_identifier = $1
       AND analysis_timestamp >= date_trunc('month', NOW())`,
    [userIdentifier]
  );
  return parseInt(rows[0].cnt, 10);
}

/**
 * Get total unused credits for a user (sum of all purchased credits minus used paid analyses).
 */
async function getCreditBalance(userIdentifier) {
  if (!pool) return 0;
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(credits_added), 0) AS total_credits
     FROM purchases
     WHERE user_identifier = $1 AND purchase_type = 'credit_pack'`,
    [userIdentifier]
  );
  const totalCredits = parseInt(rows[0].total_credits, 10);

  // Count how many paid analyses (analysis_type='paid') have been used
  const used = await pool.query(
    `SELECT COUNT(*) AS cnt FROM motor_health_usage
     WHERE user_identifier = $1 AND analysis_type = 'paid'`,
    [userIdentifier]
  );
  const usedCredits = parseInt(used.rows[0].cnt, 10);
  return Math.max(0, totalCredits - usedCredits);
}

/**
 * Check if user has an active subscription (purchased within the last 35 days,
 * allowing a 5-day grace period on the 30-day cycle).
 */
async function hasActiveSubscription(userIdentifier) {
  if (!pool) return false;
  const { rows } = await pool.query(
    `SELECT id FROM purchases
     WHERE user_identifier = $1
       AND purchase_type = 'subscription'
       AND created_at > NOW() - INTERVAL '35 days'
     LIMIT 1`,
    [userIdentifier]
  );
  return rows.length > 0;
}

/**
 * Full usage status for a user — combines free usage, credits, and subscription.
 */
async function getUsageStatus(userIdentifier) {
  if (!pool) {
    return { canAnalyze: true, reason: 'no_db', freeUsed: 0, freeLimit: FREE_MONTHLY_ANALYSES, credits: 0, isSubscriber: false };
  }
  const [monthlyUsed, credits, isSubscriber] = await Promise.all([
    getMonthlyUsageCount(userIdentifier),
    getCreditBalance(userIdentifier),
    hasActiveSubscription(userIdentifier),
  ]);

  const freeRemaining = Math.max(0, FREE_MONTHLY_ANALYSES - monthlyUsed);
  const canAnalyze = isSubscriber || credits > 0 || freeRemaining > 0;
  let reason = 'free';
  if (isSubscriber) reason = 'subscription';
  else if (freeRemaining <= 0 && credits > 0) reason = 'credits';
  else if (freeRemaining <= 0 && credits <= 0) reason = 'limit_reached';

  return {
    canAnalyze,
    reason,
    freeUsed: monthlyUsed,
    freeLimit: FREE_MONTHLY_ANALYSES,
    freeRemaining,
    credits,
    isSubscriber,
  };
}

/**
 * Consume a credit (record a paid analysis). Call after verifying user has credits.
 */
async function consumeCredit(userIdentifier, countryCode) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO motor_health_usage (user_identifier, ip_hash, analysis_type, country_code)
     VALUES ($1, $1, 'paid', $2)`,
    [userIdentifier, countryCode || null]
  );
}

/**
 * Add credits after a purchase.
 */
async function recordPurchase({ userIdentifier, stripeSessionId, purchaseType, amountUsd, creditsAdded, customerEmail }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO purchases (user_identifier, stripe_session_id, purchase_type, amount_usd, credits_added, customer_email)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (stripe_session_id) DO NOTHING
     RETURNING id`,
    [userIdentifier, stripeSessionId, purchaseType, amountUsd, creditsAdded || 0, customerEmail || null]
  );
  return rows[0] || null;
}

module.exports = {
  CREDITS_PER_PACK,
  FREE_MONTHLY_ANALYSES,
  recordUsage,
  getMonthlyUsageCount,
  getCreditBalance,
  hasActiveSubscription,
  getUsageStatus,
  consumeCredit,
  recordPurchase,
};

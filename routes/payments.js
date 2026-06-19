/**
 * Payment and usage routes.
 * Owns: /api/payments/* endpoints — usage checks, payment verification, checkout sessions, subscription status.
 * Does NOT own: Stripe SDK (uses Polsia payment verification API), BBL analysis logic.
 */
const express = require('express');
const { recordPurchase, getUsageStatus, consumeCredit, CREDITS_PER_PACK } = require('../db/usage');

const router = express.Router();

// Stripe payment link URLs (created via Polsia Stripe MCP — 2026-06-16)
const CREDIT_PACK_URL = 'https://buy.stripe.com/aFa6oH9uU8lX5cT1vz0gw05';
const SUBSCRIPTION_URL = 'https://buy.stripe.com/7sYdR94aA59LdJp7TX0gw04';

const POLSIA_BASE = () =>
  (process.env.POLSIA_API_BASE_URL || process.env.POLSIA_API_URL || 'https://polsia.com')
    .replace(/\/api\/proxy\/ai$/, '');

/**
 * GET /api/payments/links — returns payment link URLs.
 */
router.get('/links', (_req, res) => {
  res.json({
    creditPack: {
      url: CREDIT_PACK_URL,
      name: 'Motor Health Analysis - 5 Credits',
      price: '$9',
      credits: CREDITS_PER_PACK,
    },
    subscription: {
      url: SUBSCRIPTION_URL,
      name: 'FlightForge Pro - Unlimited Analysis',
      price: '$8/mo',
    },
  });
});

/**
 * POST /api/payments/create-checkout-session — returns checkout URL for requested plan.
 * Accepts { plan: 'pro' | 'credits', uid: string } in the body.
 * Appends client_reference_id for credit attribution on return.
 */
router.post('/create-checkout-session', (req, res) => {
  const { plan, uid } = req.body || {};
  const userId = uid || req.headers['x-user-id'] || req.ip;

  let baseUrl;
  if (plan === 'pro' || plan === 'subscription') {
    baseUrl = SUBSCRIPTION_URL;
  } else if (plan === 'credits' || plan === 'credit_pack') {
    baseUrl = CREDIT_PACK_URL;
  } else {
    return res.status(400).json({ error: 'invalid_plan', message: 'Plan must be "pro" or "credits"' });
  }

  // Append client_reference_id so payment success can attribute to this user
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('client_reference_id', userId);
    return res.json({ url: url.toString(), plan });
  } catch (_e) {
    return res.json({ url: baseUrl, plan });
  }
});

/**
 * GET /api/payments/subscription-status — check subscription status via Polsia.
 * Query param: ?email=user@example.com or uses x-user-id header.
 */
router.get('/subscription-status', async (req, res) => {
  const email = req.query.email;
  const userId = req.headers['x-user-id'] || req.query.uid || req.ip;

  try {
    // Check local purchase records first
    const localStatus = await getUsageStatus(userId);
    if (localStatus.isSubscriber) {
      return res.json({ active: true, plan: 'pro', source: 'local' });
    }

    // If email provided, check Polsia subscription API
    if (email) {
      const verifyUrl = `${POLSIA_BASE()}/api/company-payments/subscription-status?email=${encodeURIComponent(email)}`;
      const response = await fetch(verifyUrl, {
        headers: { Authorization: `Bearer ${process.env.POLSIA_API_KEY}` },
      });
      if (response.ok) {
        const data = await response.json();
        return res.json({
          active: !!data.active,
          plan: data.plan || 'pro',
          current_period_end: data.current_period_end || null,
          source: 'polsia',
        });
      }
    }

    return res.json({ active: false, plan: null, source: 'none' });
  } catch (err) {
    console.error('[payments] Subscription status check error:', err.message);
    return res.json({ active: false, plan: null, source: 'error' });
  }
});

/**
 * GET /api/payments/usage — check user's analysis usage status.
 * Client sends x-user-id header (browser fingerprint).
 */
router.get('/usage', async (req, res) => {
  const userId = req.headers['x-user-id'] || req.query.uid || req.ip;
  try {
    const status = await getUsageStatus(userId);
    res.json(status);
  } catch (err) {
    console.error('[payments] Usage check error:', err.message);
    // Fail open — let them analyze if DB is down
    res.json({ canAnalyze: true, reason: 'error', freeUsed: 0, freeLimit: 2, credits: 0, isSubscriber: false });
  }
});

/**
 * POST /api/payments/consume — consume one credit for a paid analysis.
 * Called by client after confirming user wants to use a credit.
 */
router.post('/consume', async (req, res) => {
  const userId = req.headers['x-user-id'] || req.body.uid || req.ip;
  const countryCode = (req.headers['cf-ipcountry'] || '').toUpperCase() || null;
  try {
    const status = await getUsageStatus(userId);
    if (!status.canAnalyze) {
      return res.status(403).json({ error: 'no_credits', message: 'No credits remaining' });
    }
    if (status.reason === 'credits') {
      await consumeCredit(userId, countryCode);
    }
    // free and subscription users don't need to consume — usage is recorded in analyze route
    res.json({ ok: true, remaining: status.credits > 0 ? status.credits - 1 : 0 });
  } catch (err) {
    console.error('[payments] Consume error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /payment/success — handles Stripe redirect after successful payment.
 * Verifies with Polsia API, credits the user.
 */
router.get('/success', async (req, res) => {
  const sessionId = req.query.session_id || req.query.checkout_session_id;
  if (!sessionId) {
    return res.redirect('/?error=missing_session');
  }

  try {
    // Verify payment with Polsia
    const verifyUrl = `${POLSIA_BASE()}/api/company-payments/verify?session_id=${encodeURIComponent(sessionId)}`;

    const response = await fetch(verifyUrl, {
      headers: { Authorization: `Bearer ${process.env.POLSIA_API_KEY}` },
    });
    const data = await response.json();

    if (data.verified && data.payment) {
      const amount = data.payment.amount_usd || data.payment.amount || 0;
      const isSubscription = amount >= 7 && amount <= 9 && data.payment.recurring;
      const purchaseType = isSubscription ? 'subscription' : 'credit_pack';
      const creditsAdded = isSubscription ? 0 : CREDITS_PER_PACK;

      // Prefer uid query param (sent from client), fall back to IP
      const userId = req.query.uid || req.headers['x-user-id'] || req.ip;

      await recordPurchase({
        userIdentifier: userId,
        stripeSessionId: sessionId,
        purchaseType,
        amountUsd: amount,
        creditsAdded,
        customerEmail: data.payment.customer_email,
      });

      return res.render('payment-success', {
        purchaseType,
        creditsAdded,
        email: data.payment.customer_email || '',
      });
    }

    return res.render('payment-success', {
      purchaseType: 'pending',
      creditsAdded: 0,
      email: '',
    });
  } catch (err) {
    console.error('[payments] Verification error:', err.message);
    return res.render('payment-success', {
      purchaseType: 'error',
      creditsAdded: 0,
      email: '',
    });
  }
});

/**
 * GET /payment/cancel — user cancelled checkout.
 */
router.get('/cancel', (_req, res) => {
  res.redirect('/');
});

module.exports = router;

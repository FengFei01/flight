/**
 * Checkout flow integration test.
 * Verifies: checkout session API, payment links API, usage API.
 * Runs against the live local server by importing express app.
 */
const http = require('http');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

function request(method, path, body) {
  const url = new URL(path, BASE);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'test_user_checkout_' + Date.now() },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
        catch (_e) { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ FAIL: ${label}`); }
}

async function run() {
  console.log('Checkout Flow Tests\n');

  // 1. POST /api/payments/create-checkout-session — pro plan
  const proRes = await request('POST', '/api/payments/create-checkout-session', { plan: 'pro', uid: 'test_123' });
  assert('Pro checkout returns 200', proRes.status === 200);
  assert('Pro checkout returns URL', proRes.body.url && proRes.body.url.includes('stripe.com'));
  assert('Pro checkout URL has client_reference_id', proRes.body.url && proRes.body.url.includes('client_reference_id'));
  assert('Pro checkout returns plan field', proRes.body.plan === 'pro');

  // 2. POST credits plan
  const credRes = await request('POST', '/api/payments/create-checkout-session', { plan: 'credits', uid: 'test_456' });
  assert('Credits checkout returns 200', credRes.status === 200);
  assert('Credits checkout returns URL', credRes.body.url && credRes.body.url.includes('stripe.com'));
  assert('Credits checkout URL has client_reference_id', credRes.body.url && credRes.body.url.includes('client_reference_id'));
  assert('Credits checkout returns plan field', credRes.body.plan === 'credits');

  // 3. POST with invalid plan
  const badRes = await request('POST', '/api/payments/create-checkout-session', { plan: 'invalid' });
  assert('Invalid plan returns 400', badRes.status === 400);
  assert('Invalid plan error field', badRes.body.error === 'invalid_plan');

  // 4. GET /api/payments/links
  const linksRes = await request('GET', '/api/payments/links');
  assert('Links returns 200', linksRes.status === 200);
  assert('Links has creditPack', !!linksRes.body.creditPack);
  assert('Links has subscription', !!linksRes.body.subscription);

  // 5. GET /api/payments/usage
  const usageRes = await request('GET', '/api/payments/usage');
  assert('Usage returns 200', usageRes.status === 200);
  assert('Usage has canAnalyze', typeof usageRes.body.canAnalyze === 'boolean');
  assert('Usage has freeLimit', typeof usageRes.body.freeLimit === 'number');

  // 6. GET /health
  const healthRes = await request('GET', '/health');
  assert('Health returns 200', healthRes.status === 200);
  assert('Health status is healthy', healthRes.body.status === 'healthy');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

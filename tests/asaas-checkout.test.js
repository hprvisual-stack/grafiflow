import test from 'node:test';
import assert from 'node:assert/strict';
import { POST as checkoutPost } from '../api/asaas/checkout.js';

const envValues = {
  GRAFIFLOW_BILLING_ENABLED: 'true',
  GRAFIFLOW_SUPABASE_URL: 'https://project-test.supabase.co',
  GRAFIFLOW_SUPABASE_ANON_KEY: 'public-test-key',
  GRAFIFLOW_SUPABASE_SECRET_KEY: 'server-only-test-key',
  ASAAS_API_KEY: 'asaas-test-key',
  ASAAS_WEBHOOK_AUTH_TOKEN: 'webhook-token-that-is-longer-than-32-characters',
  ASAAS_ENVIRONMENT: 'sandbox',
  GRAFIFLOW_APP_URL: 'https://grafiflow.vercel.app',
};
const envKeys = Object.keys(envValues);
const userId = 'f53b6810-e908-42f4-a5a9-03516e4a21ec';
const workspaceId = 'a42174fd-7087-4a64-bdcb-2247d5782e6c';

async function withCheckoutEnvironment(fetcher, callback) {
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  for (const key of envKeys) process.env[key] = envValues[key];
  globalThis.fetch = fetcher;
  try {
    return await callback();
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of envKeys) {
      if (previous.get(key) === undefined) delete process.env[key];
      else process.env[key] = previous.get(key);
    }
  }
}

function checkoutRequest(planType = 'monthly') {
  return new Request('https://grafiflow.vercel.app/api/asaas/checkout', {
    method: 'POST',
    headers: {
      origin: 'https://grafiflow.vercel.app',
      authorization: 'Bearer user-access-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ workspaceId, planType }),
  });
}

function createCheckoutFetcher({ scheduled = false, priceCents = 3500, permanentFree = false } = {}) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const call = { url: String(url), options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.url.endsWith('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: userId, email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' }), { status: 200 });
    }
    if (call.url.includes('/rest/v1/workspace_members?')) {
      return new Response(JSON.stringify([{ workspace_id: workspaceId }]), { status: 200 });
    }
    if (call.url.endsWith('/rpc/is_grafiflow_permanent_free_account')) {
      return new Response(JSON.stringify(permanentFree), { status: 200 });
    }
    if (call.url.endsWith('/rpc/claim_grafiflow_checkout')) {
      return new Response(JSON.stringify({
        action: 'create',
        claimToken: 'd4c7a184-1a2b-4f31-9c22-61546a6fb022',
        priceCents,
        nextDueDate: scheduled ? '2026-12-03' : '2026-11-03',
        scheduled,
        periodStart: scheduled ? '2026-12-03T00:00:00.000Z' : null,
      }), { status: 200 });
    }
    if (call.url.endsWith('/rpc/finalize_grafiflow_checkout')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (call.url.endsWith('/v3/paymentLinks')) {
      return new Response(JSON.stringify({ id: 'plink_test_1', url: 'https://sandbox.asaas.com/l/grafiflow-test' }), { status: 200 });
    }
    if (call.url.endsWith('/v3/checkouts')) {
      return new Response(JSON.stringify({ id: 'checkout_test_1' }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${call.url}`);
  };
  return { calls, fetcher };
}

test('permanent free account is rejected before creating any checkout', async () => {
  const { calls, fetcher } = createCheckoutFetcher({ permanentFree: true });
  await withCheckoutEnvironment(fetcher, async () => {
    const response = await checkoutPost(checkoutRequest());
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /gratuito permanente/i);
  });
  assert.equal(calls.some((call) => call.url.endsWith('/rpc/claim_grafiflow_checkout')), false);
  assert.equal(calls.some((call) => call.url.includes('/v3/paymentLinks') || call.url.includes('/v3/checkouts')), false);
});

test('monthly signup creates an expiring recurring Asaas Payment Link with selectable methods', async () => {
  const { calls, fetcher } = createCheckoutFetcher();
  await withCheckoutEnvironment(fetcher, async () => {
    const response = await checkoutPost(checkoutRequest());
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.checkoutUrl, 'https://sandbox.asaas.com/l/grafiflow-test');
    assert.equal(result.amountCents, 3500);
    assert.equal(result.planType, 'monthly');
  });
  const asaasCall = calls.find((call) => call.url.endsWith('/v3/paymentLinks'));
  assert.ok(asaasCall);
  assert.equal(asaasCall.body.value, 35);
  assert.equal(asaasCall.body.billingType, 'UNDEFINED');
  assert.equal(asaasCall.body.chargeType, 'RECURRENT');
  assert.equal(asaasCall.body.subscriptionCycle, 'MONTHLY');
  assert.equal(asaasCall.body.dueDateLimitDays, 7);
  const finalize = calls.find((call) => call.url.endsWith('/rpc/finalize_grafiflow_checkout'));
  assert.equal(finalize.body.p_checkout_id, 'plink_test_1');
  assert.match(finalize.body.p_checkout_url, /^https:\/\/sandbox\.asaas\.com\//);
});

test('scheduled monthly downgrade preserves the annual-to-monthly Asaas checkout flow', async () => {
  const { calls, fetcher } = createCheckoutFetcher({ scheduled: true, priceCents: 3500 });
  await withCheckoutEnvironment(fetcher, async () => {
    const response = await checkoutPost(checkoutRequest());
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.scheduled, true);
  });
  assert.equal(calls.some((call) => call.url.endsWith('/v3/paymentLinks')), false);
  const asaasCall = calls.find((call) => call.url.endsWith('/v3/checkouts'));
  assert.ok(asaasCall);
  assert.deepEqual(asaasCall.body.chargeTypes, ['RECURRENT']);
  assert.deepEqual(asaasCall.body.subscription, { cycle: 'MONTHLY', nextDueDate: '2026-12-03' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { POST as webhookPost } from '../api/asaas/webhook.js';

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

async function withWebhookEnvironment(fetcher, callback) {
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

function webhookRequest(token, payload = { id: 'evt-test-1', event: 'CHECKOUT_PAID' }) {
  return new Request('https://grafiflow.vercel.app/api/asaas/webhook', {
    method: 'POST',
    headers: { 'asaas-access-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('Asaas webhook rejects a wrong token before contacting Supabase', async () => {
  let fetchCount = 0;
  await withWebhookEnvironment(async () => {
    fetchCount += 1;
    return new Response('{}', { status: 200 });
  }, async () => {
    const response = await webhookPost(webhookRequest('wrong-token'));
    assert.equal(response.status, 401);
    assert.equal(fetchCount, 0);
  });
});

test('Asaas webhook forwards authenticated events to the billing RPC', async () => {
  let call;
  await withWebhookEnvironment(async (url, options) => {
    call = { url: String(url), options };
    return new Response(JSON.stringify({ duplicate: false }), { status: 200 });
  }, async () => {
    const response = await webhookPost(webhookRequest(envValues.ASAAS_WEBHOOK_AUTH_TOKEN));
    assert.equal(response.status, 200);
    assert.match(call.url, /rpc\/process_grafiflow_billing_event$/);
    assert.equal(JSON.parse(call.options.body).p_payload.id, 'evt-test-1');
  });
});

test('webhook disables only a GrafiFlow-registered payment link before reconciliation', async () => {
  const calls = [];
  await withWebhookEnvironment(async (url, options = {}) => {
    const call = { url: String(url), options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.url.includes('/rest/v1/asaas_billing_checkouts?')) {
      return new Response(JSON.stringify([{ provider_checkout_id: 'plink_grafiflow_1' }]), { status: 200 });
    }
    if (call.url.endsWith('/v3/paymentLinks/plink_grafiflow_1')) {
      return new Response(JSON.stringify({ id: 'plink_grafiflow_1', active: false }), { status: 200 });
    }
    if (call.url.endsWith('/rpc/process_grafiflow_billing_event')) {
      return new Response(JSON.stringify({ duplicate: false }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${call.url}`);
  }, async () => {
    const response = await webhookPost(webhookRequest(envValues.ASAAS_WEBHOOK_AUTH_TOKEN, {
      id: 'evt-payment-link-1',
      event: 'PAYMENT_CREATED',
      payment: { id: 'pay_link_1', paymentLink: 'plink_grafiflow_1', subscription: 'sub_link_1' },
    }));
    assert.equal(response.status, 200);
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /provider_checkout_id=eq\.plink_grafiflow_1/);
  assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(calls[1].body, { active: false });
  assert.match(calls[2].url, /rpc\/process_grafiflow_billing_event$/);
});

test('webhook failure logs omit response bodies and personal or secret values', async () => {
  const sensitiveResponse = 'customer@example.com asaas-access-token=do-not-log-this';
  const messages = [];
  const originalError = console.error;
  console.error = (...parts) => messages.push(parts.map(String).join(' '));
  try {
    await withWebhookEnvironment(async () => new Response(sensitiveResponse, { status: 500 }), async () => {
      const response = await webhookPost(webhookRequest(envValues.ASAAS_WEBHOOK_AUTH_TOKEN));
      assert.equal(response.status, 502);
    });
  } finally {
    console.error = originalError;
  }
  const logs = messages.join('\n');
  assert.doesNotMatch(logs, /customer@example\.com|do-not-log-this/);
  assert.match(logs, /Erro do Supabase.*500/);
});

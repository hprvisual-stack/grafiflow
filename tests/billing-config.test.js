import test from 'node:test';
import assert from 'node:assert/strict';
import { billingConfig } from '../server/asaas-billing.js';
import { asaasCheckoutAvailable, publicGrafiflowConfig, publicGrafiflowConfigScript } from '../server/public-config.js';

const keys = [
  'GRAFIFLOW_BILLING_ENABLED',
  'GRAFIFLOW_SUPABASE_URL',
  'GRAFIFLOW_SUPABASE_ANON_KEY',
  'GRAFIFLOW_SUPABASE_SECRET_KEY',
  'GRAFIFLOW_SUPABASE_SERVICE_ROLE_KEY',
  'ASAAS_API_KEY',
  'ASAAS_WEBHOOK_AUTH_TOKEN',
  'ASAAS_ENVIRONMENT',
  'GRAFIFLOW_APP_URL',
  'VERCEL_ENV',
  'VERCEL',
  'NODE_ENV',
];

function withBillingEnvironment(values, callback) {
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return callback();
  } finally {
    for (const key of keys) {
      if (saved.get(key) === undefined) delete process.env[key];
      else process.env[key] = saved.get(key);
    }
  }
}

const validValues = {
  GRAFIFLOW_BILLING_ENABLED: 'true',
  GRAFIFLOW_SUPABASE_URL: 'https://project-test.supabase.co',
  GRAFIFLOW_SUPABASE_ANON_KEY: 'public-test-key',
  GRAFIFLOW_SUPABASE_SECRET_KEY: 'server-only-test-key',
  ASAAS_API_KEY: 'asaas-test-key',
  ASAAS_WEBHOOK_AUTH_TOKEN: 'webhook-token-that-is-longer-than-32-characters',
  ASAAS_ENVIRONMENT: 'sandbox',
  GRAFIFLOW_APP_URL: 'https://grafiflow.vercel.app',
};

test('billing endpoints reject missing private configuration', () => {
  withBillingEnvironment({ GRAFIFLOW_BILLING_ENABLED: 'true' }, () => {
    assert.throws(() => billingConfig(), (error) => error.status === 503 && /variáveis privadas/.test(error.message));
  });
});

test('billing endpoints accept valid sandbox configuration', () => {
  withBillingEnvironment(validValues, () => {
    const config = billingConfig();
    assert.equal(config.environment, 'sandbox');
    assert.equal(config.supabaseUrl, validValues.GRAFIFLOW_SUPABASE_URL);
    assert.equal(config.asaasApiUrl, 'https://api-sandbox.asaas.com/v3');
  });
});

test('Asaas environment is restricted by deployment environment', () => {
  assert.equal(asaasCheckoutAvailable({ ASAAS_ENVIRONMENT: 'sandbox', VERCEL_ENV: 'production' }), false);
  assert.equal(asaasCheckoutAvailable({ ASAAS_ENVIRONMENT: 'sandbox', VERCEL_ENV: 'preview', NODE_ENV: 'production' }), true);
  assert.equal(asaasCheckoutAvailable({ ASAAS_ENVIRONMENT: 'production', VERCEL_ENV: 'preview' }), false);
  assert.equal(asaasCheckoutAvailable({ ASAAS_ENVIRONMENT: 'production', VERCEL_ENV: 'development' }), false);
  assert.equal(asaasCheckoutAvailable({ ASAAS_ENVIRONMENT: 'production' }), false);
  assert.equal(asaasCheckoutAvailable({ ASAAS_ENVIRONMENT: 'sandbox', VERCEL: '1' }), false);
  assert.equal(asaasCheckoutAvailable({ ASAAS_ENVIRONMENT: 'sandbox' }), true);
  assert.equal(asaasCheckoutAvailable({ ASAAS_ENVIRONMENT: 'production', VERCEL_ENV: 'production' }), true);
});

test('billing endpoints reject sandbox checkout in production', () => {
  withBillingEnvironment({ ...validValues, VERCEL_ENV: 'production' }, () => {
    assert.throws(() => billingConfig(), (error) => error.status === 503 && /checkout está pausado/.test(error.message));
  });
});

test('billing rejects a short or reused webhook token', () => {
  withBillingEnvironment({ ...validValues, ASAAS_WEBHOOK_AUTH_TOKEN: 'x'.repeat(31) }, () => {
    assert.throws(() => billingConfig(), (error) => error.status === 503 && /32 caracteres/.test(error.message));
  });
  withBillingEnvironment({ ...validValues, ASAAS_WEBHOOK_AUTH_TOKEN: validValues.ASAAS_API_KEY }, () => {
    assert.throws(() => billingConfig(), (error) => error.status === 503 && /32 caracteres/.test(error.message));
  });
});

test('public runtime configuration never exposes billing secrets', () => {
  const script = publicGrafiflowConfigScript({
    ...validValues,
    GRAFIFLOW_SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-secret',
  });
  assert.match(script, /^window\.GRAFIFLOW_CONFIG = Object\.freeze\(/);
  assert.doesNotMatch(script, /ASAAS_API_KEY|ASAAS_WEBHOOK_AUTH_TOKEN|SUPABASE_SECRET_KEY|service-role-test-secret|server-only-test-key/);
});

test('public runtime config exposes checkout only for matching Asaas and Vercel environments', () => {
  assert.equal(publicGrafiflowConfig({ GRAFIFLOW_BILLING_ENABLED: 'true', ASAAS_ENVIRONMENT: 'sandbox', VERCEL_ENV: 'production' }).billingCheckoutEnabled, false);
  assert.equal(publicGrafiflowConfig({ GRAFIFLOW_BILLING_ENABLED: 'true', ASAAS_ENVIRONMENT: 'sandbox', VERCEL_ENV: 'preview' }).billingCheckoutEnabled, true);
  assert.equal(publicGrafiflowConfig({ GRAFIFLOW_BILLING_ENABLED: 'true', ASAAS_ENVIRONMENT: 'production', VERCEL_ENV: 'preview' }).billingCheckoutEnabled, false);
  assert.equal(publicGrafiflowConfig({ GRAFIFLOW_BILLING_ENABLED: 'true', ASAAS_ENVIRONMENT: 'production', VERCEL_ENV: 'production' }).billingCheckoutEnabled, true);
});

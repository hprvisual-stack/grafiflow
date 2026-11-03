export function asaasCheckoutAvailable(env = process.env) {
  const asaasEnvironment = String(env.ASAAS_ENVIRONMENT || 'sandbox').trim().toLowerCase();
  if (!['sandbox', 'production'].includes(asaasEnvironment)) return false;

  const vercelEnvironment = String(env.VERCEL_ENV || '').trim().toLowerCase();
  if (vercelEnvironment === 'production') return asaasEnvironment === 'production';
  if (vercelEnvironment === 'preview' || vercelEnvironment === 'development') return asaasEnvironment === 'sandbox';
  if (vercelEnvironment || env.VERCEL === '1' || String(env.NODE_ENV || '').toLowerCase() === 'production') return false;
  return asaasEnvironment === 'sandbox';
}

export function publicGrafiflowConfig(env = process.env) {
  const billingEnabled = env.GRAFIFLOW_BILLING_ENABLED === 'true';
  return {
    supabaseUrl: String(env.GRAFIFLOW_SUPABASE_URL || '').replace(/\/$/, ''),
    supabaseAnonKey: String(env.GRAFIFLOW_SUPABASE_ANON_KEY || ''),
    billingEnabled,
    billingCheckoutEnabled: billingEnabled && asaasCheckoutAvailable(env),
  };
}

export function publicGrafiflowConfigScript(env = process.env) {
  return `window.GRAFIFLOW_CONFIG = Object.freeze(${JSON.stringify(publicGrafiflowConfig(env))});\n`;
}

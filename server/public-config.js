export function publicGrafiflowConfig(env = process.env) {
  return {
    supabaseUrl: String(env.GRAFIFLOW_SUPABASE_URL || '').replace(/\/$/, ''),
    supabaseAnonKey: String(env.GRAFIFLOW_SUPABASE_ANON_KEY || ''),
    billingEnabled: env.GRAFIFLOW_BILLING_ENABLED === 'true',
  };
}

export function publicGrafiflowConfigScript(env = process.env) {
  return `window.GRAFIFLOW_CONFIG = Object.freeze(${JSON.stringify(publicGrafiflowConfig(env))});\n`;
}

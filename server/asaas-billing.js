const BRAZIL_TIME_ZONE = 'America/Sao_Paulo';
const CHECKOUT_MINUTES_TO_EXPIRE = 60;
const TRIAL_DAYS = 15;
const PROMO_PRICE_CENTS = 4000;
const STANDARD_PRICE_CENTS = 5000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function errorResponse(error) {
  if (error instanceof HttpError) return jsonResponse({ error: error.message }, error.status);
  console.error('Falha interna na integração Asaas.', error?.name || 'Error');
  return jsonResponse({ error: 'Não foi possível concluir a operação de cobrança.' }, 500);
}

export function billingConfig() {
  if (process.env.GRAFIFLOW_BILLING_ENABLED !== 'true') {
    throw new HttpError(503, 'A cobrança do GrafiFlow ainda não está ativada.');
  }

  const supabaseUrl = String(process.env.GRAFIFLOW_SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseAnonKey = String(process.env.GRAFIFLOW_SUPABASE_ANON_KEY || '');
  const supabaseElevatedKey = String(
    process.env.GRAFIFLOW_SUPABASE_SECRET_KEY || process.env.GRAFIFLOW_SUPABASE_SERVICE_ROLE_KEY || '',
  );
  const asaasApiKey = String(process.env.ASAAS_API_KEY || '');
  const asaasWebhookToken = String(process.env.ASAAS_WEBHOOK_AUTH_TOKEN || '');
  const appUrl = String(process.env.GRAFIFLOW_APP_URL || 'https://grafiflow.vercel.app').replace(/\/$/, '');
  const environment = String(process.env.ASAAS_ENVIRONMENT || 'sandbox').toLowerCase();

  if (!supabaseUrl || !supabaseAnonKey || !supabaseElevatedKey || !asaasApiKey || !asaasWebhookToken) {
    throw new HttpError(503, 'A integração de cobrança está sem as variáveis privadas necessárias.');
  }
  if (asaasWebhookToken.length < 32 || asaasWebhookToken === asaasApiKey) {
    throw new HttpError(503, 'Configure um token de webhook independente com pelo menos 32 caracteres.');
  }
  if (!['sandbox', 'production'].includes(environment)) {
    throw new HttpError(503, 'ASAAS_ENVIRONMENT deve ser sandbox ou production.');
  }
  try {
    const app = new URL(appUrl);
    if (app.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(app.hostname)) throw new Error('invalid protocol');
  } catch {
    throw new HttpError(503, 'GRAFIFLOW_APP_URL precisa ser uma URL HTTPS válida.');
  }

  const allowedOrigins = new Set([
    new URL(appUrl).origin,
    ...String(process.env.GRAFIFLOW_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => {
        try { return new URL(origin).origin; } catch { return ''; }
      })
      .filter(Boolean),
  ]);

  return {
    supabaseUrl,
    supabaseAnonKey,
    supabaseElevatedKey,
    asaasApiKey,
    asaasWebhookToken,
    appUrl,
    allowedOrigins,
    environment,
    asaasApiUrl: environment === 'production' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3',
  };
}

export function setRequestDeadline(config) {
  config.deadlineAt = Date.now() + 25_000;
}

function requestSignal(config, maximumMs) {
  const remaining = config?.deadlineAt ? config.deadlineAt - Date.now() : maximumMs;
  return AbortSignal.timeout(Math.max(1, Math.min(maximumMs, remaining)));
}

export function assertSameOrigin(request, config) {
  const origin = request.headers.get('origin');
  if (!origin || !config.allowedOrigins.has(origin)) {
    throw new HttpError(403, 'Origem não autorizada.');
  }
}

export function bearerToken(request) {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || match[1].length > 8192) throw new HttpError(401, 'Entre na sua conta GrafiFlow para continuar.');
  return match[1];
}

export async function authenticatedUser(request, config) {
  const token = bearerToken(request);
  const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${token}` },
    signal: requestSignal(config, 12000),
  });
  if (!response.ok) throw new HttpError(401, 'Sua sessão expirou. Entre novamente para continuar.');
  const user = await response.json();
  if (!user?.id || !(user.email_confirmed_at || user.confirmed_at)) {
    throw new HttpError(403, 'Confirme seu e-mail antes de iniciar a assinatura.');
  }
  return { user, token };
}

export function requireWorkspaceId(value) {
  const workspaceId = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
    throw new HttpError(400, 'Espaço de trabalho inválido. Atualize a página e tente novamente.');
  }
  return workspaceId;
}

export async function assertWorkspaceOwner(workspaceId, user, config) {
  const query = new URLSearchParams({
    select: 'workspace_id',
    workspace_id: `eq.${workspaceId}`,
    user_id: `eq.${user.id}`,
    role: 'eq.owner',
    limit: '1',
  });
  const rows = await supabaseRequest(`/rest/v1/workspace_members?${query}`, { config });
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new HttpError(403, 'Somente o titular do espaço pode contratar a assinatura.');
  }
}

export async function supabaseRequest(path, { config, method = 'GET', body, prefer } = {}) {
  const response = await fetch(`${config.supabaseUrl}${path}`, {
    method,
    headers: {
      apikey: config.supabaseElevatedKey,
      ...(!config.supabaseElevatedKey.startsWith('sb_secret_')
        ? { Authorization: `Bearer ${config.supabaseElevatedKey}` }
        : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: requestSignal(config, 15000),
  });
  const raw = await response.text();
  if (!response.ok) {
    console.error('Erro do Supabase na integração Asaas.', response.status, raw.slice(0, 300));
    throw new HttpError(502, 'Não foi possível atualizar os dados da assinatura. Tente novamente.');
  }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

export function brazilDateAfterDays(days) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BRAZIL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const date = new Date(Date.UTC(get('year'), get('month') - 1, get('day') + days, 12));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function asaasCheckoutUrl(checkout, config) {
  const id = String(checkout?.id || '');
  if (!id) throw new HttpError(502, 'O Asaas não retornou o identificador do checkout.');
  const candidate = checkout?.link ? String(checkout.link) : '';
  if (candidate) {
    try {
      const link = new URL(candidate);
      if (link.protocol === 'https:' && (link.hostname === 'asaas.com' || link.hostname.endsWith('.asaas.com'))) return link.toString();
    } catch { /* usa o link documentado como alternativa */ }
  }
  const host = config.environment === 'production' ? 'asaas.com' : 'sandbox.asaas.com';
  return `https://${host}/checkoutSession/show?id=${encodeURIComponent(id)}`;
}

export async function callAsaas(path, { config, method = 'GET', body } = {}) {
  const response = await fetch(`${config.asaasApiUrl}${path}`, {
    method,
    headers: {
      access_token: config.asaasApiKey,
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'GrafiFlow/1.0',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: requestSignal(config, 18000),
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!response.ok) {
    console.error('Erro do Asaas.', response.status, JSON.stringify(data).slice(0, 400));
    const error = new HttpError(502, 'O Asaas não aceitou a operação. Verifique o ambiente e as credenciais configurados.');
    error.asaasDefinitive = response.status >= 400 && response.status < 500;
    throw error;
  }
  return data;
}

export function checkoutConstants() {
  return { checkoutMinutesToExpire: CHECKOUT_MINUTES_TO_EXPIRE, trialDays: TRIAL_DAYS, promoPriceCents: PROMO_PRICE_CENTS, standardPriceCents: STANDARD_PRICE_CENTS };
}

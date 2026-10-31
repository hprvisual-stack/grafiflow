import { timingSafeEqual } from 'node:crypto';
import {
  billingConfig,
  callAsaas,
  errorResponse,
  jsonResponse,
  setRequestDeadline,
  supabaseRequest,
} from '../../server/asaas-billing.js';

function validWebhookToken(request, expected) {
  const received = request.headers.get('asaas-access-token') || '';
  const receivedBuffer = Buffer.from(received, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export async function POST(request) {
  try {
    const config = billingConfig();
    setRequestDeadline(config);
    if (!validWebhookToken(request, config.asaasWebhookToken)) return jsonResponse({ error: 'Não autorizado.' }, 401);
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 1_048_576) return jsonResponse({ error: 'Requisição muito grande.' }, 413);
    const raw = await request.text();
    if (raw.length > 1_048_576) return jsonResponse({ error: 'Requisição muito grande.' }, 413);
    let payload;
    try { payload = JSON.parse(raw); } catch { return jsonResponse({ error: 'JSON inválido.' }, 400); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return jsonResponse({ error: 'Evento inválido.' }, 400);

    const result = await supabaseRequest('/rest/v1/rpc/process_asaas_billing_event', {
      config,
      method: 'POST',
      body: { p_payload: payload },
    });

    if (result?.upgradeRequired && result.subscriptionId) {
      await callAsaas(`/subscriptions/${encodeURIComponent(result.subscriptionId)}`, {
        config,
        method: 'PUT',
        body: { value: 50, updatePendingPayments: true },
      });
      await supabaseRequest('/rest/v1/rpc/complete_asaas_price_upgrade', {
        config,
        method: 'POST',
        body: { p_event_id: payload.id, p_provider_subscription_id: result.subscriptionId },
      });
    }

    return jsonResponse({ received: true }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

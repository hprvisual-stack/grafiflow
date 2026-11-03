import {
  assertSameOrigin,
  assertWorkspaceOwner,
  authenticatedUser,
  billingConfig,
  asaasCheckoutUrl,
  asaasPaymentLinkUrl,
  brazilDateAfterDays,
  buildAsaasMonthlyPaymentLinkPayload,
  buildAsaasCheckoutPayload,
  callAsaas,
  checkoutConstants,
  errorResponse,
  HttpError,
  isPermanentFreeAccount,
  jsonResponse,
  requireWorkspaceId,
  setRequestDeadline,
  supabaseRequest,
} from '../../server/asaas-billing.js';

function asaasPaymentUrl(payment) {
  const candidate = String(payment?.invoiceUrl || '');
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && (url.hostname === 'asaas.com' || url.hostname.endsWith('.asaas.com')) ? url.toString() : '';
  } catch { return ''; }
}

async function findUpcomingSubscriptionPayment(subscriptionId, config) {
  const result = await callAsaas(`/subscriptions/${encodeURIComponent(subscriptionId)}/payments?limit=100`, { config });
  const rows = Array.isArray(result?.data) ? result.data : [];
  const candidates = rows
    .filter((payment) => ['PENDING', 'OVERDUE'].includes(String(payment?.status || '').toUpperCase()))
    .map((payment) => ({ payment, url: asaasPaymentUrl(payment) }))
    .filter((entry) => entry.url)
    .sort((left, right) => String(left.payment.dueDate || '').localeCompare(String(right.payment.dueDate || '')));
  return candidates[0] || null;
}

export async function POST(request) {
  let claimToken = '';
  let workspaceId = '';
  let asaasCheckoutAttempted = false;
  let config;
  try {
    config = billingConfig();
    setRequestDeadline(config);
    assertSameOrigin(request, config);
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 8192) throw new HttpError(413, 'Requisição muito grande.');
    let body;
    try { body = await request.json(); } catch { throw new HttpError(400, 'Dados da solicitação inválidos.'); }

    workspaceId = requireWorkspaceId(body?.workspaceId);
    const planType = String(body?.planType || 'monthly');
    if (!['monthly', 'annual'].includes(planType)) throw new HttpError(400, 'Escolha um plano mensal ou anual.');
    const { user } = await authenticatedUser(request, config);
    await assertWorkspaceOwner(workspaceId, user, config);
    if (await isPermanentFreeAccount(user, config)) {
      throw new HttpError(409, 'Esta conta tem acesso gratuito permanente e não precisa contratar um plano.');
    }

    const claimed = await supabaseRequest('/rest/v1/rpc/claim_grafiflow_checkout', {
      config,
      method: 'POST',
      body: { p_workspace_id: workspaceId, p_plan_type: planType },
    });
    if (claimed?.action === 'reuse') {
      return jsonResponse({ checkoutUrl: asaasCheckoutUrl({ id: claimed.checkoutId, link: claimed.checkoutUrl }, config), reused: true });
    }
    if (claimed?.action === 'advance_monthly') {
      const upcoming = await findUpcomingSubscriptionPayment(claimed.subscriptionId, config);
      if (!upcoming) throw new HttpError(409, 'O Asaas ainda não gerou a próxima cobrança. Ela será exibida aqui assim que ficar disponível para pagamento antecipado.');
      return jsonResponse({ paymentUrl: upcoming.url, paymentId: upcoming.payment.id, dueDate: upcoming.payment.dueDate, amount: upcoming.payment.value, advance: true });
    }
    if (claimed?.action === 'legacy_access') throw new HttpError(409, 'Este espaço já possui acesso garantido e não precisa contratar um plano.');
    if (claimed?.action === 'annual_period_already_paid_or_pending') throw new HttpError(409, 'A próxima anuidade já está paga ou existe uma renovação em processamento. Consulte Minha Assinatura.');
    if (claimed?.action === 'plan_already_scheduled') throw new HttpError(409, 'A mudança para o plano mensal já está programada para o fim do período anual.');
    if (claimed?.action === 'plan_change_pending') throw new HttpError(409, 'Já existe uma mudança de plano programada. Aguarde a conclusão antes de solicitar outra.');
    if (claimed?.action === 'provisioning') throw new HttpError(409, 'O Asaas está confirmando sua assinatura. Aguarde alguns instantes e atualize esta tela.');
    if (claimed?.action === 'unsupported_provider') throw new HttpError(409, 'Este espaço usa outro provedor de cobrança.');
    if (claimed?.action === 'busy') throw new HttpError(409, 'Há um checkout em preparação. Aguarde e atualize esta tela antes de tentar novamente.');
    if (claimed?.action !== 'create' || !claimed.claimToken) throw new HttpError(502, 'Não foi possível reservar a criação do checkout.');

    claimToken = claimed.claimToken;
    const { checkoutMinutesToExpire } = checkoutConstants();
    const useMonthlyPaymentLink = planType === 'monthly' && !claimed.scheduled;
    const payload = useMonthlyPaymentLink
      ? buildAsaasMonthlyPaymentLinkPayload({ claim: claimed, endDate: brazilDateAfterDays(7) })
      : buildAsaasCheckoutPayload({ planType, claim: claimed, appUrl: config.appUrl, minutesToExpire: checkoutMinutesToExpire });
    asaasCheckoutAttempted = true;
    const checkout = await callAsaas(useMonthlyPaymentLink ? '/paymentLinks' : '/checkouts', { config, method: 'POST', body: payload });
    let checkoutUrl;
    try {
      checkoutUrl = useMonthlyPaymentLink
        ? asaasPaymentLinkUrl(checkout)
        : asaasCheckoutUrl(checkout, config);
    } catch (error) {
      if (useMonthlyPaymentLink && checkout?.id) {
        await callAsaas(`/paymentLinks/${encodeURIComponent(String(checkout.id))}`, { config, method: 'DELETE' })
          .catch((cleanupError) => console.error('Não foi possível remover um link Asaas incompleto.', cleanupError?.name || 'Error'));
      }
      throw error;
    }
    const expiresAt = new Date(Date.now() + (useMonthlyPaymentLink ? 7 * 24 * 60 * 60_000 : checkoutMinutesToExpire * 60_000));

    await supabaseRequest('/rest/v1/rpc/finalize_grafiflow_checkout', {
      config,
      method: 'POST',
      body: {
        p_workspace_id: workspaceId,
        p_claim_token: claimToken,
        p_checkout_id: String(checkout.id),
        p_checkout_url: checkoutUrl,
        p_checkout_expires_at: expiresAt.toISOString(),
      },
    });
    claimToken = '';
    return jsonResponse({
      checkoutUrl,
      reused: false,
      planType,
      amountCents: Number(claimed.priceCents),
      scheduled: Boolean(claimed.scheduled),
      effectiveAt: claimed.periodStart || null,
    });
  } catch (error) {
    if (claimToken && workspaceId && config && (!asaasCheckoutAttempted || error?.asaasDefinitive === true)) {
      await supabaseRequest('/rest/v1/rpc/release_grafiflow_checkout_claim', {
        config,
        method: 'POST',
        body: { p_workspace_id: workspaceId, p_claim_token: claimToken },
      }).catch((releaseError) => console.error('Não foi possível liberar a reserva do checkout.', releaseError?.name || 'Error'));
    }
    return errorResponse(error);
  }
}

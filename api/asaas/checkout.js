import {
  assertSameOrigin,
  assertWorkspaceOwner,
  authenticatedUser,
  billingConfig,
  brazilDateAfterDays,
  asaasCheckoutUrl,
  callAsaas,
  checkoutConstants,
  errorResponse,
  HttpError,
  jsonResponse,
  requireWorkspaceId,
  setRequestDeadline,
  supabaseRequest,
} from '../../server/asaas-billing.js';

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
    const { user } = await authenticatedUser(request, config);
    await assertWorkspaceOwner(workspaceId, user, config);

    const claimed = await supabaseRequest('/rest/v1/rpc/claim_asaas_checkout', {
      config,
      method: 'POST',
      body: { p_workspace_id: workspaceId },
    });
    if (claimed?.action === 'reuse') {
      return jsonResponse({ checkoutUrl: asaasCheckoutUrl({ id: claimed.checkoutId, link: claimed.checkoutUrl }, config), reused: true });
    }
    if (claimed?.action === 'provisioning') throw new HttpError(409, 'O Asaas está confirmando sua assinatura. Aguarde alguns instantes e atualize esta tela.');
    if (claimed?.action === 'already_active') throw new HttpError(409, 'Este espaço já tem uma assinatura ativa ou em período de teste.');
    if (claimed?.action === 'existing_subscription') throw new HttpError(409, 'Já existe uma assinatura em processamento ou com pagamento pendente. Regularize essa cobrança antes de criar outra.');
    if (claimed?.action === 'unsupported_provider') throw new HttpError(409, 'Este espaço usa outro provedor de cobrança.');
    if (claimed?.action === 'busy') throw new HttpError(409, 'Há um checkout em preparação ou aguardando confirmação do Asaas. Aguarde e atualize esta tela antes de tentar novamente.');
    if (claimed?.action !== 'create' || !claimed.claimToken) throw new HttpError(502, 'Não foi possível reservar a criação do checkout.');

    claimToken = claimed.claimToken;
    const { checkoutMinutesToExpire, trialDays } = checkoutConstants();
    const priceCents = Number(claimed.priceCents);
    const trial = Boolean(claimed.trial);
    if (![4000, 5000].includes(priceCents)) throw new HttpError(502, 'A configuração de preço retornada pelo banco é inválida.');
    const nextDueDate = brazilDateAfterDays(trial ? trialDays : 0);
    const trialEndsAt = trial ? new Date(`${nextDueDate}T23:59:59-03:00`).toISOString() : null;
    const value = priceCents / 100;

    asaasCheckoutAttempted = true;
    const checkout = await callAsaas('/checkouts', {
      config,
      method: 'POST',
      body: {
        billingTypes: ['CREDIT_CARD'],
        chargeTypes: ['RECURRENT'],
        minutesToExpire: checkoutMinutesToExpire,
        externalReference: claimToken,
        callback: {
          successUrl: `${config.appUrl}/?asaas=success`,
          cancelUrl: `${config.appUrl}/?asaas=cancel`,
          expiredUrl: `${config.appUrl}/?asaas=expired`,
        },
        items: [{ name: 'Assinatura GrafiFlow', description: 'Acesso mensal ao GrafiFlow', quantity: 1, value }],
        subscription: { cycle: 'MONTHLY', nextDueDate },
      },
    });
    const checkoutUrl = asaasCheckoutUrl(checkout, config);
    await supabaseRequest('/rest/v1/rpc/finalize_asaas_checkout', {
      config,
      method: 'POST',
      body: {
        p_workspace_id: workspaceId,
        p_claim_token: claimToken,
        p_checkout_id: String(checkout.id),
        p_checkout_url: checkoutUrl,
        p_checkout_expires_at: new Date(Date.now() + checkoutMinutesToExpire * 60_000).toISOString(),
        p_trial_requested: trial,
        p_trial_ends_at: trialEndsAt,
        p_price_cents: priceCents,
      },
    });
    claimToken = '';
    return jsonResponse({ checkoutUrl, reused: false, trialDays: trial ? trialDays : 0, amountCents: priceCents });
  } catch (error) {
    if (claimToken && workspaceId && config && (!asaasCheckoutAttempted || error?.asaasDefinitive === true)) {
      await supabaseRequest('/rest/v1/rpc/release_asaas_checkout_claim', {
        config,
        method: 'POST',
        body: { p_workspace_id: workspaceId, p_claim_token: claimToken },
      }).catch((releaseError) => console.error('Não foi possível liberar a reserva do checkout.', releaseError?.name || 'Error'));
    }
    return errorResponse(error);
  }
}

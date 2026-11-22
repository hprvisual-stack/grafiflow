export const TRIAL_DAYS = 15;
export const GRACE_DAYS = 10;
export const MONTHLY_PROMO_CYCLES = 3;

export const BILLING_PLAN_CATALOG = Object.freeze([
  Object.freeze({
    code: 'individual_monthly_v2', label: 'Individual mensal', family: 'individual', productTier: 'solo',
    billingCycle: 'monthly', seatLimit: 1, trialDays: TRIAL_DAYS,
    promoCycles: MONTHLY_PROMO_CYCLES, promoPriceCents: 5000, standardPriceCents: 7500,
  }),
  Object.freeze({
    code: 'team_4_monthly_v2', label: 'Equipe até 4', family: 'team', productTier: 'team',
    billingCycle: 'monthly', seatLimit: 4, trialDays: TRIAL_DAYS,
    promoCycles: MONTHLY_PROMO_CYCLES, promoPriceCents: 10000, standardPriceCents: 13000,
  }),
  Object.freeze({
    code: 'team_unlimited_monthly', label: 'Equipe ilimitada (5+)', family: 'team', productTier: 'team',
    billingCycle: 'monthly', seatLimit: null, trialDays: TRIAL_DAYS,
    promoCycles: MONTHLY_PROMO_CYCLES, promoPriceCents: 15000, standardPriceCents: 20000,
  }),
  Object.freeze({
    code: 'individual_annual', label: 'Individual anual', family: 'individual', productTier: 'solo',
    billingCycle: 'annual', seatLimit: 1, trialDays: TRIAL_DAYS, annualPriceCents: 50000,
  }),
  Object.freeze({
    code: 'team_4_annual', label: 'Equipe até 4 anual', family: 'team', productTier: 'team',
    billingCycle: 'annual', seatLimit: 4, trialDays: TRIAL_DAYS, annualPriceCents: 100000,
  }),
  Object.freeze({
    code: 'team_unlimited_annual', label: 'Equipe ilimitada (5+) anual', family: 'team', productTier: 'team',
    billingCycle: 'annual', seatLimit: null, trialDays: TRIAL_DAYS, annualPriceCents: 200000,
  }),
]);

const PLANS_BY_CODE = new Map(BILLING_PLAN_CATALOG.map((plan) => [plan.code, plan]));
const DAY_MS = 24 * 60 * 60 * 1000;

// Default values exposed by the current individual monthly offer.
export const MONTHLY_PROMO_PRICE_CENTS = 5000;
export const MONTHLY_STANDARD_PRICE_CENTS = 7500;
export const ANNUAL_PRICE_CENTS = 50000;

export function getBillingPlan(planCode) {
  return PLANS_BY_CODE.get(String(planCode || '')) || null;
}

export function monthlyPriceCents(paidMonthlyCycles = 0, planCode = 'individual_monthly_v2') {
  const plan = getBillingPlan(planCode);
  if (!plan || plan.billingCycle !== 'monthly') return null;
  return Number(paidMonthlyCycles) < plan.promoCycles ? plan.promoPriceCents : plan.standardPriceCents;
}

export function planPriceCents(planCode, paidMonthlyCycles = 0) {
  const plan = getBillingPlan(planCode);
  if (!plan) return null;
  return plan.billingCycle === 'annual' ? plan.annualPriceCents : monthlyPriceCents(paidMonthlyCycles, planCode);
}

export function addCalendarMonths(value, months) {
  const source = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(source.getTime()) || !Number.isInteger(months)) throw new TypeError('Data ou quantidade de meses inválida.');
  const targetMonth = source.getUTCMonth() + months;
  const firstOfTarget = new Date(Date.UTC(source.getUTCFullYear(), targetMonth, 1));
  const lastDay = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    firstOfTarget.getUTCFullYear(),
    firstOfTarget.getUTCMonth(),
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  ));
}

export function graceEndsAt(periodEnd) {
  const end = periodEnd instanceof Date ? periodEnd : new Date(periodEnd);
  if (Number.isNaN(end.getTime())) return null;
  return new Date(end.getTime() + GRACE_DAYS * DAY_MS);
}

export function trialEndsAt(startedAt) {
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + TRIAL_DAYS * DAY_MS);
}

export function periodStartAfterPayment(currentPeriodEnd, confirmedAt) {
  const confirmed = confirmedAt instanceof Date ? confirmedAt : new Date(confirmedAt);
  const currentEnd = currentPeriodEnd ? (currentPeriodEnd instanceof Date ? currentPeriodEnd : new Date(currentPeriodEnd)) : null;
  if (Number.isNaN(confirmed.getTime())) return null;
  if (currentEnd && !Number.isNaN(currentEnd.getTime()) && currentEnd.getTime() + GRACE_DAYS * DAY_MS >= confirmed.getTime()) return currentEnd;
  return confirmed;
}

export function isDueNoticeActive(dueAt, now = new Date()) {
  if (!dueAt) return false;
  const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
  const current = now instanceof Date ? now : new Date(now);
  const difference = due.getTime() - current.getTime();
  return Number.isFinite(difference) && difference >= 0 && difference <= 5 * DAY_MS;
}

export function deriveEntitlement(snapshot = {}, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const nowMs = current.getTime();
  const trialEnd = snapshot.trial_ends_at ? new Date(snapshot.trial_ends_at) : null;
  const periodEnd = snapshot.current_period_end ? new Date(snapshot.current_period_end) : null;
  const graceEnd = periodEnd && !Number.isNaN(periodEnd.getTime()) ? graceEndsAt(periodEnd) : null;
  const trialActive = snapshot.trial_status === 'active' && trialEnd && trialEnd.getTime() > nowMs;
  const paidActive = periodEnd && !Number.isNaN(periodEnd.getTime()) && periodEnd.getTime() > nowMs;
  const graceActive = graceEnd && graceEnd.getTime() > nowMs && !paidActive;

  let state;
  if (snapshot.legacy_access) state = 'legacy_access';
  else if (paidActive) state = 'subscription_active';
  else if (trialActive) state = 'trial_active';
  else if (graceActive) state = 'grace_active';
  else if (periodEnd && !Number.isNaN(periodEnd.getTime())) state = 'subscription_expired';
  else if (snapshot.provider_checkout_id || snapshot.provider_subscription_id || snapshot.payment_pending) state = 'payment_pending';
  else if (snapshot.trial_used || trialEnd) state = 'trial_expired';
  else state = 'trial_not_started';

  return {
    state,
    accessAllowed: ['legacy_access', 'subscription_active', 'trial_active', 'grace_active'].includes(state),
    graceEndsAt: graceEnd,
    trialEndsAt: trialEnd,
    currentPeriodEnd: periodEnd,
  };
}

export function countdownLabel(endsAt, now = new Date(), noun = 'Teste grátis') {
  const end = endsAt instanceof Date ? endsAt : new Date(endsAt);
  const current = now instanceof Date ? now : new Date(now);
  const remainingMs = end.getTime() - current.getTime();
  if (Number.isNaN(remainingMs) || remainingMs <= 0) return '';
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const totalDays = Math.ceil(remainingMs / DAY_MS);
  if (remainingMs <= DAY_MS) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${noun}: ${hours}h ${String(minutes).padStart(2, '0')}min restantes`;
  }
  if (totalDays <= 3) return `${noun}: ${totalDays} ${totalDays === 1 ? 'dia' : 'dias'} restantes`;
  return `${noun}: ${totalDays} dias restantes`;
}

function requestedPlanCode({ planCode, planType }) {
  if (planCode) return String(planCode);
  if (planType === 'monthly') return 'individual_monthly_v2';
  if (planType === 'annual') return 'individual_annual';
  return '';
}

export function buildAsaasCheckoutPayload({ planCode, planType, claim, appUrl, minutesToExpire = 60 }) {
  const code = requestedPlanCode({ planCode, planType });
  const plan = getBillingPlan(code);
  if (!plan) throw new TypeError('Plano inválido.');
  const callback = {
    successUrl: `${appUrl}/?asaas=success`,
    cancelUrl: `${appUrl}/?asaas=cancel`,
    expiredUrl: `${appUrl}/?asaas=expired`,
  };
  if (plan.billingCycle === 'annual') {
    const amountCents = Number(claim?.priceCents ?? claim?.annualPriceCents);
    if (amountCents !== plan.annualPriceCents) throw new TypeError('Preço anual do plano não corresponde ao catálogo.');
    return {
      billingTypes: ['CREDIT_CARD', 'PIX'],
      chargeTypes: ['DETACHED'],
      minutesToExpire,
      externalReference: claim.claimToken,
      callback,
      items: [{ name: `Plano ${plan.label} Metriflux`, description: '12 meses de acesso, pagamento único à vista, sem parcelamento', quantity: 1, value: amountCents / 100 }],
    };
  }
  const amountCents = Number(claim.priceCents);
  if (![plan.promoPriceCents, plan.standardPriceCents].includes(amountCents) || !/^\d{4}-\d{2}-\d{2}$/.test(String(claim.nextDueDate || ''))) {
    throw new TypeError('Configuração de cobrança mensal inválida.');
  }
  return {
    billingTypes: ['CREDIT_CARD'],
    chargeTypes: ['RECURRENT'],
    minutesToExpire,
    externalReference: claim.claimToken,
    callback,
    items: [{ name: `Plano ${plan.label} Metriflux`, description: amountCents === plan.promoPriceCents ? 'Uma das três primeiras mensalidades promocionais' : 'Mensalidade recorrente do plano Metriflux', quantity: 1, value: amountCents / 100 }],
    subscription: { cycle: 'MONTHLY', nextDueDate: claim.nextDueDate },
  };
}

export function buildAsaasMonthlyPaymentLinkPayload({ claim, endDate }) {
  const plan = getBillingPlan(claim?.planCode || 'individual_monthly_v2');
  const amountCents = Number(claim?.priceCents);
  const claimToken = String(claim?.claimToken || '');
  if (!plan || plan.billingCycle !== 'monthly' || ![plan.promoPriceCents, plan.standardPriceCents].includes(amountCents)
      || !/^[0-9a-f-]{36}$/i.test(claimToken)) {
    throw new TypeError('Configuração de cobrança mensal inválida.');
  }
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate))) {
    throw new TypeError('Validade do link de pagamento inválida.');
  }

  return {
    name: `Assinatura mensal ${plan.label} Metriflux`,
    description: amountCents === plan.promoPriceCents
      ? `Assinatura ${plan.label}: uma das três primeiras mensalidades promocionais.`
      : `Assinatura mensal ${plan.label} Metriflux.`,
    value: amountCents / 100,
    billingType: 'UNDEFINED',
    chargeType: 'RECURRENT',
    subscriptionCycle: 'MONTHLY',
    limit: 1,
    dueDateLimitDays: 7,
    externalReference: claimToken,
    notificationEnabled: true,
    ...(endDate ? { endDate } : {}),
  };
}

export function expectedPlanPriceCents(planCode, cycleNumber = 1) {
  const code = planCode === 'monthly' ? 'individual_monthly_v2' : planCode === 'annual' ? 'individual_annual' : planCode;
  const plan = getBillingPlan(code);
  if (!plan) return null;
  return plan.billingCycle === 'annual'
    ? plan.annualPriceCents
    : monthlyPriceCents(Math.max(0, Number(cycleNumber) - 1), code);
}

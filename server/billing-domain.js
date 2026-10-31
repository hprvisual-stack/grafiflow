export const TRIAL_DAYS = 15;
export const GRACE_DAYS = 10;
export const MONTHLY_PROMO_CYCLES = 3;
export const MONTHLY_PROMO_PRICE_CENTS = 3500;
export const MONTHLY_STANDARD_PRICE_CENTS = 5000;
export const ANNUAL_PRICE_CENTS = 45000;

const DAY_MS = 24 * 60 * 60 * 1000;

export function monthlyPriceCents(paidMonthlyCycles = 0) {
  return Number(paidMonthlyCycles) < MONTHLY_PROMO_CYCLES
    ? MONTHLY_PROMO_PRICE_CENTS
    : MONTHLY_STANDARD_PRICE_CENTS;
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

export function buildAsaasCheckoutPayload({ planType, claim, appUrl, minutesToExpire = 60 }) {
  if (!['monthly', 'annual'].includes(planType)) throw new TypeError('Plano inválido.');
  const callback = {
    successUrl: `${appUrl}/?asaas=success`,
    cancelUrl: `${appUrl}/?asaas=cancel`,
    expiredUrl: `${appUrl}/?asaas=expired`,
  };
  if (planType === 'annual') {
    return {
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: ['DETACHED'],
      minutesToExpire,
      externalReference: claim.claimToken,
      callback,
      items: [{ name: 'Plano anual GrafiFlow', description: '12 meses de acesso, pagamento único à vista, sem parcelamento', quantity: 1, value: 450 }],
    };
  }
  const amountCents = Number(claim.priceCents);
  if (![3500, 5000].includes(amountCents) || !/^\d{4}-\d{2}-\d{2}$/.test(String(claim.nextDueDate || ''))) {
    throw new TypeError('Configuração de cobrança mensal inválida.');
  }
  return {
    billingTypes: ['CREDIT_CARD'],
    chargeTypes: ['RECURRENT'],
    minutesToExpire,
    externalReference: claim.claimToken,
    callback,
    items: [{ name: 'Plano mensal GrafiFlow', description: amountCents === 3500 ? 'Uma das três primeiras mensalidades promocionais' : 'Mensalidade do plano GrafiFlow', quantity: 1, value: amountCents / 100 }],
    subscription: { cycle: 'MONTHLY', nextDueDate: claim.nextDueDate },
  };
}

export function expectedPlanPriceCents(planType, cycleNumber = 1) {
  if (planType === 'annual') return ANNUAL_PRICE_CENTS;
  if (planType === 'monthly') return monthlyPriceCents(Math.max(0, Number(cycleNumber) - 1));
  return null;
}

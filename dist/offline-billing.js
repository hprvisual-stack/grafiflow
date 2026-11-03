export const OFFLINE_BILLING_CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 10;

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function deriveOfflineEntitlement(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== 'object') return null;

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const cachedAt = timestamp(snapshot.client_cached_at);
  const serverNow = timestamp(snapshot.server_now);
  if (!Number.isFinite(nowMs) || cachedAt === null || serverNow === null) return null;

  const elapsed = nowMs - cachedAt;
  if (elapsed < 0 || elapsed > OFFLINE_BILLING_CACHE_MAX_AGE_MS) return null;

  const estimatedServerNow = serverNow + elapsed;
  const trialEnd = timestamp(snapshot.trial_ends_at);
  const periodEnd = timestamp(snapshot.current_period_end);
  const graceEnd = timestamp(snapshot.grace_period_ends_at)
    ?? (periodEnd === null ? null : periodEnd + GRACE_DAYS * DAY_MS);
  const legacyAccess = snapshot.legacy_access === true;
  const paidActive = periodEnd !== null && periodEnd > estimatedServerNow;
  const trialActive = snapshot.trial_status === 'active' && trialEnd !== null && trialEnd > estimatedServerNow;
  const graceActive = !paidActive && graceEnd !== null && graceEnd > estimatedServerNow;

  let state;
  if (legacyAccess) state = 'legacy_access';
  else if (paidActive) state = 'subscription_active';
  else if (trialActive) state = 'trial_active';
  else if (graceActive) state = 'grace_active';
  else if (periodEnd !== null) state = 'subscription_expired';
  else if (snapshot.provider_checkout_id || snapshot.provider_subscription_id || snapshot.payment_pending) state = 'payment_pending';
  else if (snapshot.trial_used || trialEnd !== null) state = 'trial_expired';
  else state = 'trial_not_started';

  return {
    ...snapshot,
    state,
    access_allowed: ['legacy_access', 'subscription_active', 'trial_active', 'grace_active'].includes(state),
    server_now: new Date(estimatedServerNow).toISOString(),
    client_cached_at: cachedAt,
    grace_period_ends_at: graceEnd === null ? null : new Date(graceEnd).toISOString(),
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  addCalendarMonths,
  buildAsaasCheckoutPayload,
  countdownLabel,
  deriveEntitlement,
  expectedPlanPriceCents,
  graceEndsAt,
  isDueNoticeActive,
  monthlyPriceCents,
  periodStartAfterPayment,
  trialEndsAt,
} from '../server/billing-domain.js';

const now = new Date('2026-10-31T15:00:00.000Z');
const migration = await readFile(new URL('../supabase/migrations/20261031120000_grafiflow_subscriptions_entitlements.sql', import.meta.url), 'utf8');
const checkoutHandler = await readFile(new URL('../api/asaas/checkout.js', import.meta.url), 'utf8');
const webhookHandler = await readFile(new URL('../api/asaas/webhook.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');

const scenarios = [
  ['01 new user waits at the trial gate', () => assert.equal(deriveEntitlement({}, now).state, 'trial_not_started')],
  ['02 trial activation grants exactly fifteen full days', () => assert.equal(trialEndsAt(now).getTime() - now.getTime(), 15 * 86_400_000)],
  ['03 logout and later login reuse the same persisted end date', () => {
    const end = trialEndsAt(now);
    assert.equal(deriveEntitlement({ trial_used: true, trial_status: 'active', trial_ends_at: end }, new Date(now.getTime() + 2 * 86_400_000)).trialEndsAt.getTime(), end.getTime());
  }],
  ['04 countdown uses whole days before the final twenty four hours', () => assert.equal(countdownLabel(new Date(now.getTime() + 12 * 86_400_000), now), 'Teste grátis: 12 dias restantes')],
  ['05 countdown highlights the final three days', () => assert.equal(countdownLabel(new Date(now.getTime() + 3 * 86_400_000), now), 'Teste grátis: 3 dias restantes')],
  ['06 confirmed payment replaces trial access state', () => assert.equal(deriveEntitlement({ trial_status: 'active', trial_ends_at: new Date(now.getTime() + 10 * 86_400_000), current_period_end: new Date(now.getTime() + 30 * 86_400_000) }, now).state, 'subscription_active')],
  ['07 payment on the last trial day maintains paid access', () => assert.equal(deriveEntitlement({ trial_status: 'active', trial_ends_at: now, current_period_end: new Date(now.getTime() + 30 * 86_400_000) }, now).accessAllowed, true)],
  ['08 trial expiry blocks access without grace', () => assert.equal(deriveEntitlement({ trial_used: true, trial_status: 'expired', trial_ends_at: new Date(now.getTime() - 1) }, now).accessAllowed, false)],
  ['09 first monthly cycle costs R$ 35', () => assert.equal(monthlyPriceCents(0), 3500)],
  ['10 second monthly cycle costs R$ 35', () => assert.equal(monthlyPriceCents(1), 3500)],
  ['11 third monthly cycle costs R$ 35', () => assert.equal(monthlyPriceCents(2), 3500)],
  ['12 fourth monthly cycle costs R$ 50', () => assert.equal(monthlyPriceCents(3), 5000)],
  ['13 annual plan costs R$ 450', () => assert.equal(expectedPlanPriceCents('annual'), 45000)],
  ['14 annual checkout is detached and has no installment fields', () => {
    const payload = buildAsaasCheckoutPayload({ planType: 'annual', claim: { claimToken: 'claim-1' }, appUrl: 'https://grafiflow.vercel.app' });
    assert.deepEqual(payload.chargeTypes, ['DETACHED']);
    assert.equal('subscription' in payload, false);
    assert.equal('installment' in payload, false);
    assert.equal(payload.items[0].value, 450);
  }],
  ['15 five day due notice is active inside its window only', () => {
    assert.equal(isDueNoticeActive(new Date(now.getTime() + 5 * 86_400_000), now), true);
    assert.equal(isDueNoticeActive(new Date(now.getTime() + 5 * 86_400_000 + 1), now), false);
  }],
  ['16 an advance payment clears the old period deadline and establishes a paid period', () => {
    const currentEnd = new Date(now.getTime() + 1);
    const start = periodStartAfterPayment(currentEnd, now);
    assert.equal(start.getTime(), currentEnd.getTime());
    assert.equal(deriveEntitlement({ current_period_end: addCalendarMonths(start, 1) }, now).state, 'subscription_active');
  }],
  ['17 paid next period is represented by its existing Asaas charge, not a second checkout', () => {
    assert.match(migration, /provider_payment_id text unique/);
    assert.match(migration, /advance_monthly/);
  }],
  ['18 monthly term enters a ten day grace period at its exact end', () => {
    const end = new Date(now.getTime() - 1);
    assert.equal(deriveEntitlement({ current_period_end: end }, now).state, 'grace_active');
    assert.equal(graceEndsAt(end).getTime(), end.getTime() + 10 * 86_400_000);
  }],
  ['19 access remains allowed during grace', () => assert.equal(deriveEntitlement({ current_period_end: new Date(now.getTime() - 5 * 86_400_000) }, now).accessAllowed, true)],
  ['20 payment during grace preserves the original cycle end as the new start', () => {
    const end = new Date(now.getTime() - 5 * 86_400_000);
    assert.equal(periodStartAfterPayment(end, now).getTime(), end.getTime());
  }],
  ['21 access is blocked when the tenth grace day has ended', () => assert.equal(deriveEntitlement({ current_period_end: new Date(now.getTime() - 10 * 86_400_000) }, now).accessAllowed, false)],
  ['22 payment after grace starts the new paid term at confirmation time', () => {
    const end = new Date(now.getTime() - 11 * 86_400_000);
    assert.equal(periodStartAfterPayment(end, now).getTime(), now.getTime());
  }],
  ['23 annual subscriptions use the same ten day grace rule', () => assert.equal(deriveEntitlement({ plan_type: 'annual', current_period_end: new Date(now.getTime() - 9 * 86_400_000) }, now).accessAllowed, true)],
  ['24 a trial ending does not receive paid grace', () => assert.equal(deriveEntitlement({ trial_used: true, trial_status: 'expired', trial_ends_at: new Date(now.getTime() - 1) }, now).state, 'trial_expired')],
  ['25 entitlement is derived from the server time passed to the policy', () => {
    const end = new Date(now.getTime() + 1);
    assert.equal(deriveEntitlement({ current_period_end: end }, now).accessAllowed, true);
    assert.equal(deriveEntitlement({ current_period_end: end }, new Date(end.getTime() + 1)).accessAllowed, true);
    assert.equal(deriveEntitlement({ current_period_end: end }, new Date(end.getTime() + 10 * 86_400_000 + 1)).accessAllowed, false);
  }],
  ['26 a used trial cannot return to trial_not_started', () => assert.equal(deriveEntitlement({ trial_used: true, trial_status: 'expired', trial_ends_at: new Date(now.getTime() - 1) }, now).state, 'trial_expired')],
  ['27 an unconfirmed checkout does not grant access', () => assert.equal(deriveEntitlement({ provider_checkout_id: 'checkout-1', payment_pending: true }, now).accessAllowed, false)],
  ['28 payment and webhook IDs are unique for idempotent processing', () => {
    assert.match(migration, /provider_payment_id text unique/);
    assert.match(migration, /on conflict \(provider_event_id\) do nothing/);
    assert.match(migration, /on conflict \(provider_payment_id\)/);
  }],
  ['29 an early paid period starts when the existing paid term ends', () => {
    const end = new Date(now.getTime() + 8 * 86_400_000);
    assert.equal(periodStartAfterPayment(end, now).getTime(), end.getTime());
    assert.equal(addCalendarMonths(end, 1).getTime() > end.getTime(), true);
  }],
  ['30 migration backfills existing workspaces as grandfathered once', () => {
    assert.match(migration, /legacy_access = true/);
    assert.match(migration, /grafiflow_billing_migration_markers/);
  }],
  ['31 cloud record reads and writes check billing entitlement', () => {
    assert.match(migration, /private\.grafiflow_billing_access_allowed\(workspace_id\)/);
    assert.match(migration, /enforce_grafiflow_billing_access_on_record_write/);
    assert.match(migration, /GrafiFlow subscription access is inactive/);
  }],
  ['32 an open client session transitions to blocked after the server period and grace end', () => {
    const end = new Date(now.getTime() - 10 * 86_400_000);
    assert.equal(deriveEntitlement({ current_period_end: end }, now).accessAllowed, false);
  }],
  ['33 changing plans uses the existing period end for the next plan and not a parallel term', () => {
    const end = new Date(now.getTime() + 20 * 86_400_000);
    assert.equal(periodStartAfterPayment(end, now).getTime(), end.getTime());
    assert.match(migration, /pending_plan_effective_at/);
    const annual = buildAsaasCheckoutPayload({ planType: 'annual', claim: { claimToken: 'claim-2' }, appUrl: 'https://grafiflow.vercel.app' });
    assert.deepEqual(annual.chargeTypes, ['DETACHED']);
  }],
  ['34 an expired paid term stays expired while a provider subscription id remains', () => {
    const result = deriveEntitlement({ current_period_end: new Date(now.getTime() - 11 * 86_400_000), provider_subscription_id: 'sub-active-at-provider' }, now);
    assert.equal(result.state, 'subscription_expired');
    assert.equal(result.accessAllowed, false);
  }],
  ['35 changing monthly to annual does not cancel recurring billing before annual payment confirmation', () => {
    assert.doesNotMatch(checkoutHandler, /callAsaas\([^\n]*\/subscriptions\/.*DELETE/);
    assert.match(migration, /v_required_action := 'delete_subscription'/);
    assert.match(webhookHandler, /result\?\.requiredAction === 'delete_subscription'/);
  }],
  ['36 next plan selection reads the paid period active now and clears elapsed plan schedules', () => {
    assert.match(migration, /v_row\.pending_plan_effective_at <= now\(\)/);
    assert.match(migration, /period_start <= now\(\) and period_end > now\(\)/);
    assert.match(migration, /case when v_row\.pending_plan_effective_at > v_now then v_row\.pending_plan_type else null end/);
  }],
  ['37 annual renewal begins only after an existing active paid period ends', () => {
    assert.match(migration, /v_period_start := case[\s\S]*when v_row\.current_period_end > now\(\) then v_row\.current_period_end/);
    assert.match(migration, /status = 'paid' and period_start > now\(\) and period_end > now\(\)/);
    assert.match(migration, /current_period_start', coalesce\(v_current_period\.period_start, v_row\.current_period_start\)/);
  }],
  ['38 confirmed annual periods do not display monthly promotional pricing', () => {
    assert.ok(appSource.includes("subscription?.plan_type === 'annual'"));
    assert.ok(appSource.includes('A próxima renovação custa R$ 450,00 à vista.'));
  }],
  ['39 a reserved annual period is linked to the same payment before being confirmed', () => {
    assert.match(migration, /provider_payment_id = coalesce\(provider_payment_id, v_payment_id\)/);
    assert.match(migration, /if v_saved_period\.id is not null then[\s\S]*provider_checkout_reference = coalesce\(provider_checkout_reference, v_external_reference\)/);
  }],
  ['40 promotional pricing counts paid cycles rather than generated payment rows', () => {
    assert.match(migration, /count\(\*\) filter \(where plan_type = 'monthly' and status in \('paid', 'refunded'\)\)/);
    assert.match(migration, /when coalesce\(v_previous_paid_cycles, 0\) < 3 then 3500/);
  }],
  ['41 failed webhook side effects are retried using a persisted billing action', () => {
    assert.match(migration, /action_required text/);
    assert.match(migration, /if v_required_action is not null then[\s\S]*'requiredAction', v_required_action/);
    assert.match(migration, /action_required = v_required_action, action_subscription_id = v_provider_subscription_id/);
  }],
  ['42 Asaas payment edits can reconcile pending periods to the new monthly price', () => {
    assert.match(migration, /'PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_OVERDUE'/);
    assert.match(migration, /amount_cents = 5000[\s\S]*status = 'pending'/);
    assert.match(webhookHandler, /result\?\.requiredAction === 'upgrade_monthly_price'/);
  }],
  ['43 offline entitlement timers enforce the subscription grace deadline even for long annual terms', () => {
    assert.match(migration, /'grace_period_ends_at', case when v_row\.current_period_end is not null then v_row\.current_period_end \+ interval '240 hours'/);
    assert.match(appSource, /const enforceBillingDeadline = \(\) => \{[\s\S]*const remaining = new Date\(deadline\)[\s\S]*remaining > 0[\s\S]*setTimeout\(enforceBillingDeadline/);
  }],
];

for (const [name, run] of scenarios) test(name, run);

test('calendar cycles clamp at month end and preserve leap years', () => {
  assert.equal(addCalendarMonths('2026-01-31T12:00:00.000Z', 1).toISOString(), '2026-02-28T12:00:00.000Z');
  assert.equal(addCalendarMonths('2028-02-29T12:00:00.000Z', 12).toISOString(), '2029-02-28T12:00:00.000Z');
});

test('monthly checkout uses a backend-provided cycle price and recurrence only', () => {
  const payload = buildAsaasCheckoutPayload({
    planType: 'monthly', claim: { claimToken: 'claim-monthly', priceCents: 3500, nextDueDate: '2026-10-31' }, appUrl: 'https://grafiflow.vercel.app',
  });
  assert.deepEqual(payload.chargeTypes, ['RECURRENT']);
  assert.equal(payload.items[0].value, 35);
  assert.deepEqual(payload.subscription, { cycle: 'MONTHLY', nextDueDate: '2026-10-31' });
  assert.equal('installment' in payload, false);
});

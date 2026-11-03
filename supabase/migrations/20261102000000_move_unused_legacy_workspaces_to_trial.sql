-- Reclassify only automatically grandfathered workspaces with no trial,
-- subscription, checkout, payment, period, or pending billing evidence,
-- and only after explicit manual review. The legacy flag has no provenance,
-- so absence of financial columns alone cannot prove an entitlement was not
-- granted manually. The approval table is intentionally empty by default.

create table if not exists private.grafiflow_legacy_trial_approvals_20261102 (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  reviewed_by text not null,
  review_evidence text not null,
  reviewed_at timestamptz not null default now(),
  constraint grafiflow_legacy_trial_approval_evidence_check
    check (length(btrim(review_evidence)) >= 20)
);

revoke all on private.grafiflow_legacy_trial_approvals_20261102
  from public, anon, authenticated, service_role;

create table if not exists private.grafiflow_legacy_trial_migration_backup_20261102 (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  legacy_access boolean not null,
  trial_used boolean not null,
  trial_status text not null,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  plan_type text,
  status text not null,
  updated_at timestamptz not null,
  captured_at timestamptz not null default now()
);

revoke all on private.grafiflow_legacy_trial_migration_backup_20261102
  from public, anon, authenticated, service_role;

insert into private.grafiflow_legacy_trial_migration_backup_20261102 (
  workspace_id, legacy_access, trial_used, trial_status, trial_started_at,
  trial_ends_at, plan_type, status, updated_at
)
select subscription_row.workspace_id, subscription_row.legacy_access, subscription_row.trial_used,
       subscription_row.trial_status, subscription_row.trial_started_at,
       subscription_row.trial_ends_at, subscription_row.plan_type, subscription_row.status,
       subscription_row.updated_at
from public.workspace_subscriptions as subscription_row
where subscription_row.legacy_access = true
  and subscription_row.trial_status = 'legacy'
  and subscription_row.plan_type = 'legacy'
  and subscription_row.trial_used = false
  and subscription_row.trial_started_at is null
  and subscription_row.trial_ends_at is null
  and subscription_row.current_period_start is null
  and subscription_row.current_period_end is null
  and subscription_row.subscription_started_at is null
  and subscription_row.grace_period_ends_at is null
  and subscription_row.next_billing_at is null
  and subscription_row.cancel_at_period_end = false
  and subscription_row.plan_code is null
  and subscription_row.last_payment_at is null
  and subscription_row.last_payment_status is null
  and subscription_row.provider_event_at is null
  and subscription_row.checkout_completed_at is null
  and subscription_row.provider is null
  and subscription_row.provider_customer_id is null
  and subscription_row.provider_subscription_id is null
  and subscription_row.provider_checkout_id is null
  and subscription_row.provider_checkout_url is null
  and subscription_row.provider_checkout_expires_at is null
  and subscription_row.provider_external_reference is null
  and subscription_row.scheduled_provider_subscription_id is null
  and subscription_row.pending_plan_type is null
  and subscription_row.pending_plan_effective_at is null
  and subscription_row.provider_next_payment_id is null
  and subscription_row.provider_next_payment_url is null
  and coalesce(subscription_row.paid_cycle_count, 0) = 0
  and not exists (
    select 1 from public.workspace_billing_periods as period_row
    where period_row.workspace_id = subscription_row.workspace_id
  )
  and not exists (
    select 1 from public.workspace_subscription_payments as payment_row
    where payment_row.workspace_id = subscription_row.workspace_id
  )
  and not exists (
    select 1 from public.asaas_billing_subscriptions as asaas_subscription
    where asaas_subscription.workspace_id = subscription_row.workspace_id
  )
  and not exists (
    select 1 from public.asaas_billing_checkouts as checkout_row
    where checkout_row.workspace_id = subscription_row.workspace_id
  )
  and exists (
    select 1 from private.grafiflow_legacy_trial_approvals_20261102 as approval
    where approval.workspace_id = subscription_row.workspace_id
  )
on conflict (workspace_id) do nothing;

update public.workspace_subscriptions as subscription_row
set legacy_access = false,
    trial_used = false,
    trial_status = 'not_started',
    trial_started_at = null,
    trial_ends_at = null,
    plan_type = null,
    status = 'pending',
    updated_at = now()
where subscription_row.legacy_access = true
  and subscription_row.trial_status = 'legacy'
  and subscription_row.plan_type = 'legacy'
  and subscription_row.trial_used = false
  and subscription_row.trial_started_at is null
  and subscription_row.trial_ends_at is null
  and subscription_row.current_period_start is null
  and subscription_row.current_period_end is null
  and subscription_row.subscription_started_at is null
  and subscription_row.grace_period_ends_at is null
  and subscription_row.next_billing_at is null
  and subscription_row.cancel_at_period_end = false
  and subscription_row.plan_code is null
  and subscription_row.last_payment_at is null
  and subscription_row.last_payment_status is null
  and subscription_row.provider_event_at is null
  and subscription_row.checkout_completed_at is null
  and subscription_row.provider is null
  and subscription_row.provider_customer_id is null
  and subscription_row.provider_subscription_id is null
  and subscription_row.provider_checkout_id is null
  and subscription_row.provider_checkout_url is null
  and subscription_row.provider_checkout_expires_at is null
  and subscription_row.provider_external_reference is null
  and subscription_row.scheduled_provider_subscription_id is null
  and subscription_row.pending_plan_type is null
  and subscription_row.pending_plan_effective_at is null
  and subscription_row.provider_next_payment_id is null
  and subscription_row.provider_next_payment_url is null
  and coalesce(subscription_row.paid_cycle_count, 0) = 0
  and not exists (
    select 1
    from public.workspace_billing_periods as period_row
    where period_row.workspace_id = subscription_row.workspace_id
  )
  and not exists (
    select 1
    from public.workspace_subscription_payments as payment_row
    where payment_row.workspace_id = subscription_row.workspace_id
  )
  and not exists (
    select 1
    from public.asaas_billing_subscriptions as asaas_subscription
    where asaas_subscription.workspace_id = subscription_row.workspace_id
  )
  and not exists (
    select 1
    from public.asaas_billing_checkouts as checkout_row
    where checkout_row.workspace_id = subscription_row.workspace_id
  )
  and exists (
    select 1 from private.grafiflow_legacy_trial_approvals_20261102 as approval
    where approval.workspace_id = subscription_row.workspace_id
  );

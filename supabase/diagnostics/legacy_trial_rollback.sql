-- Conservative rollback for migration 20261102000000.
-- It restores only rows still untouched after being moved to trial_not_started.
-- Rows that started a trial or acquired any billing evidence are deliberately skipped.
begin;

update public.workspace_subscriptions as subscription_row
set legacy_access = backup.legacy_access,
    trial_used = backup.trial_used,
    trial_status = backup.trial_status,
    trial_started_at = backup.trial_started_at,
    trial_ends_at = backup.trial_ends_at,
    plan_type = backup.plan_type,
    status = backup.status,
    updated_at = backup.updated_at
from private.grafiflow_legacy_trial_migration_backup_20261102 as backup
where backup.workspace_id = subscription_row.workspace_id
  and subscription_row.legacy_access = false
  and subscription_row.trial_used = false
  and subscription_row.trial_status = 'not_started'
  and subscription_row.trial_started_at is null
  and subscription_row.trial_ends_at is null
  and subscription_row.plan_type is null
  and subscription_row.status = 'pending'
  and subscription_row.current_period_start is null
  and subscription_row.current_period_end is null
  and subscription_row.provider is null
  and subscription_row.provider_customer_id is null
  and subscription_row.provider_subscription_id is null
  and subscription_row.provider_checkout_id is null
  and subscription_row.provider_external_reference is null
  and subscription_row.checkout_completed_at is null
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
returning subscription_row.workspace_id;

-- Keep the private snapshots as an audit and recovery record.
commit;

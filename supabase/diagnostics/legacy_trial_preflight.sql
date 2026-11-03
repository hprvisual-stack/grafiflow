-- Read-only preview for 20261102000000_move_unused_legacy_workspaces_to_trial.sql.
-- These are metadata candidates only. Each ID still needs manual confirmation
-- that no separately granted legacy entitlement or ambiguous financial right exists.
with candidates as materialized (
  select subscription_row.workspace_id, subscription_row.created_at
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
)
select 'SUMMARY'::text as row_type, count(*)::text as candidate_count, null::uuid as workspace_id, null::timestamptz as created_at
from candidates
union all
select 'CANDIDATE', null, workspace_id, created_at
from candidates
order by row_type, created_at nulls first, workspace_id;

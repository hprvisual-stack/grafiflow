-- Billing v2: trial activation, calendar billing periods, access enforcement and plan history.
-- Existing workspaces are grandfathered once so this migration does not interrupt current users.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

alter table public.workspace_subscriptions
  add column if not exists legacy_access boolean not null default false,
  add column if not exists trial_used boolean not null default false,
  add column if not exists trial_status text not null default 'not_started',
  add column if not exists plan_type text,
  add column if not exists subscription_started_at timestamptz,
  add column if not exists grace_period_ends_at timestamptz,
  add column if not exists next_billing_at timestamptz,
  add column if not exists scheduled_provider_subscription_id text,
  add column if not exists pending_plan_type text,
  add column if not exists pending_plan_effective_at timestamptz,
  add column if not exists provider_next_payment_id text,
  add column if not exists provider_next_payment_url text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_subscriptions_trial_status_check') then
    alter table public.workspace_subscriptions add constraint workspace_subscriptions_trial_status_check
      check (trial_status in ('not_started', 'active', 'expired', 'converted', 'legacy'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workspace_subscriptions_plan_type_check') then
    alter table public.workspace_subscriptions add constraint workspace_subscriptions_plan_type_check
      check (plan_type is null or plan_type in ('monthly', 'annual', 'legacy'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workspace_subscriptions_pending_plan_type_check') then
    alter table public.workspace_subscriptions add constraint workspace_subscriptions_pending_plan_type_check
      check (pending_plan_type is null or pending_plan_type in ('monthly', 'annual'));
  end if;
end $$;

alter table public.asaas_billing_subscriptions
  add column if not exists plan_type text not null default 'monthly';

alter table public.asaas_billing_checkouts
  add column if not exists plan_type text not null default 'monthly',
  add column if not exists period_start timestamptz,
  add column if not exists period_end timestamptz,
  add column if not exists amount_cents integer;

create table if not exists public.workspace_billing_periods (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  plan_type text not null check (plan_type in ('monthly', 'annual')),
  cycle_number integer check (cycle_number is null or cycle_number > 0),
  period_start timestamptz,
  period_end timestamptz,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'BRL' check (currency = 'BRL'),
  status text not null check (status in ('pending', 'paid', 'refunded', 'voided', 'review')),
  due_at timestamptz,
  paid_at timestamptz,
  provider_payment_id text unique,
  provider_checkout_reference text,
  payment_url text,
  is_advance_payment boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_billing_periods_dates_check
    check ((period_start is null and period_end is null) or (period_start is not null and period_end > period_start)),
  constraint workspace_billing_periods_paid_dates_check
    check (status <> 'paid' or (period_start is not null and period_end is not null and paid_at is not null))
);

drop index if exists public.workspace_billing_periods_plan_start_uidx;
create unique index workspace_billing_periods_plan_start_uidx
  on public.workspace_billing_periods(workspace_id, plan_type, period_start)
  where period_start is not null and status in ('pending', 'paid', 'review');
create unique index if not exists workspace_billing_periods_checkout_reference_uidx
  on public.workspace_billing_periods(provider_checkout_reference)
  where provider_checkout_reference is not null;
create index if not exists workspace_billing_periods_workspace_status_idx
  on public.workspace_billing_periods(workspace_id, status, period_start desc);

alter table public.workspace_subscription_payments
  drop constraint if exists workspace_subscription_payments_status_check;
alter table public.workspace_subscription_payments
  add constraint workspace_subscription_payments_status_check
    check (status in ('paid', 'refunded', 'voided'));
alter table public.workspace_subscription_payments
  add column if not exists plan_type text,
  add column if not exists cycle_number integer,
  add column if not exists billing_period_start timestamptz,
  add column if not exists billing_period_end timestamptz,
  add column if not exists due_at timestamptz,
  add column if not exists is_advance_payment boolean not null default false,
  add column if not exists refunded_at timestamptz;

alter table public.workspace_billing_periods enable row level security;
revoke all on public.workspace_billing_periods from public, anon, authenticated;
grant select on public.workspace_billing_periods to authenticated;
grant select, insert, update, delete on public.workspace_billing_periods to service_role;
drop policy if exists "workspace members can read billing periods" on public.workspace_billing_periods;
create policy "workspace members can read billing periods"
  on public.workspace_billing_periods for select to authenticated
  using (public.is_grafiflow_workspace_member(workspace_id));

create table if not exists private.grafiflow_billing_migration_markers (
  marker text primary key,
  applied_at timestamptz not null default now()
);
revoke all on private.grafiflow_billing_migration_markers from public, anon, authenticated;

create table if not exists private.grafiflow_billing_settings (
  singleton boolean primary key default true check (singleton),
  enforcement_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
revoke all on private.grafiflow_billing_settings from public, anon, authenticated, service_role;
insert into private.grafiflow_billing_settings (singleton, enforcement_enabled)
values (true, false) on conflict (singleton) do nothing;

alter table public.asaas_webhook_events
  add column if not exists action_required text,
  add column if not exists action_subscription_id text;

do $$ begin
  if not exists (
    select 1 from private.grafiflow_billing_migration_markers
    where marker = '20261031120000_grafiflow_subscriptions_entitlements'
  ) then
    update public.workspace_subscriptions
    set legacy_access = true,
        trial_used = trial_used or trial_started_at is not null,
        trial_status = case
          when trial_started_at is null then 'legacy'
          when trial_ends_at is not null and trial_ends_at > now() then 'active'
          when status in ('active', 'past_due') then 'converted'
          else 'expired'
        end,
        plan_type = case
          when provider_subscription_id is not null or plan_code like 'monthly_%' then 'monthly'
          else coalesce(plan_type, 'legacy')
        end,
        updated_at = now();

    insert into public.workspace_subscriptions (workspace_id, status, legacy_access, trial_status, plan_type)
    select workspace_row.id, 'active', true, 'legacy', 'legacy'
    from public.workspaces workspace_row
    left join public.workspace_subscriptions subscription_row on subscription_row.workspace_id = workspace_row.id
    where subscription_row.workspace_id is null
    on conflict (workspace_id) do nothing;

    insert into private.grafiflow_billing_migration_markers (marker)
    values ('20261031120000_grafiflow_subscriptions_entitlements');
  end if;
end $$;

create or replace function private.add_calendar_months(p_value timestamptz, p_months integer)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select (((p_value at time zone 'America/Sao_Paulo') + make_interval(months => p_months)) at time zone 'America/Sao_Paulo');
$$;

create or replace function private.local_date_start(p_value date)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select (p_value::timestamp at time zone 'America/Sao_Paulo');
$$;

create or replace function private.grafiflow_billing_access_allowed(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members member_row
    where member_row.workspace_id = p_workspace_id
      and member_row.user_id = (select auth.uid())
      and (
        not coalesce((select enforcement_enabled from private.grafiflow_billing_settings where singleton), false)
        or exists (
          select 1 from public.workspace_subscriptions subscription_row
          where subscription_row.workspace_id = member_row.workspace_id
            and (
              subscription_row.legacy_access
              or (subscription_row.trial_status = 'active' and subscription_row.trial_ends_at > now())
              or subscription_row.current_period_end > now()
              or subscription_row.current_period_end + interval '240 hours' > now()
            )
        )
      )
  );
$$;
revoke all on function private.grafiflow_billing_access_allowed(uuid) from public, anon;
grant execute on function private.grafiflow_billing_access_allowed(uuid) to authenticated;

drop policy if exists "workspace members can read records" on public.grafiflow_records;
create policy "workspace members can read records"
  on public.grafiflow_records for select to authenticated
  using ((select private.grafiflow_billing_access_allowed(workspace_id)));

create or replace function private.enforce_grafiflow_billing_access_on_record_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  v_workspace_id := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  if auth.uid() is not null and not private.grafiflow_billing_access_allowed(v_workspace_id) then
    raise exception using errcode = '42501', message = 'GrafiFlow subscription access is inactive';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.enforce_grafiflow_billing_access_on_record_write() from public, anon, authenticated;
drop trigger if exists grafiflow_billing_access_guard on public.grafiflow_records;
create trigger grafiflow_billing_access_guard
  before insert or update or delete on public.grafiflow_records
  for each row execute function private.enforce_grafiflow_billing_access_on_record_write();

create or replace function public.list_grafiflow_records(
  target_workspace_id uuid,
  after_change_seq bigint default 0,
  page_size integer default 500
)
returns setof public.grafiflow_records
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(target_workspace_id) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  if not private.grafiflow_billing_access_allowed(target_workspace_id) then
    raise exception 'GrafiFlow subscription access is inactive' using errcode = '42501';
  end if;
  if coalesce(after_change_seq, 0) < 0 or page_size is null or page_size < 1 or page_size > 1000 then
    raise exception 'invalid change cursor or page size' using errcode = '22023';
  end if;
  return query
    select record_row.*
    from public.grafiflow_records record_row
    where record_row.workspace_id = target_workspace_id
      and record_row.change_seq > coalesce(after_change_seq, 0)
    order by record_row.change_seq
    limit page_size;
end;
$$;
revoke all on function public.list_grafiflow_records(uuid, bigint, integer) from public, anon;
grant execute on function public.list_grafiflow_records(uuid, bigint, integer) to authenticated;

create or replace function public.get_grafiflow_entitlement(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.workspace_subscriptions%rowtype;
  v_now timestamptz := clock_timestamp();
  v_state text;
  v_access boolean := false;
  v_paid_cycles integer := 0;
  v_monthly_amount integer := 3500;
  v_next_period public.workspace_billing_periods%rowtype;
  v_current_period public.workspace_billing_periods%rowtype;
  v_plan_type text;
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(p_workspace_id) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  select * into v_row from public.workspace_subscriptions where workspace_id = p_workspace_id;
  if not found then
    return jsonb_build_object(
      'state', 'trial_not_started', 'access_allowed', false, 'server_now', v_now,
      'trial_used', false, 'trial_status', 'not_started', 'legacy_access', false,
      'paid_monthly_cycles', 0, 'monthly_amount_cents', 3500, 'annual_amount_cents', 45000
    );
  end if;

  select greatest(
    v_row.paid_cycle_count,
    count(*) filter (where plan_type = 'monthly' and status in ('paid', 'refunded'))
  )::integer into v_paid_cycles
  from public.workspace_billing_periods where workspace_id = p_workspace_id;
  v_monthly_amount := case when v_paid_cycles < 3 then 3500 else 5000 end;
  select * into v_next_period from public.workspace_billing_periods
  where workspace_id = p_workspace_id and status = 'pending'
  order by due_at nulls last, period_start nulls last, created_at
  limit 1;
  select * into v_current_period from public.workspace_billing_periods
  where workspace_id = p_workspace_id and status = 'paid'
    and period_start <= v_now and period_end > v_now
  order by period_start desc limit 1;

  v_plan_type := coalesce(v_current_period.plan_type, v_row.plan_type);
  if v_row.legacy_access then
    v_state := 'legacy_access';
    v_access := true;
  elsif v_current_period.id is not null then
    v_state := 'subscription_active';
    v_access := true;
  elsif v_row.trial_status = 'active' and v_row.trial_ends_at > v_now then
    v_state := 'trial_active';
    v_access := true;
  elsif v_row.current_period_end is not null and v_row.current_period_end + interval '240 hours' > v_now then
    v_state := case when v_row.current_period_end > v_now then 'subscription_active' else 'grace_active' end;
    v_access := true;
  elsif v_row.current_period_end is not null then
    v_state := 'subscription_expired';
  elsif (v_row.provider_checkout_id is not null and v_row.provider_checkout_expires_at > v_now)
     or v_row.provider_subscription_id is not null then
    v_state := 'payment_pending';
  elsif v_row.trial_used or v_row.trial_ends_at is not null then
    v_state := 'trial_expired';
  else
    v_state := 'trial_not_started';
  end if;

  return jsonb_build_object(
    'state', v_state,
    'access_allowed', v_access,
    'enforcement_enabled', coalesce((select enforcement_enabled from private.grafiflow_billing_settings where singleton), false),
    'server_now', v_now,
    'legacy_access', v_row.legacy_access,
    'trial_used', v_row.trial_used,
    'trial_status', v_row.trial_status,
    'trial_started_at', v_row.trial_started_at,
    'trial_ends_at', v_row.trial_ends_at,
    'plan_type', v_plan_type,
    'pending_plan_type', case when v_row.pending_plan_effective_at > v_now then v_row.pending_plan_type else null end,
    'pending_plan_effective_at', case when v_row.pending_plan_effective_at > v_now then v_row.pending_plan_effective_at else null end,
    'provider_status', v_row.status,
    'current_period_start', coalesce(v_current_period.period_start, v_row.current_period_start),
    'current_period_end', v_row.current_period_end,
    'grace_period_ends_at', case when v_row.current_period_end is not null then v_row.current_period_end + interval '240 hours' else null end,
    'next_billing_at', coalesce(v_next_period.due_at, v_row.current_period_end),
    'last_payment_at', v_row.last_payment_at,
    'last_payment_status', v_row.last_payment_status,
    'paid_monthly_cycles', v_paid_cycles,
    'monthly_amount_cents', v_monthly_amount,
    'annual_amount_cents', 45000,
    'next_payment_due_at', v_next_period.due_at,
    'next_payment_url', v_next_period.payment_url,
    'next_payment_amount_cents', v_next_period.amount_cents,
    'next_payment_status', v_next_period.status,
    'provider_subscription_id', v_row.provider_subscription_id,
    'scheduled_provider_subscription_id', v_row.scheduled_provider_subscription_id,
    'provider_checkout_id', v_row.provider_checkout_id,
    'provider_checkout_url', v_row.provider_checkout_url,
    'checkout_completed_at', v_row.checkout_completed_at
  );
end;
$$;
revoke all on function public.get_grafiflow_entitlement(uuid) from public, anon;
grant execute on function public.get_grafiflow_entitlement(uuid) to authenticated;

create or replace function public.start_grafiflow_trial(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.workspace_subscriptions%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'workspace owner access required' using errcode = '42501';
  end if;
  insert into public.workspace_subscriptions (workspace_id, status, trial_status)
  values (p_workspace_id, 'pending', 'not_started')
  on conflict (workspace_id) do nothing;
  select * into v_row from public.workspace_subscriptions where workspace_id = p_workspace_id for update;
  if v_row.legacy_access or v_row.current_period_end > v_now then
    return public.get_grafiflow_entitlement(p_workspace_id);
  end if;
  if v_row.trial_used or v_row.trial_started_at is not null then
    return public.get_grafiflow_entitlement(p_workspace_id);
  end if;
  update public.workspace_subscriptions
  set trial_used = true,
      trial_status = 'active',
      trial_started_at = v_now,
      trial_ends_at = v_now + interval '360 hours',
      status = 'trialing',
      updated_at = v_now
  where workspace_id = p_workspace_id;
  return public.get_grafiflow_entitlement(p_workspace_id);
end;
$$;
revoke all on function public.start_grafiflow_trial(uuid) from public, anon;
grant execute on function public.start_grafiflow_trial(uuid) to authenticated;

create or replace function public.claim_grafiflow_checkout(p_workspace_id uuid, p_plan_type text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.workspace_subscriptions%rowtype;
  v_claim uuid := gen_random_uuid();
  v_paid_cycles integer := 0;
  v_price_cents integer;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_next_due_date date;
  v_existing_period boolean;
  v_active_plan_type text;
begin
  if p_workspace_id is null or p_plan_type not in ('monthly', 'annual') then
    raise exception using errcode = '22023', message = 'workspace and a supported plan are required';
  end if;
  insert into public.workspace_subscriptions (workspace_id, provider, status, trial_status)
  values (p_workspace_id, 'asaas', 'pending', 'not_started')
  on conflict (workspace_id) do nothing;
  select * into v_row from public.workspace_subscriptions where workspace_id = p_workspace_id for update;

  if v_row.pending_plan_effective_at is not null and v_row.pending_plan_effective_at <= now() then
    update public.workspace_subscriptions
    set pending_plan_type = null, pending_plan_effective_at = null, updated_at = now()
    where workspace_id = p_workspace_id;
    v_row.pending_plan_type := null;
    v_row.pending_plan_effective_at := null;
  end if;
  select plan_type into v_active_plan_type
  from public.workspace_billing_periods
  where workspace_id = p_workspace_id and status = 'paid'
    and period_start <= now() and period_end > now()
  order by period_start desc limit 1;
  if v_active_plan_type is not null then v_row.plan_type := v_active_plan_type; end if;

  if v_row.legacy_access then return jsonb_build_object('action', 'legacy_access'); end if;
  if v_row.provider is not null and v_row.provider <> 'asaas' then return jsonb_build_object('action', 'unsupported_provider'); end if;
  if v_row.checkout_claim_token is not null and v_row.checkout_claimed_at > now() - interval '65 minutes' then
    return jsonb_build_object('action', 'busy');
  end if;
  if v_row.provider_checkout_id is not null and v_row.provider_checkout_expires_at > now()
     and exists (select 1 from public.asaas_billing_checkouts where provider_checkout_id = v_row.provider_checkout_id and plan_type = p_plan_type and status = 'active') then
    return jsonb_build_object('action', 'reuse', 'checkoutId', v_row.provider_checkout_id, 'checkoutUrl', v_row.provider_checkout_url);
  end if;

  if p_plan_type = 'monthly' and v_row.provider_subscription_id is not null and v_row.status not in ('canceled', 'incomplete') then
    return jsonb_build_object('action', 'advance_monthly', 'subscriptionId', v_row.provider_subscription_id);
  end if;
  if v_row.scheduled_provider_subscription_id is not null and p_plan_type = 'monthly' then
    return jsonb_build_object('action', 'plan_already_scheduled', 'planType', 'monthly', 'effectiveAt', v_row.pending_plan_effective_at);
  end if;
  if v_row.pending_plan_type is not null and v_row.pending_plan_type <> p_plan_type then
    return jsonb_build_object('action', 'plan_change_pending', 'planType', v_row.pending_plan_type, 'effectiveAt', v_row.pending_plan_effective_at);
  end if;

  select greatest(
    v_row.paid_cycle_count,
    count(*) filter (where plan_type = 'monthly' and status in ('paid', 'refunded'))
  )::integer into v_paid_cycles
  from public.workspace_billing_periods where workspace_id = p_workspace_id;
  v_price_cents := case when p_plan_type = 'annual' then 45000 when v_paid_cycles < 3 then 3500 else 5000 end;
  v_period_start := case
    when v_row.current_period_end > now() then v_row.current_period_end
    when v_row.current_period_end is not null and v_row.current_period_end + interval '240 hours' >= now() then v_row.current_period_end
    else null
  end;
  if p_plan_type = 'monthly' and v_row.current_period_end > now() and v_row.plan_type = 'annual' then
    v_next_due_date := (v_row.current_period_end at time zone 'America/Sao_Paulo')::date;
  else
    v_next_due_date := (now() at time zone 'America/Sao_Paulo')::date;
  end if;
  if p_plan_type = 'monthly' and v_row.plan_type = 'annual' and v_row.current_period_end > now() then
    update public.workspace_subscriptions
    set pending_plan_type = 'monthly', pending_plan_effective_at = v_row.current_period_end
    where workspace_id = p_workspace_id;
  elsif p_plan_type = 'annual' and v_row.plan_type = 'monthly' and v_row.provider_subscription_id is not null then
    update public.workspace_subscriptions
    set pending_plan_type = 'annual', pending_plan_effective_at = coalesce(v_row.current_period_end, now())
    where workspace_id = p_workspace_id;
  end if;

  if p_plan_type = 'annual' then
    select exists (
      select 1 from public.workspace_billing_periods
      where workspace_id = p_workspace_id and plan_type = 'annual'
        and ((status = 'pending' and provider_checkout_reference is not null)
          or (status = 'paid' and period_start > now() and period_end > now()))
    ) into v_existing_period;
    if v_existing_period then
      return jsonb_build_object('action', 'annual_period_already_paid_or_pending');
    end if;
    if v_period_start is not null then v_period_end := private.add_calendar_months(v_period_start, 12); end if;
  end if;

  if v_row.checkout_completed_at is not null and v_row.provider_subscription_id is null and v_row.status = 'pending' then
    return jsonb_build_object('action', 'provisioning');
  end if;

  insert into public.asaas_billing_checkouts (external_reference, workspace_id, status, plan_type, period_start, period_end, amount_cents)
  values (v_claim::text, p_workspace_id, 'creating', p_plan_type, v_period_start, v_period_end, v_price_cents);

  if p_plan_type = 'annual' and v_period_start is not null then
    insert into public.workspace_billing_periods (workspace_id, plan_type, period_start, period_end, amount_cents, status, is_advance_payment, provider_checkout_reference)
    values (p_workspace_id, 'annual', v_period_start, v_period_end, 45000, 'pending', v_period_start > now(), v_claim::text);
  elsif p_plan_type = 'annual' then
    insert into public.workspace_billing_periods (workspace_id, plan_type, amount_cents, status, provider_checkout_reference)
    values (p_workspace_id, 'annual', 45000, 'pending', v_claim::text);
  end if;

  update public.workspace_subscriptions
  set provider = 'asaas',
      provider_external_reference = case when v_row.provider_subscription_id is null then v_claim::text else provider_external_reference end,
      checkout_claim_token = v_claim,
      checkout_claimed_at = now(),
      checkout_trial = false,
      provider_checkout_id = null,
      provider_checkout_url = null,
      provider_checkout_expires_at = null,
      updated_at = now()
  where workspace_id = p_workspace_id;

  return jsonb_build_object(
    'action', 'create',
    'claimToken', v_claim,
    'planType', p_plan_type,
    'priceCents', v_price_cents,
    'nextDueDate', case when p_plan_type = 'monthly' then to_char(v_next_due_date, 'YYYY-MM-DD') else null end,
    'scheduled', p_plan_type = 'monthly' and v_row.plan_type = 'annual' and v_row.current_period_end > now(),
    'periodStart', v_period_start,
    'paidMonthlyCycles', v_paid_cycles
  );
end;
$$;

create or replace function public.finalize_grafiflow_checkout(
  p_workspace_id uuid,
  p_claim_token uuid,
  p_checkout_id text,
  p_checkout_url text,
  p_checkout_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.workspace_subscriptions
  set provider_checkout_id = p_checkout_id,
      provider_checkout_url = p_checkout_url,
      provider_checkout_expires_at = p_checkout_expires_at,
      checkout_claim_token = null,
      checkout_claimed_at = null,
      updated_at = now()
  where workspace_id = p_workspace_id and checkout_claim_token = p_claim_token;
  if not found then raise exception using errcode = '40001', message = 'Checkout claim expired'; end if;

  update public.asaas_billing_checkouts
  set provider_checkout_id = p_checkout_id, checkout_url = p_checkout_url,
      status = 'active', expires_at = p_checkout_expires_at, updated_at = now()
  where external_reference = p_claim_token::text and status = 'creating';
  if not found then raise exception using errcode = 'P0001', message = 'Checkout reservation is missing'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.release_grafiflow_checkout_claim(p_workspace_id uuid, p_claim_token uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.workspace_subscriptions
  set checkout_claim_token = null, checkout_claimed_at = null,
      pending_plan_type = case when exists (select 1 from public.asaas_billing_checkouts
        where external_reference = p_claim_token::text and workspace_id = p_workspace_id) then null else pending_plan_type end,
      pending_plan_effective_at = case when exists (select 1 from public.asaas_billing_checkouts
        where external_reference = p_claim_token::text and workspace_id = p_workspace_id) then null else pending_plan_effective_at end,
      provider_external_reference = case when provider_external_reference = p_claim_token::text then null else provider_external_reference end,
      updated_at = now()
  where workspace_id = p_workspace_id and checkout_claim_token = p_claim_token;
  update public.asaas_billing_checkouts set status = 'failed', updated_at = now()
  where external_reference = p_claim_token::text and status = 'creating';
  update public.workspace_billing_periods set status = 'voided', updated_at = now()
  where provider_checkout_reference = p_claim_token::text and status = 'pending';
end;
$$;

create or replace function public.process_grafiflow_billing_event(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id text := nullif(p_payload ->> 'id', '');
  v_event_type text := nullif(p_payload ->> 'event', '');
  v_event_at timestamptz := coalesce(nullif(p_payload ->> 'dateCreated', '')::timestamptz, clock_timestamp());
  v_checkout jsonb := coalesce(p_payload -> 'checkout', '{}'::jsonb);
  v_payment jsonb := coalesce(p_payload -> 'payment', '{}'::jsonb);
  v_subscription jsonb := coalesce(p_payload -> 'subscription', '{}'::jsonb);
  v_checkout_id text := coalesce(v_checkout ->> 'id', p_payload ->> 'checkoutId');
  v_subscription_id text := coalesce(v_subscription ->> 'id', v_payment ->> 'subscription', p_payload ->> 'subscriptionId');
  v_payment_id text := nullif(v_payment ->> 'id', '');
  v_customer_id text := coalesce(nullif(v_subscription ->> 'customer', ''), nullif(v_payment ->> 'customer', ''), nullif(v_checkout ->> 'customer', ''));
  v_external_reference text := coalesce(v_checkout ->> 'externalReference', v_subscription ->> 'externalReference', v_payment ->> 'externalReference', p_payload ->> 'externalReference');
  v_workspace_id uuid;
  v_plan_type text;
  v_subscription_current boolean := false;
  v_checkout_current boolean := false;
  v_previous_processed timestamptz;
  v_confirmed_at timestamptz;
  v_due_at timestamptz;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_cycle_number integer;
  v_price_cents integer;
  v_paid_cycles integer;
  v_previous_paid_cycles integer;
  v_saved_period public.workspace_billing_periods%rowtype;
  v_provider_subscription_id text;
  v_required_action text;
  v_amount_cents integer;
begin
  if v_event_id is null or v_event_type is null then
    raise exception using errcode = '22023', message = 'Webhook event id and event type are required';
  end if;
  insert into public.asaas_webhook_events (provider_event_id, event_type, resource_id, event_at)
  values (v_event_id, v_event_type, coalesce(v_payment_id, v_subscription_id, v_checkout_id), v_event_at)
  on conflict (provider_event_id) do nothing;
  select processed_at, action_required, action_subscription_id
    into v_previous_processed, v_required_action, v_provider_subscription_id
    from public.asaas_webhook_events where provider_event_id = v_event_id for update;
  if v_previous_processed is not null then return jsonb_build_object('duplicate', true); end if;
  if v_required_action is not null then
    return jsonb_build_object('duplicate', false, 'requiredAction', v_required_action,
      'subscriptionId', v_provider_subscription_id);
  end if;

  if v_subscription_id is not null then
    select workspace_id into v_workspace_id from public.asaas_billing_subscriptions where provider_subscription_id = v_subscription_id;
  end if;
  if v_workspace_id is null and v_checkout_id is not null then
    select workspace_id into v_workspace_id from public.workspace_subscriptions where provider_checkout_id = v_checkout_id;
  end if;
  if v_workspace_id is null and v_external_reference is not null then
    select workspace_id into v_workspace_id from public.asaas_billing_checkouts where external_reference = v_external_reference;
  end if;
  if v_workspace_id is null and v_external_reference is not null then
    select workspace_id into v_workspace_id from public.workspace_subscriptions where provider_external_reference = v_external_reference;
  end if;
  if v_workspace_id is null and v_external_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_workspace_id := v_external_reference::uuid;
  end if;
  if v_workspace_id is null or not exists (select 1 from public.workspaces where id = v_workspace_id) then
    update public.asaas_webhook_events set processed_at = now() where provider_event_id = v_event_id;
    return jsonb_build_object('duplicate', false, 'ignored', true);
  end if;

  select plan_type into v_plan_type from public.asaas_billing_checkouts where external_reference = v_external_reference;
  if v_plan_type is null and v_subscription_id is not null then
    select plan_type into v_plan_type from public.asaas_billing_subscriptions where provider_subscription_id = v_subscription_id;
  end if;
  select coalesce(v_plan_type, pending_plan_type, plan_type, 'monthly'), provider_subscription_id
    into v_plan_type, v_provider_subscription_id
    from public.workspace_subscriptions where workspace_id = v_workspace_id;
  v_plan_type := coalesce(v_plan_type, 'monthly');

  if v_event_type = 'SUBSCRIPTION_CREATED' and v_subscription_id is not null then
    insert into public.asaas_billing_subscriptions (provider_subscription_id, workspace_id, plan_type)
    values (v_subscription_id, v_workspace_id, coalesce(v_plan_type, 'monthly'))
    on conflict (provider_subscription_id) do update set workspace_id = excluded.workspace_id, plan_type = excluded.plan_type;
    update public.workspace_subscriptions
    set provider = 'asaas', provider_customer_id = coalesce(v_customer_id, provider_customer_id),
        scheduled_provider_subscription_id = case
          when pending_plan_type = 'monthly' and current_period_end > now() and plan_type = 'annual' then v_subscription_id
          else scheduled_provider_subscription_id end,
        provider_subscription_id = case
          when pending_plan_type = 'monthly' and current_period_end > now() and plan_type = 'annual' then provider_subscription_id
          else v_subscription_id end,
        plan_type = case
          when pending_plan_type = 'monthly' and current_period_end > now() and plan_type = 'annual' then plan_type
          else 'monthly' end,
        plan_code = case when paid_cycle_count < 3 then 'monthly_35' else 'monthly_50' end,
        status = case when trial_status = 'active' and trial_ends_at > now() then 'trialing' else 'pending' end,
        provider_event_at = greatest(coalesce(provider_event_at, '-infinity'::timestamptz), v_event_at),
        updated_at = now()
    where workspace_id = v_workspace_id;
  elsif v_event_type = 'CHECKOUT_PAID' then
    update public.asaas_billing_checkouts set status = 'paid', checkout_url = null, expires_at = null, updated_at = now()
    where external_reference = v_external_reference and workspace_id = v_workspace_id;
    update public.workspace_subscriptions set checkout_completed_at = v_event_at, provider_customer_id = coalesce(v_customer_id, provider_customer_id),
      provider_checkout_id = coalesce(v_checkout_id, provider_checkout_id), provider_checkout_url = null,
      provider_checkout_expires_at = null, checkout_claim_token = null, checkout_claimed_at = null, updated_at = now()
    where workspace_id = v_workspace_id and (provider_checkout_id = v_checkout_id or provider_external_reference = v_external_reference);
  elsif v_event_type in ('CHECKOUT_CANCELED', 'CHECKOUT_EXPIRED') then
    update public.asaas_billing_checkouts set status = case when v_event_type = 'CHECKOUT_CANCELED' then 'canceled' else 'expired' end,
      checkout_url = null, expires_at = null, updated_at = now()
    where external_reference = v_external_reference and workspace_id = v_workspace_id;
    update public.workspace_billing_periods set status = 'voided', updated_at = now()
    where provider_checkout_reference = v_external_reference and status = 'pending';
    update public.workspace_subscriptions set status = case when current_period_end > now() then 'active' else 'incomplete' end,
      provider_checkout_url = null, provider_checkout_expires_at = null,
      checkout_claim_token = null, checkout_claimed_at = null,
      pending_plan_type = null, pending_plan_effective_at = null, updated_at = now()
    where workspace_id = v_workspace_id and provider_checkout_id = v_checkout_id;
  elsif v_event_type in ('PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_OVERDUE', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') then
    if v_payment_id is null then raise exception using errcode = '22023', message = 'Payment event is missing payment.id'; end if;
    select * into v_saved_period from public.workspace_billing_periods where provider_payment_id = v_payment_id for update;
    if not found and v_external_reference is not null then
      select * into v_saved_period from public.workspace_billing_periods where provider_checkout_reference = v_external_reference for update;
    end if;
    if v_saved_period.id is not null then v_plan_type := v_saved_period.plan_type; end if;
    if v_plan_type is null then v_plan_type := 'monthly'; end if;
    v_due_at := case when nullif(v_payment ->> 'dueDate', '') is not null
      then private.local_date_start((v_payment ->> 'dueDate')::date) else null end;
    v_amount_cents := round(coalesce(nullif(v_payment ->> 'value', '')::numeric, 0) * 100)::integer;

    if v_event_type in ('PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_OVERDUE') then
      select greatest(
        coalesce((select paid_cycle_count from public.workspace_subscriptions where workspace_id = v_workspace_id), 0),
        coalesce((select count(*)::integer from public.workspace_billing_periods
          where workspace_id = v_workspace_id and plan_type = 'monthly' and status in ('paid', 'refunded')), 0)
      ) into v_paid_cycles;
      v_price_cents := case when v_plan_type = 'annual' then 45000 when v_paid_cycles < 3 then 3500 else 5000 end;
      if v_saved_period.id is null then
        select current_period_end into v_period_start from public.workspace_subscriptions where workspace_id = v_workspace_id;
        if v_period_start is null and v_due_at is not null then v_period_start := v_due_at; end if;
        if v_period_start is not null and v_plan_type = 'monthly' then v_period_end := private.add_calendar_months(v_period_start, 1);
        elsif v_period_start is not null then v_period_end := private.add_calendar_months(v_period_start, 12); end if;
        if v_plan_type = 'monthly' then
          select coalesce(max(cycle_number), 0) + 1 into v_cycle_number
          from public.workspace_billing_periods
          where workspace_id = v_workspace_id and plan_type = 'monthly'
            and (v_period_start is null or period_start <= v_period_start);
      else v_cycle_number := null; end if;
        insert into public.workspace_billing_periods (
          workspace_id, plan_type, cycle_number, period_start, period_end, amount_cents,
          status, due_at, provider_payment_id, provider_checkout_reference, payment_url, is_advance_payment
        ) values (
          v_workspace_id, v_plan_type, v_cycle_number, v_period_start, v_period_end,
          v_amount_cents, case when v_amount_cents = v_price_cents then 'pending' else 'review' end, v_due_at, v_payment_id,
          v_external_reference, nullif(v_payment ->> 'invoiceUrl', ''),
          v_due_at is not null and v_due_at > now()
        ) on conflict (provider_payment_id) do update
          set due_at = coalesce(excluded.due_at, public.workspace_billing_periods.due_at),
              payment_url = coalesce(excluded.payment_url, public.workspace_billing_periods.payment_url),
              updated_at = now();
      else
        update public.workspace_billing_periods set provider_payment_id = coalesce(provider_payment_id, v_payment_id),
          amount_cents = case when status in ('paid', 'refunded', 'voided') then amount_cents else v_amount_cents end,
          due_at = coalesce(v_due_at, due_at),
          payment_url = coalesce(nullif(v_payment ->> 'invoiceUrl', ''), payment_url),
          status = case when status in ('paid', 'refunded', 'voided') then status
            when v_amount_cents = v_price_cents then 'pending' else 'review' end,
          updated_at = now()
        where id = v_saved_period.id;
      end if;
      update public.workspace_subscriptions set provider_next_payment_id = v_payment_id,
        provider_next_payment_url = nullif(v_payment ->> 'invoiceUrl', ''), next_billing_at = v_due_at,
        last_payment_status = case when v_event_type = 'PAYMENT_OVERDUE' then 'overdue' else last_payment_status end,
        status = case when v_event_type = 'PAYMENT_OVERDUE' and current_period_end <= now() then 'past_due' else status end,
        updated_at = now() where workspace_id = v_workspace_id;
    elsif v_event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') then
      v_confirmed_at := coalesce(nullif(v_payment ->> 'paymentDate', '')::timestamptz,
        nullif(v_payment ->> 'confirmedDate', '')::timestamptz, v_event_at);
      if exists (
        select 1 from public.asaas_webhook_events
        where resource_id = v_payment_id
          and event_type in ('PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE')
          and processed_at is not null
      ) then
        update public.asaas_webhook_events set processed_at = now() where provider_event_id = v_event_id;
        return jsonb_build_object('duplicate', false, 'ignored', true, 'paymentAlreadyReversed', true);
      end if;
      if v_saved_period.status in ('paid', 'refunded') then
        update public.asaas_webhook_events set processed_at = now() where provider_event_id = v_event_id;
        return jsonb_build_object('duplicate', false, 'alreadySettled', true);
      end if;
      select current_period_end, paid_cycle_count into v_period_start, v_previous_paid_cycles
      from public.workspace_subscriptions where workspace_id = v_workspace_id for update;
      select greatest(v_previous_paid_cycles, count(*) filter (where plan_type = 'monthly' and status in ('paid', 'refunded')))::integer
        into v_previous_paid_cycles
      from public.workspace_billing_periods where workspace_id = v_workspace_id;
      if v_saved_period.id is not null and v_saved_period.period_start is not null
         and (v_period_start is null or v_period_start + interval '240 hours' >= v_confirmed_at) then
        v_period_start := v_saved_period.period_start;
      elsif v_period_start is null or v_period_start + interval '240 hours' < v_confirmed_at then
        v_period_start := v_confirmed_at;
      end if;
      if v_saved_period.plan_type = 'monthly' and coalesce(v_saved_period.cycle_number, 0) > 0 then
        v_cycle_number := v_saved_period.cycle_number;
      elsif v_plan_type = 'monthly' then
        select coalesce(max(cycle_number), 0) + 1 into v_cycle_number
        from public.workspace_billing_periods
        where workspace_id = v_workspace_id and plan_type = 'monthly'
          and (v_period_start is null or period_start <= v_period_start);
      else v_cycle_number := null; end if;
      v_price_cents := case
        when v_plan_type = 'annual' then 45000
        when coalesce(v_previous_paid_cycles, 0) < 3 then 3500
        else 5000
      end;
      if v_amount_cents <> v_price_cents then
        if v_saved_period.id is not null then
          update public.workspace_billing_periods set status = 'review', amount_cents = v_amount_cents,
            provider_payment_id = v_payment_id, due_at = v_due_at, updated_at = now()
          where id = v_saved_period.id;
        else
          insert into public.workspace_billing_periods (workspace_id, plan_type, cycle_number, amount_cents,
            status, due_at, paid_at, provider_payment_id, provider_checkout_reference)
          values (v_workspace_id, v_plan_type, v_cycle_number, v_amount_cents, 'review', v_due_at,
            v_confirmed_at, v_payment_id, v_external_reference);
        end if;
        update public.asaas_webhook_events set processed_at = now() where provider_event_id = v_event_id;
        return jsonb_build_object('duplicate', false, 'amountMismatch', true, 'expectedCents', v_price_cents);
      end if;
      if v_plan_type = 'monthly' and coalesce(v_cycle_number, 0) = 1
         and not exists (select 1 from public.workspace_billing_periods where workspace_id = v_workspace_id and plan_type = 'monthly' and status = 'paid') then
        v_period_start := v_confirmed_at;
      end if;
      if v_period_start is null then v_period_start := v_confirmed_at; end if;
      v_period_end := private.add_calendar_months(v_period_start, case when v_plan_type = 'annual' then 12 else 1 end);
      if v_saved_period.id is not null then
        update public.workspace_billing_periods set plan_type = v_plan_type, cycle_number = v_cycle_number,
          period_start = v_period_start, period_end = v_period_end, amount_cents = v_price_cents,
          status = 'paid', due_at = coalesce(v_due_at, due_at), paid_at = greatest(coalesce(paid_at, '-infinity'::timestamptz), v_confirmed_at),
          provider_payment_id = coalesce(provider_payment_id, v_payment_id),
          provider_checkout_reference = coalesce(provider_checkout_reference, v_external_reference),
          payment_url = coalesce(nullif(v_payment ->> 'invoiceUrl', ''), payment_url),
          is_advance_payment = v_period_start > v_confirmed_at, updated_at = now()
        where id = v_saved_period.id;
      else
        insert into public.workspace_billing_periods (
          workspace_id, plan_type, cycle_number, period_start, period_end, amount_cents, status,
          due_at, paid_at, provider_payment_id, provider_checkout_reference, payment_url, is_advance_payment
        ) values (
          v_workspace_id, v_plan_type, v_cycle_number, v_period_start, v_period_end, v_price_cents, 'paid',
          v_due_at, v_confirmed_at, v_payment_id, v_external_reference, nullif(v_payment ->> 'invoiceUrl', ''),
          v_period_start > v_confirmed_at
        ) on conflict (provider_payment_id) do update
          set plan_type = excluded.plan_type, cycle_number = excluded.cycle_number,
              period_start = excluded.period_start, period_end = excluded.period_end,
              amount_cents = excluded.amount_cents, status = 'paid', paid_at = greatest(public.workspace_billing_periods.paid_at, excluded.paid_at),
              due_at = coalesce(excluded.due_at, public.workspace_billing_periods.due_at), updated_at = now();
      end if;
      insert into public.workspace_subscription_payments (
        provider_payment_id, workspace_id, provider_subscription_id, amount, status, confirmed_at,
        plan_type, cycle_number, billing_period_start, billing_period_end, due_at, is_advance_payment
      ) values (
        v_payment_id, v_workspace_id, v_subscription_id, v_price_cents / 100.0, 'paid', v_confirmed_at,
        v_plan_type, v_cycle_number, v_period_start, v_period_end, v_due_at, v_period_start > v_confirmed_at
      ) on conflict (provider_payment_id) do update
        set amount = excluded.amount, status = 'paid', confirmed_at = greatest(public.workspace_subscription_payments.confirmed_at, excluded.confirmed_at),
            plan_type = excluded.plan_type, cycle_number = excluded.cycle_number,
            billing_period_start = excluded.billing_period_start, billing_period_end = excluded.billing_period_end,
            due_at = coalesce(excluded.due_at, public.workspace_subscription_payments.due_at), refunded_at = null;

      select greatest(
        coalesce((select paid_cycle_count from public.workspace_subscriptions where workspace_id = v_workspace_id), 0),
        coalesce((select count(*)::integer from public.workspace_billing_periods
          where workspace_id = v_workspace_id and plan_type = 'monthly' and status in ('paid', 'refunded')), 0)
      ) into v_paid_cycles;
      select max(period_end) into v_period_end from public.workspace_billing_periods
      where workspace_id = v_workspace_id and status = 'paid';
      update public.workspace_subscriptions set
        current_period_start = case when current_period_end is null or current_period_end <= v_confirmed_at then v_period_start else current_period_start end,
        current_period_end = greatest(coalesce(current_period_end, '-infinity'::timestamptz), coalesce(v_period_end, v_confirmed_at)),
        subscription_started_at = coalesce(subscription_started_at, v_confirmed_at),
        grace_period_ends_at = null,
        last_payment_at = greatest(coalesce(last_payment_at, '-infinity'::timestamptz), v_confirmed_at),
        last_payment_status = 'paid',
        paid_cycle_count = v_paid_cycles,
        trial_status = case when trial_status = 'active' then 'converted' else trial_status end,
        trial_used = trial_used or trial_started_at is not null,
        plan_type = case when v_period_start <= v_confirmed_at then v_plan_type else plan_type end,
        pending_plan_type = case when pending_plan_type = v_plan_type and v_period_start <= v_confirmed_at then null else pending_plan_type end,
        pending_plan_effective_at = case when pending_plan_type = v_plan_type and v_period_start <= v_confirmed_at then null else pending_plan_effective_at end,
        provider_subscription_id = case when scheduled_provider_subscription_id = v_subscription_id and v_period_start <= v_confirmed_at then v_subscription_id else provider_subscription_id end,
        scheduled_provider_subscription_id = case when scheduled_provider_subscription_id = v_subscription_id and v_period_start <= v_confirmed_at then null else scheduled_provider_subscription_id end,
        status = 'active',
        billing_phase = case when v_paid_cycles >= 3 then 'standard' else 'promo' end,
        plan_code = case when v_plan_type = 'annual' then 'annual_450' when v_paid_cycles >= 3 then 'monthly_50' else 'monthly_35' end,
        provider_next_payment_id = null, provider_next_payment_url = null,
        provider_event_at = greatest(coalesce(provider_event_at, '-infinity'::timestamptz), v_event_at), updated_at = now()
      where workspace_id = v_workspace_id;

      if v_plan_type = 'annual' then
        select provider_subscription_id into v_provider_subscription_id from public.workspace_subscriptions where workspace_id = v_workspace_id;
        if v_provider_subscription_id is not null then
          v_required_action := 'delete_subscription';
        end if;
      elsif v_plan_type = 'monthly' and v_previous_paid_cycles < 3 and v_paid_cycles >= 3 then
        select provider_subscription_id into v_provider_subscription_id from public.workspace_subscriptions where workspace_id = v_workspace_id;
        if v_provider_subscription_id is not null then v_required_action := 'upgrade_monthly_price'; end if;
      end if;
      if v_required_action is not null then
        update public.asaas_webhook_events
        set action_required = v_required_action, action_subscription_id = v_provider_subscription_id
        where provider_event_id = v_event_id;
        return jsonb_build_object('duplicate', false, 'requiredAction', v_required_action,
          'subscriptionId', v_provider_subscription_id, 'paidMonthlyCycles', v_paid_cycles);
      end if;
    end if;
  elsif v_event_type in ('PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE') then
    if v_payment_id is not null then
      update public.workspace_subscription_payments set status = 'refunded', refunded_at = v_event_at
      where provider_payment_id = v_payment_id;
      update public.workspace_billing_periods set status = 'refunded', updated_at = now()
      where provider_payment_id = v_payment_id;
      select max(period_end) into v_period_end from public.workspace_billing_periods
      where workspace_id = v_workspace_id and status = 'paid';
      update public.workspace_subscriptions set current_period_end = v_period_end,
        grace_period_ends_at = case when v_period_end is null then null else v_period_end + interval '240 hours' end,
        status = case when v_period_end > now() then 'active' else 'past_due' end,
        last_payment_status = v_event_type, updated_at = now()
      where workspace_id = v_workspace_id;
    end if;
  elsif v_event_type = 'SUBSCRIPTION_DELETED' and v_subscription_id is not null then
    update public.workspace_subscriptions set
      provider_subscription_id = case when provider_subscription_id = v_subscription_id then null else provider_subscription_id end,
      scheduled_provider_subscription_id = case when scheduled_provider_subscription_id = v_subscription_id then null else scheduled_provider_subscription_id end,
      pending_plan_type = case when scheduled_provider_subscription_id = v_subscription_id then null else pending_plan_type end,
      pending_plan_effective_at = case when scheduled_provider_subscription_id = v_subscription_id then null else pending_plan_effective_at end,
      status = case when current_period_end > now() then 'active' else 'canceled' end,
      updated_at = now()
    where workspace_id = v_workspace_id;
  end if;

  update public.asaas_webhook_events set processed_at = now() where provider_event_id = v_event_id;
  return jsonb_build_object('duplicate', false, 'requiredAction', null);
end;
$$;

create or replace function public.complete_grafiflow_billing_action(p_event_id text, p_action text, p_subscription_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_action = 'upgrade_monthly_price' then
    update public.workspace_subscriptions set billing_phase = 'standard', plan_code = 'monthly_50', updated_at = now()
    where provider_subscription_id = p_subscription_id and paid_cycle_count >= 3;
    if not found then raise exception using errcode = 'P0001', message = 'Monthly price upgrade could not be recorded'; end if;
    update public.workspace_billing_periods set amount_cents = 5000, updated_at = now()
    where workspace_id = (select workspace_id from public.workspace_subscriptions where provider_subscription_id = p_subscription_id)
      and plan_type = 'monthly' and status = 'pending';
  elsif p_action = 'delete_subscription' then
    update public.workspace_subscriptions set provider_subscription_id = null,
      status = case when current_period_end > now() then 'active' else 'canceled' end, updated_at = now()
    where provider_subscription_id = p_subscription_id;
  else
    raise exception using errcode = '22023', message = 'Unsupported billing action';
  end if;
  update public.asaas_webhook_events set processed_at = now(), action_required = null, action_subscription_id = null
  where provider_event_id = p_event_id;
end;
$$;

revoke all on function public.claim_grafiflow_checkout(uuid, text) from public, anon, authenticated;
revoke all on function public.finalize_grafiflow_checkout(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.release_grafiflow_checkout_claim(uuid, uuid) from public, anon, authenticated;
revoke all on function public.process_grafiflow_billing_event(jsonb) from public, anon, authenticated;
revoke all on function public.complete_grafiflow_billing_action(text, text, text) from public, anon, authenticated;
grant execute on function public.claim_grafiflow_checkout(uuid, text) to service_role;
grant execute on function public.finalize_grafiflow_checkout(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.release_grafiflow_checkout_claim(uuid, uuid) to service_role;
grant execute on function public.process_grafiflow_billing_event(jsonb) to service_role;
grant execute on function public.complete_grafiflow_billing_action(text, text, text) to service_role;

revoke all on function private.add_calendar_months(timestamptz, integer) from public, anon, authenticated;
revoke all on function private.local_date_start(date) from public, anon, authenticated;
revoke all on function private.enforce_grafiflow_billing_access_on_record_write() from public, anon, authenticated;


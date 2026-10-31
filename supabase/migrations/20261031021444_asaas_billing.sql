alter table public.workspace_subscriptions
  add column if not exists provider_checkout_id text,
  add column if not exists provider_checkout_url text,
  add column if not exists provider_checkout_expires_at timestamptz,
  add column if not exists provider_external_reference text,
  add column if not exists billing_phase text not null default 'promo' check (billing_phase in ('promo', 'standard')),
  add column if not exists paid_cycle_count integer not null default 0 check (paid_cycle_count >= 0),
  add column if not exists checkout_claim_token uuid,
  add column if not exists checkout_claimed_at timestamptz,
  add column if not exists checkout_trial boolean not null default false,
  add column if not exists checkout_completed_at timestamptz,
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at timestamptz,
  add column if not exists last_payment_at timestamptz,
  add column if not exists last_payment_status text,
  add column if not exists provider_event_at timestamptz;

create unique index if not exists workspace_subscriptions_checkout_id_uidx
  on public.workspace_subscriptions(provider_checkout_id)
  where provider_checkout_id is not null;

create unique index if not exists workspace_subscriptions_provider_subscription_id_uidx
  on public.workspace_subscriptions(provider_subscription_id)
  where provider_subscription_id is not null;

create unique index if not exists workspace_subscriptions_provider_external_reference_uidx
  on public.workspace_subscriptions(provider_external_reference)
  where provider_external_reference is not null;

create table if not exists public.workspace_subscription_payments (
  provider_payment_id text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider_subscription_id text,
  amount numeric(12, 2) not null check (amount >= 0),
  status text not null check (status in ('paid')),
  confirmed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists workspace_subscription_payments_workspace_idx
  on public.workspace_subscription_payments(workspace_id, confirmed_at desc);

create table if not exists public.asaas_billing_subscriptions (
  provider_subscription_id text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.asaas_billing_checkouts (
  external_reference text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider_checkout_id text unique,
  checkout_url text,
  status text not null check (status in ('creating', 'active', 'paid', 'canceled', 'expired', 'failed')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.asaas_webhook_events (
  provider_event_id text primary key,
  event_type text not null,
  resource_id text,
  event_at timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.workspace_subscription_payments enable row level security;
alter table public.asaas_billing_subscriptions enable row level security;
alter table public.asaas_billing_checkouts enable row level security;
alter table public.asaas_webhook_events enable row level security;

revoke all on public.workspace_subscription_payments from public, anon, authenticated;
revoke all on public.asaas_billing_subscriptions from public, anon, authenticated;
revoke all on public.asaas_billing_checkouts from public, anon, authenticated;
revoke all on public.asaas_webhook_events from public, anon, authenticated;
grant select, insert, update, delete on public.workspace_subscription_payments to service_role;
grant select, insert, update, delete on public.asaas_billing_subscriptions to service_role;
grant select, insert, update, delete on public.asaas_billing_checkouts to service_role;
grant select, insert, update, delete on public.asaas_webhook_events to service_role;

create or replace function public.claim_asaas_checkout(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscription public.workspace_subscriptions%rowtype;
  v_paid_cycles integer;
  v_trial boolean;
  v_price_cents integer;
  v_claim_token uuid;
begin
  if p_workspace_id is null then
    raise exception using errcode = '22023', message = 'workspace_id is required';
  end if;

  insert into public.workspace_subscriptions (workspace_id, provider, status, plan_code, billing_phase)
  values (p_workspace_id, 'asaas', 'pending', 'monthly_40', 'promo')
  on conflict (workspace_id) do nothing;

  select * into v_subscription
  from public.workspace_subscriptions
  where workspace_id = p_workspace_id
  for update;

  if v_subscription.provider is not null and v_subscription.provider <> 'asaas' then
    return jsonb_build_object('action', 'unsupported_provider');
  end if;

  if v_subscription.status in ('active', 'trialing') then
    return jsonb_build_object('action', 'already_active');
  end if;

  if v_subscription.provider_subscription_id is not null and v_subscription.status <> 'canceled' then
    return jsonb_build_object('action', 'existing_subscription');
  end if;

  if v_subscription.status = 'pending'
     and v_subscription.provider_checkout_id is not null
     and v_subscription.provider_checkout_expires_at > now() then
    return jsonb_build_object(
      'action', 'reuse',
      'checkoutUrl', v_subscription.provider_checkout_url,
      'checkoutId', v_subscription.provider_checkout_id,
      'trial', v_subscription.checkout_trial,
      'priceCents', case when v_subscription.billing_phase = 'standard' then 5000 else 4000 end,
      'paidCycles', v_subscription.paid_cycle_count
    );
  end if;

  if v_subscription.checkout_completed_at is not null
     and v_subscription.provider_subscription_id is null then
    return jsonb_build_object('action', 'provisioning');
  end if;

  if v_subscription.checkout_claim_token is not null
     and v_subscription.checkout_claimed_at > now() - interval '65 minutes' then
    return jsonb_build_object('action', 'busy');
  end if;

  select count(*)::integer into v_paid_cycles
  from public.workspace_subscription_payments
  where workspace_id = p_workspace_id and status = 'paid';

  v_trial := v_subscription.trial_started_at is null;
  v_price_cents := case when v_paid_cycles < 3 then 4000 else 5000 end;
  v_claim_token := gen_random_uuid();

  insert into public.asaas_billing_checkouts (external_reference, workspace_id, status)
  values (v_claim_token::text, p_workspace_id, 'creating');

  update public.workspace_subscriptions
  set provider = 'asaas',
      provider_customer_id = null,
      provider_subscription_id = null,
      provider_checkout_id = null,
      provider_checkout_url = null,
      provider_checkout_expires_at = null,
      provider_external_reference = v_claim_token::text,
      status = 'pending',
      plan_code = case when v_price_cents = 4000 then 'monthly_40' else 'monthly_50' end,
      billing_phase = case when v_price_cents = 4000 then 'promo' else 'standard' end,
      paid_cycle_count = v_paid_cycles,
      checkout_claim_token = v_claim_token,
      checkout_claimed_at = now(),
      checkout_trial = v_trial,
      checkout_completed_at = null,
      trial_ends_at = case when v_trial then null else trial_ends_at end,
      current_period_start = null,
      current_period_end = null,
      cancel_at_period_end = false,
      updated_at = now()
  where workspace_id = p_workspace_id;

  return jsonb_build_object(
    'action', 'create',
    'claimToken', v_claim_token,
    'trial', v_trial,
    'priceCents', v_price_cents,
    'paidCycles', v_paid_cycles
  );
end;
$$;

create or replace function public.finalize_asaas_checkout(
  p_workspace_id uuid,
  p_claim_token uuid,
  p_checkout_id text,
  p_checkout_url text,
  p_checkout_expires_at timestamptz,
  p_trial_requested boolean,
  p_trial_ends_at timestamptz,
  p_price_cents integer
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
      provider_external_reference = p_claim_token::text,
      checkout_trial = p_trial_requested,
      trial_ends_at = case
        when p_trial_requested and trial_started_at is null then p_trial_ends_at
        else trial_ends_at
      end,
      billing_phase = case when p_price_cents = 4000 then 'promo' else 'standard' end,
      plan_code = case when p_price_cents = 4000 then 'monthly_40' else 'monthly_50' end,
      checkout_claim_token = null,
      checkout_claimed_at = null,
      updated_at = now()
  where workspace_id = p_workspace_id
    and checkout_claim_token = p_claim_token;

  if not found then
    raise exception using errcode = '40001', message = 'Checkout claim expired';
  end if;

  update public.asaas_billing_checkouts
  set provider_checkout_id = p_checkout_id,
      checkout_url = p_checkout_url,
      status = 'active',
      expires_at = p_checkout_expires_at,
      updated_at = now()
  where external_reference = p_claim_token::text;

  if not found then
    raise exception using errcode = 'P0001', message = 'Checkout attempt record is missing';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.release_asaas_checkout_claim(p_workspace_id uuid, p_claim_token uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.workspace_subscriptions
  set checkout_claim_token = null,
      checkout_claimed_at = null,
      provider_external_reference = null,
      updated_at = now()
  where workspace_id = p_workspace_id
    and checkout_claim_token = p_claim_token;

  update public.asaas_billing_checkouts
  set status = 'failed', updated_at = now()
  where external_reference = p_claim_token::text and status = 'creating';
$$;

create or replace function public.process_asaas_billing_event(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id text := nullif(p_payload ->> 'id', '');
  v_event_type text := nullif(p_payload ->> 'event', '');
  v_event_at timestamptz := coalesce(nullif(p_payload ->> 'dateCreated', '')::timestamptz, now());
  v_checkout jsonb := coalesce(p_payload -> 'checkout', '{}'::jsonb);
  v_payment jsonb := coalesce(p_payload -> 'payment', '{}'::jsonb);
  v_subscription jsonb := coalesce(p_payload -> 'subscription', '{}'::jsonb);
  v_checkout_id text;
  v_subscription_id text;
  v_payment_id text;
  v_customer_id text;
  v_external_reference text;
  v_resource_id text;
  v_workspace_id uuid;
  v_processed_at timestamptz;
  v_confirmed_at timestamptz;
  v_paid_cycles integer := 0;
  v_upgrade_required boolean := false;
  v_current_subscription_id text;
  v_subscription_is_current boolean := false;
  v_checkout_is_current boolean := false;
begin
  if v_event_id is null or v_event_type is null then
    raise exception using errcode = '22023', message = 'Webhook event id and event type are required';
  end if;

  v_checkout_id := coalesce(v_checkout ->> 'id', p_payload ->> 'checkoutId');
  v_subscription_id := coalesce(v_subscription ->> 'id', v_payment ->> 'subscription', p_payload ->> 'subscriptionId');
  v_payment_id := nullif(v_payment ->> 'id', '');
  v_customer_id := coalesce(
    nullif(v_subscription ->> 'customer', ''),
    nullif(v_payment ->> 'customer', ''),
    nullif(v_checkout ->> 'customer', '')
  );
  v_external_reference := coalesce(
    v_checkout ->> 'externalReference',
    v_subscription ->> 'externalReference',
    v_payment ->> 'externalReference',
    p_payload ->> 'externalReference'
  );
  v_resource_id := coalesce(v_payment_id, v_subscription_id, v_checkout_id);

  insert into public.asaas_webhook_events (provider_event_id, event_type, resource_id, event_at)
  values (v_event_id, v_event_type, v_resource_id, v_event_at)
  on conflict (provider_event_id) do nothing;

  select processed_at into v_processed_at
  from public.asaas_webhook_events
  where provider_event_id = v_event_id
  for update;

  if v_processed_at is not null then
    return jsonb_build_object('duplicate', true, 'upgradeRequired', false);
  end if;

  if v_subscription_id is not null then
    select workspace_id into v_workspace_id
    from public.asaas_billing_subscriptions
    where provider_subscription_id = v_subscription_id;
  end if;

  if v_workspace_id is null and v_checkout_id is not null then
    select workspace_id into v_workspace_id
    from public.workspace_subscriptions
    where provider_checkout_id = v_checkout_id;
  end if;

  if v_workspace_id is null and v_external_reference is not null then
    select workspace_id into v_workspace_id
    from public.asaas_billing_checkouts
    where external_reference = v_external_reference;
  end if;

  if v_workspace_id is null and v_external_reference is not null then
    select workspace_id into v_workspace_id
    from public.workspace_subscriptions
    where provider_external_reference = v_external_reference;
  end if;

  if v_workspace_id is null and v_customer_id is not null then
    select workspace_id into v_workspace_id
    from public.workspace_subscriptions
    where provider_customer_id = v_customer_id
      and status in ('pending', 'trialing', 'active', 'past_due')
    order by updated_at desc
    limit 1;
  end if;

  if v_workspace_id is null and v_external_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_workspace_id := v_external_reference::uuid;
  end if;

  if v_workspace_id is null or not exists (
    select 1 from public.workspaces where id = v_workspace_id
  ) then
    if v_event_type = 'CHECKOUT_CREATED' then
      update public.asaas_webhook_events
      set processed_at = now()
      where provider_event_id = v_event_id;
      return jsonb_build_object('duplicate', false, 'ignored', true, 'upgradeRequired', false);
    end if;
    raise exception using errcode = 'P0001', message = 'Could not associate Asaas event with a workspace';
  end if;

  if v_subscription_id is not null and v_event_type = 'SUBSCRIPTION_CREATED' then
    insert into public.asaas_billing_subscriptions (provider_subscription_id, workspace_id)
    values (v_subscription_id, v_workspace_id)
    on conflict (provider_subscription_id) do update
      set workspace_id = excluded.workspace_id;
  end if;

  select exists (
    select 1 from public.workspace_subscriptions
    where workspace_id = v_workspace_id and provider_subscription_id = v_subscription_id
  ) into v_subscription_is_current;
  select exists (
    select 1 from public.workspace_subscriptions
    where workspace_id = v_workspace_id
      and (provider_checkout_id = v_checkout_id or provider_external_reference = v_external_reference)
  ) into v_checkout_is_current;

  if v_event_type = 'SUBSCRIPTION_CREATED' and v_subscription_id is not null then
    update public.workspace_subscriptions
    set provider = 'asaas',
        provider_subscription_id = v_subscription_id,
        provider_customer_id = coalesce(nullif(v_subscription ->> 'customer', ''), provider_customer_id),
        status = case
          when exists (
            select 1 from public.workspace_subscription_payments paid_row
            where paid_row.workspace_id = v_workspace_id
              and paid_row.provider_subscription_id = v_subscription_id
              and paid_row.status = 'paid'
          ) then 'active'
          when checkout_trial and trial_started_at is null then 'trialing'
          else 'pending'
        end,
        trial_started_at = case
          when checkout_trial and trial_started_at is null and not exists (
            select 1 from public.workspace_subscription_payments paid_row
            where paid_row.workspace_id = v_workspace_id
              and paid_row.provider_subscription_id = v_subscription_id
              and paid_row.status = 'paid'
          ) then v_event_at
          else trial_started_at
        end,
        checkout_completed_at = null,
        provider_event_at = greatest(coalesce(provider_event_at, '-infinity'::timestamptz), v_event_at),
        updated_at = now()
    where workspace_id = v_workspace_id
      and (provider_subscription_id is null or provider_subscription_id = v_subscription_id or status = 'canceled')
      and (
        (v_external_reference is not null and (provider_external_reference is null or provider_external_reference = v_external_reference))
        or (v_external_reference is null and (provider_customer_id is null or provider_customer_id = v_customer_id))
      )
      and (checkout_claimed_at is null or v_event_at >= checkout_claimed_at - interval '2 minutes');
    select exists (
      select 1 from public.workspace_subscriptions
      where workspace_id = v_workspace_id and provider_subscription_id = v_subscription_id
    ) into v_subscription_is_current;
  elsif v_event_type in ('SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_DELETED') and v_subscription_is_current then
    update public.workspace_subscriptions
    set status = 'canceled',
        cancel_at_period_end = false,
        provider_event_at = greatest(coalesce(provider_event_at, '-infinity'::timestamptz), v_event_at),
        updated_at = now()
    where workspace_id = v_workspace_id
      and provider_subscription_id = v_subscription_id
      and v_event_at >= coalesce(provider_event_at, '-infinity'::timestamptz);
  elsif v_event_type = 'SUBSCRIPTION_UPDATED' and v_subscription_is_current then
    update public.workspace_subscriptions
    set billing_phase = case when coalesce((v_subscription ->> 'value')::numeric, 0) >= 50 then 'standard' else billing_phase end,
        plan_code = case when coalesce((v_subscription ->> 'value')::numeric, 0) >= 50 then 'monthly_50' else plan_code end,
        provider_event_at = greatest(coalesce(provider_event_at, '-infinity'::timestamptz), v_event_at),
        updated_at = now()
    where workspace_id = v_workspace_id
      and provider_subscription_id = v_subscription_id
      and v_event_at >= coalesce(provider_event_at, '-infinity'::timestamptz);
  elsif v_event_type = 'CHECKOUT_CREATED' and v_checkout_is_current then
    update public.asaas_billing_checkouts
    set provider_checkout_id = coalesce(provider_checkout_id, v_checkout_id),
        checkout_url = coalesce(nullif(v_checkout ->> 'link', ''), checkout_url),
        status = 'active',
        expires_at = coalesce(
          v_event_at + make_interval(mins => coalesce(nullif(v_checkout ->> 'minutesToExpire', '')::integer, 60)),
          expires_at
        ),
        updated_at = now()
    where external_reference = v_external_reference
      and workspace_id = v_workspace_id
      and (provider_checkout_id is null or provider_checkout_id = v_checkout_id);

    update public.workspace_subscriptions
    set provider_checkout_id = coalesce(provider_checkout_id, v_checkout_id),
        provider_checkout_url = coalesce(nullif(v_checkout ->> 'link', ''), provider_checkout_url),
        provider_checkout_expires_at = coalesce(
          v_event_at + make_interval(mins => coalesce(nullif(v_checkout ->> 'minutesToExpire', '')::integer, 60)),
          provider_checkout_expires_at
        ),
        updated_at = now()
    where workspace_id = v_workspace_id
      and provider_external_reference = v_external_reference
      and (provider_checkout_id is null or provider_checkout_id = v_checkout_id);
  elsif v_event_type = 'CHECKOUT_PAID' and v_checkout_is_current then
    update public.asaas_billing_checkouts
    set provider_checkout_id = coalesce(provider_checkout_id, v_checkout_id),
        status = 'paid',
        checkout_url = null,
        expires_at = null,
        updated_at = now()
    where external_reference = v_external_reference and workspace_id = v_workspace_id;

    update public.workspace_subscriptions
    set checkout_completed_at = v_event_at,
        provider_customer_id = coalesce(v_customer_id, provider_customer_id),
        provider_checkout_url = null,
        provider_checkout_expires_at = null,
        updated_at = now()
    where workspace_id = v_workspace_id
      and (provider_checkout_id = v_checkout_id or provider_external_reference = v_external_reference)
      and provider_subscription_id is null
      and status = 'pending';
  elsif v_event_type in ('CHECKOUT_CANCELED', 'CHECKOUT_EXPIRED') and v_checkout_is_current then
    update public.asaas_billing_checkouts
    set status = case when v_event_type = 'CHECKOUT_CANCELED' then 'canceled' else 'expired' end,
        checkout_url = null,
        expires_at = null,
        updated_at = now()
    where external_reference = v_external_reference and workspace_id = v_workspace_id;

    update public.workspace_subscriptions
    set status = 'incomplete',
        provider_checkout_url = null,
        provider_checkout_expires_at = null,
        updated_at = now()
    where workspace_id = v_workspace_id
      and (provider_checkout_id = v_checkout_id or provider_external_reference = v_external_reference)
      and provider_subscription_id is null
      and status = 'pending'
      and checkout_completed_at is null;
  elsif v_event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') then
    if v_payment_id is null then
      raise exception using errcode = '22023', message = 'Payment event is missing payment.id';
    end if;
    v_confirmed_at := coalesce(
      nullif(v_payment ->> 'paymentDate', '')::timestamptz,
      nullif(v_payment ->> 'confirmedDate', '')::timestamptz,
      v_event_at
    );
    insert into public.workspace_subscription_payments as saved_payment (
      provider_payment_id, workspace_id, provider_subscription_id, amount, status, confirmed_at
    ) values (
      v_payment_id,
      v_workspace_id,
      v_subscription_id,
      coalesce(nullif(v_payment ->> 'value', '')::numeric, 0),
      'paid',
      v_confirmed_at
    )
    on conflict (provider_payment_id) do update
      set amount = excluded.amount,
          status = 'paid',
          confirmed_at = greatest(saved_payment.confirmed_at, excluded.confirmed_at);

    update public.workspace_subscriptions
    set status = 'active',
        last_payment_at = greatest(coalesce(last_payment_at, '-infinity'::timestamptz), v_confirmed_at),
        last_payment_status = 'paid',
        provider_event_at = greatest(coalesce(provider_event_at, '-infinity'::timestamptz), v_event_at),
        updated_at = now()
    where workspace_id = v_workspace_id
      and provider_subscription_id = v_subscription_id
      and v_subscription_id is not null
      and status <> 'canceled'
      and v_event_at >= coalesce(provider_event_at, '-infinity'::timestamptz);
  elsif v_event_type = 'PAYMENT_OVERDUE' and v_subscription_is_current then
    if not exists (
      select 1 from public.workspace_subscription_payments
      where provider_payment_id = v_payment_id and status = 'paid'
    ) then
      update public.workspace_subscriptions
      set status = 'past_due',
          last_payment_status = 'overdue',
          provider_event_at = greatest(coalesce(provider_event_at, '-infinity'::timestamptz), v_event_at),
          updated_at = now()
      where workspace_id = v_workspace_id
        and provider_subscription_id = v_subscription_id
        and status <> 'canceled'
        and v_event_at >= coalesce(provider_event_at, '-infinity'::timestamptz);
    end if;
  elsif v_event_type in (
    'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE',
    'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE'
  ) and v_subscription_is_current then
    update public.workspace_subscriptions
    set status = 'past_due',
        last_payment_status = v_event_type,
        provider_event_at = greatest(coalesce(provider_event_at, '-infinity'::timestamptz), v_event_at),
        updated_at = now()
    where workspace_id = v_workspace_id
      and provider_subscription_id = v_subscription_id
      and status <> 'canceled'
      and v_event_at >= coalesce(provider_event_at, '-infinity'::timestamptz);
  end if;

  select count(*)::integer into v_paid_cycles
  from public.workspace_subscription_payments
  where workspace_id = v_workspace_id and status = 'paid';

  update public.workspace_subscriptions
  set paid_cycle_count = v_paid_cycles,
      updated_at = now()
  where workspace_id = v_workspace_id;

  select (
    billing_phase = 'promo'
    and v_paid_cycles >= 3
    and provider_subscription_id is not null
    and status <> 'canceled'
  ), provider_subscription_id into v_upgrade_required, v_current_subscription_id
  from public.workspace_subscriptions
  where workspace_id = v_workspace_id;

  if not v_upgrade_required then
    update public.asaas_webhook_events
    set processed_at = now()
    where provider_event_id = v_event_id;
  end if;

  return jsonb_build_object(
    'duplicate', false,
    'upgradeRequired', coalesce(v_upgrade_required, false),
    'subscriptionId', case when v_upgrade_required then v_current_subscription_id else null end,
    'paidCycles', v_paid_cycles
  );
end;
$$;

create or replace function public.complete_asaas_price_upgrade(p_event_id text, p_provider_subscription_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.workspace_subscriptions
  set billing_phase = 'standard',
      plan_code = 'monthly_50',
      updated_at = now()
  where provider_subscription_id = p_provider_subscription_id
    and paid_cycle_count >= 3;

  if not found then
    raise exception using errcode = 'P0001', message = 'Subscription price upgrade could not be completed';
  end if;

  update public.asaas_webhook_events
  set processed_at = now()
  where provider_event_id = p_event_id;
end;
$$;

revoke all on function public.claim_asaas_checkout(uuid) from public, anon, authenticated;
revoke all on function public.finalize_asaas_checkout(uuid, uuid, text, text, timestamptz, boolean, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.release_asaas_checkout_claim(uuid, uuid) from public, anon, authenticated;
revoke all on function public.process_asaas_billing_event(jsonb) from public, anon, authenticated;
revoke all on function public.complete_asaas_price_upgrade(text, text) from public, anon, authenticated;
grant execute on function public.claim_asaas_checkout(uuid) to service_role;
grant execute on function public.finalize_asaas_checkout(uuid, uuid, text, text, timestamptz, boolean, timestamptz, integer) to service_role;
grant execute on function public.release_asaas_checkout_claim(uuid, uuid) to service_role;
grant execute on function public.process_asaas_billing_event(jsonb) to service_role;
grant execute on function public.complete_asaas_price_upgrade(text, text) to service_role;

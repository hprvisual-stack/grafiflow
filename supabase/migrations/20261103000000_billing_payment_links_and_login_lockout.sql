-- Add single-use recurring payment links and server-side password lockout accounting.
-- The password hook is dormant until enabled in Supabase Auth > Hooks. Supabase lists this
-- hook as Teams/Enterprise only; Free projects cannot enforce the five-attempt rule.

begin;

alter table public.asaas_billing_checkouts
  drop constraint if exists asaas_billing_checkouts_status_check;
alter table public.asaas_billing_checkouts
  add constraint asaas_billing_checkouts_status_check
    check (status in ('creating', 'active', 'used', 'paid', 'canceled', 'expired', 'failed'));

create table if not exists private.grafiflow_password_login_failures (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failed_attempts integer not null check (failed_attempts between 1 and 5),
  first_failed_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  locked_at timestamptz,
  updated_at timestamptz not null default now()
);
revoke all on table private.grafiflow_password_login_failures from public, anon, authenticated, service_role;
grant usage on schema private, public to supabase_auth_admin;
grant select, insert, update, delete on table private.grafiflow_password_login_failures to supabase_auth_admin;
alter table private.grafiflow_password_login_failures enable row level security;
grant usage on schema private to authenticated;
grant delete on table private.grafiflow_password_login_failures to authenticated;
drop policy if exists "users can clear their own password lockout" on private.grafiflow_password_login_failures;
create policy "users can clear their own password lockout"
  on private.grafiflow_password_login_failures for delete to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "auth can manage password lockout counters" on private.grafiflow_password_login_failures;
create policy "auth can manage password lockout counters"
  on private.grafiflow_password_login_failures for all to supabase_auth_admin
  using (true) with check (true);

create or replace function public.grafiflow_password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_user_id text := nullif(event ->> 'user_id', '');
  v_valid boolean := event -> 'valid' = 'true'::jsonb;
  v_failed_attempts integer;
  v_locked_at timestamptz;
begin
  if v_user_id is null or v_user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('decision', 'continue');
  end if;

  select failed_attempts, locked_at into v_failed_attempts, v_locked_at
  from private.grafiflow_password_login_failures
  where user_id = v_user_id::uuid
  for update;

  if v_locked_at is not null then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'Acesso bloqueado após cinco senhas incorretas. Redefina sua senha para continuar.',
      'should_logout_user', true
    );
  end if;

  if v_valid then
    delete from private.grafiflow_password_login_failures where user_id = v_user_id::uuid;
    return jsonb_build_object('decision', 'continue');
  end if;

  insert into private.grafiflow_password_login_failures as failures (
    user_id, failed_attempts, first_failed_at, last_failed_at, locked_at, updated_at
  ) values (
    v_user_id::uuid, 1, now(), now(), null, now()
  )
  on conflict (user_id) do update set
    failed_attempts = least(failures.failed_attempts + 1, 5),
    last_failed_at = now(),
    locked_at = case
      when failures.failed_attempts + 1 >= 5 then coalesce(failures.locked_at, now())
      else failures.locked_at end,
    updated_at = now()
  returning failed_attempts, locked_at into v_failed_attempts, v_locked_at;

  if v_failed_attempts >= 5 then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'Acesso bloqueado após cinco senhas incorretas. Redefina sua senha para continuar.',
      'should_logout_user', true
    );
  end if;

  return jsonb_build_object('decision', 'continue');
end;
$$;
revoke all on function public.grafiflow_password_verification_attempt(jsonb) from public, anon, authenticated;
grant execute on function public.grafiflow_password_verification_attempt(jsonb) to supabase_auth_admin;
comment on function public.grafiflow_password_verification_attempt(jsonb) is
  'Hook de bloqueio após cinco falhas. Disponível para ativação apenas em planos Supabase que ofereçam Password Verification Attempt Hook.';

create or replace function public.reset_grafiflow_password_failures()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;
  delete from private.grafiflow_password_login_failures where user_id = auth.uid();
end;
$$;
revoke all on function public.reset_grafiflow_password_failures() from public, anon, authenticated;
grant execute on function public.reset_grafiflow_password_failures() to authenticated;
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
  v_payment_link_id text := coalesce(nullif(v_payment ->> 'paymentLink', ''), nullif(v_subscription ->> 'paymentLink', ''), nullif(p_payload ->> 'paymentLink', ''));
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
  values (v_event_id, v_event_type, coalesce(v_payment_id, v_subscription_id, v_checkout_id, v_payment_link_id), v_event_at)
  on conflict (provider_event_id) do nothing;
  select processed_at, action_required, action_subscription_id
    into v_previous_processed, v_required_action, v_provider_subscription_id
    from public.asaas_webhook_events where provider_event_id = v_event_id for update;
  if v_previous_processed is not null then return jsonb_build_object('duplicate', true); end if;
  if v_required_action is not null then
    return jsonb_build_object('duplicate', false, 'requiredAction', v_required_action,
      'subscriptionId', v_provider_subscription_id);
  end if;

  if v_payment_link_id is not null then
    select workspace_id into v_workspace_id from public.asaas_billing_checkouts
    where provider_checkout_id = v_payment_link_id and plan_type = 'monthly' and status in ('active', 'used');
  end if;
  if v_workspace_id is null and v_subscription_id is not null then
    select workspace_id into v_workspace_id from public.asaas_billing_subscriptions where provider_subscription_id = v_subscription_id;
  end if;
  if v_workspace_id is null and v_checkout_id is not null then
    select workspace_id into v_workspace_id from public.workspace_subscriptions where provider_checkout_id = v_checkout_id;
  end if;
  if v_external_reference is null and v_payment_link_id is not null then
    select external_reference into v_external_reference from public.asaas_billing_checkouts
    where provider_checkout_id = v_payment_link_id and status in ('active', 'used');
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

  if v_payment_link_id is not null then
    select exists (
      select 1 from public.asaas_billing_checkouts
      where provider_checkout_id = v_payment_link_id and workspace_id = v_workspace_id
        and plan_type = 'monthly' and status in ('active', 'used')
    ) into v_checkout_current;
    if v_checkout_current then
      update public.asaas_billing_checkouts set status = 'used', checkout_url = null,
        expires_at = null, updated_at = now()
      where provider_checkout_id = v_payment_link_id and workspace_id = v_workspace_id and status = 'active';
      if v_subscription_id is not null then
        insert into public.asaas_billing_subscriptions (provider_subscription_id, workspace_id, plan_type)
        values (v_subscription_id, v_workspace_id, 'monthly')
        on conflict (provider_subscription_id) do nothing;
      end if;
      update public.workspace_subscriptions set
        provider = 'asaas',
        provider_customer_id = coalesce(v_customer_id, provider_customer_id),
        provider_subscription_id = case
          when v_subscription_id is not null and (provider_subscription_id is null or status in ('canceled', 'incomplete')) then v_subscription_id
          else provider_subscription_id end,
        provider_checkout_id = v_payment_link_id,
        provider_checkout_url = null,
        provider_checkout_expires_at = null,
        checkout_completed_at = case when v_subscription_id is not null then coalesce(checkout_completed_at, v_event_at) else checkout_completed_at end,
        checkout_claim_token = null,
        checkout_claimed_at = null,
        plan_type = case when pending_plan_type = 'monthly' and current_period_end > now() and plan_type = 'annual' then plan_type else 'monthly' end,
        plan_code = case when paid_cycle_count < 3 then 'monthly_35' else 'monthly_50' end,
        status = case
          when trial_status = 'active' and trial_ends_at > now() then 'trialing'
          when current_period_end > now() and status in ('active', 'past_due', 'trialing') then status
          when v_subscription_id is not null then 'pending'
          else status end,
        provider_event_at = greatest(coalesce(provider_event_at, '-infinity'::timestamptz), v_event_at),
        updated_at = now()
      where workspace_id = v_workspace_id;
    end if;
  end if;
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
commit;

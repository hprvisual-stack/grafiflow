-- Versioned catalog for individual and team subscriptions. Existing subscriptions keep
-- their recorded prices; only new catalog plans receive the new listed values.
create table if not exists private.grafiflow_billing_plans (
  plan_code text primary key,
  plan_name text not null,
  product_tier text not null check (product_tier in ('solo','team')),
  plan_type text not null check (plan_type in ('monthly','annual')),
  max_team_members integer check (max_team_members is null or max_team_members > 0),
  trial_days integer not null check (trial_days between 0 and 365),
  promo_cycles integer not null default 0 check (promo_cycles >= 0),
  promo_price_cents integer check (promo_price_cents is null or promo_price_cents > 0),
  standard_price_cents integer check (standard_price_cents is null or standard_price_cents > 0),
  annual_price_cents integer check (annual_price_cents is null or annual_price_cents > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint grafiflow_billing_plans_price_shape_check check (
    (plan_type = 'monthly' and promo_cycles = 3 and promo_price_cents is not null
      and standard_price_cents is not null and annual_price_cents is null)
    or (plan_type = 'annual' and promo_cycles = 0 and promo_price_cents is null
      and standard_price_cents is null and annual_price_cents is not null)
  )
);
alter table private.grafiflow_billing_plans enable row level security;
revoke all on table private.grafiflow_billing_plans from public, anon, authenticated, service_role;

insert into private.grafiflow_billing_plans
  (plan_code, plan_name, product_tier, plan_type, max_team_members, trial_days, promo_cycles, promo_price_cents, standard_price_cents, annual_price_cents, active)
values
  ('individual_monthly', 'Individual mensal', 'solo', 'monthly', null, 15, 3, 3500, 5000, null, true),
  ('team_4_monthly', 'Equipe até 4', 'team', 'monthly', 4, 15, 3, 7500, 10000, null, true),
  ('team_unlimited_monthly', 'Equipe ilimitada (5+)', 'team', 'monthly', null, 15, 3, 15000, 20000, null, true),
  ('individual_annual', 'Individual anual', 'solo', 'annual', null, 15, 0, null, null, 50000, true),
  ('team_4_annual', 'Equipe até 4 anual', 'team', 'annual', 4, 15, 0, null, null, 100000, true),
  ('team_unlimited_annual', 'Equipe ilimitada (5+)', 'team', 'annual', null, 15, 0, null, null, 200000, true),
  ('legacy_individual_monthly', 'Individual mensal legado', 'solo', 'monthly', null, 15, 3, 3500, 5000, null, false),
  ('legacy_team_monthly', 'Equipe mensal legada', 'team', 'monthly', null, 15, 3, 3500, 5000, null, false),
  ('legacy_individual_annual_450', 'Individual anual legado', 'solo', 'annual', null, 15, 0, null, null, 45000, false),
  ('legacy_team_annual_450', 'Equipe anual legada', 'team', 'annual', null, 15, 0, null, null, 45000, false)
on conflict (plan_code) do update set
  plan_name = excluded.plan_name,
  product_tier = excluded.product_tier,
  plan_type = excluded.plan_type,
  max_team_members = excluded.max_team_members,
  trial_days = excluded.trial_days,
  promo_cycles = excluded.promo_cycles,
  promo_price_cents = excluded.promo_price_cents,
  standard_price_cents = excluded.standard_price_cents,
  annual_price_cents = excluded.annual_price_cents,
  active = excluded.active,
  updated_at = now();

alter table public.workspace_subscriptions
  add column if not exists billing_plan_code text,
  add column if not exists pending_billing_plan_code text,
  add column if not exists max_team_members integer;
alter table public.asaas_billing_checkouts
  add column if not exists billing_plan_code text;
alter table public.asaas_billing_subscriptions
  add column if not exists billing_plan_code text;
alter table public.workspace_billing_periods
  add column if not exists billing_plan_code text;
alter table public.workspace_subscription_payments
  add column if not exists billing_plan_code text;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workspace_subscriptions_max_team_members_check'
      and conrelid = 'public.workspace_subscriptions'::regclass
  ) then
    alter table public.workspace_subscriptions add constraint workspace_subscriptions_max_team_members_check
      check (max_team_members is null or max_team_members > 0);
  end if;
end $$;

-- Map existing accounts to non-saleable legacy entries to preserve their current terms.
update public.workspace_subscriptions s set billing_plan_code = case
  when s.billing_plan_code is not null then s.billing_plan_code
  when s.product_tier = 'team' and s.plan_type = 'annual' then 'legacy_team_annual_450'
  when s.product_tier = 'team' then 'legacy_team_monthly'
  when s.plan_type = 'annual' then 'legacy_individual_annual_450'
  else 'legacy_individual_monthly'
end,
max_team_members = case when s.product_tier = 'team' then null else s.max_team_members end
where s.billing_plan_code is null;
update public.workspace_billing_periods p set billing_plan_code = s.billing_plan_code
from public.workspace_subscriptions s
where p.workspace_id = s.workspace_id and p.billing_plan_code is null;
update public.workspace_subscription_payments p set billing_plan_code = s.billing_plan_code
from public.workspace_subscriptions s
where p.workspace_id = s.workspace_id and p.billing_plan_code is null;
update public.asaas_billing_checkouts c set billing_plan_code = coalesce(s.billing_plan_code,
  case when c.plan_type = 'annual' then 'legacy_individual_annual_450' else 'legacy_individual_monthly' end)
from public.workspace_subscriptions s
where c.workspace_id = s.workspace_id and c.billing_plan_code is null;
update public.asaas_billing_subscriptions b set billing_plan_code = coalesce(s.billing_plan_code,
  case when b.plan_type = 'annual' then 'legacy_individual_annual_450' else 'legacy_individual_monthly' end)
from public.workspace_subscriptions s
where b.workspace_id = s.workspace_id and b.billing_plan_code is null;

create index if not exists workspace_billing_periods_plan_code_idx
  on public.workspace_billing_periods(workspace_id, billing_plan_code, status, period_start desc);

create or replace function public.get_grafiflow_entitlement(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_data jsonb;
  v_subscription public.workspace_subscriptions%rowtype;
  v_plan private.grafiflow_billing_plans%rowtype;
  v_paid_cycles integer := 0;
  v_monthly_amount integer;
  v_annual_amount integer;
  v_available_plans jsonb;
  v_team boolean;
  v_dev boolean;
begin
  v_data := public.get_grafiflow_entitlement_before_team(p_workspace_id);
  select * into v_subscription from public.workspace_subscriptions where workspace_id = p_workspace_id;
  if found then
    select * into v_plan from private.grafiflow_billing_plans where plan_code = v_subscription.billing_plan_code;
    select greatest(v_subscription.paid_cycle_count,
      count(*) filter (where plan_type = 'monthly' and status in ('paid','refunded')))::integer
      into v_paid_cycles from public.workspace_billing_periods where workspace_id = p_workspace_id;
    if v_plan.plan_type = 'monthly' then
      v_monthly_amount := case when v_paid_cycles < v_plan.promo_cycles then v_plan.promo_price_cents else v_plan.standard_price_cents end;
    elsif v_plan.plan_type = 'annual' then
      v_annual_amount := v_plan.annual_price_cents;
    end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'plan_code', p.plan_code, 'plan_name', p.plan_name, 'product_tier', p.product_tier,
    'plan_type', p.plan_type, 'max_team_members', p.max_team_members, 'trial_days', p.trial_days,
    'promo_cycles', p.promo_cycles, 'promo_price_cents', p.promo_price_cents,
    'standard_price_cents', p.standard_price_cents, 'annual_price_cents', p.annual_price_cents
  ) order by case when p.product_tier = 'solo' then 0 else 1 end, p.plan_type, p.max_team_members nulls last), '[]'::jsonb)
    into v_available_plans from private.grafiflow_billing_plans p where p.active;
  v_team := private.grafiflow_team_enabled(p_workspace_id);
  v_dev := exists(select 1 from private.grafiflow_dev_accounts d where d.user_id = auth.uid() and d.enabled);
  return coalesce(v_data,'{}'::jsonb) || jsonb_build_object(
    'billing_plan_code', v_subscription.billing_plan_code,
    'billing_plan_name', coalesce(v_plan.plan_name, 'Individual mensal'),
    'product_tier', coalesce(v_subscription.product_tier, 'solo'),
    'team_enabled', v_team,
    'team_member_limit', case when v_team then v_subscription.max_team_members else null end,
    'monthly_amount_cents', v_monthly_amount,
    'annual_amount_cents', coalesce(v_annual_amount, 50000),
    'available_plans', v_available_plans,
    'dev_account', v_dev, 'dev_access', v_dev, 'team_checkout_available', true
  ) || case when v_dev then jsonb_build_object('state','legacy_access','access_allowed',true,'legacy_access',true,'permanent_free',true) else '{}'::jsonb end;
end;
$$;
revoke all on function public.get_grafiflow_entitlement(uuid) from public, anon;
grant execute on function public.get_grafiflow_entitlement(uuid) to authenticated;

create or replace function public.start_grafiflow_plan_trial(p_workspace_id uuid, p_plan_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.workspace_subscriptions%rowtype;
  v_plan private.grafiflow_billing_plans%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or not exists (
    select 1 from public.workspace_members where workspace_id = p_workspace_id and user_id = auth.uid() and role = 'owner'
  ) then raise exception 'workspace owner access required' using errcode = '42501'; end if;
  select * into v_plan from private.grafiflow_billing_plans where plan_code = p_plan_code and active;
  if not found then raise exception using errcode = '22023', message = 'A billing plan is not available'; end if;
  insert into public.workspace_subscriptions (workspace_id, status, trial_status)
  values (p_workspace_id, 'pending', 'not_started') on conflict (workspace_id) do nothing;
  select * into v_row from public.workspace_subscriptions where workspace_id = p_workspace_id for update;
  if v_row.legacy_access or v_row.current_period_end > v_now or v_row.trial_used or v_row.trial_started_at is not null then
    return public.get_grafiflow_entitlement(p_workspace_id);
  end if;
  update public.workspace_subscriptions set
    billing_plan_code = v_plan.plan_code,
    product_tier = v_plan.product_tier,
    max_team_members = v_plan.max_team_members,
    trial_used = true, trial_status = 'active', trial_started_at = v_now,
    trial_ends_at = v_now + make_interval(days => v_plan.trial_days), status = 'trialing', updated_at = v_now
  where workspace_id = p_workspace_id;
  return public.get_grafiflow_entitlement(p_workspace_id);
end;
$$;
revoke all on function public.start_grafiflow_plan_trial(uuid, text) from public, anon;
grant execute on function public.start_grafiflow_plan_trial(uuid, text) to authenticated;

create or replace function public.start_grafiflow_trial(p_workspace_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select public.start_grafiflow_plan_trial(p_workspace_id, 'individual_monthly');
$$;
revoke all on function public.start_grafiflow_trial(uuid) from public, anon;
grant execute on function public.start_grafiflow_trial(uuid) to authenticated;

-- A service-role RPC claims an exact catalog product; the browser never supplies a price.
create or replace function public.claim_grafiflow_plan_checkout(p_workspace_id uuid, p_plan_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_subscription public.workspace_subscriptions%rowtype;
  v_plan private.grafiflow_billing_plans%rowtype;
  v_claim uuid := gen_random_uuid();
  v_paid_cycles integer := 0;
  v_price integer;
  v_start timestamptz;
  v_end timestamptz;
  v_due date;
  v_plan_type text;
begin
  if p_workspace_id is null then raise exception using errcode = '22023', message = 'workspace is required'; end if;
  select * into v_plan from private.grafiflow_billing_plans where plan_code = p_plan_code and active;
  if not found then raise exception using errcode = '22023', message = 'plan is unavailable'; end if;
  insert into public.workspace_subscriptions (workspace_id, provider, status, trial_status)
    values (p_workspace_id, 'asaas', 'pending', 'not_started') on conflict (workspace_id) do nothing;
  select * into v_subscription from public.workspace_subscriptions where workspace_id = p_workspace_id for update;
  if v_subscription.legacy_access then return jsonb_build_object('action','legacy_access'); end if;
  if v_subscription.provider is not null and v_subscription.provider <> 'asaas' then return jsonb_build_object('action','unsupported_provider'); end if;
  if v_subscription.trial_status='active' and v_subscription.trial_ends_at>now() then
    return jsonb_build_object('action','trial_active','trialEndsAt',v_subscription.trial_ends_at);
  end if;
  if v_subscription.checkout_claim_token is not null and v_subscription.checkout_claimed_at > now() - interval '65 minutes' then
    return jsonb_build_object('action','busy');
  end if;
  if v_subscription.provider_checkout_id is not null and v_subscription.provider_checkout_expires_at > now()
     and exists(select 1 from public.asaas_billing_checkouts c where c.provider_checkout_id = v_subscription.provider_checkout_id
       and c.billing_plan_code = p_plan_code and c.status = 'active') then
    return jsonb_build_object('action','reuse','checkoutId',v_subscription.provider_checkout_id,'checkoutUrl',v_subscription.provider_checkout_url);
  end if;
  if v_subscription.provider_subscription_id is not null and v_subscription.status not in ('canceled','incomplete') then
    if v_subscription.billing_plan_code = p_plan_code and v_plan.plan_type = 'monthly' then
      return jsonb_build_object('action','advance_monthly','subscriptionId',v_subscription.provider_subscription_id);
    end if;
    return jsonb_build_object('action','plan_change_not_supported');
  end if;
  if v_subscription.checkout_completed_at is not null and v_subscription.provider_subscription_id is null and v_subscription.status = 'pending' then
    return jsonb_build_object('action','provisioning');
  end if;
  select greatest(v_subscription.paid_cycle_count,
    count(*) filter(where plan_type='monthly' and status in ('paid','refunded')))::integer
    into v_paid_cycles from public.workspace_billing_periods where workspace_id=p_workspace_id;
  v_price := case when v_plan.plan_type='annual' then v_plan.annual_price_cents
    when v_paid_cycles < v_plan.promo_cycles then v_plan.promo_price_cents else v_plan.standard_price_cents end;
  v_start := case when v_subscription.current_period_end > now() then v_subscription.current_period_end
    when v_subscription.current_period_end is not null and v_subscription.current_period_end + interval '240 hours' >= now() then v_subscription.current_period_end
    else null end;
  v_end := case when v_plan.plan_type='annual' and v_start is not null then private.add_calendar_months(v_start,12) else null end;
  v_due := case when v_start is not null then (v_start at time zone 'America/Sao_Paulo')::date
    else (now() at time zone 'America/Sao_Paulo')::date end;
  v_plan_type := v_plan.plan_type;

  if v_plan_type='annual' and exists(select 1 from public.workspace_billing_periods p where p.workspace_id=p_workspace_id
    and p.plan_type='annual' and ((p.status='pending' and p.provider_checkout_reference is not null)
      or (p.status='paid' and p.period_start > now() and p.period_end > now()))) then
    return jsonb_build_object('action','annual_period_already_paid_or_pending');
  end if;

  insert into public.asaas_billing_checkouts (external_reference,workspace_id,status,plan_type,period_start,period_end,amount_cents,billing_plan_code)
    values(v_claim::text,p_workspace_id,'creating',v_plan_type,v_start,v_end,v_price,p_plan_code);
  if v_plan_type='annual' then
    insert into public.workspace_billing_periods(workspace_id,plan_type,period_start,period_end,amount_cents,status,is_advance_payment,provider_checkout_reference,billing_plan_code)
    values(p_workspace_id,'annual',v_start,v_end,v_price,'pending',coalesce(v_start>now(),false),v_claim::text,p_plan_code);
  end if;
  update public.workspace_subscriptions set provider='asaas',
    provider_external_reference=case when v_subscription.provider_subscription_id is null then v_claim::text else provider_external_reference end,
    pending_billing_plan_code=p_plan_code,
    checkout_claim_token=v_claim,checkout_claimed_at=now(),checkout_trial=false,
    provider_checkout_id=null,provider_checkout_url=null,provider_checkout_expires_at=null,updated_at=now()
  where workspace_id=p_workspace_id;
  return jsonb_build_object('action','create','claimToken',v_claim,'planCode',p_plan_code,'planType',v_plan_type,
    'priceCents',v_price,'annualPriceCents',v_price,'nextDueDate',case when v_plan_type='monthly' then to_char(v_due,'YYYY-MM-DD') else null end,
    'scheduled',v_plan_type='annual' and v_start>now(),'periodStart',v_start,'paidMonthlyCycles',v_paid_cycles);
end;
$$;
revoke all on function public.claim_grafiflow_plan_checkout(uuid,text) from public, anon, authenticated;
grant execute on function public.claim_grafiflow_plan_checkout(uuid,text) to service_role;

create or replace function public.release_grafiflow_checkout_claim(p_workspace_id uuid, p_claim_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.workspace_subscriptions set checkout_claim_token=null,checkout_claimed_at=null,pending_billing_plan_code=null,
    pending_plan_type=case when exists(select 1 from public.asaas_billing_checkouts where external_reference=p_claim_token::text and workspace_id=p_workspace_id) then null else pending_plan_type end,
    pending_plan_effective_at=case when exists(select 1 from public.asaas_billing_checkouts where external_reference=p_claim_token::text and workspace_id=p_workspace_id) then null else pending_plan_effective_at end,
    provider_external_reference=case when provider_external_reference=p_claim_token::text then null else provider_external_reference end,updated_at=now()
  where workspace_id=p_workspace_id and checkout_claim_token=p_claim_token;
  update public.asaas_billing_checkouts set status='failed',updated_at=now() where external_reference=p_claim_token::text and status='creating';
  update public.workspace_billing_periods set status='voided',updated_at=now() where provider_checkout_reference=p_claim_token::text and status='pending';
end;
$$;
revoke all on function public.release_grafiflow_checkout_claim(uuid,uuid) from public,anon,authenticated;
grant execute on function public.release_grafiflow_checkout_claim(uuid,uuid) to service_role;

-- Preserve the established webhook state machine, while translating only its legacy
-- internal price values. The real amount is validated and restored in the ledger below.
alter function public.process_grafiflow_billing_event(jsonb) rename to process_grafiflow_billing_event_legacy;
create or replace function public.process_grafiflow_billing_event(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_payload jsonb := p_payload;
  v_event text := p_payload->>'event';
  v_checkout jsonb := coalesce(p_payload->'checkout','{}'::jsonb);
  v_payment jsonb := coalesce(p_payload->'payment','{}'::jsonb);
  v_subscription jsonb := coalesce(p_payload->'subscription','{}'::jsonb);
  v_checkout_id text := coalesce(v_checkout->>'id',p_payload->>'checkoutId');
  v_subscription_id text := coalesce(v_subscription->>'id',v_payment->>'subscription',p_payload->>'subscriptionId');
  v_external text := coalesce(v_checkout->>'externalReference',v_subscription->>'externalReference',v_payment->>'externalReference',p_payload->>'externalReference');
  v_payment_id text := nullif(v_payment->>'id','');
  v_workspace uuid;
  v_plan_code text;
  v_expected integer;
  v_legacy_amount integer;
  v_actual integer;
  v_cycles integer;
  v_cycle integer;
  v_plan private.grafiflow_billing_plans%rowtype;
  v_period public.workspace_billing_periods%rowtype;
  v_result jsonb;
begin
  if v_subscription_id is not null then select workspace_id into v_workspace from public.asaas_billing_subscriptions where provider_subscription_id=v_subscription_id; end if;
  if v_workspace is null and v_checkout_id is not null then select workspace_id into v_workspace from public.workspace_subscriptions where provider_checkout_id=v_checkout_id; end if;
  if v_workspace is null and v_external is not null then select workspace_id into v_workspace from public.asaas_billing_checkouts where external_reference=v_external; end if;
  if v_workspace is null and v_external is not null then select workspace_id into v_workspace from public.workspace_subscriptions where provider_external_reference=v_external; end if;
  if v_workspace is not null then
    select * into v_period from public.workspace_billing_periods where provider_payment_id=v_payment_id or (v_external is not null and provider_checkout_reference=v_external) order by (provider_payment_id=v_payment_id) desc nulls last limit 1;
    select coalesce(v_period.billing_plan_code,c.billing_plan_code,b.billing_plan_code,s.pending_billing_plan_code,s.billing_plan_code)
      into v_plan_code from public.workspace_subscriptions s
      left join public.asaas_billing_checkouts c on c.external_reference=v_external
      left join public.asaas_billing_subscriptions b on b.provider_subscription_id=v_subscription_id
      where s.workspace_id=v_workspace;
    select * into v_plan from private.grafiflow_billing_plans where plan_code=v_plan_code;
  end if;
  if v_plan.plan_code is null then return public.process_grafiflow_billing_event_legacy(p_payload); end if;

  if v_event in ('PAYMENT_CREATED','PAYMENT_UPDATED','PAYMENT_OVERDUE','PAYMENT_CONFIRMED','PAYMENT_RECEIVED') then
    v_actual := round(coalesce(nullif(v_payment->>'value','')::numeric,0)*100)::integer;
    if v_plan.plan_type='annual' then v_expected:=v_plan.annual_price_cents;
    else
      select greatest(s.paid_cycle_count,count(*) filter(where p.plan_type='monthly' and p.status in ('paid','refunded')))::integer
        into v_cycles from public.workspace_subscriptions s left join public.workspace_billing_periods p on p.workspace_id=s.workspace_id
        where s.workspace_id=v_workspace group by s.paid_cycle_count;
      v_cycle:=coalesce(v_period.cycle_number,coalesce(v_cycles,0)+1);
      v_expected:=case when v_cycle<=v_plan.promo_cycles then v_plan.promo_price_cents else v_plan.standard_price_cents end;
    end if;
    if v_actual=v_expected then
      v_legacy_amount:=case when v_plan.plan_type='annual' then 45000
        when coalesce(v_period.cycle_number,coalesce(v_cycles,0)+1)<=3 then 3500 else 5000 end;
      v_payload:=jsonb_set(v_payload,'{payment,value}',to_jsonb(v_legacy_amount/100.0),true);
    end if;
  end if;
  v_result:=public.process_grafiflow_billing_event_legacy(v_payload);
  if v_result->>'amountMismatch'='true' and v_expected is not null then
    v_result:=jsonb_set(v_result,'{expectedCents}',to_jsonb(v_expected),true);
  elsif v_actual=v_expected and v_expected is not null then
    update public.workspace_billing_periods set amount_cents=v_actual,billing_plan_code=v_plan.plan_code
      where workspace_id=v_workspace and (provider_payment_id=v_payment_id or (v_external is not null and provider_checkout_reference=v_external));
    update public.workspace_subscription_payments set amount=v_actual/100.0,billing_plan_code=v_plan.plan_code
      where provider_payment_id=v_payment_id and workspace_id=v_workspace;
    update public.asaas_billing_subscriptions set billing_plan_code=v_plan.plan_code,plan_type=v_plan.plan_type
      where provider_subscription_id=v_subscription_id and workspace_id=v_workspace;
    if v_event in ('PAYMENT_CONFIRMED','PAYMENT_RECEIVED') and v_result->>'amountMismatch' is distinct from 'true' then
      update public.workspace_subscriptions set billing_plan_code=v_plan.plan_code,product_tier=v_plan.product_tier,
        max_team_members=v_plan.max_team_members,pending_billing_plan_code=null,plan_type=v_plan.plan_type,updated_at=now()
      where workspace_id=v_workspace;
      update public.workspace_billing_periods set billing_plan_code=v_plan.plan_code
        where workspace_id=v_workspace and (provider_payment_id=v_payment_id or (v_external is not null and provider_checkout_reference=v_external));
    end if;
  end if;
  if v_result->>'requiredAction'='upgrade_monthly_price' then
    v_result:=jsonb_set(v_result,'{standardPriceCents}',to_jsonb(v_plan.standard_price_cents),true);
  end if;
  if v_event='SUBSCRIPTION_CREATED' then
    update public.asaas_billing_subscriptions set billing_plan_code=v_plan.plan_code,plan_type=v_plan.plan_type
      where provider_subscription_id=v_subscription_id and workspace_id=v_workspace;
  end if;
  if v_event in ('CHECKOUT_CANCELED','CHECKOUT_EXPIRED') then
    update public.workspace_subscriptions set pending_billing_plan_code=null where workspace_id=v_workspace;
  end if;
  return v_result;
end;
$$;
revoke all on function public.process_grafiflow_billing_event(jsonb) from public,anon,authenticated;
revoke all on function public.process_grafiflow_billing_event_legacy(jsonb) from public,anon,authenticated;
grant execute on function public.process_grafiflow_billing_event(jsonb) to service_role;

create or replace function public.complete_grafiflow_billing_action(p_event_id text,p_action text,p_subscription_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_code text; v_price integer;
begin
  if p_action='upgrade_monthly_price' then
    select s.billing_plan_code,p.standard_price_cents into v_code,v_price
      from public.workspace_subscriptions s join private.grafiflow_billing_plans p on p.plan_code=s.billing_plan_code
      where s.provider_subscription_id=p_subscription_id and s.paid_cycle_count>=3;
    if v_code is null then raise exception using errcode='P0001',message='Monthly price upgrade could not be recorded'; end if;
    update public.workspace_subscriptions set billing_phase='standard',plan_code=case v_code when 'team_4_monthly' then 'team_4_monthly_standard' when 'team_unlimited_monthly' then 'team_unlimited_monthly_standard' else 'monthly_50' end,updated_at=now()
      where provider_subscription_id=p_subscription_id;
    update public.workspace_billing_periods set amount_cents=v_price,updated_at=now()
      where workspace_id=(select workspace_id from public.workspace_subscriptions where provider_subscription_id=p_subscription_id)
        and plan_type='monthly' and status='pending';
  elsif p_action='delete_subscription' then
    update public.workspace_subscriptions set provider_subscription_id=null,scheduled_provider_subscription_id=null,updated_at=now()
      where provider_subscription_id=p_subscription_id or scheduled_provider_subscription_id=p_subscription_id;
  else raise exception using errcode='22023',message='Unsupported billing action'; end if;
  update public.asaas_webhook_events set processed_at=now(),action_required=null,action_subscription_id=null where provider_event_id=p_event_id;
end;
$$;
revoke all on function public.complete_grafiflow_billing_action(text,text,text) from public,anon,authenticated;
grant execute on function public.complete_grafiflow_billing_action(text,text,text) to service_role;

-- The product capacity is enforced at write time for every operator PIN, including ADM.
create or replace function public.team_initialize_admin_pin(p_workspace_id uuid,p_display_name text,p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_limit integer; v_count integer;
begin
  if auth.uid() is null or not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=auth.uid() and role in ('owner','admin'))
     or not private.grafiflow_team_enabled(p_workspace_id) then raise exception 'team owner access required' using errcode='42501'; end if;
  if p_display_name is null or char_length(trim(p_display_name)) not between 1 and 120 or p_pin !~ '^[0-9]{6,12}$' then raise exception 'provide a name and a 6-12 digit PIN' using errcode='22023'; end if;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  select max_team_members into v_limit from public.workspace_subscriptions where workspace_id=p_workspace_id;
  select count(*) into v_count from private.grafiflow_team_operators where workspace_id=p_workspace_id and active and pin_hash is not null;
  if v_limit is not null and v_count>=v_limit then raise exception 'team PIN limit reached for current plan' using errcode='P0001'; end if;
  if exists(select 1 from private.grafiflow_team_operators where workspace_id=p_workspace_id and role='admin' and pin_hash is not null) then raise exception 'administrator PIN is already initialized' using errcode='23505'; end if;
  insert into private.grafiflow_team_operators(workspace_id,display_name,role,pin_hash,created_by)
    values(p_workspace_id,trim(p_display_name),'admin',extensions.crypt(p_pin,extensions.gen_salt('bf',10)),auth.uid()) returning id into v_id;
  update public.grafiflow_records set owner_operator_id=v_id where workspace_id=p_workspace_id and owner_operator_id is null
    and record_type in ('quote','material','catalog_finish','catalog_supply','catalog_labor','catalog_extra','purchase','team_task');
  return jsonb_build_object('created',true,'operator_id',v_id);
end;
$$;
revoke all on function public.team_initialize_admin_pin(uuid,text,text) from public,anon;
grant execute on function public.team_initialize_admin_pin(uuid,text,text) to authenticated;

create or replace function public.team_admin_save_member(p_workspace_id uuid,p_operator_session_token text,p_operator_id uuid,p_name text,p_pin text,p_role text default 'operator')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; v_id uuid; v_limit integer; v_count integer;
begin
  v_admin:=private.grafiflow_operator_for_token(p_workspace_id,p_operator_session_token);
  if not private.grafiflow_team_enabled(p_workspace_id) or not private.grafiflow_operator_is_admin(p_workspace_id,v_admin) then raise exception 'team administrator access required' using errcode='42501'; end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 120 or p_pin !~ '^[0-9]{6,12}$' or p_role not in ('admin','operator') then raise exception 'invalid member name, PIN or role' using errcode='22023'; end if;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if exists(select 1 from private.grafiflow_team_operators o where o.workspace_id=p_workspace_id and o.id is distinct from p_operator_id and o.active and o.pin_hash is not null and extensions.crypt(p_pin,o.pin_hash)=o.pin_hash) then raise exception 'PIN already in use' using errcode='23505'; end if;
  if p_operator_id is null then
    select max_team_members into v_limit from public.workspace_subscriptions where workspace_id=p_workspace_id;
    select count(*) into v_count from private.grafiflow_team_operators where workspace_id=p_workspace_id and active and pin_hash is not null;
    if v_limit is not null and v_count>=v_limit then raise exception 'team PIN limit reached for current plan' using errcode='P0001'; end if;
    insert into private.grafiflow_team_operators(workspace_id,display_name,role,pin_hash,created_by) values(p_workspace_id,trim(p_name),p_role,extensions.crypt(p_pin,extensions.gen_salt('bf',10)),auth.uid()) returning id into v_id;
  else
    if p_operator_id=v_admin then raise exception 'another administrator must rotate this PIN' using errcode='42501'; end if;
    update private.grafiflow_team_operators set display_name=trim(p_name),role=p_role,pin_hash=extensions.crypt(p_pin,extensions.gen_salt('bf',10)),updated_at=now()
      where workspace_id=p_workspace_id and id=p_operator_id and active returning id into v_id;
    if v_id is null then raise exception 'member not found or inactive' using errcode='P0002'; end if;
    delete from private.grafiflow_team_sessions where operator_id=p_operator_id;
  end if;
  if not exists(select 1 from private.grafiflow_team_operators where workspace_id=p_workspace_id and role='admin' and active and pin_hash is not null) then raise exception 'at least one active administrator PIN is required' using errcode='23514'; end if;
  return jsonb_build_object('id',v_id,'saved',true);
end;
$$;
revoke all on function public.team_admin_save_member(uuid,text,uuid,text,text,text) from public,anon;
grant execute on function public.team_admin_save_member(uuid,text,uuid,text,text,text) to authenticated;

create or replace function public.team_admin_set_member_active(p_workspace_id uuid,p_operator_session_token text,p_operator_id uuid,p_active boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; v_limit integer; v_count integer;
begin
  v_admin:=private.grafiflow_operator_for_token(p_workspace_id,p_operator_session_token);
  if not private.grafiflow_team_enabled(p_workspace_id) or not private.grafiflow_operator_is_admin(p_workspace_id,v_admin) then raise exception 'team administrator access required' using errcode='42501'; end if;
  if p_operator_id=v_admin then raise exception 'cannot deactivate the current PIN' using errcode='42501'; end if;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if p_active then
    select max_team_members into v_limit from public.workspace_subscriptions where workspace_id=p_workspace_id;
    select count(*) into v_count from private.grafiflow_team_operators where workspace_id=p_workspace_id and active and pin_hash is not null;
    if v_limit is not null and v_count>=v_limit and exists(select 1 from private.grafiflow_team_operators where workspace_id=p_workspace_id and id=p_operator_id and not active) then raise exception 'team PIN limit reached for current plan' using errcode='P0001'; end if;
  end if;
  if not p_active and exists(select 1 from private.grafiflow_team_operators where workspace_id=p_workspace_id and id=p_operator_id and role='admin')
    and (select count(*) from private.grafiflow_team_operators where workspace_id=p_workspace_id and role='admin' and active)<=1 then raise exception 'at least one active administrator PIN is required' using errcode='23514'; end if;
  update private.grafiflow_team_operators set active=p_active,updated_at=now() where workspace_id=p_workspace_id and id=p_operator_id;
  if not found then raise exception 'member not found' using errcode='P0002'; end if;
  if not p_active then delete from private.grafiflow_team_sessions where operator_id=p_operator_id; end if;
  return true;
end;
$$;
revoke all on function public.team_admin_set_member_active(uuid,text,uuid,boolean) from public,anon;
grant execute on function public.team_admin_set_member_active(uuid,text,uuid,boolean) to authenticated;

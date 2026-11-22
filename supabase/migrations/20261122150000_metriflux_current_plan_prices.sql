-- Publish the new monthly prices without changing subscriptions already tied
-- to the earlier monthly catalog rows.
begin;

update private.grafiflow_billing_plans
set active = false, updated_at = now()
where plan_code in ('individual_monthly', 'team_4_monthly');

insert into private.grafiflow_billing_plans
  (plan_code, plan_name, product_tier, plan_type, max_team_members, trial_days,
   promo_cycles, promo_price_cents, standard_price_cents, annual_price_cents, active)
values
  ('individual_monthly_v2', 'Individual mensal', 'solo', 'monthly', null, 15, 3, 5000, 7500, null, true),
  ('team_4_monthly_v2', 'Equipe até 4', 'team', 'monthly', 4, 15, 3, 10000, 13000, null, true)
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

create or replace function public.start_grafiflow_trial(p_workspace_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select public.start_grafiflow_plan_trial(p_workspace_id, 'individual_monthly_v2');
$$;
revoke all on function public.start_grafiflow_trial(uuid) from public, anon;
grant execute on function public.start_grafiflow_trial(uuid) to authenticated;

create or replace function public.complete_grafiflow_billing_action(p_event_id text,p_action text,p_subscription_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_code text; v_price integer;
begin
  if p_action='upgrade_monthly_price' then
    select s.billing_plan_code,p.standard_price_cents into v_code,v_price
      from public.workspace_subscriptions s
      join private.grafiflow_billing_plans p on p.plan_code=s.billing_plan_code
      where s.provider_subscription_id=p_subscription_id and s.paid_cycle_count>=3;
    if v_code is null then
      raise exception using errcode='P0001',message='Monthly price upgrade could not be recorded';
    end if;
    update public.workspace_subscriptions
    set billing_phase='standard',
        plan_code=case v_code
          when 'individual_monthly_v2' then 'monthly_75'
          when 'team_4_monthly_v2' then 'team_4_monthly_standard'
          when 'team_4_monthly' then 'team_4_monthly_standard'
          when 'team_unlimited_monthly' then 'team_unlimited_monthly_standard'
          else 'monthly_50'
        end,
        updated_at=now()
    where provider_subscription_id=p_subscription_id;
    update public.workspace_billing_periods
    set amount_cents=v_price,updated_at=now()
    where workspace_id=(select workspace_id from public.workspace_subscriptions where provider_subscription_id=p_subscription_id)
      and plan_type='monthly' and status='pending';
  elsif p_action='delete_subscription' then
    update public.workspace_subscriptions
    set provider_subscription_id=null,scheduled_provider_subscription_id=null,updated_at=now()
    where provider_subscription_id=p_subscription_id or scheduled_provider_subscription_id=p_subscription_id;
  else
    raise exception using errcode='22023',message='Unsupported billing action';
  end if;
  update public.asaas_webhook_events
  set processed_at=now(),action_required=null,action_subscription_id=null
  where provider_event_id=p_event_id;
end;
$$;
revoke all on function public.complete_grafiflow_billing_action(text,text,text) from public,anon,authenticated;
grant execute on function public.complete_grafiflow_billing_action(text,text,text) to service_role;

commit;

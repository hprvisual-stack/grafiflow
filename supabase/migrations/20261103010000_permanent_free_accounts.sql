-- Permanent free access is assigned by Supabase user ID in a private table.
-- The user's email is intentionally not stored in this public migration.

create table if not exists private.grafiflow_permanent_free_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  reason text not null default 'Permanent free account exemption'
);
revoke all on table private.grafiflow_permanent_free_accounts from public, anon, authenticated, service_role;

create or replace function private.grafiflow_is_permanent_free_account()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.grafiflow_permanent_free_accounts as exemption
    join auth.users as user_row on user_row.id = exemption.user_id
    where user_row.id = (select auth.uid())
      and coalesce(user_row.email_confirmed_at, user_row.confirmed_at) is not null
  );
$$;
revoke all on function private.grafiflow_is_permanent_free_account() from public, anon;
grant execute on function private.grafiflow_is_permanent_free_account() to authenticated;

create or replace function public.is_grafiflow_permanent_free_account(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.grafiflow_permanent_free_accounts as exemption
    join auth.users as user_row on user_row.id = exemption.user_id
    where user_row.id = p_user_id
      and coalesce(user_row.email_confirmed_at, user_row.confirmed_at) is not null
  );
$$;
revoke all on function public.is_grafiflow_permanent_free_account(uuid) from public, anon, authenticated;
grant execute on function public.is_grafiflow_permanent_free_account(uuid) to service_role;

create or replace function private.grafiflow_billing_access_allowed(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members as member_row
    where member_row.workspace_id = p_workspace_id
      and member_row.user_id = (select auth.uid())
      and (
        not coalesce((select enforcement_enabled from private.grafiflow_billing_settings where singleton), false)
        or private.grafiflow_is_permanent_free_account()
        or exists (
          select 1
          from public.workspace_subscriptions as subscription_row
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

do $$
begin
  if to_regprocedure('public.get_grafiflow_entitlement_before_permanent_free(uuid)') is null then
    alter function public.get_grafiflow_entitlement(uuid)
      rename to get_grafiflow_entitlement_before_permanent_free;
  end if;
end;
$$;
revoke all on function public.get_grafiflow_entitlement_before_permanent_free(uuid) from public, anon, authenticated;

create or replace function public.get_grafiflow_entitlement(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entitlement jsonb;
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(p_workspace_id) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;

  v_entitlement := public.get_grafiflow_entitlement_before_permanent_free(p_workspace_id);
  if private.grafiflow_is_permanent_free_account() then
    return coalesce(v_entitlement, '{}'::jsonb) || jsonb_build_object(
      'state', 'legacy_access',
      'access_allowed', true,
      'legacy_access', true,
      'permanent_free', true,
      'plan_type', 'legacy',
      'pending_plan_type', null,
      'pending_plan_effective_at', null
    );
  end if;
  return v_entitlement;
end;
$$;
revoke all on function public.get_grafiflow_entitlement(uuid) from public, anon;
grant execute on function public.get_grafiflow_entitlement(uuid) to authenticated;

do $$
begin
  if to_regprocedure('public.start_grafiflow_trial_before_permanent_free(uuid)') is null then
    alter function public.start_grafiflow_trial(uuid)
      rename to start_grafiflow_trial_before_permanent_free;
  end if;
end;
$$;
revoke all on function public.start_grafiflow_trial_before_permanent_free(uuid) from public, anon, authenticated;

create or replace function public.start_grafiflow_trial(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'workspace owner access required' using errcode = '42501';
  end if;
  if private.grafiflow_is_permanent_free_account() then
    return public.get_grafiflow_entitlement(p_workspace_id);
  end if;
  return public.start_grafiflow_trial_before_permanent_free(p_workspace_id);
end;
$$;
revoke all on function public.start_grafiflow_trial(uuid) from public, anon;
grant execute on function public.start_grafiflow_trial(uuid) to authenticated;

insert into private.grafiflow_billing_migration_markers (marker)
values ('20261103010000_permanent_free_accounts')
on conflict (marker) do nothing;

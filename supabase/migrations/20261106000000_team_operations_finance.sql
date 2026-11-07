-- Team access uses operator PINs on the server; monthly/annual billing remains separate.
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

alter table public.workspace_subscriptions
  add column if not exists product_tier text not null default 'solo';
alter table public.workspace_subscriptions drop constraint if exists workspace_subscriptions_product_tier_check;
alter table public.workspace_subscriptions add constraint workspace_subscriptions_product_tier_check
  check (product_tier in ('solo', 'team'));

alter table public.grafiflow_records
  add column if not exists owner_operator_id uuid,
  add column if not exists is_shared boolean not null default false;
alter table public.grafiflow_records drop constraint if exists grafiflow_records_record_type_check;
alter table public.grafiflow_records add constraint grafiflow_records_record_type_check
  check (record_type in ('draft','material','quote','customer','catalog_finish','catalog_supply','catalog_labor','catalog_extra','purchase','team_task'));
create index if not exists grafiflow_records_owner_type_idx
  on public.grafiflow_records(workspace_id, owner_operator_id, record_type, updated_at desc);
create index if not exists grafiflow_records_shared_catalog_idx
  on public.grafiflow_records(workspace_id, record_type, is_shared)
  where is_shared and record_type in ('material','catalog_finish','catalog_supply','catalog_labor','catalog_extra');

create table if not exists private.grafiflow_dev_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  reason text not null default 'MetriFlow development account',
  created_at timestamptz not null default now()
);
revoke all on table private.grafiflow_dev_accounts from public, anon, authenticated, service_role;

-- Provision DEV accounts out-of-band with their Auth UUID; never commit personal emails.
-- Treat the sole permanent-free account as the authorized DEV account; fail closed
-- (skip seeding) if there are zero or multiple exemptions. Preview has no production rows.
do $$
declare
  v_permanent_free_count integer;
begin
  select count(*) into v_permanent_free_count
  from private.grafiflow_permanent_free_accounts;

  if v_permanent_free_count = 1 then
    insert into private.grafiflow_dev_accounts(user_id, enabled, reason)
    select user_id, true, 'Authorized MetriFlow development account'
    from private.grafiflow_permanent_free_accounts
    on conflict (user_id) do update
      set enabled = true, reason = excluded.reason;
  end if;
end;
$$;

-- DEV accounts bypass subscription enforcement for their own workspace memberships.
create or replace function private.grafiflow_billing_access_allowed(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = (select auth.uid())
      and (
        not coalesce((select enforcement_enabled from private.grafiflow_billing_settings where singleton), false)
        or private.grafiflow_is_permanent_free_account()
        or exists (select 1 from private.grafiflow_dev_accounts d where d.user_id = (select auth.uid()) and d.enabled)
        or exists (
          select 1 from public.workspace_subscriptions s where s.workspace_id = m.workspace_id
            and (s.legacy_access or (s.trial_status = 'active' and s.trial_ends_at > now())
              or s.current_period_end > now() or s.current_period_end + interval '240 hours' > now())
        )
      )
  );
$$;
revoke all on function private.grafiflow_billing_access_allowed(uuid) from public, anon;
grant execute on function private.grafiflow_billing_access_allowed(uuid) to authenticated;

create table if not exists private.grafiflow_team_operators (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 120),
  role text not null check (role in ('admin','operator')),
  pin_hash text,
  active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index if not exists grafiflow_team_operators_workspace_idx
  on private.grafiflow_team_operators(workspace_id, active, role);
revoke all on table private.grafiflow_team_operators from public, anon, authenticated, service_role;

create table if not exists private.grafiflow_team_pin_attempts (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  failed_count integer not null default 0 check (failed_count >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, auth_user_id)
);
revoke all on table private.grafiflow_team_pin_attempts from public, anon, authenticated, service_role;

create table if not exists private.grafiflow_team_sessions (
  token_hash bytea primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  operator_id uuid not null references private.grafiflow_team_operators(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists grafiflow_team_sessions_expiry_idx on private.grafiflow_team_sessions(expires_at);
revoke all on table private.grafiflow_team_sessions from public, anon, authenticated, service_role;

create or replace function private.grafiflow_team_enabled(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_subscriptions s where s.workspace_id = p_workspace_id and s.product_tier = 'team')
    or exists (select 1 from private.grafiflow_dev_accounts d where d.user_id = (select auth.uid()) and d.enabled);
$$;
revoke all on function private.grafiflow_team_enabled(uuid) from public, anon, authenticated;

create or replace function private.grafiflow_operator_for_token(p_workspace_id uuid, p_token text)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.operator_id
  from private.grafiflow_team_sessions s
  join private.grafiflow_team_operators o on o.id = s.operator_id and o.workspace_id = s.workspace_id
  where s.workspace_id = p_workspace_id and s.auth_user_id = (select auth.uid())
    and s.expires_at > now() and o.active
    and public.is_grafiflow_workspace_member(p_workspace_id)
    and private.grafiflow_billing_access_allowed(p_workspace_id)
    and s.token_hash = extensions.digest(convert_to(coalesce(p_token, ''), 'UTF8'), 'sha256')
  limit 1;
$$;
revoke all on function private.grafiflow_operator_for_token(uuid, text) from public, anon, authenticated;

create or replace function private.grafiflow_operator_is_admin(p_workspace_id uuid, p_operator_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.grafiflow_team_operators o
    where o.workspace_id = p_workspace_id and o.id = p_operator_id and o.role = 'admin' and o.active);
$$;
revoke all on function private.grafiflow_operator_is_admin(uuid, uuid) from public, anon, authenticated;

create or replace function public.team_get_context(p_workspace_id uuid, p_operator_session_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_enabled boolean; v_operator_id uuid; v_operator private.grafiflow_team_operators%rowtype; v_has_admin boolean;
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(p_workspace_id) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  v_enabled := private.grafiflow_team_enabled(p_workspace_id);
  if not v_enabled then return jsonb_build_object('team_enabled', false, 'dev_account', false, 'setup_required', false); end if;
  v_operator_id := private.grafiflow_operator_for_token(p_workspace_id, p_operator_session_token);
  select * into v_operator from private.grafiflow_team_operators where id = v_operator_id;
  select exists (select 1 from private.grafiflow_team_operators o
    where o.workspace_id = p_workspace_id and o.role = 'admin' and o.active and o.pin_hash is not null) into v_has_admin;
  return jsonb_build_object(
    'team_enabled', true,
    'dev_account', exists (select 1 from private.grafiflow_dev_accounts d where d.user_id = auth.uid() and d.enabled),
    'setup_required', not v_has_admin,
    'authenticated', v_operator_id is not null,
    'operator_id', case when v_operator_id is null then null else v_operator.id end,
    'operator_name', case when v_operator_id is null then null else v_operator.display_name end,
    'operator_role', case when v_operator_id is null then null else v_operator.role end,
    'is_admin', coalesce(v_operator.role = 'admin', false)
  );
end;
$$;
revoke all on function public.team_get_context(uuid, text) from public, anon;
grant execute on function public.team_get_context(uuid, text) to authenticated;

create or replace function public.team_initialize_admin_pin(p_workspace_id uuid, p_display_name text, p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_operator_id uuid;
begin
  if auth.uid() is null or not exists (select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = auth.uid() and m.role in ('owner','admin'))
    or not private.grafiflow_team_enabled(p_workspace_id) then
    raise exception 'team owner access required' using errcode = '42501';
  end if;
  if p_display_name is null or char_length(trim(p_display_name)) not between 1 and 120 or p_pin !~ '^[0-9]{6,12}$' then
    raise exception 'provide a name and a 6-12 digit PIN' using errcode = '22023';
  end if;
  perform 1 from public.workspaces w where w.id = p_workspace_id for update;
  if exists (select 1 from private.grafiflow_team_operators o where o.workspace_id = p_workspace_id and o.role = 'admin' and o.pin_hash is not null) then
    raise exception 'administrator PIN is already initialized' using errcode = '23505';
  end if;
  insert into private.grafiflow_team_operators(workspace_id, display_name, role, pin_hash, created_by)
  values (p_workspace_id, trim(p_display_name), 'admin', extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), auth.uid())
  returning id into v_operator_id;
  -- Existing company data belongs to the initial DEV/owner administrator.
  update public.grafiflow_records r set owner_operator_id = v_operator_id
  where r.workspace_id = p_workspace_id and r.owner_operator_id is null
    and r.record_type in ('quote','material','catalog_finish','catalog_supply','catalog_labor','catalog_extra','purchase','team_task');
  return jsonb_build_object('created', true, 'operator_id', v_operator_id);
end;
$$;
revoke all on function public.team_initialize_admin_pin(uuid, text, text) from public, anon;
grant execute on function public.team_initialize_admin_pin(uuid, text, text) to authenticated;

create or replace function public.team_authenticate_pin(p_workspace_id uuid, p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_attempt private.grafiflow_team_pin_attempts%rowtype; v_operator private.grafiflow_team_operators%rowtype;
  v_count integer; v_locked_until timestamptz; v_token text;
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(p_workspace_id)
    or not private.grafiflow_billing_access_allowed(p_workspace_id) or not private.grafiflow_team_enabled(p_workspace_id) then
    raise exception 'team access denied' using errcode = '42501';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{6,12}$' then return jsonb_build_object('authenticated', false, 'message', 'PIN inválido.'); end if;
  insert into private.grafiflow_team_pin_attempts(workspace_id, auth_user_id) values (p_workspace_id, auth.uid())
  on conflict (workspace_id, auth_user_id) do nothing;
  select * into v_attempt from private.grafiflow_team_pin_attempts a
  where a.workspace_id = p_workspace_id and a.auth_user_id = auth.uid() for update;
  if v_attempt.locked_until > now() then
    return jsonb_build_object('authenticated', false, 'locked_until', v_attempt.locked_until, 'message', 'Muitas tentativas. Aguarde 15 minutos.');
  end if;
  select * into v_operator from private.grafiflow_team_operators o
  where o.workspace_id = p_workspace_id and o.active and o.pin_hash is not null
    and extensions.crypt(p_pin, o.pin_hash) = o.pin_hash limit 1;
  if v_operator.id is null then
    v_count := case when v_attempt.locked_until is not null and v_attempt.locked_until <= now() then 1 else v_attempt.failed_count + 1 end;
    v_locked_until := case when v_count >= 5 then now() + interval '15 minutes' else null end;
    update private.grafiflow_team_pin_attempts set failed_count = v_count, locked_until = v_locked_until, updated_at = now()
      where workspace_id = p_workspace_id and auth_user_id = auth.uid();
    return jsonb_build_object('authenticated', false, 'attempts_remaining', greatest(0, 5 - v_count), 'locked_until', v_locked_until,
      'message', case when v_count >= 5 then 'PIN bloqueado por 15 minutos.' else 'PIN incorreto.' end);
  end if;
  update private.grafiflow_team_pin_attempts set failed_count = 0, locked_until = null, updated_at = now()
    where workspace_id = p_workspace_id and auth_user_id = auth.uid();
  v_token := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  insert into private.grafiflow_team_sessions(token_hash, workspace_id, operator_id, auth_user_id, expires_at)
    values (extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), p_workspace_id, v_operator.id, auth.uid(), now() + interval '12 hours');
  return jsonb_build_object('authenticated', true, 'session_token', v_token, 'expires_at', now() + interval '12 hours',
    'operator_id', v_operator.id, 'operator_name', v_operator.display_name, 'operator_role', v_operator.role, 'is_admin', v_operator.role = 'admin');
end;
$$;
revoke all on function public.team_authenticate_pin(uuid, text) from public, anon;
grant execute on function public.team_authenticate_pin(uuid, text) to authenticated;

create or replace function public.team_logout(p_workspace_id uuid, p_operator_session_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from private.grafiflow_team_sessions s where s.workspace_id = p_workspace_id and s.auth_user_id = auth.uid()
    and s.token_hash = extensions.digest(convert_to(coalesce(p_operator_session_token, ''), 'UTF8'), 'sha256');
  return true;
end;
$$;
revoke all on function public.team_logout(uuid, text) from public, anon;
grant execute on function public.team_logout(uuid, text) to authenticated;

create or replace function public.team_list_operator_directory(p_workspace_id uuid, p_operator_session_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_operator_id uuid;
begin
  v_operator_id := private.grafiflow_operator_for_token(p_workspace_id, p_operator_session_token);
  if not private.grafiflow_team_enabled(p_workspace_id) or v_operator_id is null then
    raise exception 'team PIN session required' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'name',o.display_name,'role',o.role,'active',o.active) order by o.display_name)
    from private.grafiflow_team_operators o where o.workspace_id = p_workspace_id and o.active), '[]'::jsonb);
end;
$$;
revoke all on function public.team_list_operator_directory(uuid, text) from public, anon;
grant execute on function public.team_list_operator_directory(uuid, text) to authenticated;

create or replace function public.team_admin_list_members(p_workspace_id uuid, p_operator_session_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_admin_id uuid;
begin
  v_admin_id := private.grafiflow_operator_for_token(p_workspace_id, p_operator_session_token);
  if not private.grafiflow_team_enabled(p_workspace_id) or not private.grafiflow_operator_is_admin(p_workspace_id, v_admin_id) then
    raise exception 'team administrator access required' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.display_name, 'role', o.role, 'active', o.active, 'created_at', o.created_at) order by o.created_at)
    from private.grafiflow_team_operators o where o.workspace_id = p_workspace_id), '[]'::jsonb);
end;
$$;
revoke all on function public.team_admin_list_members(uuid, text) from public, anon;
grant execute on function public.team_admin_list_members(uuid, text) to authenticated;

create or replace function public.team_admin_save_member(
  p_workspace_id uuid, p_operator_session_token text, p_operator_id uuid,
  p_name text, p_pin text, p_role text default 'operator'
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_admin_id uuid; v_id uuid;
begin
  v_admin_id := private.grafiflow_operator_for_token(p_workspace_id, p_operator_session_token);
  if not private.grafiflow_team_enabled(p_workspace_id) or not private.grafiflow_operator_is_admin(p_workspace_id, v_admin_id) then
    raise exception 'team administrator access required' using errcode = '42501';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 120 or p_pin !~ '^[0-9]{6,12}$' or p_role not in ('admin','operator') then
    raise exception 'invalid member name, PIN or role' using errcode = '22023';
  end if;
  if exists (select 1 from private.grafiflow_team_operators o where o.workspace_id = p_workspace_id and o.id is distinct from p_operator_id
    and o.active and o.pin_hash is not null and extensions.crypt(p_pin, o.pin_hash) = o.pin_hash) then
    raise exception 'PIN already in use' using errcode = '23505';
  end if;
  if p_operator_id is null then
    insert into private.grafiflow_team_operators(workspace_id, display_name, role, pin_hash, created_by)
    values (p_workspace_id, trim(p_name), p_role, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), auth.uid()) returning id into v_id;
  else
    if p_operator_id = v_admin_id then raise exception 'another administrator must rotate this PIN' using errcode = '42501'; end if;
    update private.grafiflow_team_operators o set display_name = trim(p_name), role = p_role,
      pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), updated_at = now()
      where o.workspace_id = p_workspace_id and o.id = p_operator_id and o.active returning o.id into v_id;
    if v_id is null then raise exception 'member not found or inactive' using errcode = 'P0002'; end if;
    delete from private.grafiflow_team_sessions s where s.operator_id = p_operator_id;
    if not exists (select 1 from private.grafiflow_team_operators o where o.workspace_id = p_workspace_id and o.role = 'admin' and o.active and o.pin_hash is not null) then
      raise exception 'at least one active administrator PIN is required' using errcode = '23514';
    end if;
  end if;
  return jsonb_build_object('id', v_id, 'saved', true);
end;
$$;
revoke all on function public.team_admin_save_member(uuid, text, uuid, text, text, text) from public, anon;
grant execute on function public.team_admin_save_member(uuid, text, uuid, text, text, text) to authenticated;

create or replace function public.team_admin_set_member_active(
  p_workspace_id uuid, p_operator_session_token text, p_operator_id uuid, p_active boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_admin_id uuid;
begin
  v_admin_id := private.grafiflow_operator_for_token(p_workspace_id, p_operator_session_token);
  if not private.grafiflow_team_enabled(p_workspace_id) or not private.grafiflow_operator_is_admin(p_workspace_id, v_admin_id) then
    raise exception 'team administrator access required' using errcode = '42501';
  end if;
  if p_operator_id = v_admin_id then raise exception 'cannot deactivate the current PIN' using errcode = '42501'; end if;
  if not p_active and exists (select 1 from private.grafiflow_team_operators o where o.workspace_id = p_workspace_id and o.id = p_operator_id and o.role = 'admin')
    and (select count(*) from private.grafiflow_team_operators o where o.workspace_id = p_workspace_id and o.role = 'admin' and o.active) <= 1 then
    raise exception 'at least one active administrator PIN is required' using errcode = '23514';
  end if;
  update private.grafiflow_team_operators set active = p_active, updated_at = now()
    where workspace_id = p_workspace_id and id = p_operator_id;
  if not found then raise exception 'member not found' using errcode = 'P0002'; end if;
  if not p_active then delete from private.grafiflow_team_sessions where operator_id = p_operator_id; end if;
  return true;
end;
$$;
revoke all on function public.team_admin_set_member_active(uuid, text, uuid, boolean) from public, anon;
grant execute on function public.team_admin_set_member_active(uuid, text, uuid, boolean) to authenticated;

create or replace function public.team_admin_set_catalog_shared(
  p_workspace_id uuid, p_operator_session_token text, p_record_type text, p_record_id text, p_shared boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_admin_id uuid;
begin
  v_admin_id := private.grafiflow_operator_for_token(p_workspace_id, p_operator_session_token);
  if not private.grafiflow_team_enabled(p_workspace_id) or not private.grafiflow_operator_is_admin(p_workspace_id, v_admin_id) then
    raise exception 'team administrator access required' using errcode = '42501';
  end if;
  if p_record_type not in ('material','catalog_finish','catalog_supply','catalog_labor','catalog_extra') then
    raise exception 'record is not a catalog item' using errcode = '22023';
  end if;
  update public.grafiflow_records r set is_shared = p_shared, updated_at = clock_timestamp()
    where r.workspace_id = p_workspace_id and r.record_type = p_record_type and r.record_id = p_record_id and not r.is_deleted;
  if not found then raise exception 'catalog item not found' using errcode = 'P0002'; end if;
  return true;
end;
$$;
revoke all on function public.team_admin_set_catalog_shared(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.team_admin_set_catalog_shared(uuid, text, text, text, boolean) to authenticated;

create or replace function public.is_grafiflow_solo_workspace_member(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_grafiflow_workspace_member(p_workspace_id) and not private.grafiflow_team_enabled(p_workspace_id);
$$;
revoke all on function public.is_grafiflow_solo_workspace_member(uuid) from public, anon;
grant execute on function public.is_grafiflow_solo_workspace_member(uuid) to authenticated;

drop function if exists public.sync_grafiflow_records(uuid, jsonb);
create or replace function public.sync_grafiflow_records(
  target_workspace_id uuid, changes jsonb, operator_session_token text default null
)
returns setof public.grafiflow_records language plpgsql security definer set search_path = '' as $$
declare item jsonb; item_type text; item_id text; item_time timestamptz; item_base_updated_at timestamptz;
  item_has_base boolean; item_deleted boolean; item_payload jsonb; server_time timestamptz; item_rows_changed integer;
  v_team boolean; v_operator_id uuid; v_is_admin boolean; v_current_owner uuid;
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(target_workspace_id) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  v_team := private.grafiflow_team_enabled(target_workspace_id);
  if v_team then
    v_operator_id := private.grafiflow_operator_for_token(target_workspace_id, operator_session_token);
    if v_operator_id is null then raise exception 'operator PIN session required' using errcode = '42501'; end if;
    v_is_admin := private.grafiflow_operator_is_admin(target_workspace_id, v_operator_id);
  end if;
  perform 1 from public.workspaces w where w.id = target_workspace_id for update;
  if changes is null or jsonb_typeof(changes) <> 'array' or jsonb_array_length(changes) > 500 then
    raise exception 'changes must be a JSON array of at most 500 records' using errcode = '22023';
  end if;
  for item in select value from jsonb_array_elements(changes)
  loop
    item_type := item ->> 'record_type'; item_id := item ->> 'record_id';
    item_time := coalesce(nullif(item ->> 'updated_at', '')::timestamptz, now());
    item_has_base := item ? 'base_updated_at'; item_base_updated_at := nullif(item ->> 'base_updated_at', '')::timestamptz;
    item_deleted := coalesce((item ->> 'is_deleted')::boolean, false);
    item_payload := case when item_deleted then null else item -> 'payload' end; server_time := clock_timestamp();
    if item_type is null or item_type not in ('draft','material','quote','customer','catalog_finish','catalog_supply','catalog_labor','catalog_extra','purchase','team_task')
      or item_id is null or char_length(item_id) not between 1 and 200 or (not item_deleted and item_payload is null)
      or (not item_deleted and item_type = 'catalog_finish' and item_payload ->> 'catalogCategory' is distinct from 'finish')
      or (not item_deleted and item_type = 'catalog_supply' and item_payload ->> 'catalogCategory' is distinct from 'supply')
      or (not item_deleted and item_type = 'catalog_labor' and item_payload ->> 'catalogCategory' is distinct from 'labor')
      or (not item_deleted and item_type = 'catalog_extra' and item_payload ->> 'catalogCategory' is distinct from 'extra') then
      raise exception 'invalid MetriFlow record' using errcode = '22023';
    end if;
    select r.owner_operator_id into v_current_owner from public.grafiflow_records r
      where r.workspace_id = target_workspace_id and r.record_type = item_type and r.record_id = item_id;
    if v_team and item_type = 'quote' and v_current_owner is not null and v_current_owner <> v_operator_id then
      raise exception 'only the PIN that created this quote can edit it' using errcode = '42501';
    end if;
    if v_team and item_type in ('material','catalog_finish','catalog_supply','catalog_labor','catalog_extra','purchase','team_task') then
      if v_current_owner is not null and v_current_owner <> v_operator_id and not v_is_admin
        and not (item_type = 'team_task' and not item_deleted and item_payload ->> 'status' = 'done'
          and exists (select 1 from public.grafiflow_records task_row
            where task_row.workspace_id = target_workspace_id and task_row.record_type = 'team_task' and task_row.record_id = item_id
              and task_row.payload ->> 'assignedOperatorId' = v_operator_id::text
              and (task_row.payload - 'status' - 'updatedAt') = (item_payload - 'status' - 'updatedAt'))) then
        raise exception 'record edit requires its owner PIN or administrator PIN' using errcode = '42501';
      end if;
      if item_type in ('material','catalog_finish','catalog_supply','catalog_labor','catalog_extra') and exists (
        select 1 from public.grafiflow_records r where r.workspace_id = target_workspace_id and r.record_type = item_type and r.record_id = item_id and r.is_shared
      ) and not v_is_admin then raise exception 'shared catalog items can only be changed by an administrator' using errcode = '42501'; end if;
    end if;
    if v_team and item_type = 'team_task' and not item_deleted then
      if coalesce(item_payload ->> 'assignedOperatorId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        or not exists (select 1 from private.grafiflow_team_operators o where o.workspace_id = target_workspace_id
          and o.id = (item_payload ->> 'assignedOperatorId')::uuid and o.active) then
        raise exception 'task assignee must be an active team member' using errcode = '22023';
      end if;
      if not v_is_admin then item_payload := jsonb_set(item_payload, '{assignedOperatorId}', to_jsonb(v_operator_id::text), true); end if;
    end if;
    insert into public.grafiflow_records(workspace_id,record_type,record_id,payload,is_deleted,updated_at,owner_operator_id)
      values (target_workspace_id,item_type,item_id,item_payload,item_deleted,server_time,
        case when v_team and item_type in ('quote','material','catalog_finish','catalog_supply','catalog_labor','catalog_extra','purchase','team_task') then v_operator_id else null end)
    on conflict (workspace_id,record_type,record_id) do update set payload = excluded.payload, is_deleted = excluded.is_deleted,
      updated_at = server_time, owner_operator_id = coalesce(public.grafiflow_records.owner_operator_id, excluded.owner_operator_id)
    where case
      when item_has_base and item_base_updated_at is not null then public.grafiflow_records.updated_at = item_base_updated_at
      when item_has_base then public.grafiflow_records.is_deleted = excluded.is_deleted and
        (public.grafiflow_records.payload - '_syncUpdatedAt' - '_cloudVersionAt' - 'updatedAt') is not distinct from
        (excluded.payload - '_syncUpdatedAt' - '_cloudVersionAt' - 'updatedAt')
      else public.grafiflow_records.updated_at < item_time end;
    get diagnostics item_rows_changed = row_count;
    if item_rows_changed > 0 and item_type = 'material' and item_deleted then
      update public.grafiflow_records r set payload = null, is_deleted = true, updated_at = clock_timestamp()
      where r.workspace_id = target_workspace_id and r.record_id = item_id
        and r.record_type in ('catalog_finish','catalog_supply','catalog_labor','catalog_extra') and not r.is_deleted
        and (not v_team or r.owner_operator_id = v_operator_id or v_is_admin);
    end if;
  end loop;
  return query select r.* from public.grafiflow_records r where r.workspace_id = target_workspace_id and exists (
    select 1 from jsonb_array_elements(changes) c where c ->> 'record_type' = r.record_type and c ->> 'record_id' = r.record_id)
    order by r.record_type,r.record_id;
end;
$$;
revoke all on function public.sync_grafiflow_records(uuid, jsonb, text) from public, anon;
grant execute on function public.sync_grafiflow_records(uuid, jsonb, text) to authenticated;

drop function if exists public.list_grafiflow_records(uuid, bigint, integer);
create or replace function public.list_grafiflow_records(
  target_workspace_id uuid, after_change_seq bigint default 0, page_size integer default 500,
  operator_session_token text default null
)
returns setof public.grafiflow_records language plpgsql security definer set search_path = '' as $$
declare v_team boolean; v_operator_id uuid; v_is_admin boolean;
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(target_workspace_id) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  if coalesce(after_change_seq,0) < 0 or page_size is null or page_size < 1 or page_size > 1000 then
    raise exception 'invalid change cursor or page size' using errcode = '22023';
  end if;
  v_team := private.grafiflow_team_enabled(target_workspace_id);
  if v_team then
    v_operator_id := private.grafiflow_operator_for_token(target_workspace_id, operator_session_token);
    if v_operator_id is null then raise exception 'operator PIN session required' using errcode = '42501'; end if;
    v_is_admin := private.grafiflow_operator_is_admin(target_workspace_id, v_operator_id);
  end if;
  return query select r.* from public.grafiflow_records r
  where r.workspace_id = target_workspace_id and r.change_seq > coalesce(after_change_seq,0)
    and (not v_team or r.record_type in ('quote','customer')
      or (r.record_type in ('material','catalog_finish','catalog_supply','catalog_labor','catalog_extra') and (v_is_admin or r.is_shared or r.owner_operator_id = v_operator_id))
      or (r.record_type = 'purchase' and (v_is_admin or r.owner_operator_id = v_operator_id))
      or (r.record_type = 'team_task' and (v_is_admin or r.owner_operator_id = v_operator_id or r.payload ->> 'assignedOperatorId' = v_operator_id::text)))
  order by r.change_seq limit page_size;
end;
$$;
revoke all on function public.list_grafiflow_records(uuid, bigint, integer, text) from public, anon;
grant execute on function public.list_grafiflow_records(uuid, bigint, integer, text) to authenticated;

drop policy if exists "workspace members can read records" on public.grafiflow_records;
create policy "workspace members can read records" on public.grafiflow_records
  for select to authenticated using (public.is_grafiflow_solo_workspace_member(workspace_id));
revoke all on public.grafiflow_records from anon, authenticated;
grant select on public.grafiflow_records to authenticated;

do $$ begin
  if to_regprocedure('public.get_grafiflow_entitlement_before_team(uuid)') is null then
    alter function public.get_grafiflow_entitlement(uuid) rename to get_grafiflow_entitlement_before_team;
  end if;
end $$;
revoke all on function public.get_grafiflow_entitlement_before_team(uuid) from public, anon, authenticated;
create or replace function public.get_grafiflow_entitlement(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_data jsonb; v_team boolean; v_dev boolean;
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(p_workspace_id) then raise exception 'workspace access denied' using errcode = '42501'; end if;
  v_data := public.get_grafiflow_entitlement_before_team(p_workspace_id);
  v_team := private.grafiflow_team_enabled(p_workspace_id);
  v_dev := exists(select 1 from private.grafiflow_dev_accounts d where d.user_id = auth.uid() and d.enabled);
  return coalesce(v_data,'{}'::jsonb) || jsonb_build_object('product_tier',case when v_team then 'team' else 'solo' end,
    'team_enabled',v_team,'dev_account',v_dev,'dev_access',v_dev,'team_checkout_available',false) ||
    case when v_dev then jsonb_build_object('state','legacy_access','access_allowed',true,'legacy_access',true,'permanent_free',true)
      else '{}'::jsonb end;
end;
$$;
revoke all on function public.get_grafiflow_entitlement(uuid) from public, anon;
grant execute on function public.get_grafiflow_entitlement(uuid) to authenticated;

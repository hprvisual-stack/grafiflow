create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_user_id_idx on public.workspace_members(user_id);

create or replace function public.is_grafiflow_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workspace_members member_row
    where member_row.workspace_id = target_workspace_id
      and member_row.user_id = auth.uid()
  );
$$;

create or replace function public.create_grafiflow_workspace_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_workspace_id uuid;
  clean_name text;
begin
  clean_name := left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'workspace_name'), ''), nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(coalesce(new.email, 'GrafiFlow'), '@', 1) || ' — GrafiFlow'), 120);

  insert into public.profiles (id, full_name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), ''))
  on conflict (id) do nothing;

  insert into public.workspaces (name, owner_user_id)
  values (clean_name, new.id)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner')
  on conflict (workspace_id, user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_grafiflow_auth_user_created on auth.users;
create trigger on_grafiflow_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_grafiflow_workspace_for_new_user();

create table if not exists public.grafiflow_records (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  record_type text not null check (record_type in ('draft', 'material', 'quote')),
  record_id text not null check (char_length(record_id) between 1 and 200),
  payload jsonb,
  is_deleted boolean not null default false,
  updated_at timestamptz not null,
  primary key (workspace_id, record_type, record_id),
  check ((is_deleted and payload is null) or (not is_deleted and payload is not null))
);

create index if not exists grafiflow_records_workspace_updated_idx on public.grafiflow_records(workspace_id, updated_at desc);

create or replace function public.sync_grafiflow_records(target_workspace_id uuid, changes jsonb)
returns setof public.grafiflow_records
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  item_type text;
  item_id text;
  item_time timestamptz;
  item_deleted boolean;
  item_payload jsonb;
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(target_workspace_id) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  if changes is null or jsonb_typeof(changes) <> 'array' then
    raise exception 'changes must be a JSON array' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(changes)
  loop
    item_type := item ->> 'record_type';
    item_id := item ->> 'record_id';
    item_time := coalesce(nullif(item ->> 'updated_at', '')::timestamptz, now());
    item_deleted := coalesce((item ->> 'is_deleted')::boolean, false);
    item_payload := case when item_deleted then null else item -> 'payload' end;

    if item_type not in ('draft', 'material', 'quote') or item_id is null or char_length(item_id) > 200 or (not item_deleted and item_payload is null) then
      raise exception 'invalid GrafiFlow record' using errcode = '22023';
    end if;

    insert into public.grafiflow_records (workspace_id, record_type, record_id, payload, is_deleted, updated_at)
    values (target_workspace_id, item_type, item_id, item_payload, item_deleted, item_time)
    on conflict (workspace_id, record_type, record_id) do update
      set payload = excluded.payload,
          is_deleted = excluded.is_deleted,
          updated_at = excluded.updated_at
      where public.grafiflow_records.updated_at < excluded.updated_at;
  end loop;

  return query
    select record_row.*
    from public.grafiflow_records record_row
    where record_row.workspace_id = target_workspace_id
      and exists (
        select 1
        from jsonb_array_elements(changes) changed
        where changed ->> 'record_type' = record_row.record_type
          and changed ->> 'record_id' = record_row.record_id
      )
    order by record_row.record_type, record_row.record_id;
end;
$$;

create table if not exists public.workspace_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  plan_code text,
  status text not null default 'pending' check (status in ('pending', 'trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  provider text check (provider in ('asaas', 'stripe', 'manual')),
  provider_customer_id text,
  provider_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.grafiflow_records enable row level security;
alter table public.workspace_subscriptions enable row level security;

drop policy if exists "profile owner can read" on public.profiles;
create policy "profile owner can read" on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists "profile owner can update" on public.profiles;
create policy "profile owner can update" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "workspace members can read workspace" on public.workspaces;
create policy "workspace members can read workspace" on public.workspaces for select to authenticated using (public.is_grafiflow_workspace_member(id));
drop policy if exists "members can read workspace membership" on public.workspace_members;
create policy "members can read workspace membership" on public.workspace_members for select to authenticated using (public.is_grafiflow_workspace_member(workspace_id));

drop policy if exists "workspace members can read records" on public.grafiflow_records;
create policy "workspace members can read records" on public.grafiflow_records for select to authenticated using (public.is_grafiflow_workspace_member(workspace_id));
drop policy if exists "workspace members can read subscription" on public.workspace_subscriptions;
create policy "workspace members can read subscription" on public.workspace_subscriptions for select to authenticated using (public.is_grafiflow_workspace_member(workspace_id));

revoke all on public.grafiflow_records from anon, authenticated;
grant select on public.grafiflow_records to authenticated;
revoke all on public.workspace_subscriptions from anon, authenticated;
grant select on public.workspace_subscriptions to authenticated;
revoke all on public.profiles from anon, authenticated;
grant select, update on public.profiles to authenticated;
revoke all on public.workspaces from anon, authenticated;
grant select on public.workspaces to authenticated;
revoke all on public.workspace_members from anon, authenticated;
grant select on public.workspace_members to authenticated;
revoke all on function public.sync_grafiflow_records(uuid, jsonb) from public, anon;
grant execute on function public.sync_grafiflow_records(uuid, jsonb) to authenticated;
revoke all on function public.is_grafiflow_workspace_member(uuid) from public, anon;
grant execute on function public.is_grafiflow_workspace_member(uuid) to authenticated;
revoke all on function public.create_grafiflow_workspace_for_new_user() from public, anon, authenticated;

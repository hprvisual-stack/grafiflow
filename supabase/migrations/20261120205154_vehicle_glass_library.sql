-- Biblioteca original de referências dimensionais para aplicação de películas.
-- Esta versão registra apenas largura/altura máximas do vidro; não é um molde de corte.

create table if not exists private.vehicle_glass_contributions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by_user_id uuid not null references auth.users(id) on delete restrict,
  created_by_operator_id uuid,
  make text not null check (char_length(trim(make)) between 1 and 100),
  model text not null check (char_length(trim(model)) between 1 and 120),
  generation text not null default '' check (char_length(generation) <= 120),
  year_start smallint not null check (year_start between 1950 and 2100),
  year_end smallint not null check (year_end between year_start and 2100),
  body_style text not null default '' check (char_length(body_style) <= 80),
  trim_level text not null default '' check (char_length(trim_level) <= 120),
  glass_part text not null check (glass_part in (
    'windshield', 'rear_windshield',
    'front_left', 'front_right', 'rear_left', 'rear_right',
    'quarter_left', 'quarter_right', 'sunroof', 'other'
  )),
  width_mm numeric(10,2) not null check (width_mm > 0 and width_mm <= 10000),
  height_mm numeric(10,2) not null check (height_mm > 0 and height_mm <= 10000),
  source_type text not null check (source_type in ('own_measurement','licensed','open_license','public_reference')),
  source_label text not null check (char_length(trim(source_label)) between 1 and 180),
  source_url text check (source_url is null or (char_length(source_url) <= 500 and source_url ~* '^https?://')),
  license_name text not null default '' check (char_length(license_name) <= 180),
  rights_confirmed boolean not null check (rights_confirmed),
  rights_statement_version text not null default 'v1',
  rights_confirmed_at timestamptz not null default now(),
  record_status text not null check (record_status in ('workspace','pending_review','rejected','published')),
  review_note text not null default '' check (char_length(review_note) <= 500),
  reviewed_by_user_id uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (year_start <= year_end),
  check (source_type not in ('licensed','open_license') or char_length(trim(license_name)) > 0),
  check (source_type <> 'public_reference' or source_url is not null)
);

create index if not exists vehicle_glass_contributions_workspace_idx
  on private.vehicle_glass_contributions (workspace_id, make, model, year_start, glass_part);
create index if not exists vehicle_glass_contributions_review_idx
  on private.vehicle_glass_contributions (record_status, created_at)
  where record_status = 'pending_review';

create table if not exists public.vehicle_glass_library (
  id uuid primary key default gen_random_uuid(),
  source_contribution_id uuid unique references private.vehicle_glass_contributions(id) on delete set null,
  make text not null check (char_length(trim(make)) between 1 and 100),
  model text not null check (char_length(trim(model)) between 1 and 120),
  generation text not null default '' check (char_length(generation) <= 120),
  year_start smallint not null check (year_start between 1950 and 2100),
  year_end smallint not null check (year_end between year_start and 2100),
  body_style text not null default '' check (char_length(body_style) <= 80),
  trim_level text not null default '' check (char_length(trim_level) <= 120),
  glass_part text not null check (glass_part in (
    'windshield', 'rear_windshield',
    'front_left', 'front_right', 'rear_left', 'rear_right',
    'quarter_left', 'quarter_right', 'sunroof', 'other'
  )),
  width_mm numeric(10,2) not null check (width_mm > 0 and width_mm <= 10000),
  height_mm numeric(10,2) not null check (height_mm > 0 and height_mm <= 10000),
  source_type text not null check (source_type in ('own_measurement','licensed','open_license','public_reference')),
  source_label text not null check (char_length(trim(source_label)) between 1 and 180),
  source_url text check (source_url is null or (char_length(source_url) <= 500 and source_url ~* '^https?://')),
  license_name text not null default '' check (char_length(license_name) <= 180),
  rights_statement_version text not null default 'v1',
  rights_confirmed_at timestamptz not null default now(),
  validation_status text not null default 'published' check (validation_status = 'published'),
  validation_note text not null default '' check (char_length(validation_note) <= 500),
  validated_by uuid references auth.users(id) on delete set null,
  validated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (year_start <= year_end),
  check (source_type not in ('licensed','open_license') or char_length(trim(license_name)) > 0),
  check (source_type <> 'public_reference' or source_url is not null)
);

create index if not exists vehicle_glass_library_lookup_idx
  on public.vehicle_glass_library (lower(make), lower(model), year_start, year_end, glass_part);

alter table public.vehicle_glass_library enable row level security;
revoke all on table public.vehicle_glass_library from public, anon, authenticated;
revoke all on table private.vehicle_glass_contributions from public, anon, authenticated, service_role;

create or replace function public.can_curate_vehicle_glass()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from private.grafiflow_dev_accounts d
    where d.user_id = auth.uid() and d.enabled
  );
$$;
revoke all on function public.can_curate_vehicle_glass() from public, anon;
grant execute on function public.can_curate_vehicle_glass() to authenticated;

create or replace function public.list_vehicle_glass_records(
  p_workspace_id uuid,
  p_operator_session_token text default null,
  p_search text default null,
  p_offset integer default 0,
  p_limit integer default 200
)
returns table (
  id uuid,
  workspace_id uuid,
  make text,
  model text,
  generation text,
  year_start smallint,
  year_end smallint,
  body_style text,
  trim_level text,
  glass_part text,
  width_mm numeric,
  height_mm numeric,
  source_type text,
  source_label text,
  source_url text,
  license_name text,
  record_scope text,
  record_status text,
  created_by_operator_id uuid,
  review_note text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_team boolean;
  v_operator_id uuid;
  v_is_dev boolean;
  v_search text := nullif(trim(p_search), '');
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(p_workspace_id) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 1000000
    or p_limit is null or p_limit < 1 or p_limit > 200
    or char_length(coalesce(v_search, '')) > 100 then
    raise exception 'invalid vehicle glass search or page range' using errcode = '22023';
  end if;

  v_team := private.grafiflow_team_enabled(p_workspace_id);
  if v_team then
    v_operator_id := private.grafiflow_operator_for_token(p_workspace_id, p_operator_session_token);
    if v_operator_id is null then
      raise exception 'operator PIN session required' using errcode = '42501';
    end if;
  end if;

  v_is_dev := exists (
    select 1 from private.grafiflow_dev_accounts d
    where d.user_id = auth.uid() and d.enabled
  );

  return query
  select records.id, records.workspace_id, records.make, records.model, records.generation,
         records.year_start, records.year_end, records.body_style, records.trim_level,
         records.glass_part, records.width_mm, records.height_mm, records.source_type,
         records.source_label, records.source_url, records.license_name, records.record_scope,
         records.record_status, records.created_by_operator_id, records.review_note, records.created_at
  from (
    select c.id, null::uuid as workspace_id, c.make, c.model, c.generation,
           c.year_start, c.year_end, c.body_style, c.trim_level, c.glass_part,
           c.width_mm, c.height_mm, c.source_type, c.source_label, c.source_url,
           c.license_name, 'library'::text as record_scope, 'published'::text as record_status,
           null::uuid as created_by_operator_id, c.validation_note as review_note, c.created_at
    from public.vehicle_glass_library c
    union all
    select s.id, s.workspace_id, s.make, s.model, s.generation,
           s.year_start, s.year_end, s.body_style, s.trim_level, s.glass_part,
           s.width_mm, s.height_mm, s.source_type, s.source_label, s.source_url,
           s.license_name,
           case when v_is_dev and s.record_status = 'pending_review' then 'review'
                when s.workspace_id = p_workspace_id then 'workspace' else 'review' end as record_scope,
           s.record_status, s.created_by_operator_id, s.review_note, s.created_at
    from private.vehicle_glass_contributions s
    where (s.workspace_id = p_workspace_id and s.record_status <> 'published')
       or (v_is_dev and s.record_status = 'pending_review')
  ) records
  where v_search is null
    or lower(concat_ws(' ', records.make, records.model, records.generation, records.body_style, records.trim_level, records.glass_part)) like '%' || lower(v_search) || '%'
    or (v_search ~ '^[0-9]{4}$' and v_search::integer between records.year_start and records.year_end)
  order by lower(records.make), lower(records.model), records.year_start, records.glass_part, records.id
  limit p_limit + 1 offset p_offset;
end;
$$;

revoke all on function public.list_vehicle_glass_records(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.list_vehicle_glass_records(uuid, text, text, integer, integer) to authenticated;

create or replace function public.save_vehicle_glass_contribution(
  p_workspace_id uuid,
  p_operator_session_token text,
  p_id uuid,
  p_make text,
  p_model text,
  p_generation text,
  p_year_start smallint,
  p_year_end smallint,
  p_body_style text,
  p_trim_level text,
  p_glass_part text,
  p_width_mm numeric,
  p_height_mm numeric,
  p_source_type text,
  p_source_label text,
  p_source_url text,
  p_license_name text,
  p_submit_for_review boolean,
  p_rights_confirmed boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team boolean;
  v_operator_id uuid;
  v_is_admin boolean := false;
  v_existing private.vehicle_glass_contributions%rowtype;
  v_id uuid;
  v_status text;
  v_make text := nullif(trim(p_make), '');
  v_model text := nullif(trim(p_model), '');
  v_generation text := coalesce(trim(p_generation), '');
  v_body_style text := coalesce(trim(p_body_style), '');
  v_trim_level text := coalesce(trim(p_trim_level), '');
  v_source_type text := coalesce(p_source_type, '');
  v_source_label text := nullif(trim(p_source_label), '');
  v_source_url text := nullif(trim(p_source_url), '');
  v_license_name text := coalesce(trim(p_license_name), '');
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(p_workspace_id) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  v_team := private.grafiflow_team_enabled(p_workspace_id);
  if v_team then
    v_operator_id := private.grafiflow_operator_for_token(p_workspace_id, p_operator_session_token);
    if v_operator_id is null then raise exception 'operator PIN session required' using errcode = '42501'; end if;
    v_is_admin := private.grafiflow_operator_is_admin(p_workspace_id, v_operator_id);
  end if;

  if v_make is null or char_length(v_make) > 100 or v_model is null or char_length(v_model) > 120
    or char_length(v_generation) > 120 or char_length(v_body_style) > 80 or char_length(v_trim_level) > 120
    or p_year_start is null or p_year_end is null or p_year_start < 1950 or p_year_end > 2100 or p_year_start > p_year_end
    or p_glass_part not in ('windshield','rear_windshield','front_left','front_right','rear_left','rear_right','quarter_left','quarter_right','sunroof','other')
    or p_width_mm is null or p_height_mm is null or p_width_mm <= 0 or p_height_mm <= 0 or p_width_mm > 10000 or p_height_mm > 10000
    or v_source_type not in ('own_measurement','licensed','open_license','public_reference')
    or v_source_label is null or char_length(v_source_label) > 180 or char_length(v_license_name) > 180
    or (v_source_url is not null and (char_length(v_source_url) > 500 or v_source_url !~* '^https?://'))
    or (v_source_type in ('licensed','open_license') and char_length(v_license_name) = 0)
    or (v_source_type = 'public_reference' and v_source_url is null)
    or p_rights_confirmed is distinct from true then
    raise exception 'invalid vehicle glass record or missing data-use confirmation' using errcode = '22023';
  end if;

  v_status := case when coalesce(p_submit_for_review, false) then 'pending_review' else 'workspace' end;
  if p_id is null then
    insert into private.vehicle_glass_contributions (
      workspace_id, created_by_user_id, created_by_operator_id, make, model, generation,
      year_start, year_end, body_style, trim_level, glass_part, width_mm, height_mm,
      source_type, source_label, source_url, license_name, rights_confirmed,
      rights_statement_version, rights_confirmed_at, record_status
    ) values (
      p_workspace_id, auth.uid(), v_operator_id, v_make, v_model, v_generation,
      p_year_start, p_year_end, v_body_style, v_trim_level, p_glass_part, p_width_mm, p_height_mm,
      v_source_type, v_source_label, v_source_url, v_license_name, true, 'v1', clock_timestamp(), v_status
    ) returning id into v_id;
  else
    select s.* into v_existing from private.vehicle_glass_contributions s
    where s.id = p_id and s.workspace_id = p_workspace_id for update;
    if not found or v_existing.record_status = 'published' then
      raise exception 'vehicle glass record not found or read-only' using errcode = 'P0002';
    end if;
    if v_team then
      if v_existing.created_by_operator_id is distinct from v_operator_id and not v_is_admin then
        raise exception 'record edit requires its owner PIN or administrator PIN' using errcode = '42501';
      end if;
    elsif v_existing.created_by_user_id <> auth.uid() then
      raise exception 'record edit requires its owner account' using errcode = '42501';
    end if;
    update private.vehicle_glass_contributions set
      make = v_make, model = v_model, generation = v_generation,
      year_start = p_year_start, year_end = p_year_end, body_style = v_body_style,
      trim_level = v_trim_level, glass_part = p_glass_part, width_mm = p_width_mm,
      height_mm = p_height_mm, source_type = v_source_type, source_label = v_source_label,
      source_url = v_source_url, license_name = v_license_name, rights_confirmed = true,
      rights_statement_version = 'v1', rights_confirmed_at = clock_timestamp(),
      record_status = v_status, review_note = '', reviewed_by_user_id = null, reviewed_at = null,
      updated_at = clock_timestamp()
    where id = p_id returning id into v_id;
  end if;
  return v_id;
end;
$$;

revoke all on function public.save_vehicle_glass_contribution(uuid, text, uuid, text, text, text, smallint, smallint, text, text, text, numeric, numeric, text, text, text, text, boolean, boolean) from public, anon;
grant execute on function public.save_vehicle_glass_contribution(uuid, text, uuid, text, text, text, smallint, smallint, text, text, text, numeric, numeric, text, text, text, text, boolean, boolean) to authenticated;

create or replace function public.delete_vehicle_glass_contribution(
  p_workspace_id uuid,
  p_operator_session_token text,
  p_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team boolean;
  v_operator_id uuid;
  v_is_admin boolean := false;
  v_existing private.vehicle_glass_contributions%rowtype;
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(p_workspace_id) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  v_team := private.grafiflow_team_enabled(p_workspace_id);
  if v_team then
    v_operator_id := private.grafiflow_operator_for_token(p_workspace_id, p_operator_session_token);
    if v_operator_id is null then raise exception 'operator PIN session required' using errcode = '42501'; end if;
    v_is_admin := private.grafiflow_operator_is_admin(p_workspace_id, v_operator_id);
  end if;
  select s.* into v_existing from private.vehicle_glass_contributions s
  where s.id = p_id and s.workspace_id = p_workspace_id for update;
  if not found then raise exception 'vehicle glass record not found' using errcode = 'P0002'; end if;
  if v_team then
    if v_existing.created_by_operator_id is distinct from v_operator_id and not v_is_admin then
      raise exception 'record deletion requires its owner PIN or administrator PIN' using errcode = '42501';
    end if;
  elsif v_existing.created_by_user_id <> auth.uid() then
    raise exception 'record deletion requires its owner account' using errcode = '42501';
  end if;
  if v_existing.record_status = 'published' then raise exception 'published records are read-only' using errcode = '42501'; end if;
  delete from private.vehicle_glass_contributions where id = p_id;
  return true;
end;
$$;

revoke all on function public.delete_vehicle_glass_contribution(uuid, text, uuid) from public, anon;
grant execute on function public.delete_vehicle_glass_contribution(uuid, text, uuid) to authenticated;

create or replace function public.review_vehicle_glass_contribution(
  p_reviewer_workspace_id uuid,
  p_operator_session_token text,
  p_contribution_id uuid,
  p_approve boolean,
  p_review_note text default ''
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team boolean;
  v_operator_id uuid;
  v_submission private.vehicle_glass_contributions%rowtype;
  v_note text := coalesce(trim(p_review_note), '');
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(p_reviewer_workspace_id)
    or not exists (
      select 1 from private.grafiflow_dev_accounts d
      where d.user_id = auth.uid() and d.enabled
    ) then
    raise exception 'Metriflux developer access required' using errcode = '42501';
  end if;
  v_team := private.grafiflow_team_enabled(p_reviewer_workspace_id);
  if v_team then
    v_operator_id := private.grafiflow_operator_for_token(p_reviewer_workspace_id, p_operator_session_token);
    if v_operator_id is null or not private.grafiflow_operator_is_admin(p_reviewer_workspace_id, v_operator_id) then
      raise exception 'developer administrator PIN required' using errcode = '42501';
    end if;
  end if;
  if char_length(v_note) > 500 then raise exception 'review note is too long' using errcode = '22023'; end if;

  select s.* into v_submission from private.vehicle_glass_contributions s
  where s.id = p_contribution_id and s.record_status = 'pending_review' for update;
  if not found then raise exception 'pending contribution not found' using errcode = 'P0002'; end if;

  if coalesce(p_approve, false) then
    insert into public.vehicle_glass_library (
      source_contribution_id, make, model, generation, year_start, year_end,
      body_style, trim_level, glass_part, width_mm, height_mm, source_type,
      source_label, source_url, license_name, rights_statement_version, rights_confirmed_at,
      validation_note, validated_by, validated_at
    ) values (
      v_submission.id, v_submission.make, v_submission.model, v_submission.generation,
      v_submission.year_start, v_submission.year_end, v_submission.body_style,
      v_submission.trim_level, v_submission.glass_part, v_submission.width_mm,
      v_submission.height_mm, v_submission.source_type, v_submission.source_label,
      v_submission.source_url, v_submission.license_name, v_submission.rights_statement_version,
      v_submission.rights_confirmed_at, v_note, auth.uid(), clock_timestamp()
    ) on conflict (source_contribution_id) do nothing;
    update private.vehicle_glass_contributions set record_status = 'published', review_note = v_note,
      reviewed_by_user_id = auth.uid(), reviewed_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = p_contribution_id;
  else
    update private.vehicle_glass_contributions set record_status = 'rejected', review_note = v_note,
      reviewed_by_user_id = auth.uid(), reviewed_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = p_contribution_id;
  end if;
  return true;
end;
$$;

revoke all on function public.review_vehicle_glass_contribution(uuid, text, uuid, boolean, text) from public, anon;
grant execute on function public.review_vehicle_glass_contribution(uuid, text, uuid, boolean, text) to authenticated;

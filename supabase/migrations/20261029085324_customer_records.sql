alter table public.grafiflow_records
  drop constraint if exists grafiflow_records_record_type_check;

alter table public.grafiflow_records
  add constraint grafiflow_records_record_type_check
  check (record_type in (
    'draft', 'material', 'quote', 'customer',
    'catalog_finish', 'catalog_supply', 'catalog_labor', 'catalog_extra'
  ));

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
  item_base_updated_at timestamptz;
  item_has_base boolean;
  item_deleted boolean;
  item_payload jsonb;
  server_time timestamptz;
  item_rows_changed integer;
begin
  if auth.uid() is null or not public.is_grafiflow_workspace_member(target_workspace_id) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  perform workspace_row.id
  from public.workspaces workspace_row
  where workspace_row.id = target_workspace_id
  for update;
  if changes is null or jsonb_typeof(changes) <> 'array' then
    raise exception 'changes must be a JSON array' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(changes)
  loop
    item_type := item ->> 'record_type';
    item_id := item ->> 'record_id';
    item_time := coalesce(nullif(item ->> 'updated_at', '')::timestamptz, now());
    item_has_base := item -> 'base_updated_at' is not null;
    item_base_updated_at := nullif(item ->> 'base_updated_at', '')::timestamptz;
    item_deleted := coalesce((item ->> 'is_deleted')::boolean, false);
    item_payload := case when item_deleted then null else item -> 'payload' end;
    server_time := clock_timestamp();

    if item_type is null
      or item_type not in ('draft', 'material', 'quote', 'customer', 'catalog_finish', 'catalog_supply', 'catalog_labor', 'catalog_extra')
      or item_id is null
      or char_length(item_id) > 200
      or (not item_deleted and item_payload is null)
      or (not item_deleted and item_type = 'customer' and (
        jsonb_typeof(item_payload) is distinct from 'object'
        or item_payload ->> 'id' is distinct from item_id
        or nullif(btrim(item_payload ->> 'name'), '') is null
      ))
      or (not item_deleted and item_type = 'catalog_finish' and item_payload ->> 'catalogCategory' is distinct from 'finish')
      or (not item_deleted and item_type = 'catalog_supply' and item_payload ->> 'catalogCategory' is distinct from 'supply')
      or (not item_deleted and item_type = 'catalog_labor' and item_payload ->> 'catalogCategory' is distinct from 'labor')
      or (not item_deleted and item_type = 'catalog_extra' and item_payload ->> 'catalogCategory' is distinct from 'extra')
    then
      raise exception 'invalid GrafiFlow record' using errcode = '22023';
    end if;

    insert into public.grafiflow_records (workspace_id, record_type, record_id, payload, is_deleted, updated_at)
    values (target_workspace_id, item_type, item_id, item_payload, item_deleted, server_time)
    on conflict (workspace_id, record_type, record_id) do update
      set payload = excluded.payload,
          is_deleted = excluded.is_deleted,
          updated_at = excluded.updated_at
      where case
        when item_has_base and item_base_updated_at is not null then
          public.grafiflow_records.updated_at = item_base_updated_at
        when item_has_base then
          public.grafiflow_records.is_deleted = excluded.is_deleted
          and (public.grafiflow_records.payload - '_syncUpdatedAt' - '_cloudVersionAt' - 'updatedAt')
            is not distinct from (excluded.payload - '_syncUpdatedAt' - '_cloudVersionAt' - 'updatedAt')
        else public.grafiflow_records.updated_at < excluded.updated_at
      end;
    get diagnostics item_rows_changed = row_count;

    if item_rows_changed > 0 and item_type = 'material' and item_deleted then
      update public.grafiflow_records
      set payload = null,
          is_deleted = true,
          updated_at = clock_timestamp()
      where workspace_id = target_workspace_id
        and record_id = item_id
        and record_type in ('catalog_finish', 'catalog_supply', 'catalog_labor', 'catalog_extra')
        and not is_deleted;
    end if;
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

revoke all on function public.sync_grafiflow_records(uuid, jsonb) from public, anon;
grant execute on function public.sync_grafiflow_records(uuid, jsonb) to authenticated;

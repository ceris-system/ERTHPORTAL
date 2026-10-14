create or replace function public.rename_client_map_keys(
  source_map jsonb,
  old_client text,
  new_client text
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  map_key text;
  map_value jsonb;
  new_key text;
  renamed_map jsonb := '{}'::jsonb;
begin
  if source_map is null or jsonb_typeof(source_map) <> 'object' then
    return coalesce(source_map, '{}'::jsonb);
  end if;

  for map_key, map_value in select key, value from jsonb_each(source_map)
  loop
    new_key := case
      when lower(btrim(map_key)) = lower(btrim(old_client)) then btrim(new_client)
      else map_key
    end;
    if exists (
      select 1
      from jsonb_object_keys(renamed_map) as existing_keys(existing_key)
      where lower(existing_keys.existing_key) = lower(new_key)
    ) then
      raise exception 'A client assignment map already contains both "%" and "%". Resolve the duplicate mapping before renaming.',
        old_client, new_client;
    end if;
    renamed_map := renamed_map || jsonb_build_object(new_key, map_value);
  end loop;

  return renamed_map;
end;
$$;

revoke all on function public.rename_client_map_keys(jsonb, text, text) from public, anon, authenticated;
grant execute on function public.rename_client_map_keys(jsonb, text, text) to service_role;

create or replace function public.rename_client_globally(
  old_client text,
  new_client text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  assignment record;
  old_name text := btrim(coalesce(old_client, ''));
  new_name text := btrim(coalesce(new_client, ''));
  profiles_updated integer := 0;
  assignments_updated integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the service role can rename a client.';
  end if;
  if old_name = '' or new_name = '' or length(old_name) > 80 or length(new_name) > 80 then
    raise exception 'Client names must contain 1 to 80 characters.';
  end if;
  if lower(old_name) = lower(new_name) then
    raise exception 'Choose a different new client name.';
  end if;
  if lower(old_name) in ('admin', 'my spreadsheets') or lower(new_name) in ('admin', 'my spreadsheets') then
    raise exception 'Reserved client names cannot be renamed or used as a destination.';
  end if;

  if exists (
    select 1
    from public.dashboard_assignments a
    where exists (
      select 1 from unnest(a.client_names) as clients(client_name)
      where lower(btrim(client_name)) = lower(old_name)
    )
    and exists (
      select 1 from unnest(a.client_names) as clients(client_name)
      where lower(btrim(client_name)) = lower(new_name)
    )
  ) then
    raise exception 'At least one dashboard assignment already includes both client names. Resolve that assignment before renaming.';
  end if;
  if exists (
    select 1
    from public.profiles p
    where exists (
      select 1 from unnest(p.client_names) as clients(client_name)
      where lower(btrim(client_name)) = lower(old_name)
    )
    and exists (
      select 1 from unnest(p.client_names) as clients(client_name)
      where lower(btrim(client_name)) = lower(new_name)
    )
  ) then
    raise exception 'At least one account already includes both client names. Resolve that account scope before renaming.';
  end if;

  update public.profiles p
  set client_name = case
        when lower(btrim(p.client_name)) = lower(old_name) then new_name
        else p.client_name
      end,
      client_names = array(
        select case when lower(btrim(client_name)) = lower(old_name) then new_name else client_name end
        from unnest(p.client_names) with ordinality as clients(client_name, ordinal)
        order by ordinal
      )
  where lower(btrim(p.client_name)) = lower(old_name)
     or exists (
       select 1 from unnest(p.client_names) as clients(client_name)
       where lower(btrim(client_name)) = lower(old_name)
     );
  get diagnostics profiles_updated = row_count;

  for assignment in
    select *
    from public.dashboard_assignments a
    where exists (
      select 1 from unnest(a.client_names) as clients(client_name)
      where lower(btrim(client_name)) = lower(old_name)
    )
       or exists (
         select 1 from jsonb_each_text(a.client_sheet_urls) entry
         where lower(btrim(entry.key)) = lower(old_name)
       )
       or exists (
         select 1 from jsonb_each_text(a.client_sheet_tabs) entry
         where lower(btrim(entry.key)) = lower(old_name)
       )
       or exists (
         select 1 from jsonb_each(a.client_buffer_detail_tabs) entry
         where lower(btrim(entry.key)) = lower(old_name)
       )
       or exists (
         select 1 from jsonb_each_text(a.client_vcode_source_urls) entry
         where lower(btrim(entry.key)) = lower(old_name)
       )
       or exists (
         select 1 from jsonb_each_text(a.client_vcode_source_tabs) entry
         where lower(btrim(entry.key)) = lower(old_name)
       )
       or exists (
         select 1 from jsonb_each_text(a.client_vcode_deleted_tabs) entry
         where lower(btrim(entry.key)) = lower(old_name)
       )
       or exists (
         select 1 from jsonb_each_text(a.client_deactivation_mika_tabs) entry
         where lower(btrim(entry.key)) = lower(old_name)
       )
  loop
    update public.dashboard_assignments
    set client_names = array(
          select case when lower(btrim(client_name)) = lower(old_name) then new_name else client_name end
      from unnest(assignment.client_names) with ordinality as clients(client_name, ordinal)
      order by ordinal
        ),
        client_sheet_urls = public.rename_client_map_keys(assignment.client_sheet_urls, old_name, new_name),
        client_sheet_tabs = public.rename_client_map_keys(assignment.client_sheet_tabs, old_name, new_name),
        client_buffer_detail_tabs = public.rename_client_map_keys(assignment.client_buffer_detail_tabs, old_name, new_name),
        client_vcode_source_urls = public.rename_client_map_keys(assignment.client_vcode_source_urls, old_name, new_name),
        client_vcode_source_tabs = public.rename_client_map_keys(assignment.client_vcode_source_tabs, old_name, new_name),
        client_vcode_deleted_tabs = public.rename_client_map_keys(assignment.client_vcode_deleted_tabs, old_name, new_name),
        client_deactivation_mika_tabs = public.rename_client_map_keys(assignment.client_deactivation_mika_tabs, old_name, new_name),
        updated_at = now()
    where user_id = assignment.user_id
      and dashboard_name = assignment.dashboard_name;
    assignments_updated := assignments_updated + 1;
  end loop;

  return jsonb_build_object(
    'oldClient', old_name,
    'newClient', new_name,
    'profilesUpdated', profiles_updated,
    'assignmentsUpdated', assignments_updated
  );
end;
$$;

revoke all on function public.rename_client_globally(text, text) from public, anon, authenticated;
grant execute on function public.rename_client_globally(text, text) to service_role;

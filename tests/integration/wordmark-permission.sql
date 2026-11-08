do $$
declare actor record; page uuid; permission_id uuid;
begin
  for actor in select distinct on (tenant_id) id,tenant_id from public.bff_members
    where enabled and role='admin' order by tenant_id,created_at,id loop
    select id into page from public.bff_menus where tenant_id=actor.tenant_id and name='BffBranding';
    if page is null then continue; end if;
    select id into permission_id from public.bff_menus where tenant_id=actor.tenant_id and parent_id=page
      and type='button' and name='System:WebsiteConfig:GenerateWordmark' and meta->>'isEnable'='true';
    if permission_id is null then raise exception 'Wordmark permission is missing or belongs to wrong page'; end if;
    if not exists(select 1 from public.bff_menus m join public.bff_menus p on p.id=m.parent_id and p.tenant_id=m.tenant_id
      where m.tenant_id=actor.tenant_id and m.name='BffAiConfiguration' and p.name='BffSystem'
        and m.meta->>'link'='https://art-si.github.io/art-supabase-pro/#/system/ai-configuration'
        and m.meta->>'isEnable'='true') then raise exception 'Central pro AI configuration entry is missing'; end if;
    if public.bff_actor_can(actor.id,'System:WebsiteConfig:Publish') and
      not public.bff_actor_can(actor.id,'System:WebsiteConfig:GenerateWordmark') then
      raise exception 'BFF administrator cannot access the wordmark action';
    end if;
  end loop;
  if has_table_privilege('authenticated','public.bff_menus','select') or
    has_function_privilege('authenticated','public.bff_actor_permissions(uuid)','execute') then
    raise exception 'Browser authorization boundary changed';
  end if;
end $$;
select 'BFF wordmark action placement, administrator access and browser boundary passed' as verification;

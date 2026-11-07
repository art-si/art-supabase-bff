-- Tenant branding uses the shared pro UI but owns only BFF configuration data.
do $branding_test$
declare tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid();
  admin_a uuid:=gen_random_uuid(); admin_b uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid();
  delegated_role uuid:=gen_random_uuid(); config_a jsonb; config_b jsonb; result jsonb;
  config_page uuid:=gen_random_uuid(); edit_button uuid:=gen_random_uuid();
begin
  insert into public.bff_members(id,issuer,subject,tenant_id,role) values
    (admin_a,'urn:bff-branding-fixture',admin_a::text,tenant_a,'admin'),
    (admin_b,'urn:bff-branding-fixture',admin_b::text,tenant_b,'admin'),
    (viewer,'urn:bff-branding-fixture',viewer::text,tenant_a,'viewer');
  config_a:='{"siteName":"BFF平台","siteShortName":"BFF","siteDescription":"示例配置一",
    "logoUrl":"https://assets.example.test/mark.png","faviconUrl":"/favicon.svg",
    "watermarkEnabled":true,"watermarkContentType":"username","watermarkCustomText":""}'::jsonb;
  config_b:=config_a||'{"siteName":"BFF运维中心","siteDescription":"示例配置二",
    "watermarkContentType":"custom","watermarkCustomText":"内部使用"}'::jsonb;
  result:=public.bff_read_branding(viewer);
  if result->>'id'<>tenant_a::text or result->>'version'<>'0' or result->'config'<>'{}'::jsonb
  then raise exception 'Initial branding scope/default invalid'; end if;
  begin
    perform public.bff_write_branding(viewer,0,config_a);
    raise exception 'Ordinary member changed branding without permission';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  result:=public.bff_write_branding(admin_a,0,config_a);
  if result->>'version'<>'1' or result->'config'->>'siteName'<>'BFF平台'
  then raise exception 'First branding write failed'; end if;
  if public.bff_read_branding(admin_b)->>'version'<>'0' then
    raise exception 'Branding crossed tenant boundary'; end if;
  begin
    perform public.bff_write_branding(admin_a,0,config_b);
    raise exception 'Stale branding snapshot overwrote newer config';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  if public.bff_valid_branding(config_a||'{"serviceKey":"forged"}'::jsonb) or
    public.bff_valid_branding(config_a||'{"logoUrl":"javascript:alert(1)"}'::jsonb) or
    public.bff_valid_branding(config_a||'{"logoUrl":"https://user:pass@example.test/logo.png"}'::jsonb) or
    public.bff_valid_branding(config_a||'{"logoUrl":"//example.test/logo.png"}'::jsonb) or
    public.bff_valid_branding(config_a||'{"logoUrl":"https://assets.example.test/logo?token=secret"}'::jsonb)
  then raise exception 'Unsafe branding settings accepted'; end if;
  insert into public.bff_menus(id,tenant_id,name,type,path,component,meta,create_by,update_by) values
    (config_page,tenant_a,'BrandFixture','menu','/system/website-config','/shared/system/website-config',
      '{"title":"Branding"}'::jsonb,admin_a,admin_a);
  insert into public.bff_menus(id,tenant_id,parent_id,name,type,meta,create_by,update_by) values
    (edit_button,tenant_a,config_page,'BffBrand:Edit','button','{"title":"Edit"}'::jsonb,admin_a,admin_a);
  insert into public.bff_roles(id,tenant_id,role_code,role_name,create_by,update_by)
    values(delegated_role,tenant_a,'BRANDING_FIXTURE','Brand maintainer',admin_a,admin_a);
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by)
    select tenant_a,delegated_role,id,admin_a from public.bff_menus
    where tenant_id=tenant_a and name='BffBrand:Edit';
  insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by)
    values(tenant_a,viewer,delegated_role,admin_a);
  result:=public.bff_write_branding(viewer,1,config_b);
  if result->>'version'<>'2' or result->'config'->>'siteName'<>'BFF运维中心'
  then raise exception 'Delegated branding write failed'; end if;
  result:=public.bff_session_context(viewer);
  if result->'branding'->>'id'<>tenant_a::text or result->'branding'->'config'->>'siteName'<>'BFF运维中心' or
    jsonb_typeof(result->'permissions')<>'array' or jsonb_typeof(result->'navigation')<>'array'
  then raise exception 'Atomic session context lost branding or authorization scope'; end if;
  if exists(select 1 from public.bff_audit_events where tenant_id=tenant_a and
    resource_type='branding' and (summary ? 'config' or summary::text like '%https://%'))
  then raise exception 'Branding audit exposed configuration values'; end if;
  if has_table_privilege('anon','public.bff_platform_settings','select') or
    has_table_privilege('authenticated','public.bff_platform_settings','update') or
    has_table_privilege('service_role','public.bff_platform_settings','truncate') or
    has_function_privilege('authenticated','public.bff_write_branding(uuid,integer,jsonb)','execute')
  then raise exception 'Branding database grants failed'; end if;
end $branding_test$;

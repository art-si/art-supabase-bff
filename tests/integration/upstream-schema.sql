-- BFF-only canonical rollback fixture. The caller owns BEGIN/ROLLBACK.
do $upstream_test$
declare
  tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid();
  admin_a uuid:=gen_random_uuid(); admin_b uuid:=gen_random_uuid(); viewer_a uuid:=gen_random_uuid();
  app_a public.bff_applications; app_disabled public.bff_applications; app_foreign public.bff_applications;
  service_a uuid:=gen_random_uuid(); service_b uuid:=gen_random_uuid(); service_c uuid:=gen_random_uuid(); service_foreign uuid:=gen_random_uuid();
  page_id uuid:=gen_random_uuid(); role_id uuid:=gen_random_uuid(); result jsonb; before_count integer; header text;
begin
  if exists(select 1 from pg_class c where c.oid in ('public.bff_upstream_services'::regclass,
    'public.bff_upstream_credentials'::regclass,'public.bff_upstream_service_revisions'::regclass)
    and (not c.relrowsecurity or has_table_privilege('anon',c.oid,'select') or
      has_table_privilege('authenticated',c.oid,'insert') or has_table_privilege('service_role',c.oid,'truncate')))
  then raise exception 'Upstream table privilege or RLS boundary failed'; end if;
  if has_function_privilege('authenticated','public.bff_write_upstream(uuid,text,uuid,integer,jsonb,jsonb)','execute') or
    has_function_privilege('authenticated','public.bff_upstream_public(uuid)','execute') or
    has_function_privilege('anon','public.bff_upstream_probe_target(uuid,uuid)','execute')
  then raise exception 'Browser role can invoke upstream RPC'; end if;
  insert into public.bff_members(id,issuer,subject,tenant_id,role,display_name) values
    (admin_a,'urn:bff-upstream-test',admin_a::text,tenant_a,'admin','Upstream admin A'),
    (viewer_a,'urn:bff-upstream-test',viewer_a::text,tenant_a,'viewer','Upstream viewer A'),
    (admin_b,'urn:bff-upstream-test',admin_b::text,tenant_b,'admin','Upstream admin B');
  app_a:=public.bff_save_application(admin_a,null,null,'upstream-app-a','Upstream app A','','',true);
  app_disabled:=public.bff_save_application(admin_a,null,null,'upstream-app-disabled','Disabled app','','',false);
  app_foreign:=public.bff_save_application(admin_b,null,null,'upstream-app-b','Foreign app','','',true);
  perform public.bff_set_application_member(admin_a,app_a.id,viewer_a,true);
  insert into public.bff_menus(id,tenant_id,name,type,path,component,meta,create_by,update_by)
    values(page_id,tenant_a,'UpstreamFixturePage','menu','/upstream-fixture','/bff/upstreams/index','{"title":"Upstreams","isEnable":true}',admin_a,admin_a);
  insert into public.bff_menus(tenant_id,parent_id,name,type,meta,create_by,update_by) values
    (tenant_a,page_id,'BffUpstream:View','button','{"title":"View","isEnable":true}',admin_a,admin_a),
    (tenant_a,page_id,'BffUpstream:Add','button','{"title":"Add","isEnable":true}',admin_a,admin_a);
  insert into public.bff_roles(id,tenant_id,role_code,role_name,create_by,update_by)
    values(role_id,tenant_a,'UpstreamFixtureReader','Upstream reader',admin_a,admin_a);
  insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by) values(tenant_a,viewer_a,role_id,admin_a);
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by)
    select tenant_a,role_id,id,admin_a from public.bff_menus where tenant_id=tenant_a and parent_id=page_id;
  result:=public.bff_write_upstream(admin_a,'create',service_a,null,
    jsonb_build_object('applicationId',app_a.id,'code','supplier-a','name','供应商接口 A','description','开发连接',
      'environment','development','baseUrl','http://127.0.0.1:12345/v1','authType','none','headerName','','timeoutMs',2500),null);
  if result->>'status'<>'draft' or result->>'version'<>'1' or result->>'configVersion'<>'1' or
    result->>'credentialVersion'<>'0' or result->>'credentialConfigured'<>'false'
  then raise exception 'Initial upstream DTO is invalid'; end if;
  result:=public.bff_write_upstream(admin_a,'create',service_b,null,
    jsonb_build_object('applicationId',app_a.id,'code','supplier-b','name','供应商接口 B','environment','production',
      'baseUrl','https://partner.example.test/api','authType','bearer','headerName','Authorization','timeoutMs',5000),
    jsonb_build_object('ciphertext','encrypted-fixture-one','keyId','fixture-key','version',1));
  if result->>'credentialConfigured'<>'true' or result->>'credentialVersion'<>'1'
  then raise exception 'Encrypted credential creation failed'; end if;
  perform public.bff_write_upstream(admin_a,'create',service_c,null,
    jsonb_build_object('applicationId',app_disabled.id,'code','disabled-app','name','停用应用连接','environment','staging',
      'baseUrl','https://disabled.example.test','authType','none','timeoutMs',3000),null);
  perform public.bff_write_upstream(admin_b,'create',service_foreign,null,
    jsonb_build_object('applicationId',app_foreign.id,'code','foreign-tenant','name','外租户连接','environment','production',
      'baseUrl','https://foreign.example.test','authType','none','timeoutMs',3000),null);
  if (public.bff_read_upstreams(admin_a,'{}')->>'total')::integer<>3 or
    (public.bff_read_upstreams(viewer_a,'{}')->>'total')::integer<>2 or
    (public.bff_read_upstreams(admin_b,'{}')->>'total')::integer<>1
  then raise exception 'Tenant/application upstream visibility failed'; end if;
  result:=public.bff_read_upstreams(admin_a,jsonb_build_object('recordId',service_a));
  if result->>'total'<>'1' or result->'records'->0->>'id'<>service_a::text or
    result->'records'->0->>'applicationId'<>app_a.id::text or
    result->'records'->0->'application'->>'code'<>app_a.code
  then raise exception 'Record locator or nested application DTO is invalid'; end if;
  result:=public.bff_upstream_target(admin_a,service_a);
  if result->>'applicationId'<>app_a.id::text or result->'application'->>'name'<>app_a.name
  then raise exception 'Target DTO is missing application identity'; end if;
  if (public.bff_read_upstreams(admin_a,'{"name":"supplier-b"}')->>'total')::integer<>1
  then raise exception 'Upstream code search failed'; end if;
  result:=public.bff_read_upstreams(viewer_a,'{"current":2,"size":1,"environment":"development"}');
  if result->>'total'<>'1' or jsonb_array_length(result->'records')<>0 or
    result->'summary'->>'total'<>'1' then raise exception 'Upstream paging/filter summary failed'; end if;
  if jsonb_array_length(public.bff_upstream_options(viewer_a)->'applications')<>1 or
    jsonb_array_length(public.bff_upstream_options(admin_a)->'applications')<>2 then raise exception 'Application options crossed scope'; end if;
  if pg_catalog.strpos(public.bff_read_upstreams(admin_a,'{}')::text,'encrypted-fixture-one')>0 or
    pg_catalog.strpos(public.bff_upstream_target(admin_a,service_b)::text,'ciphertext')>0
  then raise exception 'Upstream read leaked credential material'; end if;
  begin
    perform public.bff_write_upstream(viewer_a,'create',gen_random_uuid(),null,
      jsonb_build_object('applicationId',app_disabled.id,'code','wrong-app','name','Wrong app','environment','development',
        'baseUrl','https://api.example.test','authType','none','timeoutMs',1000),null);
    raise exception 'Member created upstream in unassigned application';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_upstream_target(viewer_a,service_a,'BffUpstream:Edit');
    raise exception 'View role read edit target';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_upstream_target(admin_a,service_foreign);
    raise exception 'Foreign upstream target was disclosed';
  exception when raise_exception then if sqlerrm<>'BFF_NOT_FOUND' then raise; end if; end;
  begin
    perform public.bff_write_upstream(admin_a,'create',gen_random_uuid(),null,
      jsonb_build_object('applicationId',app_a.id,'code','invalid-http','name','HTTP','environment','development',
        'baseUrl','http://api.example.test','authType','none','timeoutMs',1000),null);
    raise exception 'HTTP upstream was persisted';
  exception when check_violation then null; end;
  begin
    perform public.bff_write_upstream(admin_a,'create',gen_random_uuid(),null,
      jsonb_build_object('applicationId',app_a.id,'code','invalid-production-http','name','Production HTTP','environment','production',
        'baseUrl','http://127.0.0.1:12345','authType','none','timeoutMs',1000),null);
    raise exception 'Production loopback HTTP was persisted';
  exception when check_violation then null; end;
  begin
    perform public.bff_write_upstream(admin_a,'create',gen_random_uuid(),null,
      jsonb_build_object('applicationId',app_a.id,'code','invalid-lookalike','name','Lookalike host','environment','development',
        'baseUrl','http://localhost.evil.example','authType','none','timeoutMs',1000),null);
    raise exception 'Lookalike localhost HTTP was persisted';
  exception when check_violation then null; end;
  for header in select name from (values ('Accept'),('Accept-Encoding'),('Content-Type'),('Origin'),
    ('Referer'),('User-Agent'),('Expect'),('Proxy-Connection')) as blocked(name) loop
    begin
      perform public.bff_write_upstream(admin_a,'create',gen_random_uuid(),null,
        jsonb_build_object('applicationId',app_a.id,'code','invalid-header-'||lower(replace(header,'-','')),
          'name','Unsafe header','environment','development','baseUrl','https://api.example.test',
          'authType','api_key_header','headerName',header,'timeoutMs',1000),null);
      raise exception 'Protected transport header was persisted';
    exception when check_violation then null; end;
  end loop;
  select count(*) into before_count from public.bff_audit_events where tenant_id=tenant_a and action='upstream.update';
  begin
    perform public.bff_write_upstream(admin_a,'update',service_a,99,
      jsonb_build_object('name','Stale','baseUrl','https://api.example.test/v2','authType','none','timeoutMs',2500),null);
    raise exception 'Stale upstream edit was accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  if (select count(*) from public.bff_audit_events where tenant_id=tenant_a and action='upstream.update')<>before_count
  then raise exception 'Failed edit wrote audit event'; end if;
  result:=public.bff_write_upstream(admin_a,'update',service_a,1,
    jsonb_build_object('name','供应商接口 A 修订','description','修订连接','baseUrl','https://api.example.test/v2',
      'authType','none','headerName','','timeoutMs',2500),null);
  if result->>'version'<>'2' or result->>'configVersion'<>'2' or
    (select count(*) from public.bff_upstream_service_revisions where service_id=service_a)<>2
  then raise exception 'Configuration revision was not appended'; end if;
  begin
    update public.bff_upstream_service_revisions set name='tampered' where service_id=service_a and config_version=1;
    raise exception 'Historical revision changed';
  exception when check_violation then null; end;
  begin
    update public.bff_upstream_services set environment='production' where id=service_a;
    raise exception 'Service moved environment';
  exception when check_violation then null; end;
  begin
    perform public.bff_write_upstream(admin_a,'status',service_c,1,'{"status":"active"}',null);
    raise exception 'Disabled application service activated';
  exception when raise_exception then if sqlerrm<>'BFF_UPSTREAM_NOT_READY' then raise; end if; end;
  result:=public.bff_write_upstream(admin_a,'status',service_b,1,'{"status":"active"}',null);
  if result->>'status'<>'active' then raise exception 'Credentialed service did not activate'; end if;
  insert into public.bff_menus(tenant_id,parent_id,name,type,meta,create_by,update_by)
    values(tenant_a,page_id,'BffUpstream:Edit','button','{"title":"Edit","isEnable":true}',admin_a,admin_a);
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by)
    select tenant_a,role_id,id,admin_a from public.bff_menus where tenant_id=tenant_a and name='BffUpstream:Edit';
  begin
    perform public.bff_write_upstream(viewer_a,'update',service_b,2,
      jsonb_build_object('name','Rerouted','baseUrl','https://attacker.example.test',
        'authType','bearer','headerName','Authorization','timeoutMs',5000),null);
    raise exception 'Edit-only actor rerouted an existing secret';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  if jsonb_array_length(public.bff_upstream_references(admin_a,service_b))<>1 then raise exception 'Active service delete guard missing'; end if;
  begin
    perform public.bff_write_upstream(admin_a,'credential',service_b,2,null,'{"clear":true}');
    raise exception 'Active service credential cleared';
  exception when raise_exception then if sqlerrm<>'BFF_UPSTREAM_ACTIVE' then raise; end if; end;
  result:=public.bff_write_upstream(admin_a,'update',service_b,2,
    jsonb_build_object('name','供应商接口 B 修订','baseUrl','https://partner.example.test/api',
      'authType','bearer','headerName','Authorization','timeoutMs',4000),null);
  if result->>'credentialVersion'<>'1' or result->>'credentialConfigured'<>'true' or result->>'configVersion'<>'2'
  then raise exception 'Metadata edit lost existing credential'; end if;
  begin
    perform public.bff_write_upstream(admin_a,'credential',service_b,3,null,
      jsonb_build_object('ciphertext','encrypted-fixture-wrong','keyId','fixture-key','version',99));
    raise exception 'Wrong credential version was accepted';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_CREDENTIAL_VERSION' then raise; end if; end;
  result:=public.bff_write_upstream(admin_a,'credential',service_b,3,null,
    jsonb_build_object('ciphertext','encrypted-fixture-two','keyId','fixture-key','version',2));
  if result->>'credentialVersion'<>'2' or result->>'version'<>'4' then raise exception 'Credential rotation did not advance once'; end if;
  if not exists(select 1 from public.bff_upstream_credentials where service_id=service_b and credential_version=2 and ciphertext='encrypted-fixture-two')
  then raise exception 'Rotated encrypted credential missing'; end if;
  if (public.bff_upstream_probe_target(admin_a,service_b)->>'version')::integer<>4
  then raise exception 'Probe target version mismatch'; end if;
  result:=public.bff_record_upstream_probe(admin_a,service_b,4,
    '{"status":"reachable","code":"reachable","statusCode":200,"durationMs":12}');
  if result->>'healthStatus'<>'reachable' or result->>'lastHealthCode'<>'reachable' or result->>'stale'<>'false'
  then raise exception 'Successful probe record failed'; end if;
  result:=public.bff_record_upstream_probe(admin_a,service_b,3,
    '{"status":"failed","code":"timeout","statusCode":null,"durationMs":1000}');
  if result->>'stale'<>'true' or result->>'healthStatus'<>'reachable'
  then raise exception 'Stale probe overwrote current health'; end if;
  if not exists(select 1 from public.bff_audit_events where tenant_id=tenant_a and action='upstream.probe.stale' and resource_id=service_b)
  then raise exception 'Stale probe audit missing'; end if;
  begin
    perform public.bff_write_upstream(admin_a,'delete',service_b,4,null,null);
    raise exception 'Active upstream was deleted';
  exception when raise_exception then if sqlerrm<>'BFF_UPSTREAM_ACTIVE' then raise; end if; end;
  result:=public.bff_write_upstream(admin_a,'status',service_b,4,'{"status":"disabled"}',null);
  if jsonb_array_length(public.bff_upstream_references(admin_a,service_b))<>0 then raise exception 'Disabled service delete guard remained'; end if;
  result:=public.bff_write_upstream(admin_a,'credential',service_b,5,null,'{"clear":true}');
  if result->>'credentialVersion'<>'3' or result->>'credentialConfigured'<>'false' then raise exception 'Credential clear failed'; end if;
  begin
    perform public.bff_write_upstream(admin_a,'status',service_b,6,'{"status":"active"}',null);
    raise exception 'Missing credential service activated';
  exception when raise_exception then if sqlerrm<>'BFF_UPSTREAM_NOT_READY' then raise; end if; end;
  result:=public.bff_write_upstream(admin_a,'delete',service_b,6,null,null);
  if result->>'saved'<>'true' or (select deleted_at from public.bff_upstream_services where id=service_b) is null or
    exists(select 1 from public.bff_upstream_credentials where service_id=service_b)
  then raise exception 'Soft delete did not wipe credential'; end if;
  if (public.bff_read_upstreams(admin_a,'{}')->>'total')::integer<>2 then raise exception 'Deleted service remained visible'; end if;
  result:=public.bff_write_upstream(admin_a,'update',service_c,1,
    jsonb_build_object('name','停用应用连接','baseUrl','https://disabled.example.test',
      'authType','bearer','headerName','Authorization','timeoutMs',3000),
    jsonb_build_object('ciphertext','encrypted-fixture-change','keyId','fixture-key','version',1));
  if result->>'credentialVersion'<>'1' or result->>'credentialConfigured'<>'true'
  then raise exception 'Auth-type change did not store new encrypted credential'; end if;
  result:=public.bff_write_upstream(admin_a,'update',service_c,2,
    jsonb_build_object('name','停用应用连接','baseUrl','https://disabled.example.test',
      'authType','none','headerName','','timeoutMs',3000),null);
  if result->>'credentialVersion'<>'2' or result->>'credentialConfigured'<>'false' or
    exists(select 1 from public.bff_upstream_credentials where service_id=service_c)
  then raise exception 'Auth-type change did not clear obsolete credential once'; end if;
end $upstream_test$;

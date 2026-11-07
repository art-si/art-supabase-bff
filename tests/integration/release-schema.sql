-- BFF release/gateway transaction fixture. The scoped CLI owns BEGIN/ROLLBACK.
do $release_test$
declare
  tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid();
  admin_a uuid:=gen_random_uuid(); admin_b uuid:=gen_random_uuid(); viewer_a uuid:=gen_random_uuid();
  app_a public.bff_applications; app_b public.bff_applications;
  service_a uuid:=gen_random_uuid(); service_b uuid:=gen_random_uuid();
  interface_a uuid:=gen_random_uuid(); interface_b uuid:=gen_random_uuid(); interface_c uuid:=gen_random_uuid();
  page_id uuid:=gen_random_uuid(); role_id uuid:=gen_random_uuid();
  definition jsonb; observed jsonb; tested jsonb; result jsonb; history jsonb;
  version_one uuid; version_two uuid; version_secure uuid; request_one uuid:=gen_random_uuid();
  request_two uuid:=gen_random_uuid(); request_three uuid:=gen_random_uuid(); request_four uuid:=gen_random_uuid();
  hash_one text:=repeat('a',64); input_one text:=repeat('b',64);
begin
  if (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and c.relname ~ '^bff_[a-z_]+$')<23
  then raise exception 'Canonical BFF table inventory is incomplete'; end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relname ~ '^bff_[a-z_]+$' and
      (not c.relrowsecurity or
       has_table_privilege('anon',c.oid,'SELECT') or has_table_privilege('anon',c.oid,'INSERT') or
       has_table_privilege('anon',c.oid,'UPDATE') or has_table_privilege('anon',c.oid,'DELETE') or
       has_table_privilege('authenticated',c.oid,'SELECT') or
       has_table_privilege('authenticated',c.oid,'INSERT') or
       has_table_privilege('authenticated',c.oid,'UPDATE') or
       has_table_privilege('authenticated',c.oid,'DELETE') or
       has_table_privilege('service_role',c.oid,'TRUNCATE')))
  then raise exception 'BFF table browser privilege, RLS or service TRUNCATE boundary failed'; end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.proname ~ '^bff_[a-z_]+$' and
      (has_function_privilege('anon',p.oid,'EXECUTE') or
       has_function_privilege('authenticated',p.oid,'EXECUTE')))
  then raise exception 'BFF function executable by browser role'; end if;
  if exists(select 1 from pg_class c where c.oid in
    ('public.bff_interface_versions'::regclass,'public.bff_interface_version_upstreams'::regclass,
     'public.bff_interface_deployments'::regclass,'public.bff_interface_release_events'::regclass,
     'public.bff_interface_calls'::regclass)
    and (not c.relrowsecurity or has_table_privilege('anon',c.oid,'select') or
      has_table_privilege('authenticated',c.oid,'insert') or has_table_privilege('service_role',c.oid,'truncate')))
  then raise exception 'Release table RLS or browser grant failed'; end if;
  if has_function_privilege('authenticated',
    'public.bff_write_release(uuid,text,uuid,integer,integer,uuid,text,jsonb)','execute') or
    has_function_privilege('anon','public.bff_gateway_begin(uuid,uuid,uuid,integer,uuid,text,text)','execute') or
    has_function_privilege('authenticated',
      'public.bff_gateway_step_targets(uuid,uuid,uuid,integer,text[])','execute') or
    has_function_privilege('anon',
      'public.bff_gateway_finish(uuid,uuid,boolean,integer,integer,text,jsonb,text,jsonb,text)','execute')
  then raise exception 'Browser can invoke release or gateway RPC'; end if;
  if to_regprocedure('public.bff_gateway_finish(uuid,uuid,boolean,integer,integer,text,jsonb,text)') is not null
  then raise exception 'Legacy gateway finish without observations remains callable'; end if;
  if not public.bff_route_matches('/order-{id}','/order-123') or
    public.bff_route_matches('/order-{id}','/orders/123') or
    not public.bff_route_matches('/file.{id}','/file.123') or
    public.bff_route_matches('/file.{id}','/fileX123')
  then raise exception 'Safe partial-placeholder routing failed'; end if;
  insert into public.bff_members(id,issuer,subject,tenant_id,role,display_name) values
    (admin_a,'urn:bff-release-test',admin_a::text,tenant_a,'admin','Release admin A'),
    (viewer_a,'urn:bff-release-test',viewer_a::text,tenant_a,'viewer','Release viewer A'),
    (admin_b,'urn:bff-release-test',admin_b::text,tenant_b,'admin','Release admin B');
  app_a:=public.bff_save_application(admin_a,null,null,'release-app-a','Release app A','','',true);
  app_b:=public.bff_save_application(admin_b,null,null,'release-app-b','Release app B','','',true);
  perform public.bff_set_application_member(admin_a,app_a.id,viewer_a,true);
  insert into public.bff_menus(id,tenant_id,name,type,path,component,meta,create_by,update_by)
    values(page_id,tenant_a,'ReleaseFixturePage','menu','/release-fixture',
      '/bff/releases/index','{"title":"Release fixture","isEnable":true}',admin_a,admin_a);
  insert into public.bff_menus(tenant_id,parent_id,name,type,meta,create_by,update_by)
    values(tenant_a,page_id,'BffRelease:Rollback','button',
      '{"title":"Rollback only","isEnable":true}',admin_a,admin_a);
  insert into public.bff_roles(id,tenant_id,role_code,role_name,create_by,update_by)
    values(role_id,tenant_a,'ReleaseFixtureRollback','Rollback only',admin_a,admin_a);
  insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by)
    values(tenant_a,viewer_a,role_id,admin_a);
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by)
    select tenant_a,role_id,id,admin_a from public.bff_menus
      where tenant_id=tenant_a and parent_id=page_id and name='BffRelease:Rollback';
  perform public.bff_write_upstream(admin_a,'create',service_a,null,
    jsonb_build_object('applicationId',app_a.id,'environment','development','code','release-service-a',
      'name','Release service A','baseUrl','https://release.example.test','authType','none',
      'timeoutMs',1000),null);
  perform public.bff_write_upstream(admin_a,'status',service_a,1,'{"status":"active"}'::jsonb,null);
  definition:=jsonb_build_object('inputs','[]'::jsonb,
    'steps',jsonb_build_array(jsonb_build_object('key','load','name','Load','upstreamId',service_a,
      'configVersion',1,'method','GET','path','/orders/{id}','pathParams','[]'::jsonb,
      'query','[]'::jsonb,'body','[]'::jsonb)),
    'outputs',jsonb_build_array(jsonb_build_object('target','ok','source','literal',
      'inputKey','','stepKey','','pointer','','literalType','boolean','literalValue','true')));
  perform public.bff_write_interface(admin_a,'create',interface_a,null,
    jsonb_build_object('applicationId',app_a.id,'environment','development','code','release-orders',
      'name','Release orders','method','GET','path','/orders/{id}','definition',definition));
  tested:=jsonb_build_array(jsonb_build_object('id',service_a,'configVersion',1,'credentialVersion',0));
  observed:=jsonb_build_array(jsonb_build_object('id',service_a,'configVersion',1,
    'currentConfigVersion',1,'credentialVersion',0));
  perform public.bff_record_interface_validation(admin_a,interface_a,1,'[]'::jsonb);
  perform public.bff_record_interface_test(admin_a,interface_a,1,true,tested);
  result:=public.bff_release_prepare_snapshot(admin_a,interface_a,'publish');
  if result->'snapshot'->>'applicationId'<>app_a.id::text or
    result->>'validatedVersion'<>'1' or result->'lastTestUpstreams'<>tested or
    result->>'routeConflict'<>'false' or result->'targets'->0->>'readinessCode'<>'ready' or
    result->'targets'->0->>'baseUrl'<>'https://release.example.test'
  then raise exception 'Atomic private publish snapshot was incomplete'; end if;
  begin
    perform public.bff_release_prepare_snapshot(admin_b,interface_a,'publish');
    raise exception 'Cross tenant private snapshot accessible';
  exception when raise_exception then if sqlerrm<>'BFF_NOT_FOUND' then raise; end if; end;
  if has_function_privilege('authenticated',
    'public.bff_release_prepare_snapshot(uuid,uuid,text,uuid)','execute')
  then raise exception 'Browser can fetch private release snapshot'; end if;
  begin
    perform public.bff_write_release(admin_a,'publish',interface_a,1,0,null,'  ',observed);
    raise exception 'Blank release notes accepted';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_NOTES' then raise; end if; end;
  history:=public.bff_write_release(admin_a,'publish',interface_a,1,0,null,'First release',observed);
  version_one:=(history->'versions'->0->>'id')::uuid;
  if history->'record'->'deployment'->>'activeVersionId'<>version_one::text or
    history->'record'->'deployment'->>'version'<>'1' or
    history->>'versionsTotal'<>'1' or history->>'eventsTotal'<>'1' or
    history->'versions'->0->>'checksum' !~ '^[0-9a-f]{64}$' or
    history->'versions'->0->>'description' is null
  then raise exception 'Initial publication/history DTO invalid'; end if;
  if (select count(*) from public.bff_interface_version_upstreams where version_id=version_one)<>1
  then raise exception 'Published upstream binding missing'; end if;
  if public.bff_release_snapshot(admin_a,interface_a,null,'BffRelease:View')->>'versionId'<>version_one::text or
    jsonb_array_length(public.bff_gateway_candidates(admin_a,app_a.code,'development','GET','/orders/123'))<>1
  then raise exception 'Published snapshot/gateway candidate invalid'; end if;
  result:=public.bff_gateway_step_targets(admin_a,interface_a,version_one,1,array['load']);
  if jsonb_array_length(result)<>1 or result->0->>'stepKey'<>'load' or
    result->0->>'id'<>service_a::text or result->0->>'baseUrl'<>'https://release.example.test' or
    result->0->>'configVersion'<>'1' or result->0->>'currentConfigVersion'<>'1' or
    result->0->>'credentialVersion'<>'0' or result->0->'credential'<>'null'::jsonb
  then raise exception 'Atomic published step target returned wrong scoped metadata'; end if;
  begin
    perform public.bff_gateway_step_targets(admin_a,interface_a,version_one,1,array['load','load']);
    raise exception 'Duplicate step keys accepted';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_STEP_KEYS' then raise; end if; end;
  begin
    perform public.bff_gateway_step_targets(admin_a,interface_a,version_one,1,array['undeclared']);
    raise exception 'Undeclared step key accepted';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_STEP_KEYS' then raise; end if; end;
  begin
    perform public.bff_gateway_step_targets(viewer_a,interface_a,version_one,1,array['load']);
    raise exception 'Assigned app alone read private step target';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_write_interface(admin_a,'delete',interface_a,1,'{}'::jsonb);
    raise exception 'Published interface archived';
  exception when raise_exception then if sqlerrm<>'BFF_REFERENCED' then raise; end if; end;
  begin
    perform public.bff_write_upstream(admin_a,'status',service_a,2,'{"status":"disabled"}'::jsonb,null);
    perform public.bff_write_upstream(admin_a,'delete',service_a,3,'{}'::jsonb,null);
    raise exception 'Published upstream deleted';
  exception when raise_exception then if sqlerrm<>'BFF_REFERENCED' then raise; end if; end;
  if jsonb_array_length(public.bff_interface_references(admin_a,interface_a))<>1 or
    jsonb_array_length(public.bff_upstream_references(admin_a,service_a))<1
  then raise exception 'Release references not reported'; end if;
  begin
    perform public.bff_gateway_candidates(viewer_a,app_a.code,'development','GET','/orders/123');
    raise exception 'Assigned app alone granted invoke';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  if jsonb_array_length(public.bff_gateway_candidates(admin_b,app_b.code,'development','GET','/orders/123'))<>0
  then raise exception 'Gateway leaked another tenant'; end if;
  if public.bff_read_releases(admin_b,'{}'::jsonb)->>'total'<>'0' then
    raise exception 'Release list leaked another tenant';
  end if;
  begin
    perform public.bff_release_target(viewer_a,interface_a,'BffRelease:View');
    raise exception 'Assigned app alone granted release access';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  result:=public.bff_gateway_begin(admin_a,interface_a,version_one,1,request_one,hash_one,input_one);
  if result->>'kind'<>'started' then raise exception 'Gateway request did not start'; end if;
  result:=public.bff_gateway_begin(admin_a,interface_a,version_one,1,request_two,hash_one,input_one);
  if result->>'kind'<>'running' or result->>'requestId'<>request_one::text
  then raise exception 'Idempotency did not return running lease'; end if;
  begin
    perform public.bff_gateway_begin(admin_a,interface_a,version_one,1,request_two,hash_one,repeat('c',64));
    raise exception 'Idempotency accepted different input';
  exception when raise_exception then if sqlerrm<>'BFF_IDEMPOTENCY_CONFLICT' then raise; end if; end;
  result:=public.bff_gateway_finish(admin_a,request_one,true,200,30,null,
    jsonb_build_array(jsonb_build_object('key','load','status','passed','durationMs',30)),
    'encrypted-fixture-payload',observed);
  if result->>'stale'<>'false' then raise exception 'Gateway finish marked fresh run stale'; end if;
  result:=public.bff_gateway_begin(admin_a,interface_a,version_one,1,request_two,hash_one,input_one);
  if result->>'kind'<>'replay' or result->>'resultPayload'<>'encrypted-fixture-payload'
  then raise exception 'Encrypted replay cache not returned'; end if;
  result:=public.bff_gateway_begin(admin_a,interface_a,version_one,1,request_four,repeat('e',64),input_one);
  if result->>'kind'<>'started' then raise exception 'Completeness fixture lease failed'; end if;
  result:=public.bff_gateway_finish(admin_a,request_four,true,200,30,null,
    jsonb_build_array(jsonb_build_object('key','load','status','passed','durationMs',30)),
    'must-not-cache','[]'::jsonb);
  if result->>'stale'<>'true' or
    (select status from public.bff_interface_calls where request_id=request_four)<>'unknown'
  then raise exception 'Successful finish accepted missing target observations'; end if;
  if position('encrypted-fixture-payload' in public.bff_release_history(admin_a,interface_a)::text)>0
  then raise exception 'Release history leaked result cache'; end if;
  begin
    update public.bff_interface_versions set name='tampered' where id=version_one;
    raise exception 'Immutable version changed';
  exception when check_violation then
    if sqlerrm<>'BFF_RELEASE_HISTORY_IMMUTABLE' then raise; end if;
  end;
  perform public.bff_write_interface(admin_a,'update',interface_a,1,
    jsonb_build_object('name','Release orders v2','description','Updated','method','GET',
      'path','/orders/{id}','definition',definition));
  perform public.bff_record_interface_validation(admin_a,interface_a,2,'[]'::jsonb);
  perform public.bff_record_interface_test(admin_a,interface_a,2,true,tested);
  begin
    perform public.bff_write_release(admin_a,'publish',interface_a,2,0,null,'Stale deployment',observed);
    raise exception 'Old deployment version accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  history:=public.bff_write_release(admin_a,'publish',interface_a,2,1,null,'Second release',observed);
  version_two:=(history->'versions'->0->>'id')::uuid;
  if version_two=version_one or history->'versions'->0->>'number'<>'2' or
    history->'record'->'deployment'->>'version'<>'2'
  then raise exception 'Second publication failed'; end if;
  result:=public.bff_gateway_begin(admin_a,interface_a,version_two,2,request_three,repeat('d',64),input_one);
  if result->>'kind'<>'started' then raise exception 'Second gateway lease did not start'; end if;
  perform public.bff_write_upstream(admin_a,'update',service_a,2,
    jsonb_build_object('name','Release service A','description','Updated after publication',
      'baseUrl','https://release-v2.example.test','authType','none','headerName','',
      'timeoutMs',1000),null);
  result:=public.bff_gateway_finish(admin_a,request_three,true,200,30,null,
    jsonb_build_array(jsonb_build_object('key','load','status','passed','durationMs',30)),
    'must-not-cache',observed);
  if result->>'stale'<>'true' or
    (select status from public.bff_interface_calls where request_id=request_three)<>'unknown' or
    (select result_payload from public.bff_interface_calls where request_id=request_three) is not null
  then raise exception 'Gateway finish cached stale upstream result'; end if;
  observed:=jsonb_build_array(jsonb_build_object('id',service_a,'configVersion',1,
    'currentConfigVersion',2,'credentialVersion',0));
  result:=public.bff_release_prepare_snapshot(admin_a,interface_a,'rollback',version_one);
  if result->'targets'->0->>'configVersion'<>'1' or
    result->'targets'->0->>'currentConfigVersion'<>'2' or
    result->'targets'->0->>'baseUrl'<>'https://release.example.test' or
    result->'targets'->0->>'readinessCode'<>'ready'
  then raise exception 'Historical pin snapshot did not preserve the published revision'; end if;
  begin
    perform public.bff_write_release(admin_a,'rollback',interface_a,null,2,version_one,'Stale upstream',
      jsonb_build_array(jsonb_build_object('id',service_a,'configVersion',1,
        'currentConfigVersion',1,'credentialVersion',0)));
    raise exception 'Rollback accepted stale current upstream version';
  exception when raise_exception then if sqlerrm<>'BFF_RELEASE_UPSTREAM_CHANGED' then raise; end if; end;
  history:=public.bff_write_release(admin_a,'rollback',interface_a,null,2,version_one,'Restore first',observed);
  if history->'record'->'deployment'->>'activeVersionId'<>version_one::text or
    history->'record'->'deployment'->>'version'<>'3' or history->>'versionsTotal'<>'2'
  then raise exception 'Rollback did not point to history'; end if;
  history:=public.bff_write_release(admin_a,'disable',interface_a,null,3,null,'Pause','[]'::jsonb);
  if history->'record'->'deployment'->>'enabled'<>'false' or
    jsonb_array_length(public.bff_gateway_candidates(admin_a,app_a.code,'development','GET','/orders/123'))<>0
  then raise exception 'Disable did not close gateway'; end if;
  history:=public.bff_write_release(admin_a,'enable',interface_a,null,4,null,'Resume',observed);
  if history->'record'->'deployment'->>'enabled'<>'true' or
    history->>'eventsTotal'<>'5' then raise exception 'Reenable did not restore pointer'; end if;
  app_a:=public.bff_save_application(admin_a,app_a.id,1,app_a.code,app_a.name,'','',false);
  history:=public.bff_write_release(admin_a,'disable',interface_a,null,5,null,'Emergency stop','[]'::jsonb);
  if history->'record'->'deployment'->>'enabled'<>'false'
  then raise exception 'Disabled application blocked emergency release stop'; end if;
  app_a:=public.bff_save_application(admin_a,app_a.id,2,app_a.code,app_a.name,'','',true);
  begin
    perform public.bff_write_release(viewer_a,'enable',interface_a,null,6,null,'Unauthorized enable',observed);
    raise exception 'Rollback-only member enabled deployment';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  history:=public.bff_write_release(viewer_a,'rollback',interface_a,null,6,version_two,
    'Rollback while disabled',observed);
  if history->'record'->'deployment'->>'enabled'<>'false' or
    history->'record'->'deployment'->>'activeVersionId'<>version_two::text
  then raise exception 'Rollback reopened disabled deployment'; end if;
  perform public.bff_write_release(admin_a,'enable',interface_a,null,7,null,'Resume after app',observed);
  perform public.bff_write_interface(admin_a,'create',interface_b,null,
    jsonb_build_object('applicationId',app_a.id,'environment','development','code','release-collision',
      'name','Collision','method','GET','path','/orders/{orderNo}',
      'definition',jsonb_set(definition,'{steps,0,configVersion}','2'::jsonb)));
  perform public.bff_record_interface_validation(admin_a,interface_b,1,'[]'::jsonb);
  perform public.bff_record_interface_test(admin_a,interface_b,1,true,
    jsonb_build_array(jsonb_build_object('id',service_a,'configVersion',2,'credentialVersion',0)));
  result:=public.bff_release_prepare_snapshot(admin_a,interface_b,'publish');
  if result->>'routeConflict'<>'true' then raise exception 'Private snapshot missed route conflict'; end if;
  begin
    perform public.bff_write_release(admin_a,'publish',interface_b,1,0,null,'Collision',
      jsonb_build_array(jsonb_build_object('id',service_a,'configVersion',2,
        'currentConfigVersion',2,'credentialVersion',0)));
    raise exception 'Placeholder-shape route collision accepted';
  exception when unique_violation then null; end;
  if (public.bff_read_releases(admin_a,'{"current":1,"size":1}'::jsonb)->>'total')::integer<>2 or
    jsonb_array_length(public.bff_release_history(admin_a,interface_a,2,2,1)->'versions')<>1
  then raise exception 'Release list/history paging failed'; end if;
  perform public.bff_write_upstream(admin_a,'create',service_b,null,
    jsonb_build_object('applicationId',app_a.id,'environment','development','code','release-secure-b',
      'name','Secure release service','baseUrl','https://secure.example.test',
      'authType','bearer','headerName','Authorization','timeoutMs',1000),
    jsonb_build_object('ciphertext','fixture-only-encrypted-value','keyId','fixture-key','version',1));
  perform public.bff_write_upstream(admin_a,'status',service_b,1,'{"status":"active"}'::jsonb,null);
  perform public.bff_write_interface(admin_a,'create',interface_c,null,
    jsonb_build_object('applicationId',app_a.id,'environment','development','code','release-secure',
      'name','Secure release','method','GET','path','/secure/{id}','definition',
      jsonb_set(definition,'{steps,0,upstreamId}',to_jsonb(service_b))));
  perform public.bff_record_interface_validation(admin_a,interface_c,1,'[]'::jsonb);
  perform public.bff_record_interface_test(admin_a,interface_c,1,true,
    jsonb_build_array(jsonb_build_object('id',service_b,'configVersion',1,'credentialVersion',1)));
  history:=public.bff_write_release(admin_a,'publish',interface_c,1,0,null,'Secure metadata fixture',
    jsonb_build_array(jsonb_build_object('id',service_b,'configVersion',1,
      'currentConfigVersion',1,'credentialVersion',1)));
  version_secure:=(history->'versions'->0->>'id')::uuid;
  result:=public.bff_release_prepare_snapshot(admin_a,interface_c,'enable');
  if result->'targets'->0->>'readinessCode'<>'ready' or
    result->'targets'->0->'credential'->>'ciphertext'<>'fixture-only-encrypted-value'
  then raise exception 'Private snapshot did not return ready encrypted credential'; end if;
  result:=public.bff_gateway_step_targets(admin_a,interface_c,version_secure,1,array['load']);
  if jsonb_array_length(result)<>1 or
    result->0->'credential'->>'ciphertext'<>'fixture-only-encrypted-value' or
    result->0->'credential'->>'keyId'<>'fixture-key' or
    result->0->'credential'->>'version'<>'1'
  then raise exception 'Private encrypted credential target metadata missing'; end if;
  if pg_catalog.strpos(public.bff_gateway_public(interface_c)::text,'fixture-only-encrypted-value')>0 or
    pg_catalog.strpos(public.bff_release_history(admin_a,interface_c)::text,'fixture-only-encrypted-value')>0 or
    pg_catalog.strpos(public.bff_read_releases(admin_a,'{}'::jsonb)::text,'fixture-only-encrypted-value')>0
  then raise exception 'Private encrypted credential leaked to public release DTO'; end if;
  perform public.bff_write_upstream(admin_a,'status',service_b,2,'{"status":"disabled"}'::jsonb,null);
  result:=public.bff_release_prepare_snapshot(admin_a,interface_c,'enable');
  if result->'targets'->0->>'readinessCode'<>'inactive' or
    result->'targets'->0->'credential'<>'null'::jsonb
  then raise exception 'Inactive snapshot exposed credential or wrong readiness'; end if;
  begin
    perform public.bff_gateway_step_targets(admin_a,interface_c,version_secure,1,array['load']);
    raise exception 'Disabled upstream still returned private gateway target';
  exception when raise_exception then if sqlerrm<>'BFF_RELEASE_UPSTREAM_CHANGED' then raise; end if; end;
end $release_test$;

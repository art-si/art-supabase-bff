-- Runs inside the canonical schema validation transaction and is rolled back.
do $calls_alerts_test$
declare tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid();
  admin_a uuid:=gen_random_uuid(); admin_b uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid();
  app_a uuid:=gen_random_uuid(); app_b uuid:=gen_random_uuid(); app_c uuid:=gen_random_uuid();
  interface_a uuid:=gen_random_uuid(); interface_c uuid:=gen_random_uuid();
  version_a uuid:=gen_random_uuid(); version_c uuid:=gen_random_uuid();
  failed_request uuid:=gen_random_uuid(); success_request uuid:=gen_random_uuid(); other_request uuid:=gen_random_uuid();
  expired_request uuid:=gen_random_uuid(); old_request uuid:=gen_random_uuid();
  protected_request uuid:=gen_random_uuid(); page_id uuid:=gen_random_uuid(); fixture_role uuid:=gen_random_uuid();
  root_folder uuid:=gen_random_uuid(); nested_folder uuid:=gen_random_uuid(); nested_leaf uuid:=gen_random_uuid();
  incident_leaf uuid:=gen_random_uuid();
  rule_one uuid; rule_two uuid; rule_three uuid; tenant_b_rule uuid;
  instance_one uuid; result jsonb; payload jsonb;
  stale_version integer;
begin
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('bff_alert_rules','bff_alert_instances') and not c.relrowsecurity) or
    has_table_privilege('anon','public.bff_alert_rules','select') or
    has_table_privilege('authenticated','public.bff_alert_instances','select') or
    has_table_privilege('service_role','public.bff_alert_rules','truncate') or
    has_function_privilege('anon','public.bff_read_calls(uuid,jsonb)','execute') or
    has_function_privilege('authenticated','public.bff_alert_evaluate_batch(integer)','execute')
  then raise exception 'Calls or alerts browser/database permission failure'; end if;
  insert into public.bff_members(id,issuer,subject,tenant_id,role,display_name) values
    (admin_a,'urn:bff-observability-fixture',admin_a::text,tenant_a,'admin','Observability admin A'),
    (admin_b,'urn:bff-observability-fixture',admin_b::text,tenant_b,'admin','Observability admin B'),
    (viewer,'urn:bff-observability-fixture',viewer::text,tenant_a,'viewer','Observability viewer');
  insert into public.bff_applications(id,tenant_id,code,name,created_by,updated_by) values
    (app_a,tenant_a,'obs-app-a','Observability app A',admin_a,admin_a),
    (app_b,tenant_b,'obs-app-b','Observability app B',admin_b,admin_b),
    (app_c,tenant_a,'obs-app-c','Unassigned app C',admin_a,admin_a);
  insert into public.bff_application_members(application_id,member_id,created_by,tenant_id)
    values(app_a,viewer,admin_a,tenant_a);
  insert into public.bff_menus(id,tenant_id,name,type,path,component,meta,create_by,update_by)
    values(page_id,tenant_a,'ObservabilityFixture','menu','/observability-fixture',
      '/bff/calls/index','{"title":"Observability fixture","isEnable":true}',admin_a,admin_a);
  insert into public.bff_menus(tenant_id,parent_id,name,type,meta,create_by,update_by) values
    (tenant_a,page_id,'BffCall:View','button','{"title":"View","isEnable":true}',admin_a,admin_a);
  insert into public.bff_menus(id,tenant_id,parent_id,name,type,path,component,meta,create_by,update_by) values
    (root_folder,tenant_a,null,'ObsFixtureRoot','folder','/obs-nav','/index/index',
      '{"title":"Root","isEnable":true}',admin_a,admin_a),
    (nested_folder,tenant_a,root_folder,'ObsFixtureNested','folder','/obs-nav/alerts','/index/index',
      '{"title":"Nested","isEnable":true}',admin_a,admin_a),
    (nested_leaf,tenant_a,nested_folder,'ObsFixtureLeaf','menu','/obs-nav/alerts/rules','/bff/alerts/rules/index',
      '{"title":"Rules","isEnable":true}',admin_a,admin_a),
    (incident_leaf,tenant_a,nested_folder,'ObsFixtureIncident','menu','/obs-nav/alerts/instances','/bff/alerts/index',
      '{"title":"Incidents","isEnable":true}',admin_a,admin_a);
  insert into public.bff_menus(tenant_id,parent_id,name,type,meta,create_by,update_by) values
    (tenant_a,nested_leaf,'BffAlertRule:View','button','{"title":"View rules","isEnable":true}',admin_a,admin_a),
    (tenant_a,incident_leaf,'BffAlert:View','button','{"title":"View incidents","isEnable":true}',admin_a,admin_a);
  if (select node->>'component' from jsonb_array_elements(public.bff_navigation(admin_a)) as node
      where node->>'name'='ObsFixtureRoot')<>'/index/index' or
    (select node->>'component' from jsonb_array_elements(public.bff_navigation(admin_a)) as node
      where node->>'name'='ObsFixtureNested')<>'' or
    (select node->>'component' from jsonb_array_elements(public.bff_navigation(admin_a)) as node
      where node->>'name'='ObsFixtureLeaf')<>'/bff/alerts/rules/index'
  then raise exception 'Nested folder navigation would mount another Layout'; end if;
  insert into public.bff_roles(id,tenant_id,role_code,role_name,create_by,update_by)
    values(fixture_role,tenant_a,'OBS_FIXTURE','Observability fixture',admin_a,admin_a);
  insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by)
    values(tenant_a,viewer,fixture_role,admin_a);
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by)
    select tenant_a,fixture_role,id,admin_a from public.bff_menus where tenant_id=tenant_a and
      name in ('BffCall:View','BffAlert:View');
  insert into public.bff_interfaces(id,tenant_id,application_id,environment,code,name,method,path,definition,created_by,updated_by)
    values(interface_a,tenant_a,app_a,'development','obs-interface','Observability interface','GET','/obs/{id}',
      '{"inputs":[],"steps":[{"key":"load"}],"outputs":[{}]}'::jsonb,admin_a,admin_a),
      (interface_c,tenant_a,app_c,'development','obs-other','Unassigned interface','GET','/other/{id}',
      '{"inputs":[],"steps":[{"key":"load"}],"outputs":[{}]}'::jsonb,admin_a,admin_a);
  insert into public.bff_interface_versions(id,interface_id,tenant_id,application_id,environment,number,draft_version,
    code,name,description,method,path,definition,checksum,created_by)
    values(version_a,interface_a,tenant_a,app_a,'development',1,1,'obs-interface','Immutable version name','',
      'GET','/obs/{id}','{"inputs":[],"steps":[{"key":"load"}],"outputs":[{}]}'::jsonb,
      repeat('a',64),admin_a),
      (version_c,interface_c,tenant_a,app_c,'development',1,1,'obs-other','Unassigned version','',
      'GET','/other/{id}','{"inputs":[],"steps":[{"key":"load"}],"outputs":[{}]}'::jsonb,
      repeat('a',64),admin_a);
  insert into public.bff_interface_calls(request_id,tenant_id,application_id,environment,interface_id,version_id,
    member_id,deployment_version,method,path_template,started_at,finished_at,status,http_status,error_code,
    error_class,steps,idempotency_hash,input_hash,result_payload,result_expires_at) values
    (failed_request,tenant_a,app_a,'development',interface_a,version_a,admin_a,1,'GET','/obs/{id}',
      now()-interval '2 minutes',now()-interval '1 minute','failed',502,'UPSTREAM_FAILED','timeout',
      '[{"key":"load","status":"failed","statusCode":502,"durationMs":80,"code":"UPSTREAM_FAILED","errorClass":"timeout","url":"https://secret.test/path"}]'::jsonb,
      repeat('b',64),repeat('c',64),null,null),
    (success_request,tenant_a,app_a,'development',interface_a,version_a,admin_a,1,'GET','/obs/{id}',
      now()-interval '1 minute',now()-interval '30 seconds','succeeded',200,null,null,
      '[{"key":"load","status":"passed","durationMs":30}]'::jsonb,
      repeat('d',64),repeat('e',64),'sealed-secret-marker',now()+interval '1 minute'),
    (expired_request,tenant_a,app_a,'development',interface_a,version_a,admin_a,1,'GET','/obs/{id}',
      now()-interval '1 minute',null,'running',null,null,null,'[]'::jsonb,
      repeat('f',64),repeat('0',64),null,null),
    (other_request,tenant_a,app_c,'development',interface_c,version_c,admin_a,1,'GET','/other/{id}',
      now()-interval '30 seconds',now()-interval '20 seconds','succeeded',200,null,null,
      '[]'::jsonb,repeat('1',64),repeat('2',64),null,null);
  update public.bff_interface_calls set expires_at=now()+interval '1 hour' where request_id=expired_request;
  result:=public.bff_read_calls(viewer,'{}'::jsonb);
  if result->>'total'<>'3' or result->'summary'->>'failed'<>'1' or
    result->'records'->0->>'requestId' is null or
    result::text like '%sealed-secret-marker%' or result::text like '%https://secret.test%' or
    result::text like '%'||repeat('b',64)||'%' or result::text like '%idempotencyHash%' or
    public.bff_call_detail(viewer,failed_request)->>'versionNumber'<>'1' or
    public.bff_call_detail(viewer,failed_request)->>'interfaceName'<>'Immutable version name'
  then raise exception 'Call DTO, privacy or immutable version metadata failed'; end if;
  if public.bff_read_calls(admin_b,'{}'::jsonb)->>'total'<>'0' then raise exception 'Call read crossed tenant'; end if;
  if public.bff_read_calls(admin_a,'{}'::jsonb)->>'total'<>'4' or
    public.bff_call_options(viewer)::text like '%Unassigned app C%'
  then raise exception 'Call application scope failed'; end if;
  begin
    perform public.bff_call_detail(viewer,other_request);
    raise exception 'Unassigned application detail accessible';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_call_detail(admin_b,failed_request);
    raise exception 'Cross tenant detail accessible';
  exception when raise_exception then if sqlerrm<>'BFF_NOT_FOUND' then raise; end if; end;
  perform pg_catalog.set_config('request.headers',jsonb_build_object('x-art-tenant-scope',tenant_b)::text,true);
  if public.bff_read_calls(viewer,'{}'::jsonb)->>'total'<>'3' then raise exception 'Forged header changed call scope'; end if;
  begin
    perform public.bff_read_calls(viewer,'{"from":"2020-01-01T00:00:00Z","to":"2020-03-01T00:00:00Z"}'::jsonb);
    raise exception 'Unbounded call window accepted';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_FILTER' then raise; end if; end;
  payload:=jsonb_build_object('applicationId',app_a,'environment','development','interfaceId',interface_a,
    'name','Timeouts','metric','timeout_count','windowMinutes',5,'threshold',1,'minCalls',1,
    'severity','critical','enabled',true,'quietMinutes',60);
  result:=public.bff_write_alert_rule(admin_a,'create',null,null,payload);
  rule_one:=(result->>'id')::uuid;
  if rule_one is null or result->>'version'<>'1' then raise exception 'Rule create failed'; end if;
  begin
    perform public.bff_read_alert_rules(viewer,'{}'::jsonb);
    raise exception 'Instance View unexpectedly read alert rules';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  if public.bff_alert_options(viewer)->'applications'->0->>'id'<>app_a::text then
    raise exception 'Instance View did not get scoped alert options'; end if;
  begin
    perform public.bff_write_alert_rule(admin_a,'update',rule_one,0,payload);
    raise exception 'Stale alert rule version accepted';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_ALERT' then raise; end if; end;
  result:=public.bff_evaluate_alert_rule(admin_a,rule_one);
  instance_one:=(result->>'instanceId')::uuid;
  if result->>'opened'<>'1' or instance_one is null then raise exception 'Failed to open alert'; end if;
  result:=public.bff_evaluate_alert_rule(admin_a,rule_one);
  if result->>'opened'<>'0' or result->>'updated'<>'1' or
    (select count(*) from public.bff_alert_instances where rule_id=rule_one)<>1
  then raise exception 'Active alert dedup failed'; end if;
  result:=public.bff_acknowledge_alert(admin_a,instance_one,1);
  if result->>'state'<>'acknowledged' or result->>'version'<>'2'
  then raise exception 'Alert acknowledgement failed'; end if;
  begin
    perform public.bff_acknowledge_alert(admin_a,instance_one,1);
    raise exception 'Stale alert acknowledgement accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  result:=public.bff_write_alert_rule(admin_a,'disable',rule_one,1,'{}'::jsonb);
  if result->>'enabled'<>'false' or
    public.bff_alert_detail(admin_a,instance_one)->>'closedReason'<>'disabled' or
    public.bff_alert_detail(admin_a,instance_one)->>'state'<>'closed'
  then raise exception 'Rule disable did not close active incident'; end if;
  result:=public.bff_write_alert_rule(admin_a,'archive',rule_one,2,'{}'::jsonb);
  if result->>'archivedAt' is null or
    public.bff_read_alert_rules(admin_a,'{"archived":true}'::jsonb)->>'total'<>'1'
  then raise exception 'Rule archive lost history'; end if;
  payload:=payload||'{"name":"Unknown calls","metric":"unknown_count","quietMinutes":0}'::jsonb;
  result:=public.bff_write_alert_rule(admin_a,'create',null,null,payload);
  rule_two:=(result->>'id')::uuid;
  insert into public.bff_interface_calls(request_id,tenant_id,application_id,environment,interface_id,version_id,
    member_id,deployment_version,method,path_template,started_at,finished_at,status,http_status,
    error_code,error_class,steps,idempotency_hash,input_hash,result_payload,result_expires_at) values
    (old_request,tenant_a,app_a,'development',interface_a,version_a,admin_a,1,'GET','/obs/{id}',
      now()-interval '91 days',now()-interval '91 days','failed',502,'UPSTREAM_FAILED','timeout','[]'::jsonb,
      repeat('3',64),repeat('4',64),null,null),
    (protected_request,tenant_a,app_a,'development',interface_a,version_a,admin_a,1,'GET','/obs/{id}',
      now()-interval '91 days',now()-interval '91 days','succeeded',200,null,null,'[]'::jsonb,
      repeat('5',64),repeat('6',64),'sealed-retention-marker',now()+interval '1 minute');
  update public.bff_interface_calls set expires_at=now()-interval '1 second' where request_id=expired_request;
  result:=public.bff_alert_evaluate_batch(100);
  if (result->>'expired')::integer<1 or
    (select status from public.bff_interface_calls where request_id=expired_request)<>'unknown' or
    (select error_class from public.bff_interface_calls where request_id=expired_request)<>'unknown'
  then raise exception 'Batch did not classify expired lease'; end if;
  if exists(select 1 from public.bff_interface_calls where request_id=old_request) or
    not exists(select 1 from public.bff_interface_calls where request_id=protected_request and
      result_payload='sealed-retention-marker') or
    not exists(select 1 from public.bff_interface_calls where request_id=success_request and
      result_payload='sealed-secret-marker') or
    not exists(select 1 from public.bff_interface_calls where request_id=failed_request)
  then raise exception '90-day retention removed recent or still-replayable calls, or kept old terminal call'; end if;
  result:=public.bff_evaluate_alert_rule(admin_a,rule_two);
  if (result->>'opened')::integer+(result->>'updated')::integer<1 then raise exception 'Unknown metric failed'; end if;
  payload:=payload||'{"name":"Quiet failure","metric":"failure_count","quietMinutes":60}'::jsonb;
  result:=public.bff_write_alert_rule(admin_a,'create',null,null,payload);
  rule_three:=(result->>'id')::uuid;
  update public.bff_alert_rules set last_triggered_at=now() where id=rule_three;
  result:=public.bff_evaluate_alert_rule(admin_a,rule_three);
  if result->>'opened'<>'0' then raise exception 'Quiet period did not suppress new instance'; end if;
  insert into public.bff_alert_instances(rule_id,tenant_id,application_id,environment,interface_id,
    metric,severity,state,observed_value,known_calls,failed_calls,unknown_calls,window_started_at,window_ended_at)
    values(rule_three,tenant_a,app_a,'development',interface_a,'failure_count','critical','open',1,0,0,0,
      now()-interval '10 minutes',now()-interval '5 minutes');
  result:=public.bff_write_alert_rule(admin_a,'update',rule_three,1,payload||'{"threshold":2}'::jsonb);
  if (select count(*) from public.bff_alert_instances where rule_id=rule_three and state='closed' and closed_reason='reconfigured')<>1
  then raise exception 'Critical rule edit did not close prior incident'; end if;
  -- A prior incident whose observations have aged out must recover, preserving history.
  insert into public.bff_alert_instances(rule_id,tenant_id,application_id,environment,interface_id,
    metric,severity,state,observed_value,known_calls,failed_calls,unknown_calls,window_started_at,window_ended_at)
    values(rule_three,tenant_a,app_a,'development',interface_a,'failure_count','critical','open',2,2,2,0,
      now()-interval '10 minutes',now()-interval '5 minutes');
  update public.bff_alert_rules set threshold=999 where id=rule_three;
  result:=public.bff_evaluate_alert_rule(admin_a,rule_three);
  if result->>'recovered'<>'1' or
    (select count(*) from public.bff_alert_instances where rule_id=rule_three and state='recovered')<>1
  then raise exception 'Condition fall did not recover incident'; end if;
  insert into public.bff_alert_instances(rule_id,tenant_id,application_id,environment,interface_id,
    metric,severity,state,observed_value,known_calls,failed_calls,unknown_calls,
    window_started_at,window_ended_at,opened_at)
    values(rule_three,tenant_a,app_a,'development',interface_a,'failure_count','critical','open',1,1,1,0,
      now()-interval '32 days',now()-interval '32 days',now()-interval '32 days');
  if public.bff_read_alert_instances(admin_b,'{}'::jsonb)->>'total'<>'0' or
    public.bff_read_alert_instances(viewer,'{}'::jsonb)->>'total'<>'5'
  then raise exception 'Instance scope or history failed'; end if;
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by)
    select tenant_a,fixture_role,id,admin_a from public.bff_menus where tenant_id=tenant_a and name='BffAlertRule:View';
  if public.bff_read_alert_rules(viewer,'{}'::jsonb)->>'total'<>'2' then
    raise exception 'Rule View did not unlock rule list'; end if;
  delete from public.bff_role_menus where role_id=fixture_role and menu_id in
    (select id from public.bff_menus where tenant_id=tenant_a and name='BffAlert:View');
  begin
    perform public.bff_read_alert_instances(viewer,'{}'::jsonb);
    raise exception 'Rule View unexpectedly read alert instances';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  update public.bff_members set enabled=false where id=viewer;
  begin
    perform public.bff_read_calls(viewer,'{}'::jsonb);
    raise exception 'Revoked viewer retained call access';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  -- A tenant with 101 unevaluated rules must not occupy the whole candidate
  -- window ahead of another tenant. Advisory-lock contention needs two DB
  -- connections and is intentionally not simulated in this one transaction.
  insert into public.bff_alert_rules(tenant_id,application_id,environment,name,metric,
    window_minutes,threshold,min_calls,severity,enabled,quiet_minutes,created_by,updated_by)
    select tenant_a,app_a,'development','Saturated rule '||n,'failure_count',
      5,999,1,'warning',true,0,admin_a,admin_a from generate_series(1,101) n;
  insert into public.bff_alert_rules(tenant_id,application_id,environment,name,metric,
    window_minutes,threshold,min_calls,severity,enabled,quiet_minutes,created_by,updated_by)
    values(tenant_b,app_b,'development','Later tenant rule','failure_count',
      5,999,1,'warning',true,0,admin_b,admin_b) returning id into tenant_b_rule;
  result:=public.bff_alert_evaluate_batch(2);
  if result->>'evaluated'<>'2' or
    (select last_evaluated_at from public.bff_alert_rules where id=tenant_b_rule) is null
  then raise exception 'Saturated tenant starved a later tenant rule'; end if;
end $calls_alerts_test$;

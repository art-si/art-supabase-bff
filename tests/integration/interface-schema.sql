-- BFF-only interface draft/step binding validation. The caller owns BEGIN/ROLLBACK.
do $interface_test$
declare
  tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid();
  admin_a uuid:=gen_random_uuid(); admin_b uuid:=gen_random_uuid(); reader_a uuid:=gen_random_uuid();
  app_a public.bff_applications; app_other public.bff_applications; app_foreign public.bff_applications;
  service_a uuid:=gen_random_uuid(); service_b uuid:=gen_random_uuid();
  service_other uuid:=gen_random_uuid(); service_foreign uuid:=gen_random_uuid(); service_prod uuid:=gen_random_uuid();
  interface_a uuid:=gen_random_uuid(); interface_b uuid:=gen_random_uuid();
  interface_other uuid:=gen_random_uuid(); interface_foreign uuid:=gen_random_uuid(); interface_prod uuid:=gen_random_uuid();
  page_id uuid:=gen_random_uuid(); role_id uuid:=gen_random_uuid();
  definition_a jsonb; definition_b jsonb; metadata record; result jsonb; before_count integer;
begin
  if exists(select 1 from pg_class c where c.oid in ('public.bff_interfaces'::regclass,'public.bff_interface_upstreams'::regclass)
    and (not c.relrowsecurity or has_table_privilege('anon',c.oid,'select') or
      has_table_privilege('authenticated',c.oid,'insert') or has_table_privilege('service_role',c.oid,'truncate')))
  then raise exception 'Interface table RLS or grants are unsafe'; end if;
  if has_function_privilege('authenticated','public.bff_write_interface(uuid,text,uuid,integer,jsonb)','execute') or
    has_function_privilege('authenticated','public.bff_interface_public(uuid)','execute') or
    has_function_privilege('anon','public.bff_record_interface_test(uuid,uuid,integer,boolean,jsonb)','execute')
  then raise exception 'Browser role can call interface RPC'; end if;
  insert into public.bff_members(id,issuer,subject,tenant_id,role,display_name) values
    (admin_a,'urn:bff-interface-test',admin_a::text,tenant_a,'admin','Interface admin A'),
    (reader_a,'urn:bff-interface-test',reader_a::text,tenant_a,'viewer','Interface reader A'),
    (admin_b,'urn:bff-interface-test',admin_b::text,tenant_b,'admin','Interface admin B');
  app_a:=public.bff_save_application(admin_a,null,null,'interface-app-a','Interface app A','','',true);
  app_other:=public.bff_save_application(admin_a,null,null,'interface-app-other','Other app','','',true);
  app_foreign:=public.bff_save_application(admin_b,null,null,'interface-app-b','Foreign app','','',true);
  perform public.bff_set_application_member(admin_a,app_a.id,reader_a,true);
  for metadata in select * from (values
    (service_a,admin_a,app_a.id,'interface-service-a','https://a.example.test'),
    (service_b,admin_a,app_a.id,'interface-service-b','https://b.example.test'),
    (service_other,admin_a,app_other.id,'interface-service-other','https://other.example.test'),
    (service_foreign,admin_b,app_foreign.id,'interface-service-foreign','https://foreign.example.test')
  ) as services(id,actor,application_id,code,base_url) loop
    perform public.bff_write_upstream(metadata.actor,'create',metadata.id,null,
      jsonb_build_object('applicationId',metadata.application_id,'environment','development','code',metadata.code,
        'name',metadata.code,'baseUrl',metadata.base_url,'authType','none','timeoutMs',3000),null);
  end loop;
  insert into public.bff_menus(id,tenant_id,name,type,path,component,meta,create_by,update_by)
    values(page_id,tenant_a,'InterfaceFixturePage','menu','/interface-fixture','/bff/interfaces/index','{"title":"Interfaces","isEnable":true}',admin_a,admin_a);
  insert into public.bff_menus(tenant_id,parent_id,name,type,meta,create_by,update_by) values
    (tenant_a,page_id,'BffInterface:View','button','{"title":"View","isEnable":true}',admin_a,admin_a),
    (tenant_a,page_id,'BffInterface:Add','button','{"title":"Add","isEnable":true}',admin_a,admin_a),
    (tenant_a,page_id,'BffInterface:Test','button','{"title":"Test","isEnable":true}',admin_a,admin_a),
    (tenant_a,page_id,'BffInterface:TestWrite','button','{"title":"Test write","isEnable":true}',admin_a,admin_a);
  insert into public.bff_roles(id,tenant_id,role_code,role_name,create_by,update_by)
    values(role_id,tenant_a,'InterfaceFixtureReader','Interface reader',admin_a,admin_a);
  insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by) values(tenant_a,reader_a,role_id,admin_a);
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by)
    select tenant_a,role_id,id,admin_a from public.bff_menus where tenant_id=tenant_a and parent_id=page_id
      and name<>'BffInterface:TestWrite';
  definition_a:=jsonb_build_object('inputs',jsonb_build_array(jsonb_build_object('key','orderId','label','订单号',
    'location','path','type','string','required',true)),
    'steps',jsonb_build_array(jsonb_build_object('key','load','name','读取订单','upstreamId',service_a,
      'configVersion',1,'method','GET','path','/orders/{orderId}',
      'pathParams',jsonb_build_array(jsonb_build_object('target','orderId','source','input','inputKey','orderId',
        'stepKey','','pointer','','literalType','string','literalValue','')),
      'query',jsonb_build_array(),'body',jsonb_build_array())),
    'outputs',jsonb_build_array(jsonb_build_object('target','result','source','step','inputKey','',
      'stepKey','load','pointer','/id','literalType','string','literalValue','')));
  definition_b:=jsonb_set(jsonb_set(jsonb_set(jsonb_set(definition_a,'{steps,0,key}','"check"'),
    '{steps,0,upstreamId}',to_jsonb(service_b)),'{outputs,0,stepKey}','"check"'),'{steps,0,method}','"POST"');
  result:=public.bff_write_interface(admin_a,'create',interface_a,null,
    jsonb_build_object('applicationId',app_a.id,'environment','development','code','orders-query',
      'name','订单查询','description','草稿 A','method','GET','path','/orders/{orderId}','definition',definition_a));
  if result->>'version'<>'1' or result->>'validationStatus'<>'unvalidated' or result ? 'publishedStatus' or
    (select count(*) from public.bff_interface_upstreams where interface_id=interface_a)<>1
  then raise exception 'Initial interface draft or step binding invalid'; end if;
  result:=public.bff_write_interface(admin_a,'create',interface_b,null,
    jsonb_build_object('applicationId',app_a.id,'environment','development','code','orders-check',
      'name','订单校验','method','POST','path','/orders/check/{orderId}','definition',definition_b));
  perform public.bff_interface_target(reader_a,interface_b,'BffInterface:Test');
  begin
    perform public.bff_interface_target(reader_a,interface_b,'BffInterface:TestWrite');
    raise exception 'Ordinary Test permission also granted write-test access';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  perform public.bff_record_interface_validation(admin_a,interface_b,1,'[]');
  begin
    perform public.bff_record_interface_test(reader_a,interface_b,1,true,
      jsonb_build_array(jsonb_build_object('id',service_b,'configVersion',1,'credentialVersion',0)));
    raise exception 'Test-only actor recorded a write-step success';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  result:=public.bff_record_interface_test(reader_a,interface_b,1,false);
  if result->>'stale'<>'false' or result->>'lastTestStatus'<>'failed'
  then raise exception 'Write-step readiness failure required TestWrite'; end if;
  perform public.bff_write_interface(admin_a,'create',interface_other,null,
    jsonb_build_object('applicationId',app_other.id,'environment','development','code','other-query',
      'name','其他应用查询','method','GET','path','/other/{orderId}','definition',jsonb_set(definition_a,'{steps,0,upstreamId}',to_jsonb(service_other))));
  perform public.bff_write_interface(admin_b,'create',interface_foreign,null,
    jsonb_build_object('applicationId',app_foreign.id,'environment','development','code','foreign-query',
      'name','外租户查询','method','GET','path','/foreign/{orderId}','definition',jsonb_set(definition_a,'{steps,0,upstreamId}',to_jsonb(service_foreign))));
  if (public.bff_read_interfaces(admin_a,'{}')->>'total')::integer<>3 or
    (public.bff_read_interfaces(reader_a,'{}')->>'total')::integer<>2 or
    (public.bff_read_interfaces(admin_b,'{}')->>'total')::integer<>1
  then raise exception 'Interface list escaped tenant/application scope'; end if;
  result:=public.bff_read_interfaces(reader_a,jsonb_build_object('recordId',interface_a));
  if result->>'total'<>'1' or result->'records'->0->>'applicationId'<>app_a.id::text or
    result->'records'->0->'application'->>'code'<>app_a.code
  then raise exception 'Interface locator or nested application DTO failed'; end if;
  result:=public.bff_interface_options(reader_a);
  if jsonb_array_length(result->'applications')<>1 or jsonb_array_length(result->'upstreams')<>2
  then raise exception 'Interface options require only Interface View plus app membership'; end if;
  perform public.bff_write_upstream(admin_a,'create',service_prod,null,
    jsonb_build_object('applicationId',app_a.id,'environment','production','code','prod-write-service',
      'name','Production write service','baseUrl','https://production.example.test',
      'authType','none','timeoutMs',3000),null);
  perform public.bff_write_upstream(admin_a,'status',service_prod,1,'{"status":"active"}',null);
  perform public.bff_write_interface(admin_a,'create',interface_prod,null,
    jsonb_build_object('applicationId',app_a.id,'environment','production','code','prod-write-interface',
      'name','Production write draft','method','POST','path','/production/{orderId}',
      'definition',jsonb_set(definition_b,'{steps,0,upstreamId}',to_jsonb(service_prod))));
  perform public.bff_record_interface_validation(admin_a,interface_prod,1,'[]');
  begin
    perform public.bff_record_interface_test(admin_a,interface_prod,1,true,
      jsonb_build_array(jsonb_build_object('id',service_prod,'configVersion',1,'credentialVersion',0)));
    raise exception 'Production write-step test was recorded as successful';
  exception when raise_exception then if sqlerrm<>'BFF_INTERFACE_WRITE_PRODUCTION' then raise; end if; end;
  perform public.bff_write_interface(admin_a,'delete',interface_prod,1,null);
  begin
    perform public.bff_interface_target(reader_a,interface_a,'BffInterface:Edit');
    raise exception 'Reader was allowed to edit';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_interface_target(admin_a,interface_foreign);
    raise exception 'Foreign interface target was disclosed';
  exception when raise_exception then if sqlerrm<>'BFF_NOT_FOUND' then raise; end if; end;
  begin
    perform public.bff_write_interface(reader_a,'create',gen_random_uuid(),null,
      jsonb_build_object('applicationId',app_other.id,'environment','development','code','forbidden',
        'name','Forbidden','method','GET','path','/forbidden','definition',definition_a));
    raise exception 'Reader created in unassigned application';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_write_interface(admin_a,'create',gen_random_uuid(),null,
      jsonb_build_object('applicationId',app_a.id,'environment','development','code','same-route',
        'name','Duplicate route','method','GET','path','/orders/{orderId}','definition',definition_a));
    raise exception 'Duplicate public method/path was accepted';
  exception when unique_violation then null; end;
  before_count:=(select count(*) from public.bff_audit_events where tenant_id=tenant_a and action='interface.update');
  begin
    perform public.bff_write_interface(admin_a,'update',interface_a,99,
      jsonb_build_object('name','Stale','method','PATCH','path','/orders/{orderId}','definition',definition_a));
    raise exception 'Stale definition edit was accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  if (select count(*) from public.bff_audit_events where tenant_id=tenant_a and action='interface.update')<>before_count
  then raise exception 'Failed definition edit wrote audit'; end if;
  begin
    perform public.bff_write_interface(admin_a,'update',interface_a,1,
      jsonb_build_object('name','Cross binding','method','PATCH','path','/orders/{orderId}',
        'definition',jsonb_set(definition_a,'{steps,0,upstreamId}',to_jsonb(service_foreign))));
    raise exception 'Foreign upstream bound to interface';
  exception when raise_exception then if sqlerrm<>'BFF_INTERFACE_UPSTREAM_INVALID' then raise; end if; end;
  begin
    perform public.bff_write_interface(admin_a,'update',interface_a,1,
      jsonb_build_object('name','Stale service','method','PATCH','path','/orders/{orderId}',
        'definition',jsonb_set(definition_a,'{steps,0,configVersion}','99'::jsonb)));
    raise exception 'Uncurrent upstream config version was accepted';
  exception when raise_exception then if sqlerrm<>'BFF_INTERFACE_UPSTREAM_INVALID' then raise; end if; end;
  result:=public.bff_write_interface(admin_a,'update',interface_a,1,
    jsonb_build_object('name','订单查询修订','description','草稿 B','method','PATCH','path','/orders/{orderId}',
      'definition',definition_b));
  if result->>'version'<>'2' or result->>'method'<>'PATCH' or result->>'validationStatus'<>'unvalidated' or
    (select count(*) from public.bff_interface_upstreams where interface_id=interface_a and step_key='check' and service_id=service_b)<>1 or
    exists(select 1 from public.bff_interface_upstreams where interface_id=interface_a and step_key='load')
  then raise exception 'Definition edit failed to atomically replace step binding'; end if;
  if jsonb_array_length(public.bff_upstream_references(admin_a,service_b))<>2 then raise exception 'Upstream references omitted draft consumers'; end if;
  begin
    perform public.bff_write_upstream(admin_a,'delete',service_b,1,null,null);
    raise exception 'Referenced upstream was archived';
  exception when raise_exception then if sqlerrm<>'BFF_REFERENCED' then raise; end if; end;
  begin
    perform public.bff_record_interface_test(admin_a,interface_a,2,false);
    raise exception 'Unvalidated draft was marked tested';
  exception when raise_exception then if sqlerrm<>'BFF_INTERFACE_NOT_VALIDATED' then raise; end if; end;
  begin
    perform public.bff_record_interface_validation(admin_a,interface_a,1,'[]');
    raise exception 'Old definition validation was accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  result:=public.bff_record_interface_validation(admin_a,interface_a,2,'[]');
  if result->>'version'<>'2' or result->>'validationStatus'<>'valid' or result->>'validatedVersion'<>'2'
  then raise exception 'Structural validation changed definition version'; end if;
  result:=public.bff_record_interface_test(admin_a,interface_a,2,true);
  if result->>'stale'<>'true' or result->>'lastTestStatus'<>'not_tested'
  then raise exception 'Unobserved successful test was accepted'; end if;
  perform public.bff_write_upstream(admin_a,'status',service_b,1,'{"status":"active"}',null);
  result:=public.bff_record_interface_test(admin_a,interface_a,2,true,
    jsonb_build_array(jsonb_build_object('id',service_b,'configVersion',1,'credentialVersion',0)));
  if result->>'lastTestStatus'<>'passed' or result->>'lastTestVersion'<>'2' or result->>'stale'<>'false'
  then raise exception 'Draft test metadata was not recorded'; end if;
  begin
    perform public.bff_record_interface_test(admin_a,interface_a,2,true,
      jsonb_build_array(jsonb_build_object('id',service_other,'configVersion',1,'credentialVersion',0)));
    raise exception 'Unknown call target was accepted';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_TEST_RESULT' then raise; end if; end;
  result:=public.bff_record_interface_test(admin_a,interface_a,1,false);
  if result->>'stale'<>'true' or result->>'lastTestStatus'<>'passed'
  then raise exception 'Stale test overwrote current result'; end if;
  if not exists(select 1 from public.bff_audit_events where action='interface.test.stale' and resource_id=interface_a)
  then raise exception 'Stale test audit missing'; end if;
  perform public.bff_write_upstream(admin_a,'status',service_b,2,'{"status":"disabled"}',null);
  perform public.bff_record_interface_validation(admin_a,interface_other,1,'[]');
  result:=public.bff_record_interface_test(admin_a,interface_other,1,false);
  if result->>'stale'<>'false' or result->>'lastTestStatus'<>'failed'
  then raise exception 'Draft-only preflight failure was discarded'; end if;
  perform public.bff_write_upstream(admin_a,'status',service_other,1,'{"status":"active"}',null);
  result:=public.bff_record_interface_test(admin_a,interface_other,1,true,
    jsonb_build_array(jsonb_build_object('id',service_other,'configVersion',1,'credentialVersion',0)));
  if result->>'stale'<>'false' or result->>'lastTestStatus'<>'passed'
  then raise exception 'Active upstream test snapshot was not accepted'; end if;
  perform public.bff_write_upstream(admin_a,'update',service_other,2,
    jsonb_build_object('name','Other changed','baseUrl','https://other.example.test/v2',
      'authType','none','headerName','','timeoutMs',3000),null);
  result:=public.bff_record_interface_test(admin_a,interface_other,1,true,
    jsonb_build_array(jsonb_build_object('id',service_other,'configVersion',1,'credentialVersion',0)));
  if result->>'stale'<>'true' or result->>'lastTestStatus'<>'passed'
  then raise exception 'Upstream config edit did not stale the test'; end if;
  result:=public.bff_write_interface(admin_a,'update',interface_other,1,
    jsonb_build_object('name','其他应用查询二版','method','GET','path','/other/{orderId}',
      'definition',jsonb_set(jsonb_set(definition_a,'{steps,0,upstreamId}',to_jsonb(service_other)),
        '{steps,0,configVersion}','2'::jsonb)));
  if result->>'version'<>'2' then raise exception 'Interface rebind after config edit failed'; end if;
  perform public.bff_write_upstream(admin_a,'update',service_other,3,
    jsonb_build_object('name','Other authenticated','baseUrl','https://other.example.test/v2',
      'authType','bearer','headerName','Authorization','timeoutMs',3000),
    jsonb_build_object('ciphertext','encrypted-interface-test-one','keyId','fixture-key','version',1));
  result:=public.bff_write_interface(admin_a,'update',interface_other,2,
    jsonb_build_object('name','其他应用查询三版','method','GET','path','/other/{orderId}',
      'definition',jsonb_set(jsonb_set(definition_a,'{steps,0,upstreamId}',to_jsonb(service_other)),
        '{steps,0,configVersion}','3'::jsonb)));
  perform public.bff_record_interface_validation(admin_a,interface_other,3,'[]');
  result:=public.bff_record_interface_test(admin_a,interface_other,3,true,
    jsonb_build_array(jsonb_build_object('id',service_other,'configVersion',3,'credentialVersion',1)));
  if result->>'stale'<>'false' then raise exception 'Credentialed target test snapshot was rejected'; end if;
  perform public.bff_write_upstream(admin_a,'credential',service_other,4,null,
    jsonb_build_object('ciphertext','encrypted-interface-test-two','keyId','fixture-key','version',2));
  result:=public.bff_record_interface_test(admin_a,interface_other,3,true,
    jsonb_build_array(jsonb_build_object('id',service_other,'configVersion',3,'credentialVersion',1)));
  if result->>'stale'<>'true' or result->>'lastTestStatus'<>'passed'
  then raise exception 'Credential rotation did not stale the test'; end if;
  result:=public.bff_write_interface(admin_a,'update',interface_a,2,
    jsonb_build_object('name','订单查询第三版','method','PATCH','path','/orders/{orderId}',
      'definition',definition_b));
  if result->>'version'<>'3' or result->>'validationStatus'<>'unvalidated' or result->>'lastTestStatus'<>'stale'
  then raise exception 'Definition edit retained stale validation/test result'; end if;
  result:=public.bff_record_interface_validation(admin_a,interface_a,3,'["输出映射缺失"]');
  if result->>'validationStatus'<>'invalid' or jsonb_array_length(result->'validationIssues')<>1
  then raise exception 'Invalid structural result not recorded'; end if;
  select jsonb_agg(to_jsonb(repeat('x',500)) order by n) into result from generate_series(1,40) as g(n);
  result:=public.bff_record_interface_validation(admin_a,interface_a,3,result);
  if jsonb_array_length(result->'validationIssues')<>40
  then raise exception 'Validator contract lost the 40-issue boundary'; end if;
  begin
    perform public.bff_record_interface_validation(admin_a,interface_a,3,
      (select jsonb_agg(to_jsonb('x'::text)) from generate_series(1,41)));
    raise exception 'More than 40 issues were accepted';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_ISSUES' then raise; end if; end;
  begin
    perform public.bff_record_interface_validation(admin_a,interface_a,3,
      jsonb_build_array(repeat('x',501)));
    raise exception 'Overlong issue was accepted';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_ISSUES' then raise; end if; end;
  if jsonb_array_length(public.bff_interface_references(admin_a,interface_a))<>0
  then raise exception 'Unpublished draft falsely reports release references'; end if;
  perform public.bff_write_interface(admin_a,'delete',interface_a,3,null);
  if jsonb_array_length(public.bff_upstream_references(admin_a,service_b))<>1
  then raise exception 'Archived draft still blocks upstream'; end if;
  perform public.bff_write_interface(admin_a,'delete',interface_b,1,null);
  if jsonb_array_length(public.bff_upstream_references(admin_a,service_b))<>0
  then raise exception 'Archived consumers still block upstream'; end if;
  perform public.bff_write_upstream(admin_a,'delete',service_b,3,null,null);
  if (public.bff_read_interfaces(admin_a,'{}')->>'total')::integer<>1
  then raise exception 'Archived interface remained visible'; end if;
end $interface_test$;

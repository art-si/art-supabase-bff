-- Synthetic bridge acceptance; the scoped CLI owns the outer rollback transaction.
set local role service_role;
do $bridge_test$
declare tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid();
  admin_a uuid:=gen_random_uuid(); admin_b uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid();
  result jsonb;
begin
  if not public.bff_valid_interface_definition('{"inputs":[],"steps":[{"key":"load","method":"GET",
    "responseContract":{"mode":"business","codePointer":"/code","dataPointer":"/data","successCodes":[0]},
    "pagination":{"mode":"offset","currentInputKey":"current","sizeInputKey":"size",
      "pageParameter":"offset","sizeParameter":"limit","exactCount":true}}],"outputs":[],
    "page":{"stepKey":"load","recordsPointer":"/rows","totalSource":"body","totalPointer":"/total",
      "currentInputKey":"current","sizeInputKey":"size","fields":[{"target":"name",
        "label":"名称","pointer":"/name","type":"string","required":true}]}}'::jsonb) or
    public.bff_valid_interface_definition('{"inputs":[],"steps":[{"key":"load","method":"GET"}],
      "outputs":[],"page":{"fields":[]}}'::jsonb) or
    public.bff_valid_interface_definition('{"inputs":[],"steps":[{"key":"load","method":"GET",
      "responseContract":{"codePointer":"/code","dataPointer":"/data","successCodes":[0]}}],
      "outputs":[{}]}'::jsonb)
  then raise exception 'Page contract SQL structural validation failed'; end if;
  if not (select relrowsecurity from pg_class where oid='public.bff_pro_bridge_nonces'::regclass) or
    has_table_privilege('anon','public.bff_pro_bridge_nonces','select') or
    has_table_privilege('authenticated','public.bff_pro_bridge_nonces','insert') or
    has_table_privilege('service_role','public.bff_pro_bridge_nonces','truncate') or
    has_function_privilege('authenticated','public.bff_consume_pro_bridge_nonce(uuid,text,timestamptz)','execute') or
    has_function_privilege('anon','public.bff_pro_consumer_catalog(uuid)','execute')
  then raise exception 'Pro bridge browser grants or RLS failed'; end if;
  insert into public.bff_members(id,issuer,subject,tenant_id,role,enabled) values
    (admin_a,'https://ckbftoopuyophiebamwy.supabase.co/auth/v1',admin_a::text,tenant_a,'admin',true),
    (admin_b,'https://ckbftoopuyophiebamwy.supabase.co/auth/v1',admin_b::text,tenant_b,'admin',true),
    (viewer,'https://ckbftoopuyophiebamwy.supabase.co/auth/v1',viewer::text,tenant_a,'viewer',true);
  if not public.bff_consume_pro_bridge_nonce(admin_a,repeat('a',64),now()+interval '45 seconds')
  then raise exception 'Fresh bridge nonce was not consumed'; end if;
  begin
    perform public.bff_consume_pro_bridge_nonce(admin_a,repeat('a',64),now()+interval '45 seconds');
    raise exception 'Bridge replay accepted';
  exception when raise_exception then if sqlerrm<>'BFF_BRIDGE_REPLAY' then raise; end if; end;
  begin
    perform public.bff_consume_pro_bridge_nonce(admin_b,repeat('a',64),now()+interval '45 seconds');
    raise exception 'Cross tenant bridge replay accepted';
  exception when raise_exception then if sqlerrm<>'BFF_BRIDGE_REPLAY' then raise; end if; end;
  begin
    perform public.bff_consume_pro_bridge_nonce(admin_a,repeat('b',64),now()-interval '1 second');
    raise exception 'Expired bridge assertion accepted';
  exception when raise_exception then if sqlerrm<>'BFF_BRIDGE_INVALID_NONCE' then raise; end if; end;
  insert into public.bff_pro_bridge_nonces(nonce_hash,tenant_id,member_id,expires_at,created_at)
    values(repeat('c',64),tenant_b,admin_b,now()-interval '1 minute',now()-interval '2 minutes');
  perform public.bff_consume_pro_bridge_nonce(admin_a,repeat('d',64),now()+interval '45 seconds');
  if exists(select 1 from public.bff_pro_bridge_nonces where nonce_hash=repeat('c',64))
  then raise exception 'Expired bridge nonce was not pruned'; end if;
  update public.bff_members set enabled=false where id=admin_b;
  begin
    perform public.bff_consume_pro_bridge_nonce(admin_b,repeat('e',64),now()+interval '45 seconds');
    raise exception 'Disabled BFF member consumed bridge nonce';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  result:=public.bff_pro_consumer_catalog(admin_a);
  if result<>'[]'::jsonb then raise exception 'Empty catalog leaked another tenant'; end if;
  begin
    perform public.bff_pro_consumer_catalog(viewer);
    raise exception 'Viewer without Invoke read catalog';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
end $bridge_test$;
do $bridge_catalog$
declare tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid();
  admin_a uuid:=gen_random_uuid(); admin_b uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid();
  app_a public.bff_applications; app_b public.bff_applications;
  interface_a uuid:=gen_random_uuid(); interface_b uuid:=gen_random_uuid();
  version_a uuid:=gen_random_uuid(); version_b uuid:=gen_random_uuid();
  page_id uuid:=gen_random_uuid(); role_id uuid:=gen_random_uuid(); definition jsonb; page_definition jsonb; result jsonb;
begin
  insert into public.bff_members(id,issuer,subject,tenant_id,role,enabled) values
    (admin_a,'https://ckbftoopuyophiebamwy.supabase.co/auth/v1',admin_a::text,tenant_a,'admin',true),
    (admin_b,'https://ckbftoopuyophiebamwy.supabase.co/auth/v1',admin_b::text,tenant_b,'admin',true),
    (viewer,'https://ckbftoopuyophiebamwy.supabase.co/auth/v1',viewer::text,tenant_a,'viewer',true);
  app_a:=public.bff_save_application(admin_a,null,null,'bridge-app-a','Bridge app A','','',true);
  app_b:=public.bff_save_application(admin_a,null,null,'bridge-app-b','Bridge app B','','',true);
  perform public.bff_set_application_member(admin_a,app_a.id,viewer,true);
  insert into public.bff_menus(id,tenant_id,name,type,path,component,meta,create_by,update_by)
    values(page_id,tenant_a,'BridgeFixture','menu','/bridge-fixture','/bff/interfaces/index',
      '{"title":"Bridge fixture","isEnable":true}',admin_a,admin_a);
  insert into public.bff_menus(tenant_id,parent_id,name,type,meta,create_by,update_by)
    values(tenant_a,page_id,'BffInterface:Invoke','button',
      '{"title":"Invoke","isEnable":true}',admin_a,admin_a);
  insert into public.bff_roles(id,tenant_id,role_code,role_name,create_by,update_by)
    values(role_id,tenant_a,'BRIDGE_FIXTURE','Bridge fixture',admin_a,admin_a);
  insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by)
    values(tenant_a,viewer,role_id,admin_a);
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by)
    select tenant_a,role_id,id,admin_a from public.bff_menus
    where tenant_id=tenant_a and parent_id=page_id and name='BffInterface:Invoke';
  definition:='{"inputs":[{"key":"id","label":"编号","location":"path","type":"string","required":true}],
    "steps":[{"key":"load","name":"Load","upstreamId":"11111111-1111-4111-8111-111111111111",
      "configVersion":1,"method":"GET","path":"/items/{id}","pathParams":[],"query":[],"body":[]}],
    "outputs":[{"target":"name","source":"literal","inputKey":"","stepKey":"","pointer":"",
      "literalType":"string","literalValue":"example"}]}'::jsonb;
  page_definition:='{"inputs":[{"key":"current","label":"页码","location":"query","type":"number","required":true},
    {"key":"size","label":"页长","location":"query","type":"number","required":true}],
    "steps":[{"key":"load","name":"Load","upstreamId":"11111111-1111-4111-8111-111111111111",
      "configVersion":1,"method":"GET","path":"/items","pathParams":[],"query":[],"body":[],
      "pagination":{"mode":"offset","currentInputKey":"current","sizeInputKey":"size",
        "pageParameter":"offset","sizeParameter":"limit","exactCount":true}}],
    "outputs":[],"page":{"stepKey":"load","recordsPointer":"","totalSource":"content-range",
      "totalPointer":"","currentInputKey":"current","sizeInputKey":"size",
      "fields":[{"target":"name","label":"名称","pointer":"/name","type":"string","required":true}]}}'::jsonb;
  insert into public.bff_interfaces(id,tenant_id,application_id,environment,code,name,description,
    method,path,definition,created_by,updated_by) values
    (interface_a,tenant_a,app_a.id,'development','bridge-items-a','Bridge items A','',
      'GET','/items/{id}',definition,admin_a,admin_a),
    (interface_b,tenant_a,app_b.id,'development','bridge-items-b','Bridge items B','',
      'GET','/items-b',page_definition,admin_a,admin_a);
  insert into public.bff_interface_versions(id,interface_id,tenant_id,application_id,environment,
    number,draft_version,code,name,description,method,path,definition,checksum,created_by) values
    (version_a,interface_a,tenant_a,app_a.id,'development',1,1,'bridge-items-a','Bridge items A','',
      'GET','/items/{id}',definition,repeat('a',64),admin_a),
    (version_b,interface_b,tenant_a,app_b.id,'development',1,1,'bridge-items-b','Bridge items B','',
      'GET','/items-b',page_definition,repeat('b',64),admin_a);
  insert into public.bff_interface_deployments(interface_id,tenant_id,application_id,environment,
    active_version_id,enabled,method,path,route_shape,created_by,updated_by) values
    (interface_a,tenant_a,app_a.id,'development',version_a,true,'GET','/items/{id}','/items/{}',admin_a,admin_a),
    (interface_b,tenant_a,app_b.id,'development',version_b,true,'GET','/items-b','/items-b',admin_a,admin_a);
  result:=public.bff_pro_consumer_catalog(viewer);
  if jsonb_array_length(result)<>1 or result->0->>'applicationCode'<>'bridge-app-a' or
    result->0->>'resultKind'<>'scalar' or result->0->'inputs'->0->>'key'<>'id' or
    result::text like '%upstreamId%' or result::text like '%credential%'
  then raise exception 'Pro catalog leaked cross-application or private definition'; end if;
  result:=public.bff_pro_consumer_catalog(admin_a);
  if jsonb_array_length(result)<>2 or result->1->>'resultKind'<>'page' or
    result->1->'pagination'->>'currentInputKey'<>'current' or
    result->1->'pagination'->>'sizeInputKey'<>'size' or
    result->0->'pagination'<>'null'::jsonb or
    public.bff_pro_consumer_catalog(admin_b)<>'[]'::jsonb
  then raise exception 'Catalog tenant or admin scope invalid'; end if;
  update public.bff_applications set enabled=false where id=app_b.id;
  if jsonb_array_length(public.bff_pro_consumer_catalog(admin_a))<>1
  then raise exception 'Disabled application remained in catalog'; end if;
end $bridge_catalog$;
reset role;

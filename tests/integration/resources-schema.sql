-- Resource and private-branding acceptance. The scoped CLI owns BEGIN/ROLLBACK.
do $sequence_test$
begin
  if not has_sequence_privilege('service_role','public.bff_resources_id_seq','USAGE') or
    not has_sequence_privilege('service_role','public.bff_resources_id_seq','SELECT') or
    has_sequence_privilege('anon','public.bff_resources_id_seq','USAGE') or
    has_sequence_privilege('authenticated','public.bff_resources_id_seq','USAGE')
  then raise exception 'Resource identity sequence privileges failed'; end if;
end $sequence_test$;
set local role service_role;
do $service_role_resource_test$
declare tenant_id uuid:=gen_random_uuid(); actor_id uuid:=gen_random_uuid(); reserved jsonb; completed jsonb;
begin
  insert into public.bff_members(id,issuer,subject,tenant_id,role)
    values(actor_id,'urn:bff-resource-service-fixture',actor_id::text,tenant_id,'admin');
  reserved:=public.bff_resource_reserve(actor_id,'service.png','image/png','png',32,repeat('a',64));
  completed:=public.bff_resource_complete(actor_id,(reserved->>'id')::bigint,reserved->>'uploadToken');
  if completed->>'originName'<>'service.png' or completed->>'version'<>'2'
  then raise exception 'service_role could not reserve and complete identity resource'; end if;
end $service_role_resource_test$;
reset role;
do $resource_test$
declare tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid();
  admin_a uuid:=gen_random_uuid(); admin_b uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid();
  page_id uuid:=gen_random_uuid(); fixture_role uuid:=gen_random_uuid();
  image_result jsonb; document_result jsonb; foreign_result jsonb; pending_result jsonb;
  image_id bigint; document_id bigint; foreign_id bigint; stale_id bigint;
  image_token text; document_token text; foreign_token text; stale_token text; cleanup_token text;
  brand jsonb; result jsonb; key_a text; key_b text;
begin
  if not exists(select 1 from storage.buckets where id='bff-assets' and not public and file_size_limit=10485760) or
    not (select relrowsecurity from pg_class where oid='public.bff_resources'::regclass) or
    has_table_privilege('anon','public.bff_resources','select') or
    has_table_privilege('authenticated','public.bff_resources','insert') or
    has_table_privilege('service_role','public.bff_resources','truncate') or
    has_function_privilege('anon','public.bff_resource_reserve(uuid,text,text,text,bigint,text)','execute') or
    has_function_privilege('authenticated','public.bff_resource_cleanup_claim(integer)','execute')
  then raise exception 'Private resource storage, RLS or grant policy failed'; end if;
  insert into public.bff_members(id,issuer,subject,tenant_id,role,display_name) values
    (admin_a,'urn:bff-resource-fixture',admin_a::text,tenant_a,'admin','Resource admin A'),
    (admin_b,'urn:bff-resource-fixture',admin_b::text,tenant_b,'admin','Resource admin B'),
    (viewer,'urn:bff-resource-fixture',viewer::text,tenant_a,'viewer','Resource viewer A');
  insert into public.bff_menus(id,tenant_id,name,type,path,component,meta,create_by,update_by)
    values(page_id,tenant_a,'ResourceFixture','menu','/resource-fixture',
      '/shared/data-center/attachment','{"title":"Resources","isEnable":true}',admin_a,admin_a);
  insert into public.bff_menus(tenant_id,parent_id,name,type,meta,create_by,update_by) values
    (tenant_a,page_id,'BffResource:View','button','{"title":"View","isEnable":true}',admin_a,admin_a),
    (tenant_a,page_id,'BffResource:Add','button','{"title":"Add","isEnable":true}',admin_a,admin_a),
    (tenant_a,page_id,'BffResource:Edit','button','{"title":"Edit","isEnable":true}',admin_a,admin_a),
    (tenant_a,page_id,'BffResource:Delete','button','{"title":"Delete","isEnable":true}',admin_a,admin_a);
  insert into public.bff_roles(id,tenant_id,role_code,role_name,create_by,update_by)
    values(fixture_role,tenant_a,'RESOURCE_FIXTURE','Resource viewer role',admin_a,admin_a);
  insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by)
    values(tenant_a,viewer,fixture_role,admin_a);
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by)
    select tenant_a,fixture_role,id,admin_a from public.bff_menus where parent_id=page_id and name='BffResource:View';
  image_result:=public.bff_resource_reserve(admin_a,'brand.png','image/png','png',512,repeat('a',64));
  document_result:=public.bff_resource_reserve(admin_a,'report.pdf','application/pdf','pdf',1000,repeat('b',64));
  foreign_result:=public.bff_resource_reserve(admin_b,'foreign.png','image/png','png',512,repeat('c',64));
  image_id:=(image_result->>'id')::bigint; document_id:=(document_result->>'id')::bigint;
  foreign_id:=(foreign_result->>'id')::bigint;
  image_token:=image_result->>'uploadToken'; document_token:=document_result->>'uploadToken';
  foreign_token:=foreign_result->>'uploadToken'; key_a:=image_result->>'objectKey'; key_b:=document_result->>'objectKey';
  if image_id is null or image_id>9007199254740991 or key_a not like tenant_a::text||'/%' or
    key_b not like tenant_a::text||'/%' or key_a=key_b or
    foreign_result->>'objectKey' not like tenant_b::text||'/%' or
    image_result->>'storageBucket'<>'bff-assets' or image_token !~ '^[0-9a-f]{64}$'
  then raise exception 'Resource reservation key or token invalid'; end if;
  begin
    perform public.bff_resource_reserve(viewer,'unauthorized.png','image/png','png',10,repeat('d',64));
    raise exception 'View permission granted upload';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_resource_reserve(admin_a,'too-large.pdf','application/pdf','pdf',10485761,repeat('e',64));
    raise exception 'Oversized resource accepted';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_RESOURCE' then raise; end if; end;
  begin
    perform public.bff_resource_complete(admin_a,image_id,repeat('0',64));
    raise exception 'Wrong upload token completed resource';
  exception when raise_exception then if sqlerrm<>'BFF_RESOURCE_RESERVATION_EXPIRED' then raise; end if; end;
  begin
    perform public.bff_resource_complete(admin_b,image_id,image_token);
    raise exception 'Cross tenant completion accepted';
  exception when raise_exception then if sqlerrm<>'BFF_NOT_FOUND' then raise; end if; end;
  result:=public.bff_resource_complete(admin_a,image_id,image_token);
  if result->>'originName'<>'brand.png' or result->>'url'<>'/api/resources/'||image_id::text||'/content' or
    result ? 'objectKey' or result ? 'hash' or result->>'version'<>'2'
  then raise exception 'Resource completion or public DTO invalid'; end if;
  perform public.bff_resource_complete(admin_a,document_id,document_token);
  perform public.bff_resource_complete(admin_b,foreign_id,foreign_token);
  result:=public.bff_read_resources(viewer,0,29,'',array[]::text[]);
  if result->>'total'<>'2' or jsonb_array_length(result->'data')<>2 or
    result::text like '%/storage/v1/%' or result::text like '%objectKey%'
  then raise exception 'Tenant resource list or privacy failed'; end if;
  if public.bff_read_resources(admin_b)->>'total'<>'1' or
    public.bff_resource_names(viewer,array[foreign_id])<>'[]'::jsonb
  then raise exception 'Cross tenant resource list/name leaked'; end if;
  perform pg_catalog.set_config('request.headers',jsonb_build_object('x-art-tenant-scope',tenant_b)::text,true);
  if public.bff_read_resources(viewer)->>'total'<>'2' then raise exception 'Forged tenant header changed scope'; end if;
  begin
    perform public.bff_rename_resource(viewer,document_id,2,'unauthorized.pdf');
    raise exception 'View permission granted rename';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  result:=public.bff_rename_resource(admin_a,document_id,2,'new-report.pdf');
  if result->>'version'<>'3' or result->>'originName'<>'new-report.pdf'
  then raise exception 'Resource rename CAS failed'; end if;
  begin
    perform public.bff_rename_resource(admin_a,document_id,2,'stale.pdf');
    raise exception 'Stale resource version accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  begin
    perform public.bff_rename_resource(admin_a,document_id,3,'spoofed.exe');
    raise exception 'Rename changed the verified file extension';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_RESOURCE' then raise; end if; end;
  brand:=jsonb_build_object('siteName','BFF平台','siteShortName','BFF','siteDescription','',
    'logoUrl','/api/resources/'||image_id::text||'/content','faviconUrl','',
    'watermarkEnabled',false,'watermarkContentType','username','watermarkCustomText','');
  perform public.bff_write_branding(admin_a,0,brand);
  if jsonb_array_length(public.bff_resource_references(admin_a,array[image_id]))<>1 or
    public.bff_resource_content(viewer,image_id)->>'objectKey'<>key_a
  then raise exception 'Brand reference or scoped content lookup failed'; end if;
  begin
    perform public.bff_resource_delete_begin(admin_a,image_id,2);
    raise exception 'Referenced brand image deleted';
  exception when raise_exception then if sqlerrm<>'BFF_REFERENCED' then raise; end if; end;
  begin
    perform public.bff_write_branding(admin_a,1,brand||
      jsonb_build_object('logoUrl','/api/resources/'||foreign_id::text||'/content'));
    raise exception 'Foreign brand resource accepted';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_BRANDING_RESOURCE' then raise; end if; end;
  delete from public.bff_role_menus where role_id=fixture_role and menu_id in
    (select id from public.bff_menus where tenant_id=tenant_a and name='BffResource:View');
  if public.bff_resource_content(viewer,image_id)->>'id'<>image_id::text or
    public.bff_resource_names(viewer,array[image_id,document_id])->0->>'id'<>image_id::text
  then raise exception 'Current brand image exception failed'; end if;
  begin
    perform public.bff_resource_content(viewer,document_id);
    raise exception 'Nonbrand content remained visible without View';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  result:=public.bff_resource_delete_begin(admin_a,document_id,3);
  if result->>'storageBucket'<>'bff-assets' or result->>'objectKey'<>key_b or
    result->>'cleanupToken' !~ '^[0-9a-f]{64}$'
  then raise exception 'Delete begin did not return private cleanup target'; end if;
  cleanup_token:=result->>'cleanupToken';
  result:=public.bff_resource_cleanup_finish(document_id,cleanup_token);
  if result->>'deleted'<>'true' or
    (select status from public.bff_resources where id=document_id)<>'deleted'
  then raise exception 'Delete cleanup lifecycle failed'; end if;
  stale_token:=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(gen_random_uuid()::text,'UTF8'),'sha256'),'hex');
  insert into public.bff_resources(tenant_id,storage_path,object_name,origin_name,mime_type,suffix,
    size_byte,hash,upload_token_hash,created_by,updated_by,created_at)
    values(tenant_a,tenant_a::text,gen_random_uuid()::text||'.png','stale.png','image/png','png',10,
      repeat('d',64),pg_catalog.encode(extensions.digest(pg_catalog.convert_to(stale_token,'UTF8'),'sha256'),'hex'),
      admin_a,admin_a,now()-interval '2 hours') returning id into stale_id;
  result:=public.bff_resource_cleanup_claim(20);
  if not exists(select 1 from jsonb_array_elements(result) as item(value)
    where (item.value->>'id')::bigint=stale_id) or
    (select status from public.bff_resources where id=stale_id)<>'deleting'
  then raise exception 'Expired pending resource not claimed'; end if;
  if exists(select 1 from jsonb_array_elements(public.bff_resource_cleanup_claim(20)) as item(value)
    where (item.value->>'id')::bigint=stale_id)
  then raise exception 'Cleanup lease allowed duplicate claim'; end if;
  select item.value->>'cleanupToken' into cleanup_token from jsonb_array_elements(result) as item(value)
    where (item.value->>'id')::bigint=stale_id;
  begin
    perform public.bff_resource_cleanup_finish(stale_id,repeat('0',64));
    raise exception 'Wrong cleanup token finished resource';
  exception when raise_exception then if sqlerrm<>'BFF_RESOURCE_CLEANUP_LEASE' then raise; end if; end;
  perform public.bff_resource_cleanup_finish(stale_id,cleanup_token);
  perform public.bff_write_branding(admin_a,1,brand||'{"logoUrl":"https://assets.example.test/logo.png"}'::jsonb);
  result:=public.bff_resource_delete_begin(admin_a,image_id,2);
  if result->>'objectKey'<>key_a then raise exception 'Released brand image cannot be deleted'; end if;
  update public.bff_members set enabled=false where id=viewer;
  begin
    perform public.bff_resource_content(viewer,image_id);
    raise exception 'Revoked member retained brand resource access';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
end $resource_test$;

-- Always run in a transaction and roll back these authorization fixtures.
do $$
declare admin_a uuid:=gen_random_uuid(); viewer_a uuid:=gen_random_uuid(); admin_b uuid:=gen_random_uuid();
  tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid(); app_a uuid; app_b uuid;
  page uuid; action uuid; role_a uuid; blocked boolean;
begin
  insert into public.bff_members(id,issuer,subject,tenant_id,role) values
    (admin_a,'https://pilot-fixture.invalid',admin_a::text,tenant_a,'admin'),
    (viewer_a,'https://pilot-fixture.invalid',viewer_a::text,tenant_a,'viewer'),
    (admin_b,'https://pilot-fixture.invalid',admin_b::text,tenant_b,'admin');
  insert into public.bff_applications(tenant_id,code,name,created_by,updated_by)
    values(tenant_a,'pro-transport-pilot','测试甲',admin_a,admin_a) returning id into app_a;
  insert into public.bff_applications(tenant_id,code,name,created_by,updated_by)
    values(tenant_b,'pro-transport-pilot','测试乙',admin_b,admin_b) returning id into app_b;
  insert into public.bff_menus(tenant_id,name,path,component,type,meta,create_by,update_by)
    values(tenant_a,'BffApplications','/applications','/bff/applications/index','menu','{"title":"应用","isEnable":true}',admin_a,admin_a) returning id into page;
  insert into public.bff_menus(tenant_id,parent_id,name,type,meta,create_by,update_by)
    values(tenant_a,page,'BffProTransport:View','button','{"title":"综合核验","isEnable":true}',admin_a,admin_a) returning id into action;
  insert into public.bff_roles(tenant_id,role_code,role_name,create_by,update_by)
    values(tenant_a,'pilot_viewer','测试核验员',admin_a,admin_a) returning id into role_a;
  insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by) values(tenant_a,viewer_a,role_a,admin_a);
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by) values(tenant_a,role_a,action,admin_a);
  blocked:=false;
  begin perform public.bff_pro_transport_context(viewer_a); exception when others then blocked:=sqlerrm='BFF_FORBIDDEN'; end;
  if not blocked then raise exception 'Application grant was bypassed'; end if;
  insert into public.bff_application_members(tenant_id,application_id,member_id,created_by) values(tenant_a,app_a,viewer_a,admin_a);
  if public.bff_pro_transport_context(viewer_a)->>'applicationId'<>app_a::text then raise exception 'Wrong application tenant'; end if;
  update public.bff_applications set enabled=false where id=app_a;
  blocked:=false;
  begin perform public.bff_pro_transport_context(viewer_a); exception when others then blocked:=sqlerrm='BFF_FORBIDDEN'; end;
  if not blocked then raise exception 'Disabled application remained accessible'; end if;
  update public.bff_applications set enabled=true where id=app_a;
  delete from public.bff_role_menus where role_id=role_a;
  blocked:=false;
  begin perform public.bff_pro_transport_context(viewer_a); exception when others then blocked:=sqlerrm='BFF_FORBIDDEN'; end;
  if not blocked then raise exception 'Business permission was bypassed'; end if;
  if has_function_privilege('authenticated','public.bff_pro_transport_context(uuid)','execute') or
    has_function_privilege('anon','public.bff_pro_transport_context(uuid)','execute') then raise exception 'Browser RPC boundary opened'; end if;
end $$;
select 'Pro transport application grant, business permission, disabled application and browser boundary passed' as verification;

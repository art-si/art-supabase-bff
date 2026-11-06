-- Run only against the BFF project after the canonical schema, never pro.
-- The canonical validator wraps this fixture in its rollback transaction.
do $test$
declare
  tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid();
  admin_a uuid:=gen_random_uuid(); admin_b uuid:=gen_random_uuid();
  delegate_a uuid:=gen_random_uuid(); viewer_a uuid:=gen_random_uuid(); disabled_a uuid:=gen_random_uuid();
  app_page uuid:=gen_random_uuid(); role_a uuid:=gen_random_uuid();
  app_active public.bff_applications; app_disabled public.bff_applications;
  app_private public.bff_applications; app_created public.bff_applications; app_foreign public.bff_applications;
  result jsonb; failed boolean;
begin
  insert into public.bff_members(id,issuer,subject,tenant_id,role,display_name,enabled) values
    (admin_a,'urn:bff-application-test',admin_a::text,tenant_a,'admin','Admin A',true),
    (delegate_a,'urn:bff-application-test',delegate_a::text,tenant_a,'viewer','Delegate A',true),
    (viewer_a,'urn:bff-application-test',viewer_a::text,tenant_a,'viewer','Viewer A',true),
    (disabled_a,'urn:bff-application-test',disabled_a::text,tenant_a,'viewer','Member A',true),
    (admin_b,'urn:bff-application-test',admin_b::text,tenant_b,'admin','Admin B',true);
  insert into public.bff_menus(id,tenant_id,name,type,path,component,meta,create_by,update_by)
    values(app_page,tenant_a,'FixtureApplicationPage','menu','/fixture-applications','/bff/applications/index',
      '{"title":"Applications"}',admin_a,admin_a);
  insert into public.bff_menus(tenant_id,parent_id,name,type,meta,create_by,update_by) values
    (tenant_a,app_page,'BffApplication:Add','button','{"title":"Add"}',admin_a,admin_a),
    (tenant_a,app_page,'BffApplication:Edit','button','{"title":"Edit"}',admin_a,admin_a),
    (tenant_a,app_page,'BffApplication:Grant','button','{"title":"Grant"}',admin_a,admin_a);
  insert into public.bff_roles(id,tenant_id,role_code,role_name,create_by,update_by)
    values(role_a,tenant_a,'FixtureApplicationDelegate','Application delegate',admin_a,admin_a);
  insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by)
    values(tenant_a,delegate_a,role_a,admin_a);
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by)
    select tenant_a,role_a,id,admin_a from public.bff_menus where tenant_id=tenant_a and parent_id=app_page and type='button';

  app_active:=public.bff_save_application(admin_a,null,null,'fixture-active','Active app','','',true);
  app_disabled:=public.bff_save_application(admin_a,null,null,'fixture-disabled','Disabled app','','',false);
  app_private:=public.bff_save_application(admin_a,null,null,'fixture-private','Private app','','',true);
  app_foreign:=public.bff_save_application(admin_b,null,null,'fixture-foreign','Foreign app','','',true);
  if not exists(select 1 from public.bff_application_members
      where application_id=app_active.id and member_id=admin_a and tenant_id=tenant_a)
    then raise exception 'Application creator did not receive membership'; end if;
  if (public.bff_read_applications(delegate_a,1,20,'')->>'total')::integer<>0
    then raise exception 'Unassigned delegate saw a tenant application'; end if;
  perform public.bff_set_application_member(admin_a,app_active.id,delegate_a,true);
  perform public.bff_set_application_member(admin_a,app_disabled.id,delegate_a,true);
  perform public.bff_set_application_member(admin_a,app_active.id,viewer_a,true);
  perform public.bff_set_application_member(admin_a,app_disabled.id,viewer_a,true);
  result:=public.bff_read_applications(delegate_a,1,20,'');
  if (result->>'total')::integer<>2 then raise exception 'Delegated editor cannot see disabled assigned app'; end if;
  result:=public.bff_read_applications(viewer_a,1,20,'');
  if (result->>'total')::integer<>1 or result->'records'->0->>'id'<>app_active.id::text
    then raise exception 'Viewer saw a disabled or unassigned app'; end if;
  if jsonb_array_length(public.bff_read_application_members(delegate_a,app_active.id))<>4
    then raise exception 'Delegated grant did not read tenant members'; end if;
  begin
    perform public.bff_read_application_members(viewer_a,app_active.id);
    raise exception 'Viewer read application members';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_save_application(delegate_a,app_private.id,app_private.version,app_private.code,'Changed','','',true);
    raise exception 'Delegate edited an unassigned app';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_set_application_member(delegate_a,app_private.id,viewer_a,true);
    raise exception 'Delegate granted an unassigned app';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_save_application(delegate_a,app_foreign.id,app_foreign.version,app_foreign.code,'Changed','','',true);
    raise exception 'Delegate edited a foreign tenant app';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  begin
    perform public.bff_set_application_member(delegate_a,app_foreign.id,viewer_a,true);
    raise exception 'Delegate granted a foreign tenant app';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;

  app_disabled:=public.bff_save_application(delegate_a,app_disabled.id,app_disabled.version,
    app_disabled.code,'Re-enabled app','','',true);
  if not app_disabled.enabled then raise exception 'Delegated editor cannot re-enable assigned app'; end if;
  app_created:=public.bff_save_application(delegate_a,null,null,'fixture-created','Created app','','',true);
  if not exists(select 1 from public.bff_application_members
      where application_id=app_created.id and member_id=delegate_a and tenant_id=tenant_a)
    then raise exception 'Delegated creator lost access to own new app'; end if;
  perform public.bff_set_application_member(delegate_a,app_created.id,delegate_a,false);
  if exists(select 1 from public.bff_application_members where application_id=app_created.id and member_id=delegate_a)
    then raise exception 'Creator grant was not revoked'; end if;
  if (public.bff_read_applications(delegate_a,1,20,'')->>'total')::integer<>2
    then raise exception 'Historical creator retained access after membership revocation'; end if;
  begin
    perform public.bff_save_application(delegate_a,app_created.id,app_created.version,
      app_created.code,'Changed after revoke','','',true);
    raise exception 'Historical creator edited an app after membership revocation';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  perform public.bff_set_application_member(delegate_a,app_active.id,disabled_a,true);
  update public.bff_members set enabled=false where id=disabled_a;
  begin
    perform public.bff_set_application_member(delegate_a,app_active.id,disabled_a,true);
    raise exception 'Disabled member received a new grant';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  perform public.bff_set_application_member(delegate_a,app_active.id,disabled_a,false);
  if exists(select 1 from public.bff_application_members where application_id=app_active.id and member_id=disabled_a)
    then raise exception 'Disabled member grant could not be revoked'; end if;
  update public.bff_roles set enabled=false where id=role_a;
  if (public.bff_read_applications(delegate_a,1,20,'')->>'total')::integer<>2
    then raise exception 'Role disable changed visible enabled membership scope'; end if;
  begin
    perform public.bff_save_application(delegate_a,null,null,'fixture-denied','Denied app','','',true);
    raise exception 'Disabled role retained application add';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_read_application_members(delegate_a,app_active.id);
    raise exception 'Disabled role retained application grant';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  update public.bff_members set enabled=false where id=delegate_a;
  begin
    perform public.bff_read_applications(delegate_a,1,20,'');
    raise exception 'Disabled actor read applications';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  if has_function_privilege('authenticated','public.bff_read_applications(uuid,integer,integer,text)','execute') or
     has_function_privilege('authenticated','public.bff_read_application_members(uuid,uuid)','execute')
    then raise exception 'Browser role can invoke application read RPC'; end if;
end $test$;

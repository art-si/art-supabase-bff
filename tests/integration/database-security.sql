begin;
do $$
declare admin_a uuid := gen_random_uuid(); admin_b uuid := gen_random_uuid(); viewer uuid := gen_random_uuid(); tenant_a uuid := gen_random_uuid(); tenant_b uuid := gen_random_uuid(); app public.bff_applications; failed boolean;
begin
  insert into public.bff_members(id,issuer,subject,tenant_id,role) values
    (admin_a,'https://test.invalid',admin_a::text,tenant_a,'admin'),
    (admin_b,'https://test.invalid',admin_b::text,tenant_b,'admin'),
    (viewer,'https://test.invalid',viewer::text,tenant_a,'viewer');
  app := public.bff_save_application(admin_a,null,null,'security-fixture','安全验证','','',true);
  if app.tenant_id <> tenant_a then raise exception 'wrong tenant ownership'; end if;
  failed := false;
  begin perform public.bff_save_application(viewer,null,null,'forbidden','forbidden','','',true); exception when others then failed := sqlerrm='BFF_FORBIDDEN'; end;
  if not failed then raise exception 'viewer mutation unexpectedly permitted'; end if;
  failed := false;
  begin perform public.bff_save_application(admin_b,app.id,app.version,app.code,'forbidden','','',true); exception when others then failed := sqlerrm='BFF_CONFLICT'; end;
  if not failed then raise exception 'cross-tenant application update unexpectedly permitted'; end if;
  failed := false;
  begin perform public.bff_set_application_member(admin_a,app.id,admin_b,true); exception when others then failed := sqlerrm='BFF_FORBIDDEN'; end;
  if not failed then raise exception 'cross-tenant grant unexpectedly permitted'; end if;
  perform public.bff_set_application_member(admin_a,app.id,viewer,true);
  if not exists(select 1 from public.bff_application_members where application_id=app.id and member_id=viewer) then raise exception 'grant failed'; end if;
  perform public.bff_set_application_member(admin_a,app.id,viewer,false);
  if exists(select 1 from public.bff_application_members where application_id=app.id and member_id=viewer) then raise exception 'revoke failed'; end if;
  failed := false;
  begin perform public.bff_save_application(admin_a,app.id,999,app.code,'stale','','',true); exception when others then failed := sqlerrm='BFF_CONFLICT'; end;
  if not failed then raise exception 'stale edit unexpectedly permitted'; end if;
  if has_table_privilege('authenticated','public.bff_sessions','select') or has_table_privilege('anon','public.bff_members','select') then raise exception 'browser role can access protected data'; end if;
  if has_function_privilege('authenticated','public.bff_save_application(uuid,uuid,integer,text,text,text,text,boolean)','execute') then raise exception 'browser role can invoke privileged mutation'; end if;
end $$;
select 'BFF tenant isolation, grant/revoke, stale edit and privilege assertions passed' as verification;
rollback;

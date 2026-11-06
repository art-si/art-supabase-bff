-- Runs only inside canonical BFF validation, with the outer transaction rolled back.
do $$
declare tenant uuid:=gen_random_uuid(); other_tenant uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid();
  member_a uuid:=gen_random_uuid(); member_b uuid:=gen_random_uuid(); foreign_member uuid:=gen_random_uuid();
  role_a uuid; role_b uuid; delegated_role uuid:=gen_random_uuid(); page uuid:=gen_random_uuid();
  view_button uuid:=gen_random_uuid(); edit_button uuid:=gen_random_uuid(); assign_button uuid:=gen_random_uuid();
  result jsonb; snapshot jsonb; version_a integer; revision bigint;
begin
  insert into public.bff_members(id,issuer,subject,tenant_id,role,display_name) values
    (actor,'https://role-fixture.example.test',actor::text,tenant,'admin','Role fixture admin'),
    (member_a,'https://role-fixture.example.test',member_a::text,tenant,'viewer','Role fixture reader'),
    (member_b,'https://role-fixture.example.test',member_b::text,tenant,'viewer','Role fixture operator'),
    (foreign_member,'https://role-fixture.example.test',foreign_member::text,other_tenant,'admin','Role fixture other tenant');
  insert into public.bff_menus(id,tenant_id,parent_id,name,type,path,component,meta,create_by,update_by) values
    (page,tenant,null,'RoleFixture','menu','/roles-fixture','/shared/system/role','{"title":"Roles"}',actor,actor),
    (view_button,tenant,page,'System:Role:View','button','','','{"title":"View"}',actor,actor),
    (edit_button,tenant,page,'System:Role:Edit','button','','','{"title":"Edit"}',actor,actor),
    (assign_button,tenant,page,'System:Role:AssignPermission','button','','','{"title":"Assign"}',actor,actor);
  result:=public.bff_write_role(actor,'create','{"definition":{"roleName":"示例：只读角色","roleCode":"FixtureReader","enabled":true}}',1);
  role_a:=(result->>'id')::uuid;
  result:=public.bff_write_role(actor,'create','{"definition":{"roleName":"示例：运维角色","roleCode":"FixtureOperator","enabled":true}}',2);
  role_b:=(result->>'id')::uuid;
  if jsonb_array_length(public.bff_read_roles(actor)->'records')<>2 then raise exception 'Role list must contain both fixtures'; end if;
  begin
    perform public.bff_write_role(actor,'update',jsonb_build_object('definition',jsonb_build_object('id',role_a,'version',1,'roleCode','FixtureReader','roleName','Stale','enabled',true)),2);
    raise exception 'Role stale collection was accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  snapshot:=public.bff_read_role_menus(actor,role_a);
  result:=public.bff_set_role_menus(actor,role_a,array[page,view_button],array[]::uuid[],3,1,1);
  begin
    perform public.bff_set_role_menus(actor,role_a,array[edit_button],array[]::uuid[],3,1,1);
    raise exception 'Role stale permission snapshot was accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  result:=public.bff_set_role_users(actor,role_a,array[member_a,member_b],array[]::uuid[]);
  if not public.bff_actor_can(member_a,'System:Role:View') or public.bff_actor_can(member_a,'System:Role:Edit') then raise exception 'Role View escalated to Edit'; end if;
  if jsonb_array_length(public.bff_read_role_users(actor,role_a)->'records')<>3 then raise exception 'Role member picker crossed tenant'; end if;
  if jsonb_array_length(public.bff_control_references(actor,'role',array[role_a]))<>2 then raise exception 'Role references must list two members'; end if;
  revision:=(public.bff_read_roles(actor)->>'revision')::bigint;
  select version into version_a from public.bff_roles where id=role_a;
  begin
    perform public.bff_write_role(actor,'delete',jsonb_build_object('id',role_a,'version',version_a),revision);
    raise exception 'An assigned role was deleted';
  exception when raise_exception then if sqlerrm<>'BFF_REFERENCED' then raise; end if; end;
  begin
    perform public.bff_set_role_users(actor,role_a,array[foreign_member],array[member_a,member_b]);
    raise exception 'A foreign member was assigned';
  exception when raise_exception then if sqlerrm<>'BFF_NOT_FOUND' then raise; end if; end;
  begin
    perform public.bff_set_role_users(actor,role_a,array[member_a],array[]::uuid[]);
    raise exception 'A stale member assignment was accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  insert into public.bff_roles(id,tenant_id,role_code,role_name,create_by,update_by) values(delegated_role,tenant,'FixtureDelegate','Fixture delegate',actor,actor);
  insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by) values(tenant,member_a,delegated_role,actor);
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by) values(tenant,delegated_role,assign_button,actor);
  snapshot:=public.bff_read_role_menus(member_a,role_b);
  if jsonb_array_length(public.bff_read_menus(member_a,true)->'records')<>4 then raise exception 'Permission-only actor cannot load catalog'; end if;
  begin
    perform public.bff_set_role_menus(member_a,role_b,array[edit_button],array[]::uuid[],(snapshot->>'revision')::bigint,1,1);
    raise exception 'Delegated grant exceeded actor authority';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_write_member(member_a,jsonb_build_object('id',member_a,'version',1,'enabled',true,'role','admin'),1);
    raise exception 'Role assignment changed base administrator';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    update public.bff_members set subject=gen_random_uuid()::text where id=member_a;
    raise exception 'A membership changed identity';
  exception when check_violation then null; end;
  begin
    perform public.bff_write_member(actor,jsonb_build_object('id',actor,'version',1,'enabled',false,'role','admin'),1);
    raise exception 'The admin disabled itself';
  exception when raise_exception then if sqlerrm<>'BFF_SELF_LOCKOUT' then raise; end if; end;
  if jsonb_array_length(public.bff_read_members(actor)->'records')<>3 then raise exception 'Member directory crossed tenant'; end if;
  insert into public.bff_sessions(token_hash,member_id,payload,csrf_token,expires_at) values('role-fixture-'||member_a::text,member_a,'fixture','fixture',now()+interval '1 hour');
  result:=public.bff_write_member(actor,jsonb_build_object('id',member_a,'version',1,'enabled',false,'role','viewer'),1);
  if exists(select 1 from public.bff_sessions where member_id=member_a) or exists(select 1 from public.bff_member_roles where member_id=member_a) then raise exception 'Member disable failed to revoke access'; end if;
  if public.bff_actor_can(member_a,'System:Role:View') then raise exception 'Disabled member retained access'; end if;
  begin
    perform public.bff_write_member(actor,jsonb_build_object('id',member_a,'version',1,'enabled',true,'role','viewer'),2);
    raise exception 'A stale member edit was accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  result:=public.bff_write_member(actor,jsonb_build_object('id',member_a,'version',2,'enabled',true,'role','viewer'),2);
  if public.bff_actor_can(member_a,'System:Role:View') then raise exception 'Member re-enable restored revoked grants'; end if;
  result:=public.bff_set_role_users(actor,role_a,array[]::uuid[],array[member_b]);
  revision:=(public.bff_read_roles(actor)->>'revision')::bigint;
  select version into version_a from public.bff_roles where id=role_a;
  result:=public.bff_write_role(actor,'delete',jsonb_build_object('id',role_a,'version',version_a),revision);
  if exists(select 1 from public.bff_roles where id=role_a) then raise exception 'Unassigned role deletion failed'; end if;
end $$;

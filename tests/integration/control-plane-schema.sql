-- Executed inside the canonical schema validation transaction, always followed by ROLLBACK.
set constraints all immediate;
do $$
declare
  tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid();
  actor_a uuid:=gen_random_uuid(); actor_b uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid();
  folder_a uuid:=gen_random_uuid(); folder_b uuid:=gen_random_uuid(); foreign_menu uuid:=gen_random_uuid();
  directory_a uuid:=gen_random_uuid(); type_a uuid:=gen_random_uuid(); type_b uuid:=gen_random_uuid();
  item_a uuid:=gen_random_uuid(); item_b uuid:=gen_random_uuid(); cascade_item uuid:=gen_random_uuid();
  role_a uuid:=gen_random_uuid(); role_b uuid:=gen_random_uuid();
  page uuid:=gen_random_uuid(); view_button uuid:=gen_random_uuid(); edit_button uuid:=gen_random_uuid(); revision bigint;
begin
  if exists(
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relname like 'bff_%' and (
      not c.relrowsecurity or has_table_privilege('anon',c.oid,'select,insert,update,delete') or
      has_table_privilege('authenticated',c.oid,'select,insert,update,delete') or
      has_table_privilege('service_role',c.oid,'truncate')
    )
  ) then raise exception 'BFF table grants and RLS do not match the server-session boundary'; end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname ~ '^bff_[a-z_]+$'
    and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute')))
  then raise exception 'BFF server-only functions are executable by a browser role'; end if;
  insert into public.bff_members(id,issuer,subject,tenant_id,role,display_name) values
    (actor_a,'https://identity.example.test',actor_a::text,tenant_a,'admin','Schema fixture A'),
    (actor_b,'https://identity.example.test',actor_b::text,tenant_b,'admin','Schema fixture B'),
    (viewer,'https://identity.example.test',viewer::text,tenant_a,'viewer','Schema fixture viewer');
  insert into public.bff_menus(id,tenant_id,parent_id,name,type,path,component,meta,create_by,update_by) values
    (folder_a,tenant_a,null,'FixtureA','folder','/fixture-a','/index/index','{"title":"Fixture A"}',actor_a,actor_a),
    (folder_b,tenant_a,folder_a,'FixtureB','folder','/fixture-a/group','','{"title":"Fixture B"}',actor_a,actor_a),
    (foreign_menu,tenant_b,null,'ForeignFixture','folder','/foreign','','{"title":"Foreign"}',actor_b,actor_b);
  begin
    update public.bff_menus set parent_id=folder_b where id=folder_a;
    raise exception 'A menu cycle was accepted';
  exception when check_violation then null; end;
  begin
    update public.bff_menus set parent_id=foreign_menu where id=folder_b;
    raise exception 'A foreign-tenant parent was accepted';
  exception when foreign_key_violation then null; end;
  begin
    update public.bff_menus set tenant_id=tenant_b where id=folder_b;
    raise exception 'A menu changed tenant ownership';
  exception when check_violation then null; end;
  begin
    insert into public.bff_menus(tenant_id,name,type,path,meta,create_by,update_by)
    values(tenant_a,'InvalidTitle','menu','/invalid-title','{}',actor_a,actor_a);
    raise exception 'A missing menu title was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.bff_menus(tenant_id,name,type,path,meta,create_by,update_by)
    values(tenant_a,'InvalidActor','menu','/invalid-actor','{"title":"Invalid"}',actor_b,actor_b);
    raise exception 'A foreign-tenant write actor was accepted';
  exception when check_violation then null; end;
  update public.bff_menus set parent_id=null where id=folder_b;
  if (select path from public.bff_menus where id=folder_b)<>'/fixture-a/group'
  then raise exception 'Moving a menu changed its stable URL'; end if;
  insert into public.bff_roles(id,tenant_id,role_code,role_name,create_by,update_by) values
    (role_a,tenant_a,'FixtureReader','Fixture reader',actor_a,actor_a),
    (role_b,tenant_a,'FixtureMaintainer','Fixture maintainer',actor_a,actor_a);
  insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by) values(tenant_a,actor_a,role_a,actor_a);
  insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by) values(tenant_a,viewer,role_a,actor_a);
  insert into public.bff_menus(id,tenant_id,parent_id,name,type,path,component,meta,create_by,update_by) values
    (page,tenant_a,folder_a,'FixtureMenuPage','menu','/fixture-a/menus','/system/menu/index','{"title":"Menus"}',actor_a,actor_a),
    (view_button,tenant_a,page,'System:Menu:View','button','','','{"title":"View"}',actor_a,actor_a),
    (edit_button,tenant_a,page,'System:Menu:Edit','button','','','{"title":"Edit"}',actor_a,actor_a);
  if public.bff_actor_can(viewer,'System:Menu:Edit') then raise exception 'Authentication granted a write permission'; end if;
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by) values(tenant_a,role_a,view_button,actor_a);
  if not public.bff_actor_can(viewer,'System:Menu:View') then raise exception 'An explicit active role grant was not honored'; end if;
  if public.bff_actor_can(viewer,'System:Menu:Edit') then raise exception 'A view permission granted edit access'; end if;
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by) values(tenant_a,role_a,edit_button,actor_a);
  if not public.bff_actor_can(viewer,'System:Menu:Edit') then raise exception 'An explicit edit grant was not honored'; end if;
  update public.bff_roles set enabled=false where id=role_a;
  if public.bff_actor_can(viewer,'System:Menu:View') then raise exception 'A disabled role retained access'; end if;
  update public.bff_roles set enabled=true where id=role_a;
  update public.bff_menus set meta=meta||'{"isEnable":false}'::jsonb where id=folder_a;
  if public.bff_actor_can(viewer,'System:Menu:View') then raise exception 'A disabled ancestor retained access'; end if;
  update public.bff_menus set meta=meta||'{"isEnable":true}'::jsonb where id=folder_a;
  update public.bff_members set enabled=false where id=viewer;
  if public.bff_actor_can(viewer,'BffApplication:View') then raise exception 'A disabled member retained workspace access'; end if;
  update public.bff_members set enabled=true where id=viewer;
  delete from public.bff_role_menus where role_id=role_a and menu_id=edit_button;
  begin
    perform public.bff_control_lock(viewer,'System:Menu:Edit','menus');
    raise exception 'A forbidden actor acquired a mutation scope';
  exception when raise_exception then if SQLERRM<>'BFF_FORBIDDEN' then raise; end if; end;
  revision:=public.bff_control_lock(actor_a,'System:Menu:Edit','menus');
  if public.bff_control_advance(actor_a,'menus','fixture.update',page,'{"fields":["name"]}')<>revision+1
  then raise exception 'The mutation scope revision did not advance'; end if;
  if not exists(select 1 from public.bff_audit_events where actor_id=actor_a and action='fixture.update' and resource_id=page)
  then raise exception 'The control mutation did not record its audit event'; end if;
  begin
    insert into public.bff_member_roles(tenant_id,member_id,role_id,create_by) values(tenant_a,actor_b,role_b,actor_a);
    raise exception 'A foreign-tenant member received a role';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by) values(tenant_a,role_a,foreign_menu,actor_a);
    raise exception 'A role received a foreign-tenant menu';
  exception when foreign_key_violation then null; end;
  insert into public.bff_dictionary_types(id,tenant_id,parent_id,node_type,name,code,cascade_parent_type_id,create_by,update_by) values
    (directory_a,tenant_a,null,'directory','Fixture directory','',null,actor_a,actor_a),
    (type_a,tenant_a,directory_a,'dictionary','Fixture status','fixtureStatus',null,actor_a,actor_a),
    (type_b,tenant_a,directory_a,'dictionary','Fixture cascade','fixtureCascade',type_a,actor_a,actor_a);
  insert into public.bff_dictionary_items(id,tenant_id,type_id,label,value,cascade_parent_id,create_by,update_by) values
    (item_a,tenant_a,type_a,'Enabled','1',null,actor_a,actor_a),
    (item_b,tenant_a,type_a,'Disabled','2',null,actor_a,actor_a),
    (cascade_item,tenant_a,type_b,'Child','child',item_a,actor_a,actor_a);
  begin
    update public.bff_dictionary_types set cascade_parent_type_id=type_b where id=type_a;
    raise exception 'A dictionary cascade cycle was accepted';
  exception when check_violation then null; end;
  begin
    update public.bff_dictionary_items set cascade_parent_id=cascade_item where id=cascade_item;
    raise exception 'A dictionary item referenced itself';
  exception when check_violation then null; end;
  begin
    update public.bff_dictionary_items set type_id=type_b where id=item_a;
    raise exception 'A referenced cascade value changed dictionary type';
  exception when check_violation then null; end;
  begin
    delete from public.bff_dictionary_types where id=type_a;
    raise exception 'A referenced dictionary type was deleted';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.bff_dictionary_items(tenant_id,type_id,label,value,create_by,update_by)
    values(tenant_b,type_a,'Foreign value','foreign',actor_b,actor_b);
    raise exception 'A dictionary item crossed tenant ownership';
  exception when foreign_key_violation then null; end;
end $$;

do $$
declare actor uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); tenant uuid:=gen_random_uuid();
  first_menu uuid; second_menu uuid; dictionary uuid; first_item uuid; second_item uuid;
  revision bigint; result jsonb; definition jsonb; saved_count integer;
begin
  insert into public.bff_members(id,issuer,subject,tenant_id,display_name,role)
  values(actor,'urn:bff-rpc-test',actor::text,tenant,'RPC admin','admin'),
    (outsider,'urn:bff-rpc-test',outsider::text,gen_random_uuid(),'Other admin','admin');
  result:=public.bff_read_menus(actor);
  if result->'records'<>'[]'::jsonb or (result->>'revision')::bigint<>1 then raise exception 'Invalid initial menu snapshot'; end if;
  definition:='{"name":"RpcMenuA","type":"menu","path":"/rpc-a","component":"/bff/applications/index","meta":{"title":"示例入口一"}}';
  result:=public.bff_write_menu(actor,'create',jsonb_build_object('definition',definition),1);
  first_menu:=(result->>'id')::uuid;
  definition:=jsonb_set(jsonb_set(jsonb_set(definition,'{name}','"RpcMenuB"'),'{path}','"/rpc-b"'),'{meta,title}','"示例入口二"');
  result:=public.bff_write_menu(actor,'create',jsonb_build_object('definition',definition),2);
  second_menu:=(result->>'id')::uuid;
  if jsonb_array_length(public.bff_read_menus(actor)->'records')<>2 then raise exception 'Menu create failed'; end if;
  begin
    perform public.bff_write_menu(actor,'create',jsonb_build_object('definition',definition),1);
    raise exception 'Stale menu revision accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  begin
    perform public.bff_write_menu(outsider,'delete',jsonb_build_object('ids',jsonb_build_array(first_menu)),1);
    raise exception 'Foreign menu deletion accepted';
  exception when raise_exception then if sqlerrm<>'BFF_NOT_FOUND' then raise; end if; end;
  definition:=definition||jsonb_build_object('id',second_menu,'version',1);
  result:=public.bff_write_menu(actor,'update',jsonb_build_object('definition',definition,'order',jsonb_build_array(jsonb_build_object('id',first_menu,'sort',3))),3);
  if (select sort from public.bff_menus where id=first_menu)<>3 then raise exception 'Atomic menu sort failed'; end if;
  begin
    perform public.bff_write_menu(actor,'update',jsonb_build_object('definition',definition,'order','[]'::jsonb),4);
    raise exception 'Stale menu row accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  result:=public.bff_write_menu(actor,'delete',jsonb_build_object('ids',jsonb_build_array(first_menu,second_menu)),4);
  if jsonb_array_length(public.bff_read_menus(actor)->'records')<>0 then raise exception 'Menu deletion failed'; end if;

  result:=public.bff_write_dictionary(actor,'type','create','{"definition":{"nodeType":"dictionary","code":"RpcStatus","name":"示例运行状态"}}',1);
  dictionary:=(result->>'id')::uuid;
  definition:=jsonb_build_object('typeId',dictionary,'label','运行中','value','running','sort',1);
  result:=public.bff_write_dictionary(actor,'item','create',jsonb_build_object('definition',definition),2);
  first_item:=(result->>'id')::uuid;
  definition:=definition||'{"label":"已停止","value":"stopped","status":"2","sort":2}'::jsonb;
  result:=public.bff_write_dictionary(actor,'item','create',jsonb_build_object('definition',definition),3);
  second_item:=(result->>'id')::uuid;
  if jsonb_array_length(public.bff_read_dictionaries(actor,false)->'items')<>2 or jsonb_array_length(public.bff_read_dictionaries(actor,true)->'items')<>1 then raise exception 'Dictionary option status isolation failed'; end if;
  begin
    perform public.bff_write_dictionary(actor,'type','delete',jsonb_build_object('ids',jsonb_build_array(dictionary)),4);
    raise exception 'Referenced dictionary type deleted';
  exception when raise_exception then if sqlerrm<>'BFF_REFERENCED' then raise; end if; end;
  definition:=definition||jsonb_build_object('id',second_item,'version',1,'status','1');
  result:=public.bff_write_dictionary(actor,'item','update',jsonb_build_object('definition',definition),4);
  if jsonb_array_length(public.bff_read_dictionaries(actor,true)->'items')<>2 then raise exception 'Enabled dictionary not refreshed'; end if;
  result:=public.bff_write_dictionary(actor,'item','delete',jsonb_build_object('ids',jsonb_build_array(first_item,second_item)),5);
  result:=public.bff_write_dictionary(actor,'type','delete',jsonb_build_object('ids',jsonb_build_array(dictionary)),6);
  select count(*) into saved_count from public.bff_audit_events where tenant_id=tenant;
  if saved_count<>10 then raise exception 'Expected exactly 10 committed-in-transaction audit events, got %',saved_count; end if;
end $$;

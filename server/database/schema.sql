-- Canonical schema, exclusively for project bksbwnxdurmuolygiofh.
begin;
create table if not exists public.bff_members (
  id uuid primary key default gen_random_uuid(),
  issuer text not null,
  subject text not null,
  tenant_id uuid not null,
  display_name text not null default '',
  email text not null default '',
  role text not null check (role in ('admin','viewer')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (issuer,subject)
);
create index if not exists bff_members_tenant_idx on public.bff_members(tenant_id);
create table if not exists public.bff_applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null check (code ~ '^[a-z][a-z0-9-]{1,63}$'),
  name text not null check (length(trim(name)) between 1 and 100),
  description text not null default '' check (length(description) <= 1000),
  home_url text not null default '',
  enabled boolean not null default true,
  version integer not null default 1,
  created_by uuid not null references public.bff_members(id),
  updated_by uuid not null references public.bff_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,code)
);
create index if not exists bff_applications_tenant_idx on public.bff_applications(tenant_id);
create table if not exists public.bff_application_members (
  application_id uuid not null references public.bff_applications(id),
  member_id uuid not null references public.bff_members(id),
  created_by uuid not null references public.bff_members(id),
  created_at timestamptz not null default now(),
  primary key (application_id,member_id)
);
create index if not exists bff_application_members_member_idx on public.bff_application_members(member_id);
create table if not exists public.bff_auth_transactions (
  state_hash text primary key,
  browser_hash text not null,
  payload text not null,
  expires_at timestamptz not null
);
create table if not exists public.bff_sessions (
  token_hash text primary key,
  member_id uuid not null references public.bff_members(id),
  payload text not null,
  csrf_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists bff_sessions_member_idx on public.bff_sessions(member_id);
create table if not exists public.bff_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  actor_id uuid not null references public.bff_members(id),
  action text not null,
  application_id uuid references public.bff_applications(id),
  created_at timestamptz not null default now()
);
create index if not exists bff_audit_tenant_created_idx on public.bff_audit_events(tenant_id,created_at desc);

-- Control-plane records follow pro's menu/dictionary DTOs; identity stays in pro Auth.
create unique index if not exists bff_members_id_tenant_uidx on public.bff_members(id,tenant_id);
create table if not exists public.bff_resource_revisions (
  tenant_id uuid not null,
  resource text not null check (resource in ('menus','dictionaries','roles','members')),
  version bigint not null default 1 check (version > 0),
  primary key (tenant_id,resource)
);
create table if not exists public.bff_menus (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  parent_id uuid,
  name text not null check (name ~ '^[A-Za-z][A-Za-z0-9_:-]{0,119}$'),
  type text not null check (type in ('folder','menu','button')),
  path text not null default '',
  component text not null default '',
  meta jsonb not null check (jsonb_typeof(meta)='object' and meta ? 'title' and jsonb_typeof(meta->'title')='string' and length(trim(meta->>'title')) between 1 and 120),
  sort integer not null default 1 check (sort >= 0),
  builtin boolean not null default false,
  version integer not null default 1 check (version > 0),
  create_by uuid not null references public.bff_members(id),
  update_by uuid not null references public.bff_members(id),
  create_time timestamptz not null default now(),
  update_time timestamptz not null default now(),
  unique (id,tenant_id),
  unique (tenant_id,name),
  foreign key (parent_id,tenant_id) references public.bff_menus(id,tenant_id) deferrable initially immediate,
  check (parent_id is distinct from id),
  check (type <> 'button' or (parent_id is not null and path='' and component='')),
  check (type='button' or (left(path,1)='/' and left(path,2)<>'//' and path !~ '[[:cntrl:]#\\]') or
    (type='menu' and path='' and coalesce(meta->>'link','') ~ '^https?://' and coalesce(meta->'isIframe','false'::jsonb)<>'true'::jsonb))
);
create unique index if not exists bff_menu_route_uidx on public.bff_menus(tenant_id,path) where type<>'button' and path<>'';
create index if not exists bff_menu_parent_idx on public.bff_menus(tenant_id,parent_id,sort,id);
create index if not exists bff_menu_creator_idx on public.bff_menus(create_by);
create index if not exists bff_menu_updater_idx on public.bff_menus(update_by);
create table if not exists public.bff_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  role_code text not null check (role_code ~ '^[A-Za-z][A-Za-z0-9_:-]{0,99}$'),
  role_name text not null check (length(trim(role_name)) between 1 and 100),
  description text not null default '' check (length(description)<=1000),
  enabled boolean not null default true,
  builtin_type text check (builtin_type in ('tenant_admin','member')),
  version integer not null default 1 check (version > 0),
  create_by uuid not null references public.bff_members(id),
  update_by uuid not null references public.bff_members(id),
  create_time timestamptz not null default now(),
  update_time timestamptz not null default now(),
  unique (id,tenant_id),
  unique (tenant_id,role_code)
);
create unique index if not exists bff_role_builtin_uidx on public.bff_roles(tenant_id,builtin_type) where builtin_type is not null;
create index if not exists bff_role_creator_idx on public.bff_roles(create_by);
create index if not exists bff_role_updater_idx on public.bff_roles(update_by);
create table if not exists public.bff_member_roles (
  tenant_id uuid not null,
  member_id uuid not null,
  role_id uuid not null,
  create_by uuid not null references public.bff_members(id),
  create_time timestamptz not null default now(),
  primary key (member_id,role_id),
  foreign key (member_id,tenant_id) references public.bff_members(id,tenant_id),
  foreign key (role_id,tenant_id) references public.bff_roles(id,tenant_id)
);
create index if not exists bff_member_role_role_idx on public.bff_member_roles(tenant_id,role_id,member_id);
create index if not exists bff_member_role_creator_idx on public.bff_member_roles(create_by);
create table if not exists public.bff_role_menus (
  tenant_id uuid not null,
  role_id uuid not null,
  menu_id uuid not null,
  create_by uuid not null references public.bff_members(id),
  create_time timestamptz not null default now(),
  primary key (role_id,menu_id),
  foreign key (role_id,tenant_id) references public.bff_roles(id,tenant_id),
  foreign key (menu_id,tenant_id) references public.bff_menus(id,tenant_id)
);
create index if not exists bff_role_menu_menu_idx on public.bff_role_menus(tenant_id,menu_id,role_id);
create index if not exists bff_role_menu_creator_idx on public.bff_role_menus(create_by);
create table if not exists public.bff_dictionary_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  parent_id uuid,
  cascade_parent_type_id uuid,
  node_type text not null check (node_type in ('directory','dictionary')),
  name text not null check (length(trim(name)) between 1 and 100),
  code text not null default '' check (length(code)<=100),
  status text not null default '1' check (status in ('1','2')),
  sort integer not null default 0 check (sort >= 0),
  remark text not null default '' check (length(remark)<=1000),
  builtin boolean not null default false,
  version integer not null default 1 check (version > 0),
  create_by uuid not null references public.bff_members(id),
  update_by uuid not null references public.bff_members(id),
  create_time timestamptz not null default now(),
  update_time timestamptz not null default now(),
  unique (id,tenant_id),
  foreign key (parent_id,tenant_id) references public.bff_dictionary_types(id,tenant_id) deferrable initially immediate,
  foreign key (cascade_parent_type_id,tenant_id) references public.bff_dictionary_types(id,tenant_id) deferrable initially immediate,
  check (parent_id is distinct from id and cascade_parent_type_id is distinct from id),
  check ((node_type='directory' and cascade_parent_type_id is null) or (node_type='dictionary' and code ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,99}$'))
);
create unique index if not exists bff_dict_type_code_uidx on public.bff_dictionary_types(tenant_id,code) where node_type='dictionary';
create index if not exists bff_dict_type_parent_idx on public.bff_dictionary_types(tenant_id,parent_id,sort,id);
create index if not exists bff_dict_type_cascade_idx on public.bff_dictionary_types(tenant_id,cascade_parent_type_id);
create index if not exists bff_dict_type_creator_idx on public.bff_dictionary_types(create_by);
create index if not exists bff_dict_type_updater_idx on public.bff_dictionary_types(update_by);
create table if not exists public.bff_dictionary_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  type_id uuid not null,
  parent_id uuid,
  cascade_parent_id uuid,
  label text not null check (length(trim(label)) between 1 and 120),
  value text not null check (length(trim(value)) between 1 and 1000),
  code text not null default '' check (length(code)<=100),
  status text not null default '1' check (status in ('1','2')),
  sort integer not null default 0 check (sort >= 0),
  i18n_scope text not null default '1' check (length(i18n_scope)<=20),
  color text not null default '' check (color='' or color ~ '^#[0-9A-Fa-f]{3,8}$'),
  tag_type text not null default '' check (tag_type in ('','primary','success','warning','info','danger')),
  remark text not null default '' check (length(remark)<=1000),
  builtin boolean not null default false,
  version integer not null default 1 check (version > 0),
  create_by uuid not null references public.bff_members(id),
  update_by uuid not null references public.bff_members(id),
  create_time timestamptz not null default now(),
  update_time timestamptz not null default now(),
  unique (id,tenant_id),
  unique (id,type_id,tenant_id),
  unique (tenant_id,type_id,value),
  foreign key (type_id,tenant_id) references public.bff_dictionary_types(id,tenant_id),
  foreign key (parent_id,type_id,tenant_id) references public.bff_dictionary_items(id,type_id,tenant_id) deferrable initially immediate,
  foreign key (cascade_parent_id,tenant_id) references public.bff_dictionary_items(id,tenant_id) deferrable initially immediate,
  check (parent_id is distinct from id and cascade_parent_id is distinct from id)
);
create index if not exists bff_dict_item_parent_idx on public.bff_dictionary_items(tenant_id,type_id,parent_id,sort,id);
create index if not exists bff_dict_item_cascade_idx on public.bff_dictionary_items(tenant_id,cascade_parent_id);
create index if not exists bff_dict_item_creator_idx on public.bff_dictionary_items(create_by);
create index if not exists bff_dict_item_updater_idx on public.bff_dictionary_items(update_by);
alter table public.bff_audit_events add column if not exists resource_type text;
alter table public.bff_audit_events add column if not exists resource_id uuid;
alter table public.bff_audit_events add column if not exists summary jsonb not null default '{}'::jsonb;
create index if not exists bff_audit_resource_idx on public.bff_audit_events(tenant_id,resource_type,resource_id,created_at desc);

-- Deferred guards see the final graph after an atomic multi-row reordering operation.
create or replace function public.bff_guard_tree_cycles()
returns trigger language plpgsql security invoker set search_path='' as $$
declare parent uuid; tenant uuid; cyclic boolean; parent_column text;
begin
  parent_column := TG_ARGV[0];
  if TG_TABLE_SCHEMA<>'public' or TG_TABLE_NAME not in ('bff_menus','bff_dictionary_types','bff_dictionary_items')
    or parent_column is null or parent_column not in ('parent_id','cascade_parent_type_id')
    or (parent_column='cascade_parent_type_id' and TG_TABLE_NAME<>'bff_dictionary_types')
  then raise exception using errcode='23514',message='BFF_TREE_CONFIGURATION_INVALID'; end if;
  execute format('select %I,tenant_id from public.%I where id=$1',parent_column,TG_TABLE_NAME)
    into parent,tenant using NEW.id;
  if parent is null then return null; end if;
  execute format(
    'with recursive ancestors as (
      select id,%1$I as parent_id,array[id] as visited,false as cyclic from public.%2$I where id=$1 and tenant_id=$2
      union all
      select p.id,p.%1$I,a.visited||p.id,p.id=any(a.visited)
      from public.%2$I p join ancestors a on p.id=a.parent_id and p.tenant_id=$2
      where not a.cyclic and cardinality(a.visited)<128
    ) select coalesce(bool_or(id=$3 or cyclic or cardinality(visited)>=128),false) from ancestors',
    parent_column,TG_TABLE_NAME
  ) into cyclic using parent,tenant,NEW.id;
  if cyclic then raise exception using errcode='23514',message='BFF_TREE_CYCLE'; end if;
  return null;
end $$;
create or replace function public.bff_guard_control_relationships()
returns trigger language plpgsql security invoker set search_path='' as $$
declare menu public.bff_menus; dict_type public.bff_dictionary_types; item public.bff_dictionary_items;
begin
  if TG_TABLE_NAME='bff_menus' then
    select * into menu from public.bff_menus where id=NEW.id;
    if menu.id is null then return null; end if;
    if menu.parent_id is not null and not exists(
      select 1 from public.bff_menus p where p.id=menu.parent_id and p.tenant_id=menu.tenant_id
      and ((menu.type='button' and p.type='menu') or (menu.type<>'button' and p.type='folder'))
    ) then raise exception using errcode='23514',message='BFF_MENU_PARENT_INVALID'; end if;
    if exists(
      select 1 from public.bff_menus c where c.parent_id=menu.id and
      not ((c.type='button' and menu.type='menu') or (c.type<>'button' and menu.type='folder'))
    ) then raise exception using errcode='23514',message='BFF_MENU_PARENT_IN_USE'; end if;
  elsif TG_TABLE_NAME='bff_dictionary_types' then
    select * into dict_type from public.bff_dictionary_types where id=NEW.id;
    if dict_type.id is null then return null; end if;
    if dict_type.parent_id is not null and not exists(
      select 1 from public.bff_dictionary_types p where p.id=dict_type.parent_id and p.tenant_id=dict_type.tenant_id and p.node_type='directory'
    ) then raise exception using errcode='23514',message='BFF_DICTIONARY_PARENT_INVALID'; end if;
    if dict_type.cascade_parent_type_id is not null and not exists(
      select 1 from public.bff_dictionary_types p where p.id=dict_type.cascade_parent_type_id and p.tenant_id=dict_type.tenant_id and p.node_type='dictionary'
    ) then raise exception using errcode='23514',message='BFF_DICTIONARY_CASCADE_INVALID'; end if;
    if dict_type.node_type<>'directory' and exists(select 1 from public.bff_dictionary_types c where c.parent_id=dict_type.id)
    then raise exception using errcode='23514',message='BFF_DICTIONARY_DIRECTORY_IN_USE'; end if;
    if dict_type.node_type<>'dictionary' and (
      exists(select 1 from public.bff_dictionary_items i where i.type_id=dict_type.id) or
      exists(select 1 from public.bff_dictionary_types c where c.cascade_parent_type_id=dict_type.id)
    )
    then raise exception using errcode='23514',message='BFF_DICTIONARY_TYPE_IN_USE'; end if;
    if exists(
      select 1 from public.bff_dictionary_items i join public.bff_dictionary_items p on p.id=i.cascade_parent_id
      where i.type_id=dict_type.id and p.type_id is distinct from dict_type.cascade_parent_type_id
    ) then raise exception using errcode='23514',message='BFF_DICTIONARY_CASCADE_IN_USE'; end if;
  elsif TG_TABLE_NAME='bff_dictionary_items' then
    select * into item from public.bff_dictionary_items where id=NEW.id;
    if item.id is null then return null; end if;
    select * into dict_type from public.bff_dictionary_types where id=item.type_id and tenant_id=item.tenant_id;
    if dict_type.node_type is distinct from 'dictionary'
    then raise exception using errcode='23514',message='BFF_DICTIONARY_TYPE_INVALID'; end if;
    if item.cascade_parent_id is not null and not exists(
      select 1 from public.bff_dictionary_items p where p.id=item.cascade_parent_id and p.tenant_id=item.tenant_id and p.type_id=dict_type.cascade_parent_type_id
    ) then raise exception using errcode='23514',message='BFF_DICTIONARY_CASCADE_VALUE_INVALID'; end if;
    if exists(
      select 1 from public.bff_dictionary_items c join public.bff_dictionary_types t on t.id=c.type_id
      where c.cascade_parent_id=item.id and t.cascade_parent_type_id is distinct from item.type_id
    ) then raise exception using errcode='23514',message='BFF_DICTIONARY_CASCADE_IN_USE'; end if;
  else
    raise exception using errcode='23514',message='BFF_TREE_CONFIGURATION_INVALID';
  end if;
  return null;
end $$;
create or replace function public.bff_guard_record_scope()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if TG_OP='UPDATE' and (NEW.id is distinct from OLD.id or NEW.tenant_id is distinct from OLD.tenant_id or
    NEW.create_by is distinct from OLD.create_by or NEW.create_time is distinct from OLD.create_time)
  then raise exception using errcode='23514',message='BFF_RECORD_IDENTITY_IMMUTABLE'; end if;
  if not exists(select 1 from public.bff_members m where m.id=NEW.create_by and m.tenant_id=NEW.tenant_id)
    or not exists(select 1 from public.bff_members m where m.id=NEW.update_by and m.tenant_id=NEW.tenant_id)
  then raise exception using errcode='23514',message='BFF_RECORD_ACTOR_SCOPE_INVALID'; end if;
  return NEW;
end $$;
drop trigger if exists bff_menu_scope_guard on public.bff_menus;
create trigger bff_menu_scope_guard before insert or update on public.bff_menus for each row execute function public.bff_guard_record_scope();
drop trigger if exists bff_role_scope_guard on public.bff_roles;
create trigger bff_role_scope_guard before insert or update on public.bff_roles for each row execute function public.bff_guard_record_scope();
drop trigger if exists bff_dict_type_scope_guard on public.bff_dictionary_types;
create trigger bff_dict_type_scope_guard before insert or update on public.bff_dictionary_types for each row execute function public.bff_guard_record_scope();
drop trigger if exists bff_dict_item_scope_guard on public.bff_dictionary_items;
create trigger bff_dict_item_scope_guard before insert or update on public.bff_dictionary_items for each row execute function public.bff_guard_record_scope();
drop trigger if exists bff_menu_cycle_guard on public.bff_menus;
create constraint trigger bff_menu_cycle_guard after insert or update on public.bff_menus deferrable initially deferred
for each row execute function public.bff_guard_tree_cycles('parent_id');
drop trigger if exists bff_menu_relationship_guard on public.bff_menus;
create constraint trigger bff_menu_relationship_guard after insert or update on public.bff_menus deferrable initially deferred
for each row execute function public.bff_guard_control_relationships();
drop trigger if exists bff_dict_type_cycle_guard on public.bff_dictionary_types;
create constraint trigger bff_dict_type_cycle_guard after insert or update on public.bff_dictionary_types deferrable initially deferred
for each row execute function public.bff_guard_tree_cycles('parent_id');
drop trigger if exists bff_dict_type_cascade_cycle_guard on public.bff_dictionary_types;
create constraint trigger bff_dict_type_cascade_cycle_guard after insert or update on public.bff_dictionary_types deferrable initially deferred
for each row execute function public.bff_guard_tree_cycles('cascade_parent_type_id');
drop trigger if exists bff_dict_type_relationship_guard on public.bff_dictionary_types;
create constraint trigger bff_dict_type_relationship_guard after insert or update on public.bff_dictionary_types deferrable initially deferred
for each row execute function public.bff_guard_control_relationships();
drop trigger if exists bff_dict_item_cycle_guard on public.bff_dictionary_items;
create constraint trigger bff_dict_item_cycle_guard after insert or update on public.bff_dictionary_items deferrable initially deferred
for each row execute function public.bff_guard_tree_cycles('parent_id');
drop trigger if exists bff_dict_item_relationship_guard on public.bff_dictionary_items;
create constraint trigger bff_dict_item_relationship_guard after insert or update on public.bff_dictionary_items deferrable initially deferred
for each row execute function public.bff_guard_control_relationships();
revoke all on function public.bff_guard_tree_cycles(),public.bff_guard_control_relationships(),public.bff_guard_record_scope() from public,anon,authenticated;
grant execute on function public.bff_guard_tree_cycles(),public.bff_guard_control_relationships(),public.bff_guard_record_scope() to service_role;

create or replace function public.bff_actor_can(p_actor uuid,p_permission text)
returns boolean language sql stable security invoker set search_path='' as $$
with recursive actor as (
  select id,tenant_id,role from public.bff_members where id=p_actor and enabled
), granted_nodes as (
  select n.id,n.parent_id,n.meta,a.tenant_id
  from actor a join public.bff_member_roles mr on mr.member_id=a.id and mr.tenant_id=a.tenant_id
  join public.bff_roles r on r.id=mr.role_id and r.tenant_id=a.tenant_id and r.enabled
  join public.bff_role_menus rm on rm.role_id=r.id and rm.tenant_id=a.tenant_id
  join public.bff_menus n on n.id=rm.menu_id and n.tenant_id=a.tenant_id
  where a.role<>'admin' and n.type='button' and n.name=p_permission
), lineage as (
  select id as root,id,parent_id,tenant_id,coalesce(meta->'isEnable','true'::jsonb)='true'::jsonb as active,array[id] as visited,false as cycle
  from granted_nodes
  union all
  select l.root,p.id,p.parent_id,l.tenant_id,coalesce(p.meta->'isEnable','true'::jsonb)='true'::jsonb,
    l.visited||p.id,p.id=any(l.visited)
  from lineage l join public.bff_menus p on p.id=l.parent_id and p.tenant_id=l.tenant_id
  where not l.cycle and cardinality(l.visited)<128
)
select exists(select 1 from actor where role='admin' or p_permission='BffApplication:View') or
  exists(select 1 from granted_nodes g where not exists(
    select 1 from lineage l where l.root=g.id and (not l.active or l.cycle or cardinality(l.visited)>=128)
  ))
$$;
create or replace function public.bff_control_lock(p_actor uuid,p_permission text,p_resource text)
returns bigint language plpgsql security invoker set search_path='' as $$
declare tenant uuid; revision bigint;
begin
  select tenant_id into tenant from public.bff_members where id=p_actor and enabled;
  if tenant is null or not public.bff_actor_can(p_actor,p_permission) then raise exception 'BFF_FORBIDDEN'; end if;
  -- Control-plane writes are infrequent. Serialize within a tenant so a role or
  -- membership revocation cannot race a mutation authorized by the old grant.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bff-control:'||tenant::text,0));
  insert into public.bff_resource_revisions(tenant_id,resource) values(tenant,p_resource) on conflict do nothing;
  select version into revision from public.bff_resource_revisions where tenant_id=tenant and resource=p_resource for update;
  perform 1 from public.bff_members where id=p_actor and tenant_id=tenant and enabled for share;
  if not found or not public.bff_actor_can(p_actor,p_permission) then raise exception 'BFF_FORBIDDEN'; end if;
  return revision;
end $$;
create or replace function public.bff_control_advance(p_actor uuid,p_resource text,p_action text,p_record uuid,p_summary jsonb)
returns bigint language plpgsql security invoker set search_path='' as $$
declare tenant uuid; revision bigint;
begin
  select tenant_id into tenant from public.bff_members where id=p_actor and enabled;
  if tenant is null then raise exception 'BFF_FORBIDDEN'; end if;
  update public.bff_resource_revisions set version=version+1 where tenant_id=tenant and resource=p_resource returning version into revision;
  if revision is null then raise exception 'BFF_RESOURCE_LOCK_REQUIRED'; end if;
  insert into public.bff_audit_events(tenant_id,actor_id,action,resource_type,resource_id,summary)
  values(tenant,p_actor,p_action,p_resource,p_record,coalesce(p_summary,'{}'::jsonb));
  return revision;
end $$;
revoke all on function public.bff_actor_can(uuid,text),public.bff_control_lock(uuid,text,text),public.bff_control_advance(uuid,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.bff_actor_can(uuid,text),public.bff_control_lock(uuid,text,text),public.bff_control_advance(uuid,text,text,uuid,jsonb) to service_role;
create or replace function public.bff_actor_permissions(p_actor uuid)
returns text[] language sql stable security invoker set search_path='' as $$
select coalesce(array_agg(permission order by permission),array[]::text[]) from (
  select distinct n.name as permission from public.bff_menus n
  join public.bff_members a on a.id=p_actor and a.tenant_id=n.tenant_id and a.enabled
  where n.type='button' and public.bff_actor_can(p_actor,n.name)
  union select 'BffApplication:View' where public.bff_actor_can(p_actor,'BffApplication:View')
) permitted
$$;
revoke all on function public.bff_actor_permissions(uuid) from public,anon,authenticated;
grant execute on function public.bff_actor_permissions(uuid) to service_role;

-- A snapshot carries the revision used by dialogs, reorder and delete intents.
create or replace function public.bff_read_menus(p_actor uuid,p_catalog boolean default false)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare tenant uuid; result jsonb;
begin
  select tenant_id into tenant from public.bff_members where id=p_actor and enabled;
  if tenant is null or not (public.bff_actor_can(p_actor,'System:Menu:View') or
    (p_catalog and public.bff_actor_can(p_actor,'System:Role:Edit')))
  then raise exception 'BFF_FORBIDDEN'; end if;
  select jsonb_build_object('revision',coalesce((select version from public.bff_resource_revisions where tenant_id=tenant and resource='menus'),1),
    'records',coalesce(jsonb_agg(jsonb_build_object('id',n.id,'parentId',n.parent_id,'name',n.name,'type',n.type,
      'path',n.path,'component',n.component,'meta',n.meta,'sort',n.sort,'builtin',n.builtin,'version',n.version,
      'updateTime',n.update_time) order by n.sort,n.id),'[]'::jsonb)) into result
    from public.bff_menus n where n.tenant_id=tenant;
  return result;
end $$;
create or replace function public.bff_write_menu(p_actor uuid,p_operation text,p_payload jsonb,p_revision bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare tenant uuid; revision bigint; saved public.bff_menus; existing public.bff_menus;
  definition jsonb; entry jsonb; ids uuid[]; target uuid; affected integer;
begin
  if p_operation not in ('create','update','reorder','delete') then raise exception 'BFF_INVALID_OPERATION'; end if;
  revision:=public.bff_control_lock(p_actor,'System:Menu:'||case p_operation when 'create' then 'Add' when 'delete' then 'Delete' else 'Edit' end,'menus');
  if p_revision is distinct from revision then raise exception 'BFF_CONFLICT'; end if;
  select tenant_id into tenant from public.bff_members where id=p_actor;
  set constraints all deferred;
  if p_operation in ('create','update') then
    definition:=p_payload->'definition';
    target:=nullif(definition->>'id','')::uuid;
    if p_operation='update' then
      select * into existing from public.bff_menus where id=target and tenant_id=tenant for update;
      if existing.id is null then raise exception 'BFF_NOT_FOUND'; end if;
      if existing.version is distinct from (definition->>'version')::integer then raise exception 'BFF_CONFLICT'; end if;
      if existing.builtin and (existing.name is distinct from definition->>'name' or existing.type is distinct from definition->>'type'
        or existing.path is distinct from coalesce(definition->>'path','') or existing.component is distinct from coalesce(definition->>'component','')
        or existing.parent_id is distinct from nullif(definition->>'parentId','')::uuid or definition->'meta'->'isEnable'='false'::jsonb)
      then raise exception 'BFF_BUILTIN_PROTECTED'; end if;
      update public.bff_menus set parent_id=nullif(definition->>'parentId','')::uuid,name=definition->>'name',type=definition->>'type',
        path=coalesce(definition->>'path',''),component=coalesce(definition->>'component',''),meta=definition->'meta',
        sort=coalesce((definition->>'sort')::integer,1),version=version+1,update_by=p_actor,update_time=now()
        where id=existing.id returning * into saved;
    else
      if target is not null then raise exception 'BFF_INVALID_CREATE'; end if;
      insert into public.bff_menus(tenant_id,parent_id,name,type,path,component,meta,sort,create_by,update_by)
        values(tenant,nullif(definition->>'parentId','')::uuid,definition->>'name',definition->>'type',coalesce(definition->>'path',''),
          coalesce(definition->>'component',''),definition->'meta',coalesce((definition->>'sort')::integer,1),p_actor,p_actor) returning * into saved;
    end if;
  end if;
  if p_operation in ('update','reorder') then
    if jsonb_typeof(p_payload->'order') is distinct from 'array' then raise exception 'BFF_INVALID_ORDER'; end if;
    if exists(select 1 from jsonb_array_elements(p_payload->'order') e group by e->>'id' having count(*)>1) then raise exception 'BFF_INVALID_ORDER'; end if;
    for entry in select * from jsonb_array_elements(p_payload->'order') loop
      select * into existing from public.bff_menus where id=(entry->>'id')::uuid and tenant_id=tenant;
      if existing.id is null then raise exception 'BFF_NOT_FOUND'; end if;
      if existing.builtin and entry ? 'parentId' and existing.parent_id is distinct from nullif(entry->>'parentId','')::uuid then raise exception 'BFF_BUILTIN_PROTECTED'; end if;
      update public.bff_menus set sort=(entry->>'sort')::integer,
        parent_id=case when entry ? 'parentId' then nullif(entry->>'parentId','')::uuid else parent_id end,
        version=version+1,update_by=p_actor,update_time=now() where id=existing.id;
    end loop;
  end if;
  if p_operation='delete' then
    select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_payload->'ids');
    if coalesce(cardinality(ids),0)=0 then raise exception 'BFF_INVALID_DELETE'; end if;
    if exists(select 1 from unnest(ids) requested where not exists(select 1 from public.bff_menus n where n.id=requested and n.tenant_id=tenant)) then raise exception 'BFF_NOT_FOUND'; end if;
    if exists(select 1 from public.bff_menus where id=any(ids) and builtin) then raise exception 'BFF_BUILTIN_PROTECTED'; end if;
    if exists(select 1 from public.bff_role_menus where menu_id=any(ids)) or exists(select 1 from public.bff_menus where parent_id=any(ids) and not(id=any(ids))) then raise exception 'BFF_REFERENCED'; end if;
    set constraints all deferred;
    delete from public.bff_menus where tenant_id=tenant and id=any(ids);
    get diagnostics affected=row_count;
    target:=ids[1];
  else target:=saved.id;
  end if;
  set constraints all immediate;
  revision:=public.bff_control_advance(p_actor,'menus','menu.'||p_operation,target,jsonb_build_object('count',coalesce(affected,1)));
  return jsonb_build_object('saved',true,'revision',revision,'id',saved.id);
end $$;

create or replace function public.bff_read_dictionaries(p_actor uuid,p_options boolean default false)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare tenant uuid; revision bigint;
begin
  select tenant_id into tenant from public.bff_members where id=p_actor and enabled;
  if tenant is null or (not p_options and not public.bff_actor_can(p_actor,'DataCenter:Dict:View')) then raise exception 'BFF_FORBIDDEN'; end if;
  select coalesce((select version from public.bff_resource_revisions where tenant_id=tenant and resource='dictionaries'),1) into revision;
  return jsonb_build_object('revision',revision,
    'types',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'parentId',t.parent_id,'cascadeParentTypeId',t.cascade_parent_type_id,
      'nodeType',t.node_type,'name',t.name,'code',t.code,'status',t.status,'sort',t.sort,'remark',t.remark,'builtin',t.builtin,
      'version',t.version,'updateTime',t.update_time,'cascadeParentType',case when c.id is not null then jsonb_build_object('id',c.id,'name',c.name,'code',c.code) end)
      order by t.sort,t.id),'[]'::jsonb) from public.bff_dictionary_types t left join public.bff_dictionary_types c on c.id=t.cascade_parent_type_id
      where t.tenant_id=tenant and (not p_options or t.status='1')),
    'items',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'typeId',d.type_id,'parentId',d.parent_id,'cascadeParentId',d.cascade_parent_id,
      'label',d.label,'value',d.value,'code',d.code,'status',d.status,'sort',d.sort,'i18nScope',d.i18n_scope,'color',d.color,'tagType',d.tag_type,
      'remark',d.remark,'builtin',d.builtin,'version',d.version,'updateTime',d.update_time,'dictTypeTable',jsonb_build_object('code',t.code,'name',t.name))
      order by d.sort,d.id),'[]'::jsonb) from public.bff_dictionary_items d join public.bff_dictionary_types t on t.id=d.type_id and t.tenant_id=d.tenant_id
      where d.tenant_id=tenant and (not p_options or (d.status='1' and t.status='1'))));
end $$;

create or replace function public.bff_write_dictionary(p_actor uuid,p_resource text,p_operation text,p_payload jsonb,p_revision bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare tenant uuid; revision bigint; definition jsonb; entry jsonb; target uuid; ids uuid[];
  existing_type public.bff_dictionary_types; existing_item public.bff_dictionary_items; saved_id uuid;
begin
  if p_resource not in ('type','item') or p_operation not in ('create','update','delete','reorder') or (p_resource='item' and p_operation='reorder') then raise exception 'BFF_INVALID_OPERATION'; end if;
  revision:=public.bff_control_lock(p_actor,'DataCenter:Dict:'||case p_operation when 'create' then 'Add' when 'delete' then 'Delete' else 'Edit' end,'dictionaries');
  if p_revision is distinct from revision then raise exception 'BFF_CONFLICT'; end if;
  select tenant_id into tenant from public.bff_members where id=p_actor;
  set constraints all deferred;
  definition:=p_payload->'definition'; target:=nullif(definition->>'id','')::uuid;
  if p_operation in ('create','update') then
    if p_operation='create' and target is not null then raise exception 'BFF_INVALID_CREATE'; end if;
    if p_resource='type' then
      if p_operation='update' then
        select * into existing_type from public.bff_dictionary_types where id=target and tenant_id=tenant for update;
        if existing_type.id is null then raise exception 'BFF_NOT_FOUND'; end if;
        if existing_type.version is distinct from (definition->>'version')::integer then raise exception 'BFF_CONFLICT'; end if;
        if existing_type.builtin and (existing_type.code is distinct from definition->>'code' or existing_type.node_type is distinct from definition->>'nodeType' or definition->>'status'<>'1') then raise exception 'BFF_BUILTIN_PROTECTED'; end if;
        update public.bff_dictionary_types set parent_id=nullif(definition->>'parentId','')::uuid,cascade_parent_type_id=nullif(definition->>'cascadeParentTypeId','')::uuid,
          node_type=definition->>'nodeType',name=definition->>'name',code=coalesce(definition->>'code',''),status=coalesce(definition->>'status','1'),
          sort=coalesce((definition->>'sort')::integer,0),remark=coalesce(definition->>'remark',''),version=version+1,update_by=p_actor,update_time=now() where id=target returning id into saved_id;
      else
        insert into public.bff_dictionary_types(tenant_id,parent_id,cascade_parent_type_id,node_type,name,code,status,sort,remark,create_by,update_by)
          values(tenant,nullif(definition->>'parentId','')::uuid,nullif(definition->>'cascadeParentTypeId','')::uuid,definition->>'nodeType',definition->>'name',
          coalesce(definition->>'code',''),coalesce(definition->>'status','1'),coalesce((definition->>'sort')::integer,0),coalesce(definition->>'remark',''),p_actor,p_actor) returning id into saved_id;
      end if;
    else
      if p_operation='update' then
        select * into existing_item from public.bff_dictionary_items where id=target and tenant_id=tenant for update;
        if existing_item.id is null then raise exception 'BFF_NOT_FOUND'; end if;
        if existing_item.version is distinct from (definition->>'version')::integer then raise exception 'BFF_CONFLICT'; end if;
        if existing_item.builtin and (existing_item.type_id is distinct from (definition->>'typeId')::uuid or existing_item.value is distinct from definition->>'value' or definition->>'status'<>'1') then raise exception 'BFF_BUILTIN_PROTECTED'; end if;
        update public.bff_dictionary_items set type_id=(definition->>'typeId')::uuid,parent_id=nullif(definition->>'parentId','')::uuid,cascade_parent_id=nullif(definition->>'cascadeParentId','')::uuid,
          label=definition->>'label',value=definition->>'value',code=coalesce(definition->>'code',''),status=coalesce(definition->>'status','1'),sort=coalesce((definition->>'sort')::integer,0),
          i18n_scope=coalesce(definition->>'i18nScope','1'),color=coalesce(definition->>'color',''),tag_type=coalesce(definition->>'tagType',''),remark=coalesce(definition->>'remark',''),
          version=version+1,update_by=p_actor,update_time=now() where id=target returning id into saved_id;
      else
        insert into public.bff_dictionary_items(tenant_id,type_id,parent_id,cascade_parent_id,label,value,code,status,sort,i18n_scope,color,tag_type,remark,create_by,update_by)
          values(tenant,(definition->>'typeId')::uuid,nullif(definition->>'parentId','')::uuid,nullif(definition->>'cascadeParentId','')::uuid,definition->>'label',definition->>'value',
          coalesce(definition->>'code',''),coalesce(definition->>'status','1'),coalesce((definition->>'sort')::integer,0),coalesce(definition->>'i18nScope','1'),
          coalesce(definition->>'color',''),coalesce(definition->>'tagType',''),coalesce(definition->>'remark',''),p_actor,p_actor) returning id into saved_id;
      end if;
    end if;
  elsif p_operation='reorder' then
    if jsonb_typeof(p_payload->'order') is distinct from 'array' or exists(select 1 from jsonb_array_elements(p_payload->'order') e group by e->>'id' having count(*)>1) then raise exception 'BFF_INVALID_ORDER'; end if;
    for entry in select * from jsonb_array_elements(p_payload->'order') loop
      update public.bff_dictionary_types set parent_id=nullif(entry->>'parentId','')::uuid,sort=(entry->>'sort')::integer,
        version=version+1,update_by=p_actor,update_time=now() where id=(entry->>'id')::uuid and tenant_id=tenant;
      if not found then raise exception 'BFF_NOT_FOUND'; end if;
    end loop;
  else
    select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_payload->'ids');
    if coalesce(cardinality(ids),0)=0 then raise exception 'BFF_INVALID_DELETE'; end if;
    if p_resource='type' then
      if exists(select 1 from unnest(ids) requested where not exists(select 1 from public.bff_dictionary_types where id=requested and tenant_id=tenant)) then raise exception 'BFF_NOT_FOUND'; end if;
      if exists(select 1 from public.bff_dictionary_types where id=any(ids) and builtin) then raise exception 'BFF_BUILTIN_PROTECTED'; end if;
      if exists(select 1 from public.bff_dictionary_types where (parent_id=any(ids) or cascade_parent_type_id=any(ids)) and not(id=any(ids)))
        or exists(select 1 from public.bff_dictionary_items where type_id=any(ids)) then raise exception 'BFF_REFERENCED'; end if;
      set constraints all deferred;
      delete from public.bff_dictionary_types where tenant_id=tenant and id=any(ids);
    else
      if exists(select 1 from unnest(ids) requested where not exists(select 1 from public.bff_dictionary_items where id=requested and tenant_id=tenant)) then raise exception 'BFF_NOT_FOUND'; end if;
      if exists(select 1 from public.bff_dictionary_items where id=any(ids) and builtin) then raise exception 'BFF_BUILTIN_PROTECTED'; end if;
      if exists(select 1 from public.bff_dictionary_items where (parent_id=any(ids) or cascade_parent_id=any(ids)) and not(id=any(ids))) then raise exception 'BFF_REFERENCED'; end if;
      set constraints all deferred;
      delete from public.bff_dictionary_items where tenant_id=tenant and id=any(ids);
    end if;
    saved_id:=ids[1];
  end if;
  set constraints all immediate;
  revision:=public.bff_control_advance(p_actor,'dictionaries','dictionary.'||p_resource||'.'||p_operation,saved_id,jsonb_build_object('count',coalesce(cardinality(ids),1)));
  return jsonb_build_object('saved',true,'id',saved_id,'revision',revision);
end $$;
revoke all on function public.bff_read_menus(uuid,boolean),public.bff_write_menu(uuid,text,jsonb,bigint),public.bff_read_dictionaries(uuid,boolean),public.bff_write_dictionary(uuid,text,text,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.bff_read_menus(uuid,boolean),public.bff_write_menu(uuid,text,jsonb,bigint),public.bff_read_dictionaries(uuid,boolean),public.bff_write_dictionary(uuid,text,text,jsonb,bigint) to service_role;

create or replace function public.bff_navigation(p_actor uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
with recursive actor as (
  select * from public.bff_members where id=p_actor and enabled
), active_tree as (
  select n.*,array[n.id] as visited from public.bff_menus n join actor a on a.tenant_id=n.tenant_id
    where n.parent_id is null and n.type<>'button' and coalesce(n.meta->'isEnable','true'::jsonb)='true'::jsonb
  union all
  select n.*,p.visited||n.id from public.bff_menus n join active_tree p on n.parent_id=p.id and n.tenant_id=p.tenant_id
    where n.type<>'button' and coalesce(n.meta->'isEnable','true'::jsonb)='true'::jsonb and not(n.id=any(p.visited)) and cardinality(p.visited)<128
), accessible as (
  select n.id,n.parent_id from active_tree n cross join actor a where n.type='menu' and
    (a.role='admin' or (n.name='BffApplications' and public.bff_actor_can(p_actor,'BffApplication:View')) or exists(
      select 1 from public.bff_menus b where b.parent_id=n.id and b.type='button' and b.name like '%:View' and public.bff_actor_can(p_actor,b.name)))
), visible as (
  select * from accessible union select p.id,p.parent_id from active_tree p join visible c on c.parent_id=p.id
)
select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'parentId',n.parent_id,'name',n.name,'path',n.path,'type',n.type,'sort',n.sort,'meta',n.meta,
  'component',case when n.type='folder' then case when n.parent_id is null then '/index/index' else '' end else n.component end) order by n.sort,n.id),'[]'::jsonb)
from active_tree n where n.id in (select id from visible)
$$;
revoke all on function public.bff_navigation(uuid) from public,anon,authenticated;
grant execute on function public.bff_navigation(uuid) to service_role;

create or replace function public.bff_control_references(p_actor uuid,p_resource text,p_ids uuid[])
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare tenant uuid; result jsonb;
begin
  select tenant_id into tenant from public.bff_members where id=p_actor and enabled;
  if tenant is null or p_resource not in ('menu','dict_type','dictionary') or not public.bff_actor_can(p_actor,
    case when p_resource='menu' then 'System:Menu:Delete' else 'DataCenter:Dict:Delete' end)
  then raise exception 'BFF_FORBIDDEN'; end if;
  if coalesce(cardinality(p_ids),0) not between 1 and 500 then raise exception 'BFF_INVALID_DELETE'; end if;
  if exists(select 1 from unnest(p_ids) requested where not exists(
    select 1 from public.bff_menus where p_resource='menu' and id=requested and tenant_id=tenant
    union all select 1 from public.bff_dictionary_types where p_resource='dict_type' and id=requested and tenant_id=tenant
    union all select 1 from public.bff_dictionary_items where p_resource='dictionary' and id=requested and tenant_id=tenant
  )) then raise exception 'BFF_NOT_FOUND'; end if;
  with dependencies as (
    select n.id as resource_id,'sys_menu'::text as source_table,n.id,n.meta->>'title' as label,'系统预置入口，需保留'::text as summary,n.update_time as created_at
      from public.bff_menus n where p_resource='menu' and n.tenant_id=tenant and n.id=any(p_ids) and n.builtin
    union all select n.parent_id,'sys_menu',n.id,n.meta->>'title','下级菜单',n.update_time from public.bff_menus n
      where p_resource='menu' and n.tenant_id=tenant and n.parent_id=any(p_ids) and not(n.id=any(p_ids))
    union all select rm.menu_id,'sys_role',r.id,r.role_name,'角色菜单授权',rm.create_time from public.bff_role_menus rm join public.bff_roles r on r.id=rm.role_id
      where p_resource='menu' and rm.tenant_id=tenant and rm.menu_id=any(p_ids)
    union all select t.id,'sys_dict_type',t.id,t.name,'系统预置字典，需保留',t.update_time from public.bff_dictionary_types t
      where p_resource='dict_type' and t.tenant_id=tenant and t.id=any(p_ids) and t.builtin
    union all select t.parent_id,'sys_dict_type',t.id,t.name,'下级字典节点',t.update_time from public.bff_dictionary_types t
      where p_resource='dict_type' and t.tenant_id=tenant and t.parent_id=any(p_ids) and not(t.id=any(p_ids))
    union all select t.cascade_parent_type_id,'sys_dict_type',t.id,t.name,'级联引用类型',t.update_time from public.bff_dictionary_types t
      where p_resource='dict_type' and t.tenant_id=tenant and t.cascade_parent_type_id=any(p_ids) and not(t.id=any(p_ids))
    union all select d.type_id,'sys_dictionary',d.id,d.label,'所属字典项',d.update_time from public.bff_dictionary_items d
      where p_resource='dict_type' and d.tenant_id=tenant and d.type_id=any(p_ids)
    union all select d.id,'sys_dictionary',d.id,d.label,'系统预置字典项，需保留',d.update_time from public.bff_dictionary_items d
      where p_resource='dictionary' and d.tenant_id=tenant and d.id=any(p_ids) and d.builtin
    union all select d.parent_id,'sys_dictionary',d.id,d.label,'下级字典项',d.update_time from public.bff_dictionary_items d
      where p_resource='dictionary' and d.tenant_id=tenant and d.parent_id=any(p_ids) and not(d.id=any(p_ids))
    union all select d.cascade_parent_id,'sys_dictionary',d.id,d.label,'级联引用项',d.update_time from public.bff_dictionary_items d
      where p_resource='dictionary' and d.tenant_id=tenant and d.cascade_parent_id=any(p_ids) and not(d.id=any(p_ids))
  ) select coalesce(jsonb_agg(jsonb_build_object('resourceId',resource_id,'sourceTable',source_table,'dependencyCode',case
    when p_resource='menu' and source_table='sys_role' then 'menu_role_grant'
    when p_resource='dict_type' and source_table='sys_dictionary' then 'dict_type_item'
    when p_resource='dict_type' then 'dict_type_child'
    when p_resource='dictionary' then 'dictionary_child'
    else source_table end,
    'recordId',id,'targetId',id,'recordNo',label,'recordSummary',summary,'createdAt',created_at,'cleanupAllowed',false)),'[]'::jsonb) into result from dependencies;
  return result;
end $$;
revoke all on function public.bff_control_references(uuid,text,uuid[]) from public,anon,authenticated;
grant execute on function public.bff_control_references(uuid,text,uuid[]) to service_role;

-- Seed installed shared capabilities only, without changing existing records.
-- An active, explicitly provisioned BFF administrator is required in each tenant.
do $$
declare actor record; entry record; parent uuid; page uuid; action text; dictionary uuid; option record; normalized integer;
begin
  for actor in select distinct on (tenant_id) id,tenant_id from public.bff_members where enabled and role='admin' order by tenant_id,created_at,id loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bff-control:'||actor.tenant_id::text,0));
    -- Shared reference navigation resolves these canonical pro route names.
    update public.bff_menus set name=case component when '/shared/system/menu' then 'Menu' else 'Dict' end,
      version=version+1,update_by=actor.id,update_time=now()
      where tenant_id=actor.tenant_id and builtin and
        ((component='/shared/system/menu' and name<>'Menu') or (component='/shared/data-center/dict' and name<>'Dict'));
    get diagnostics normalized=row_count;
    if normalized>0 then
      insert into public.bff_resource_revisions(tenant_id,resource) values(actor.tenant_id,'menus') on conflict do nothing;
      perform public.bff_control_advance(actor.id,'menus','menu.bootstrap',null,jsonb_build_object('normalized',normalized));
    end if;
    for entry in select * from (values
      ('BffApplications',null::text,'/applications','/bff/applications/index','应用管理','ri:apps-2-line','menu',1),
      ('BffSystem',null,'/system','/index/index','系统管理','ri:settings-3-line','folder',90),
      ('Menu','BffSystem','/system/menu','/shared/system/menu','菜单管理','ri:menu-2-line','menu',1),
      ('BffDataCenter',null,'/data-center','/index/index','数据中心','ri:database-2-line','folder',91),
      ('Dict','BffDataCenter','/data-center/dict','/shared/data-center/dict','字典管理','ri:book-2-line','menu',1)
    ) as installed(name,parent_name,path,component,title,icon,type,sort) loop
      parent:=null;
      if entry.parent_name is not null then select id into parent from public.bff_menus where tenant_id=actor.tenant_id and name=entry.parent_name; end if;
      insert into public.bff_menus(tenant_id,parent_id,name,path,component,type,sort,meta,builtin,create_by,update_by)
        values(actor.tenant_id,parent,entry.name,entry.path,entry.component,entry.type,entry.sort,jsonb_build_object('title',entry.title,'icon',entry.icon,'isEnable',true,'keepAlive',true),true,actor.id,actor.id)
        on conflict (tenant_id,name) do nothing;
    end loop;
    for entry in select * from (values('BffApplications','BffApplication'),('Menu','System:Menu'),('Dict','DataCenter:Dict')) as pages(name,mark) loop
      select id into page from public.bff_menus where tenant_id=actor.tenant_id and name=entry.name;
      foreach action in array case when entry.mark='BffApplication' then array['View','Add','Edit','Grant'] else array['View','Add','Edit','Delete'] end loop
        insert into public.bff_menus(tenant_id,parent_id,name,type,meta,builtin,create_by,update_by)
          values(actor.tenant_id,page,entry.mark||':'||action,'button',jsonb_build_object('title',case action when 'View' then '查看' when 'Add' then '新增' when 'Edit' then '编辑' when 'Grant' then '访问授权' else '删除' end,'isEnable',true),true,actor.id,actor.id)
          on conflict (tenant_id,name) do nothing;
      end loop;
    end loop;
    for entry in select * from (values
      ('BffCommon','通用配置'),('BffBusinessExamples','BFF 业务配置')
    ) as directories(code,name) loop
      insert into public.bff_dictionary_types(tenant_id,node_type,name,code,builtin,create_by,update_by)
        select actor.tenant_id,'directory',entry.name,entry.code,true,actor.id,actor.id
        where not exists(select 1 from public.bff_dictionary_types where tenant_id=actor.tenant_id and node_type='directory' and code=entry.code);
    end loop;
    for entry in select * from (values
      ('status','状态','BffCommon',true),('commonBoolean','是否','BffCommon',true),
      ('menuType','菜单类型','BffCommon',true),('i18nScope','国际化范围','BffCommon',true),
      ('bffEnvironment','示例：环境类型','BffBusinessExamples',false),('bffAccessPolicy','示例：访问策略','BffBusinessExamples',false)
    ) as types(code,name,directory,builtin) loop
      select id into parent from public.bff_dictionary_types where tenant_id=actor.tenant_id and node_type='directory' and code=entry.directory;
      insert into public.bff_dictionary_types(tenant_id,parent_id,node_type,name,code,builtin,create_by,update_by)
        values(actor.tenant_id,parent,'dictionary',entry.name,entry.code,entry.builtin,actor.id,actor.id)
        on conflict (tenant_id,code) where node_type='dictionary' do nothing;
    end loop;
    for option in select * from (values
      ('status','1','启用',1,'success'),('status','2','停用',2,'info'),
      ('commonBoolean','true','是',1,'success'),('commonBoolean','false','否',2,'info'),
      ('menuType','folder','目录',1,'warning'),('menuType','menu','菜单',2,'primary'),('menuType','button','按钮',3,'danger'),
      ('i18nScope','1','默认',1,'primary'),('i18nScope','2','业务',2,'info'),
      ('bffEnvironment','development','开发环境',1,'info'),('bffEnvironment','production','生产环境',2,'success'),
      ('bffAccessPolicy','read_only','只读访问',1,'info'),('bffAccessPolicy','managed','受管访问',2,'primary')
    ) as options(code,value,label,sort,tag) loop
      select id into dictionary from public.bff_dictionary_types where tenant_id=actor.tenant_id and node_type='dictionary' and code=option.code;
      insert into public.bff_dictionary_items(tenant_id,type_id,label,value,sort,tag_type,builtin,create_by,update_by)
        values(actor.tenant_id,dictionary,option.label,option.value,option.sort,option.tag,option.code not in ('bffEnvironment','bffAccessPolicy'),actor.id,actor.id)
        on conflict (tenant_id,type_id,value) do nothing;
    end loop;
  end loop;
end $$;
set constraints all immediate;
create or replace function public.bff_save_application(p_actor uuid,p_id uuid,p_version integer,p_code text,p_name text,p_description text,p_home_url text,p_enabled boolean)
returns public.bff_applications language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; saved public.bff_applications;
begin
  select * into actor from public.bff_members where id=p_actor and enabled and role='admin';
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  if p_id is null then
    insert into public.bff_applications(tenant_id,code,name,description,home_url,enabled,created_by,updated_by)
    values(actor.tenant_id,p_code,p_name,p_description,p_home_url,p_enabled,p_actor,p_actor) returning * into saved;
  else
    update public.bff_applications set name=p_name,description=p_description,home_url=p_home_url,enabled=p_enabled,version=version+1,updated_by=p_actor,updated_at=now()
    where id=p_id and tenant_id=actor.tenant_id and version=p_version and code=p_code returning * into saved;
    if saved.id is null then raise exception 'BFF_CONFLICT'; end if;
  end if;
  insert into public.bff_audit_events(tenant_id,actor_id,action,application_id) values(actor.tenant_id,p_actor,case when p_id is null then 'application.create' else 'application.update' end,saved.id);
  return saved;
end $$;
create or replace function public.bff_set_application_member(p_actor uuid,p_application uuid,p_member uuid,p_granted boolean)
returns void language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members;
begin
  select * into actor from public.bff_members where id=p_actor and enabled and role='admin';
  if actor.id is null or not exists(select 1 from public.bff_applications where id=p_application and tenant_id=actor.tenant_id)
    or not exists(select 1 from public.bff_members where id=p_member and tenant_id=actor.tenant_id and enabled)
  then raise exception 'BFF_FORBIDDEN'; end if;
  if p_granted then
    insert into public.bff_application_members(application_id,member_id,created_by) values(p_application,p_member,p_actor) on conflict do nothing;
  else
    delete from public.bff_application_members where application_id=p_application and member_id=p_member;
  end if;
  insert into public.bff_audit_events(tenant_id,actor_id,action,application_id) values(actor.tenant_id,p_actor,case when p_granted then 'application.grant' else 'application.revoke' end,p_application);
end $$;
revoke all on function public.bff_save_application(uuid,uuid,integer,text,text,text,text,boolean),public.bff_set_application_member(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.bff_save_application(uuid,uuid,integer,text,text,text,text,boolean),public.bff_set_application_member(uuid,uuid,uuid,boolean) to service_role;
alter table public.bff_members enable row level security;
alter table public.bff_applications enable row level security;
alter table public.bff_application_members enable row level security;
alter table public.bff_auth_transactions enable row level security;
alter table public.bff_sessions enable row level security;
alter table public.bff_audit_events enable row level security;
revoke all on public.bff_members,public.bff_applications,public.bff_application_members,public.bff_auth_transactions,public.bff_sessions,public.bff_audit_events from anon,authenticated;
revoke all on public.bff_members,public.bff_applications,public.bff_application_members,public.bff_auth_transactions,public.bff_sessions,public.bff_audit_events from service_role;
grant select,insert,update,delete on public.bff_members,public.bff_applications,public.bff_application_members,public.bff_auth_transactions,public.bff_sessions,public.bff_audit_events to service_role;
alter table public.bff_resource_revisions enable row level security;
alter table public.bff_menus enable row level security;
alter table public.bff_roles enable row level security;
alter table public.bff_member_roles enable row level security;
alter table public.bff_role_menus enable row level security;
alter table public.bff_dictionary_types enable row level security;
alter table public.bff_dictionary_items enable row level security;
revoke all on public.bff_resource_revisions,public.bff_menus,public.bff_roles,public.bff_member_roles,public.bff_role_menus,public.bff_dictionary_types,public.bff_dictionary_items from public,anon,authenticated;
revoke all on public.bff_resource_revisions,public.bff_menus,public.bff_roles,public.bff_member_roles,public.bff_role_menus,public.bff_dictionary_types,public.bff_dictionary_items from service_role;
grant select,insert,update,delete on public.bff_resource_revisions,public.bff_menus,public.bff_roles,public.bff_member_roles,public.bff_role_menus,public.bff_dictionary_types,public.bff_dictionary_items to service_role;
commit;

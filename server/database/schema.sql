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
grant all on public.bff_members,public.bff_applications,public.bff_application_members,public.bff_auth_transactions,public.bff_sessions,public.bff_audit_events to service_role;
commit;

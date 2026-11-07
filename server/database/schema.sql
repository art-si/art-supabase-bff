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
alter table public.bff_members add column if not exists version integer not null default 1 check (version > 0);
alter table public.bff_members add column if not exists updated_at timestamptz not null default now();
alter table public.bff_members add column if not exists updated_by uuid references public.bff_members(id);
create index if not exists bff_members_updater_idx on public.bff_members(updated_by);
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
create unique index if not exists bff_applications_id_tenant_uidx on public.bff_applications(id,tenant_id);
alter table public.bff_application_members add column if not exists tenant_id uuid;
update public.bff_application_members am set tenant_id=a.tenant_id from public.bff_applications a where a.id=am.application_id and am.tenant_id is null;
alter table public.bff_application_members alter column tenant_id set not null;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.bff_application_members'::regclass and conname='bff_application_member_tenant_fk') then
    alter table public.bff_application_members add constraint bff_application_member_tenant_fk foreign key(member_id,tenant_id) references public.bff_members(id,tenant_id);
    alter table public.bff_application_members add constraint bff_application_scope_fk foreign key(application_id,tenant_id) references public.bff_applications(id,tenant_id);
    alter table public.bff_application_members add constraint bff_application_grant_actor_fk foreign key(created_by,tenant_id) references public.bff_members(id,tenant_id);
  end if;
end $$;
create index if not exists bff_application_member_tenant_idx on public.bff_application_members(tenant_id,member_id);
create index if not exists bff_application_grant_actor_idx on public.bff_application_members(created_by,tenant_id);
create table if not exists public.bff_upstream_services (
  id uuid primary key,
  tenant_id uuid not null,
  application_id uuid not null,
  code text not null check (code ~ '^[a-z][a-z0-9-]{1,63}$'),
  name text not null check (length(trim(name)) between 1 and 100),
  description text not null default '' check (length(description)<=1000),
  environment text not null check (environment in ('development','staging','production')),
  status text not null default 'draft' check (status in ('draft','active','disabled')),
  base_url text not null check (length(base_url) between 10 and 2000 and base_url !~ '[[:cntrl:]]' and (
    base_url ~ '^https://[^/?#@ ]+(/[^?#]*)?$' or
    (environment='development' and base_url ~ '^http://(localhost|127[.]0[.]0[.]1|\[::1\])(:[0-9]{1,5})?(/[^?#]*)?$'))),
  auth_type text not null default 'none' check (auth_type in ('none','bearer','api_key_header')),
  header_name text not null default '' check (
    (auth_type='none' and header_name='') or (auth_type='bearer' and header_name='Authorization') or
    (auth_type='api_key_header' and header_name ~ '^[A-Za-z][A-Za-z0-9-]{0,63}$' and
      lower(header_name) not in ('authorization','cookie','set-cookie','host','content-length','connection',
        'proxy-authorization','proxy-authenticate','transfer-encoding','te','trailer','upgrade','forwarded',
        'accept','accept-encoding','content-type','origin','referer','user-agent','expect') and
      lower(header_name) not like 'x-forwarded-%' and lower(header_name) not like 'proxy-%')),
  timeout_ms integer not null default 5000 check (timeout_ms between 100 and 30000),
  version integer not null default 1 check (version>0),
  config_version integer not null default 1 check (config_version>0),
  credential_version integer not null default 0 check (credential_version>=0),
  health_status text not null default 'unknown' check (health_status in ('unknown','reachable','failed','stale')),
  last_checked_at timestamptz,
  last_status_code integer check (last_status_code between 100 and 599),
  last_duration_ms integer check (last_duration_ms between 0 and 60000),
  last_message_code text check (last_message_code in ('reachable','invalid_url','invalid_policy','invalid_timeout',
    'target_not_allowed','target_blocked','dns_failed','connection_failed','timeout','redirect_blocked','response_too_large','stale')),
  deleted_at timestamptz,
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id,tenant_id,application_id),
  unique(tenant_id,application_id,environment,code),
  foreign key (application_id,tenant_id) references public.bff_applications(id,tenant_id),
  foreign key (created_by,tenant_id) references public.bff_members(id,tenant_id),
  foreign key (updated_by,tenant_id) references public.bff_members(id,tenant_id)
);
alter table public.bff_upstream_services drop constraint if exists bff_upstream_services_header_name_check;
alter table public.bff_upstream_services add constraint bff_upstream_services_header_name_check check (
  (auth_type='none' and header_name='') or (auth_type='bearer' and header_name='Authorization') or
  (auth_type='api_key_header' and header_name ~ '^[A-Za-z][A-Za-z0-9-]{0,63}$' and
    lower(header_name) not in ('authorization','cookie','set-cookie','host','content-length','connection',
      'proxy-authorization','proxy-authenticate','transfer-encoding','te','trailer','upgrade','forwarded',
      'accept','accept-encoding','content-type','origin','referer','user-agent','expect') and
    lower(header_name) not like 'x-forwarded-%' and lower(header_name) not like 'proxy-%'));
create index if not exists bff_upstreams_scope_idx on public.bff_upstream_services(tenant_id,application_id,environment,status,created_at desc,id) where deleted_at is null;
create index if not exists bff_upstreams_creator_idx on public.bff_upstream_services(created_by);
create index if not exists bff_upstreams_updater_idx on public.bff_upstream_services(updated_by);
create table if not exists public.bff_upstream_credentials (
  service_id uuid primary key,
  tenant_id uuid not null,
  application_id uuid not null,
  ciphertext text not null check (length(ciphertext) between 16 and 32768),
  key_id text not null check (key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  credential_version integer not null check (credential_version>0),
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  foreign key (service_id,tenant_id,application_id) references public.bff_upstream_services(id,tenant_id,application_id),
  foreign key (updated_by,tenant_id) references public.bff_members(id,tenant_id)
);
create index if not exists bff_upstream_credentials_scope_idx on public.bff_upstream_credentials(tenant_id,application_id);
create index if not exists bff_upstream_credentials_updater_idx on public.bff_upstream_credentials(updated_by);
create table if not exists public.bff_upstream_service_revisions (
  service_id uuid not null,
  tenant_id uuid not null,
  application_id uuid not null,
  config_version integer not null check (config_version>0),
  code text not null,
  name text not null,
  description text not null,
  environment text not null,
  base_url text not null,
  auth_type text not null,
  header_name text not null,
  timeout_ms integer not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key(service_id,config_version),
  foreign key (service_id,tenant_id,application_id) references public.bff_upstream_services(id,tenant_id,application_id),
  foreign key (application_id,tenant_id) references public.bff_applications(id,tenant_id),
  foreign key (created_by,tenant_id) references public.bff_members(id,tenant_id)
);
create index if not exists bff_upstream_revisions_scope_idx on public.bff_upstream_service_revisions(tenant_id,application_id,service_id,config_version desc);
create index if not exists bff_upstream_revisions_creator_idx on public.bff_upstream_service_revisions(created_by);
create unique index if not exists bff_upstream_service_environment_uidx on public.bff_upstream_services(id,tenant_id,application_id,environment);
create unique index if not exists bff_upstream_revision_environment_uidx on public.bff_upstream_service_revisions(service_id,config_version,tenant_id,application_id,environment);
create table if not exists public.bff_interfaces (
  id uuid primary key,
  tenant_id uuid not null,
  application_id uuid not null,
  environment text not null check (environment in ('development','staging','production')),
  code text not null check (code ~ '^[a-z][a-z0-9-]{1,63}$'),
  name text not null check (length(trim(name)) between 1 and 100),
  description text not null default '' check (length(description)<=1000),
  method text not null check (method in ('GET','POST','PUT','PATCH','DELETE')),
  path text not null check (length(path) between 1 and 500 and left(path,1)='/' and left(path,2)<>'//' and path !~ '[[:cntrl:]?#\\]'),
  definition jsonb not null check (case when jsonb_typeof(definition)='object' and
    jsonb_typeof(definition->'inputs')='array' and jsonb_typeof(definition->'steps')='array' and
    jsonb_typeof(definition->'outputs')='array' then
      jsonb_array_length(definition->'inputs')<=32 and jsonb_array_length(definition->'steps') between 1 and 8 and
      jsonb_array_length(definition->'outputs') between 1 and 32 else false end),
  version integer not null default 1 check (version>0),
  validation_status text not null default 'unvalidated' check (validation_status in ('unvalidated','valid','invalid')),
  validated_version integer check (validated_version>0),
  validation_issues jsonb not null default '[]'::jsonb check (jsonb_typeof(validation_issues)='array'),
  last_validated_at timestamptz,
  last_test_status text not null default 'not_tested' check (last_test_status in ('not_tested','passed','failed','stale')),
  last_test_version integer check (last_test_version>0),
  last_test_at timestamptz,
  last_test_upstreams jsonb not null default '[]'::jsonb check (jsonb_typeof(last_test_upstreams)='array'),
  deleted_at timestamptz,
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id,tenant_id,application_id,environment),
  foreign key (application_id,tenant_id) references public.bff_applications(id,tenant_id),
  foreign key (created_by,tenant_id) references public.bff_members(id,tenant_id),
  foreign key (updated_by,tenant_id) references public.bff_members(id,tenant_id)
);
create unique index if not exists bff_interface_code_uidx on public.bff_interfaces(tenant_id,application_id,environment,code) where deleted_at is null;
create unique index if not exists bff_interface_route_uidx on public.bff_interfaces(tenant_id,application_id,environment,method,path) where deleted_at is null;
create index if not exists bff_interface_scope_idx on public.bff_interfaces(tenant_id,application_id,environment,created_at desc,id) where deleted_at is null;
create index if not exists bff_interface_creator_idx on public.bff_interfaces(created_by);
create index if not exists bff_interface_updater_idx on public.bff_interfaces(updated_by);
create table if not exists public.bff_interface_upstreams (
  interface_id uuid not null,
  step_key text not null check (step_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  service_id uuid not null,
  config_version integer not null check (config_version>0),
  tenant_id uuid not null,
  application_id uuid not null,
  environment text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key(interface_id,step_key),
  foreign key (interface_id,tenant_id,application_id,environment) references public.bff_interfaces(id,tenant_id,application_id,environment),
  foreign key (service_id,tenant_id,application_id,environment) references public.bff_upstream_services(id,tenant_id,application_id,environment),
  foreign key (service_id,config_version,tenant_id,application_id,environment)
    references public.bff_upstream_service_revisions(service_id,config_version,tenant_id,application_id,environment),
  foreign key (created_by,tenant_id) references public.bff_members(id,tenant_id)
);
create index if not exists bff_interface_upstream_service_idx on public.bff_interface_upstreams(tenant_id,application_id,service_id,interface_id);
create index if not exists bff_interface_upstream_creator_idx on public.bff_interface_upstreams(created_by);
alter table public.bff_interfaces add column if not exists last_test_upstreams jsonb not null default '[]'::jsonb;
create table if not exists public.bff_interface_versions (
  id uuid primary key default gen_random_uuid(),
  interface_id uuid not null,
  tenant_id uuid not null,
  application_id uuid not null,
  environment text not null,
  number integer not null check (number>0),
  draft_version integer not null check (draft_version>0),
  code text not null,
  name text not null,
  description text not null,
  method text not null check (method in ('GET','POST','PUT','PATCH','DELETE')),
  path text not null,
  definition jsonb not null,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  notes text not null default '' check (length(notes)<=1000),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique(interface_id,number),
  unique(id,tenant_id,application_id,environment,interface_id),
  foreign key (interface_id,tenant_id,application_id,environment)
    references public.bff_interfaces(id,tenant_id,application_id,environment),
  foreign key (created_by,tenant_id) references public.bff_members(id,tenant_id)
);
create index if not exists bff_interface_versions_scope_idx
  on public.bff_interface_versions(tenant_id,application_id,interface_id,number desc);
create index if not exists bff_interface_versions_creator_idx on public.bff_interface_versions(created_by);
create table if not exists public.bff_interface_version_upstreams (
  version_id uuid not null,
  interface_id uuid not null,
  step_key text not null,
  service_id uuid not null,
  config_version integer not null check (config_version>0),
  credential_version integer not null check (credential_version>=0),
  auth_type text not null check (auth_type in ('none','bearer','api_key_header')),
  header_name text not null,
  tenant_id uuid not null,
  application_id uuid not null,
  environment text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key(version_id,step_key),
  foreign key (version_id,tenant_id,application_id,environment,interface_id)
    references public.bff_interface_versions(id,tenant_id,application_id,environment,interface_id),
  foreign key (service_id,config_version,tenant_id,application_id,environment)
    references public.bff_upstream_service_revisions(service_id,config_version,tenant_id,application_id,environment),
  foreign key (created_by,tenant_id) references public.bff_members(id,tenant_id)
);
create index if not exists bff_interface_version_upstreams_service_idx
  on public.bff_interface_version_upstreams(tenant_id,application_id,service_id,version_id);
create index if not exists bff_interface_version_upstreams_creator_idx
  on public.bff_interface_version_upstreams(created_by);
create table if not exists public.bff_interface_deployments (
  interface_id uuid primary key,
  tenant_id uuid not null,
  application_id uuid not null,
  environment text not null,
  active_version_id uuid not null,
  enabled boolean not null default true,
  version integer not null default 1 check (version>0),
  method text not null check (method in ('GET','POST','PUT','PATCH','DELETE')),
  path text not null,
  route_shape text not null,
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (interface_id,tenant_id,application_id,environment)
    references public.bff_interfaces(id,tenant_id,application_id,environment),
  foreign key (active_version_id,tenant_id,application_id,environment,interface_id)
    references public.bff_interface_versions(id,tenant_id,application_id,environment,interface_id)
    deferrable initially immediate,
  foreign key (created_by,tenant_id) references public.bff_members(id,tenant_id),
  foreign key (updated_by,tenant_id) references public.bff_members(id,tenant_id)
);
create unique index if not exists bff_interface_deployment_route_uidx
  on public.bff_interface_deployments(tenant_id,application_id,environment,method,route_shape) where enabled;
create index if not exists bff_interface_deployments_actor_idx on public.bff_interface_deployments(updated_by);
create table if not exists public.bff_interface_release_events (
  id uuid primary key default gen_random_uuid(),
  interface_id uuid not null,
  tenant_id uuid not null,
  application_id uuid not null,
  environment text not null,
  action text not null check (action in ('publish','rollback','enable','disable')),
  from_version_id uuid,
  to_version_id uuid not null,
  deployment_version integer not null check (deployment_version>0),
  notes text not null default '' check (length(notes)<=1000),
  actor_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (interface_id,tenant_id,application_id,environment)
    references public.bff_interfaces(id,tenant_id,application_id,environment),
  foreign key (from_version_id,tenant_id,application_id,environment,interface_id)
    references public.bff_interface_versions(id,tenant_id,application_id,environment,interface_id),
  foreign key (to_version_id,tenant_id,application_id,environment,interface_id)
    references public.bff_interface_versions(id,tenant_id,application_id,environment,interface_id),
  foreign key (actor_id,tenant_id) references public.bff_members(id,tenant_id)
);
create index if not exists bff_interface_release_events_scope_idx
  on public.bff_interface_release_events(tenant_id,application_id,interface_id,created_at desc,id);
create index if not exists bff_interface_release_events_actor_idx on public.bff_interface_release_events(actor_id);
create table if not exists public.bff_interface_calls (
  request_id uuid primary key,
  tenant_id uuid not null,
  application_id uuid not null,
  environment text not null,
  interface_id uuid not null,
  version_id uuid not null,
  member_id uuid not null,
  deployment_version integer not null check (deployment_version>0),
  method text not null check (method in ('GET','POST','PUT','PATCH','DELETE')),
  path_template text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '45 seconds'),
  finished_at timestamptz,
  duration_ms integer check (duration_ms between 0 and 60000),
  status text not null default 'running' check (status in ('running','succeeded','failed','unknown')),
  http_status integer check (http_status between 100 and 599),
  error_code text check (length(error_code)<=80 and error_code ~ '^[A-Z][A-Z0-9_]*$'),
  steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps)='array' and jsonb_array_length(steps)<=8),
  idempotency_hash text check (idempotency_hash ~ '^[0-9a-f]{64}$'),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  result_payload text check (length(result_payload)<=131072),
  result_expires_at timestamptz,
  foreign key (interface_id,tenant_id,application_id,environment)
    references public.bff_interfaces(id,tenant_id,application_id,environment),
  foreign key (version_id,tenant_id,application_id,environment,interface_id)
    references public.bff_interface_versions(id,tenant_id,application_id,environment,interface_id),
  foreign key (member_id,tenant_id) references public.bff_members(id,tenant_id)
);
alter table public.bff_interface_calls add column if not exists error_class text;
alter table public.bff_interface_calls drop constraint if exists bff_interface_calls_error_class_check;
alter table public.bff_interface_calls add constraint bff_interface_calls_error_class_check
  check (error_class in ('timeout','upstream','unknown','authorization','validation','rate_limited'));
create unique index if not exists bff_interface_calls_idempotency_uidx
  on public.bff_interface_calls(tenant_id,member_id,idempotency_hash) where idempotency_hash is not null;
create index if not exists bff_interface_calls_scope_time_idx
  on public.bff_interface_calls(tenant_id,application_id,interface_id,started_at desc);
create index if not exists bff_interface_calls_actor_time_idx
  on public.bff_interface_calls(member_id,started_at desc);
create index if not exists bff_interface_calls_tenant_time_idx
  on public.bff_interface_calls(tenant_id,started_at desc);
create index if not exists bff_interface_calls_running_idx
  on public.bff_interface_calls(tenant_id,expires_at) where status='running';
create index if not exists bff_interface_calls_replay_expiry_idx
  on public.bff_interface_calls(tenant_id,result_expires_at) where result_payload is not null;
create index if not exists bff_interface_calls_monitor_idx
  on public.bff_interface_calls(tenant_id,application_id,environment,started_at desc,request_id desc);
create index if not exists bff_interface_calls_status_monitor_idx
  on public.bff_interface_calls(tenant_id,application_id,environment,status,error_class,started_at desc);
create table if not exists public.bff_alert_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  application_id uuid not null,
  environment text not null check (environment in ('development','staging','production')),
  interface_id uuid,
  name text not null check (length(trim(name)) between 1 and 100),
  metric text not null check (metric in ('failure_count','failure_rate','timeout_count','unknown_count')),
  window_minutes integer not null check (window_minutes in (5,15,60)),
  threshold numeric(8,2) not null check (threshold>0),
  min_calls integer not null default 1 check (min_calls between 1 and 1000000),
  severity text not null check (severity in ('warning','critical')),
  enabled boolean not null default false,
  quiet_minutes integer not null default 0 check (quiet_minutes between 0 and 1440),
  version integer not null default 1 check (version>0),
  archived_at timestamptz,
  last_evaluated_at timestamptz,
  last_triggered_at timestamptz,
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((metric='failure_rate' and threshold between 0.1 and 100) or
    (metric<>'failure_rate' and threshold>=1 and threshold=trunc(threshold))),
  foreign key (application_id,tenant_id) references public.bff_applications(id,tenant_id),
  foreign key (interface_id,tenant_id,application_id,environment)
    references public.bff_interfaces(id,tenant_id,application_id,environment),
  foreign key (created_by,tenant_id) references public.bff_members(id,tenant_id),
  foreign key (updated_by,tenant_id) references public.bff_members(id,tenant_id)
);
create unique index if not exists bff_alert_rules_id_scope_uidx
  on public.bff_alert_rules(id,tenant_id,application_id,environment);
create index if not exists bff_alert_rules_eval_idx
  on public.bff_alert_rules(last_evaluated_at nulls first,id) where enabled and archived_at is null;
create index if not exists bff_alert_rules_scope_idx
  on public.bff_alert_rules(tenant_id,application_id,environment,created_at desc,id);
create table if not exists public.bff_alert_instances (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null,
  tenant_id uuid not null,
  application_id uuid not null,
  environment text not null,
  interface_id uuid,
  metric text not null check (metric in ('failure_count','failure_rate','timeout_count','unknown_count')),
  severity text not null check (severity in ('warning','critical')),
  state text not null check (state in ('open','acknowledged','recovered','closed')),
  observed_value numeric(10,2) not null check (observed_value>=0),
  known_calls integer not null check (known_calls>=0),
  failed_calls integer not null check (failed_calls>=0),
  unknown_calls integer not null check (unknown_calls>=0),
  window_started_at timestamptz not null,
  window_ended_at timestamptz not null,
  opened_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  recovered_at timestamptz,
  closed_at timestamptz,
  closed_reason text check (closed_reason in ('disabled','archived','reconfigured')),
  last_observed_at timestamptz not null default now(),
  version integer not null default 1 check (version>0),
  check ((state='acknowledged')=(acknowledged_at is not null and recovered_at is null and closed_at is null) or
    (state in ('recovered','closed') and (recovered_at is not null or closed_at is not null)) or
    (state='open' and acknowledged_at is null and recovered_at is null and closed_at is null)),
  check ((state='recovered' and recovered_at is not null and closed_at is null and closed_reason is null) or
    (state='closed' and closed_at is not null and recovered_at is null and closed_reason is not null) or
    (state in ('open','acknowledged') and recovered_at is null and closed_at is null and closed_reason is null)),
  foreign key (rule_id,tenant_id,application_id,environment)
    references public.bff_alert_rules(id,tenant_id,application_id,environment),
  foreign key (acknowledged_by,tenant_id) references public.bff_members(id,tenant_id)
);
create unique index if not exists bff_alert_instance_unfinished_uidx
  on public.bff_alert_instances(rule_id) where state in ('open','acknowledged');
create index if not exists bff_alert_instances_scope_idx
  on public.bff_alert_instances(tenant_id,application_id,environment,opened_at desc,id);
create or replace function public.bff_valid_branding(p_config jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare item text; address text;
begin
  if jsonb_typeof(p_config) is distinct from 'object' or not (p_config ?& array[
    'siteName','siteShortName','siteDescription','logoUrl','faviconUrl',
    'watermarkEnabled','watermarkContentType','watermarkCustomText']) or
    exists(select 1 from jsonb_object_keys(p_config) as k(name) where k.name not in (
      'siteName','siteShortName','siteDescription','logoUrl','faviconUrl',
      'watermarkEnabled','watermarkContentType','watermarkCustomText'))
  then return false; end if;
  foreach item in array array['siteName','siteShortName','siteDescription','logoUrl','faviconUrl',
    'watermarkContentType','watermarkCustomText'] loop
    if jsonb_typeof(p_config->item) is distinct from 'string' then return false; end if;
  end loop;
  if length(trim(p_config->>'siteName')) not between 1 and 60 or
    length(p_config->>'siteShortName')>40 or length(p_config->>'siteDescription')>255 or
    jsonb_typeof(p_config->'watermarkEnabled') is distinct from 'boolean' or
    p_config->>'watermarkContentType' not in ('username','username_time','site_name','custom') or
    length(p_config->>'watermarkCustomText')>80
  then return false; end if;
  if (p_config->>'watermarkEnabled')::boolean and p_config->>'watermarkContentType'='custom' and
    length(trim(p_config->>'watermarkCustomText'))=0 then return false; end if;
  foreach item in array array['logoUrl','faviconUrl'] loop
    address:=p_config->>item;
    if length(address)>2000 or address ~ '[[:space:]\\?#]' or left(address,2)='//' or
      (address<>'' and address !~ '^https://[^/@[:space:]?#]+(/[^[:space:]?#]*)?$' and
        address !~ '^/[^/[:space:]?#][^[:space:]?#]*$') or
      address ~ '(^|/)\.{1,2}(/|$)'
    then return false; end if;
  end loop;
  return true;
end $$;
create table if not exists public.bff_platform_settings (
  tenant_id uuid primary key,
  config jsonb not null check (public.bff_valid_branding(config)),
  version integer not null default 1 check (version>0),
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (created_by,tenant_id) references public.bff_members(id,tenant_id),
  foreign key (updated_by,tenant_id) references public.bff_members(id,tenant_id)
);
create index if not exists bff_platform_settings_creator_idx on public.bff_platform_settings(created_by);
create index if not exists bff_platform_settings_updater_idx on public.bff_platform_settings(updated_by);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('bff-assets','bff-assets',false,10485760,array[
    'image/png','image/jpeg','image/webp','image/gif','image/x-icon','image/vnd.microsoft.icon',
    'application/pdf','application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint',
    'audio/mpeg','video/mp4','audio/ogg','audio/wav','video/webm','application/zip',
    'text/plain','text/csv','application/json',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
  on conflict(id) do nothing;
do $$ begin
  if not exists(select 1 from storage.buckets where id='bff-assets' and name='bff-assets' and not public and
    file_size_limit=10485760 and allowed_mime_types @> array[
      'image/png','image/jpeg','image/webp','image/gif','image/x-icon','image/vnd.microsoft.icon',
      'application/pdf','application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint',
      'audio/mpeg','video/mp4','audio/ogg','audio/wav','video/webm','application/zip',
      'text/plain','text/csv','application/json',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
  then raise exception 'BFF_RESOURCE_BUCKET_POLICY_MISMATCH'; end if;
end $$;
create table if not exists public.bff_resources (
  id bigint generated always as identity primary key check (id between 1 and 9007199254740991),
  tenant_id uuid not null,
  storage_bucket text not null default 'bff-assets' check (storage_bucket='bff-assets'),
  storage_path text not null,
  object_name text not null,
  origin_name text not null check (length(trim(origin_name)) between 1 and 255 and origin_name !~ '[[:cntrl:]/\\]'),
  mime_type text not null check (length(mime_type) between 3 and 150 and
    mime_type ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$'),
  suffix text not null check (suffix ~ '^[a-z0-9]{1,10}$'),
  size_byte bigint not null check (size_byte between 1 and 10485760),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending','ready','deleting','deleted')),
  upload_token_hash text check (upload_token_hash ~ '^[0-9a-f]{64}$'),
  cleanup_token_hash text check (cleanup_token_hash ~ '^[0-9a-f]{64}$'),
  cleanup_lease_until timestamptz,
  version integer not null default 1 check (version>0),
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(storage_bucket,storage_path,object_name),
  unique(id,tenant_id),
  check (storage_path=tenant_id::text and object_name ~ '^[0-9a-f-]{36}[.][a-z0-9]{1,10}$'),
  check ((status='pending' and upload_token_hash is not null and deleted_at is null) or
    (status='ready' and upload_token_hash is null and deleted_at is null) or
    (status='deleting' and upload_token_hash is null and deleted_at is null) or
    (status='deleted' and upload_token_hash is null and deleted_at is not null)),
  foreign key (created_by,tenant_id) references public.bff_members(id,tenant_id),
  foreign key (updated_by,tenant_id) references public.bff_members(id,tenant_id)
);
create index if not exists bff_resources_tenant_ready_idx
  on public.bff_resources(tenant_id,created_at desc,id desc) where status='ready';
create index if not exists bff_resources_cleanup_idx
  on public.bff_resources(status,created_at,id) where status in ('pending','deleting');
revoke all on sequence public.bff_resources_id_seq from public,anon,authenticated,service_role;
grant usage,select on sequence public.bff_resources_id_seq to service_role;
create or replace function public.bff_guard_resource_identity()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if NEW.id is distinct from OLD.id or NEW.tenant_id is distinct from OLD.tenant_id or
    NEW.storage_bucket is distinct from OLD.storage_bucket or NEW.storage_path is distinct from OLD.storage_path or
    NEW.object_name is distinct from OLD.object_name or NEW.hash is distinct from OLD.hash or
    NEW.mime_type is distinct from OLD.mime_type or NEW.suffix is distinct from OLD.suffix or
    NEW.size_byte is distinct from OLD.size_byte or NEW.created_by is distinct from OLD.created_by or
    NEW.created_at is distinct from OLD.created_at or NEW.version<OLD.version or
    (OLD.status='pending' and NEW.status not in ('pending','ready','deleting')) or
    (OLD.status='ready' and NEW.status not in ('ready','deleting')) or
    (OLD.status='deleting' and NEW.status not in ('deleting','deleted')) or
    (OLD.status='deleted' and NEW.status<>'deleted')
  then raise exception 'BFF_RESOURCE_IDENTITY_IMMUTABLE'; end if;
  return NEW;
end $$;
drop trigger if exists bff_resource_identity_guard on public.bff_resources;
create trigger bff_resource_identity_guard before update on public.bff_resources
  for each row execute function public.bff_guard_resource_identity();
create or replace function public.bff_guard_branding_identity()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if NEW.tenant_id is distinct from OLD.tenant_id or NEW.created_by is distinct from OLD.created_by or
    NEW.created_at is distinct from OLD.created_at then raise exception 'BFF_INVALID_BRANDING_SCOPE'; end if;
  return NEW;
end $$;
drop trigger if exists bff_platform_settings_scope_guard on public.bff_platform_settings;
create trigger bff_platform_settings_scope_guard before update on public.bff_platform_settings
  for each row execute function public.bff_guard_branding_identity();
create table if not exists public.bff_resource_revisions (
  tenant_id uuid not null,
  resource text not null check (resource in ('menus','dictionaries','roles','members','upstreams','interfaces','releases','branding','alerts','resources')),
  version bigint not null default 1 check (version > 0),
  primary key (tenant_id,resource)
);
alter table public.bff_resource_revisions drop constraint if exists bff_resource_revisions_resource_check;
alter table public.bff_resource_revisions add constraint bff_resource_revisions_resource_check
  check (resource in ('menus','dictionaries','roles','members','upstreams','interfaces','releases','branding','alerts','resources'));
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
create or replace function public.bff_guard_upstream_scope()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if TG_OP='UPDATE' then
    if NEW.id is distinct from OLD.id or NEW.tenant_id is distinct from OLD.tenant_id or
      NEW.application_id is distinct from OLD.application_id or NEW.code is distinct from OLD.code or
      NEW.environment is distinct from OLD.environment or NEW.created_by is distinct from OLD.created_by or
      NEW.created_at is distinct from OLD.created_at
    then raise exception using errcode='23514',message='BFF_UPSTREAM_IDENTITY_IMMUTABLE'; end if;
  end if;
  if not exists(select 1 from public.bff_members where id=NEW.created_by and tenant_id=NEW.tenant_id) or
    not exists(select 1 from public.bff_members where id=NEW.updated_by and tenant_id=NEW.tenant_id)
  then raise exception using errcode='23514',message='BFF_UPSTREAM_ACTOR_SCOPE_INVALID'; end if;
  return NEW;
end $$;
drop trigger if exists bff_upstream_scope_guard on public.bff_upstream_services;
create trigger bff_upstream_scope_guard before insert or update on public.bff_upstream_services
for each row execute function public.bff_guard_upstream_scope();
create or replace function public.bff_guard_upstream_credential()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if TG_OP='UPDATE' then
    if NEW.service_id is distinct from OLD.service_id or NEW.tenant_id is distinct from OLD.tenant_id or
      NEW.application_id is distinct from OLD.application_id or NEW.credential_version<=OLD.credential_version
    then raise exception using errcode='23514',message='BFF_CREDENTIAL_VERSION_INVALID'; end if;
  end if;
  if not exists(select 1 from public.bff_members where id=NEW.updated_by and tenant_id=NEW.tenant_id) or
    not exists(select 1 from public.bff_upstream_services s where s.id=NEW.service_id and s.tenant_id=NEW.tenant_id and
      s.application_id=NEW.application_id and s.credential_version=NEW.credential_version and s.auth_type<>'none' and s.deleted_at is null)
  then raise exception using errcode='23514',message='BFF_CREDENTIAL_SCOPE_INVALID'; end if;
  return NEW;
end $$;
drop trigger if exists bff_upstream_credential_guard on public.bff_upstream_credentials;
create trigger bff_upstream_credential_guard before insert or update on public.bff_upstream_credentials
for each row execute function public.bff_guard_upstream_credential();
create or replace function public.bff_guard_upstream_revision()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if TG_OP<>'INSERT' then raise exception using errcode='23514',message='BFF_UPSTREAM_REVISION_IMMUTABLE'; end if;
  if not exists(select 1 from public.bff_upstream_services s where s.id=NEW.service_id and s.tenant_id=NEW.tenant_id and
    s.application_id=NEW.application_id and s.config_version=NEW.config_version and s.code=NEW.code and
    s.name=NEW.name and s.description=NEW.description and s.environment=NEW.environment and s.base_url=NEW.base_url and
    s.auth_type=NEW.auth_type and s.header_name=NEW.header_name and s.timeout_ms=NEW.timeout_ms)
  then raise exception using errcode='23514',message='BFF_UPSTREAM_REVISION_SCOPE_INVALID'; end if;
  return NEW;
end $$;
drop trigger if exists bff_upstream_revision_guard on public.bff_upstream_service_revisions;
create trigger bff_upstream_revision_guard before insert or update or delete on public.bff_upstream_service_revisions
for each row execute function public.bff_guard_upstream_revision();
create or replace function public.bff_guard_upstream_active_credential()
returns trigger language plpgsql security invoker set search_path='' as $$
declare target_id uuid;
begin
  if TG_TABLE_NAME='bff_upstream_services' then target_id:=NEW.id;
  elsif TG_OP='DELETE' then target_id:=OLD.service_id;
  else target_id:=NEW.service_id; end if;
  if exists(select 1 from public.bff_upstream_services s where s.id=target_id and s.deleted_at is null and
    s.status='active' and s.auth_type<>'none' and not exists(select 1 from public.bff_upstream_credentials c
      where c.service_id=s.id and c.credential_version=s.credential_version))
  then raise exception using errcode='23514',message='BFF_UPSTREAM_REQUIRES_CREDENTIAL'; end if;
  return null;
end $$;
drop trigger if exists bff_upstream_active_credential_guard on public.bff_upstream_services;
create constraint trigger bff_upstream_active_credential_guard after insert or update on public.bff_upstream_services
deferrable initially deferred for each row execute function public.bff_guard_upstream_active_credential();
drop trigger if exists bff_upstream_credential_active_guard on public.bff_upstream_credentials;
create constraint trigger bff_upstream_credential_active_guard after insert or update or delete on public.bff_upstream_credentials
deferrable initially deferred for each row execute function public.bff_guard_upstream_active_credential();
revoke all on function public.bff_guard_upstream_scope(),public.bff_guard_upstream_credential(),public.bff_guard_upstream_revision(),
  public.bff_guard_upstream_active_credential() from public,anon,authenticated;
grant execute on function public.bff_guard_upstream_scope(),public.bff_guard_upstream_credential(),public.bff_guard_upstream_revision(),
  public.bff_guard_upstream_active_credential() to service_role;
create or replace function public.bff_guard_interface_scope()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if TG_OP='UPDATE' then
    if NEW.id is distinct from OLD.id or NEW.tenant_id is distinct from OLD.tenant_id or
      NEW.application_id is distinct from OLD.application_id or NEW.environment is distinct from OLD.environment or
      NEW.code is distinct from OLD.code or NEW.created_by is distinct from OLD.created_by or
      NEW.created_at is distinct from OLD.created_at
    then raise exception using errcode='23514',message='BFF_INTERFACE_IDENTITY_IMMUTABLE'; end if;
  end if;
  if not exists(select 1 from public.bff_members where id=NEW.created_by and tenant_id=NEW.tenant_id) or
    not exists(select 1 from public.bff_members where id=NEW.updated_by and tenant_id=NEW.tenant_id)
  then raise exception using errcode='23514',message='BFF_INTERFACE_ACTOR_SCOPE_INVALID'; end if;
  return NEW;
end $$;
drop trigger if exists bff_interface_scope_guard on public.bff_interfaces;
create trigger bff_interface_scope_guard before insert or update on public.bff_interfaces
for each row execute function public.bff_guard_interface_scope();
revoke all on function public.bff_guard_interface_scope() from public,anon,authenticated;
grant execute on function public.bff_guard_interface_scope() to service_role;
create or replace function public.bff_guard_release_immutable()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  raise exception using errcode='23514',message='BFF_RELEASE_HISTORY_IMMUTABLE';
end $$;
drop trigger if exists bff_interface_versions_immutable on public.bff_interface_versions;
create trigger bff_interface_versions_immutable before update or delete on public.bff_interface_versions
for each row execute function public.bff_guard_release_immutable();
drop trigger if exists bff_interface_version_upstreams_immutable on public.bff_interface_version_upstreams;
create trigger bff_interface_version_upstreams_immutable before update or delete on public.bff_interface_version_upstreams
for each row execute function public.bff_guard_release_immutable();
drop trigger if exists bff_interface_release_events_immutable on public.bff_interface_release_events;
create trigger bff_interface_release_events_immutable before update or delete on public.bff_interface_release_events
for each row execute function public.bff_guard_release_immutable();
create or replace function public.bff_guard_release_deployment()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if TG_OP='UPDATE' and (NEW.interface_id is distinct from OLD.interface_id or
    NEW.tenant_id is distinct from OLD.tenant_id or NEW.application_id is distinct from OLD.application_id or
    NEW.environment is distinct from OLD.environment or NEW.created_by is distinct from OLD.created_by or
    NEW.created_at is distinct from OLD.created_at)
  then raise exception using errcode='23514',message='BFF_RELEASE_IDENTITY_IMMUTABLE'; end if;
  if NEW.route_shape is distinct from pg_catalog.regexp_replace(NEW.path,'\{[A-Za-z][A-Za-z0-9_]*\}','{}','g')
  then raise exception using errcode='23514',message='BFF_RELEASE_ROUTE_SHAPE'; end if;
  return NEW;
end $$;
drop trigger if exists bff_interface_deployment_scope_guard on public.bff_interface_deployments;
create trigger bff_interface_deployment_scope_guard before insert or update on public.bff_interface_deployments
for each row execute function public.bff_guard_release_deployment();
create or replace function public.bff_guard_call_identity()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if NEW.request_id is distinct from OLD.request_id or NEW.tenant_id is distinct from OLD.tenant_id or
    NEW.application_id is distinct from OLD.application_id or NEW.environment is distinct from OLD.environment or
    NEW.interface_id is distinct from OLD.interface_id or NEW.version_id is distinct from OLD.version_id or
    NEW.member_id is distinct from OLD.member_id or NEW.deployment_version is distinct from OLD.deployment_version or
    NEW.method is distinct from OLD.method or NEW.path_template is distinct from OLD.path_template or
    NEW.started_at is distinct from OLD.started_at or NEW.idempotency_hash is distinct from OLD.idempotency_hash or
    NEW.input_hash is distinct from OLD.input_hash or
    (OLD.status<>'running' and
      (NEW.status is distinct from OLD.status or NEW.finished_at is distinct from OLD.finished_at or
       NEW.duration_ms is distinct from OLD.duration_ms or NEW.http_status is distinct from OLD.http_status or
       NEW.error_code is distinct from OLD.error_code or NEW.error_class is distinct from OLD.error_class or NEW.steps is distinct from OLD.steps or
       NEW.result_payload is not null or NEW.result_expires_at is not null))
  then raise exception using errcode='23514',message='BFF_CALL_IDENTITY_IMMUTABLE'; end if;
  return NEW;
end $$;
drop trigger if exists bff_interface_call_identity_guard on public.bff_interface_calls;
create trigger bff_interface_call_identity_guard before update on public.bff_interface_calls
for each row execute function public.bff_guard_call_identity();
revoke all on function public.bff_guard_release_immutable(),public.bff_guard_release_deployment(),
  public.bff_guard_call_identity() from public,anon,authenticated;
grant execute on function public.bff_guard_release_immutable(),public.bff_guard_release_deployment(),
  public.bff_guard_call_identity() to service_role;

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
    (p_catalog and public.bff_actor_can(p_actor,'System:Role:AssignPermission')))
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

-- Membership identity is established only by the verified pro onboarding path.
create or replace function public.bff_guard_member_identity()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if NEW.id is distinct from OLD.id or NEW.tenant_id is distinct from OLD.tenant_id or
    NEW.issuer is distinct from OLD.issuer or NEW.subject is distinct from OLD.subject or NEW.created_at is distinct from OLD.created_at
  then raise exception using errcode='23514',message='BFF_MEMBER_IDENTITY_IMMUTABLE'; end if;
  if NEW.updated_by is not null and not exists(select 1 from public.bff_members where id=NEW.updated_by and tenant_id=NEW.tenant_id)
  then raise exception using errcode='23514',message='BFF_MEMBER_ACTOR_SCOPE_INVALID'; end if;
  return NEW;
end $$;
drop trigger if exists bff_member_identity_guard on public.bff_members;
create trigger bff_member_identity_guard before update on public.bff_members for each row execute function public.bff_guard_member_identity();

create or replace function public.bff_read_roles(p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare tenant uuid; result jsonb;
begin
  select tenant_id into tenant from public.bff_members where id=p_actor and enabled;
  if tenant is null or not public.bff_actor_can(p_actor,'System:Role:View') then raise exception 'BFF_FORBIDDEN'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'tenantId',r.tenant_id,'roleName',r.role_name,'roleCode',r.role_code,
    'description',r.description,'enabled',r.enabled,'builtinType',r.builtin_type,'version',r.version,
    'createTime',r.create_time,'createBy',m.display_name) order by r.create_time desc,r.id),'[]'::jsonb) into result
    from public.bff_roles r join public.bff_members m on m.id=r.create_by where r.tenant_id=tenant;
  return jsonb_build_object('records',result,'revision',coalesce((select version from public.bff_resource_revisions where tenant_id=tenant and resource='roles'),1));
end $$;

-- Any delegated role operation is capped by the actor's current effective buttons.
-- A label, folder, custom role name, or builtin_type never grants base administrator status.
create or replace function public.bff_role_within_authority(p_actor uuid,p_role uuid)
returns boolean language sql stable security invoker set search_path='' as $$
select exists(select 1 from public.bff_members a join public.bff_roles r on r.id=p_role and r.tenant_id=a.tenant_id
  where a.id=p_actor and a.enabled and (a.role='admin' or not exists(
    select 1 from public.bff_role_menus rm join public.bff_menus n on n.id=rm.menu_id
    where rm.role_id=r.id and n.type='button' and not public.bff_actor_can(p_actor,n.name)
  )))
$$;

create or replace function public.bff_write_role(p_actor uuid,p_operation text,p_payload jsonb,p_revision bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare tenant uuid; revision bigint; definition jsonb:=p_payload->'definition'; saved public.bff_roles; target uuid;
begin
  if p_operation not in ('create','update','delete') then raise exception 'BFF_INVALID_OPERATION'; end if;
  revision:=public.bff_control_lock(p_actor,'System:Role:'||case p_operation when 'create' then 'Add' when 'update' then 'Edit' else 'Delete' end,'roles');
  if p_revision is distinct from revision then raise exception 'BFF_CONFLICT'; end if;
  select tenant_id into tenant from public.bff_members where id=p_actor;
  target:=nullif(coalesce(definition->>'id',p_payload->>'id'),'')::uuid;
  if p_operation<>'create' then
    select * into saved from public.bff_roles where id=target and tenant_id=tenant for update;
    if saved.id is null then raise exception 'BFF_NOT_FOUND'; end if;
    if saved.builtin_type is not null then raise exception 'BFF_BUILTIN_PROTECTED'; end if;
    if not public.bff_role_within_authority(p_actor,saved.id) then raise exception 'BFF_FORBIDDEN'; end if;
    if saved.version is distinct from (coalesce(definition->>'version',p_payload->>'version'))::integer then raise exception 'BFF_CONFLICT'; end if;
  end if;
  if p_operation='create' then
    insert into public.bff_roles(tenant_id,role_code,role_name,description,enabled,create_by,update_by)
      values(tenant,definition->>'roleCode',definition->>'roleName',coalesce(definition->>'description',''),(definition->>'enabled')::boolean,p_actor,p_actor) returning * into saved;
  elsif p_operation='update' then
    update public.bff_roles set role_code=definition->>'roleCode',role_name=definition->>'roleName',description=coalesce(definition->>'description',''),
      enabled=(definition->>'enabled')::boolean,version=version+1,update_by=p_actor,update_time=now() where id=saved.id returning * into saved;
  else
    if exists(select 1 from public.bff_member_roles where role_id=saved.id) then raise exception 'BFF_REFERENCED'; end if;
    delete from public.bff_role_menus where role_id=saved.id and tenant_id=tenant;
    delete from public.bff_roles where id=saved.id;
  end if;
  revision:=public.bff_control_advance(p_actor,'roles','role.'||p_operation,saved.id,jsonb_build_object('roleCode',saved.role_code));
  return jsonb_build_object('saved',true,'id',saved.id,'revision',revision);
end $$;

create or replace function public.bff_read_role_menus(p_actor uuid,p_role uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare tenant uuid; target public.bff_roles;
begin
  select tenant_id into tenant from public.bff_members where id=p_actor and enabled;
  if tenant is null or not public.bff_actor_can(p_actor,'System:Role:AssignPermission') then raise exception 'BFF_FORBIDDEN'; end if;
  select * into target from public.bff_roles where id=p_role and tenant_id=tenant;
  if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_role_within_authority(p_actor,p_role) then raise exception 'BFF_FORBIDDEN'; end if;
  return jsonb_build_object('records',coalesce((select jsonb_agg(jsonb_build_object('menuId',menu_id) order by menu_id) from public.bff_role_menus where role_id=p_role and tenant_id=tenant),'[]'::jsonb),
    'revision',coalesce((select version from public.bff_resource_revisions where tenant_id=tenant and resource='roles'),1),
    'menuRevision',coalesce((select version from public.bff_resource_revisions where tenant_id=tenant and resource='menus'),1),'roleVersion',target.version);
end $$;

create or replace function public.bff_set_role_menus(p_actor uuid,p_role uuid,p_ids uuid[],p_expected uuid[],p_revision bigint,p_menu_revision bigint,p_role_version integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare tenant uuid; revision bigint; target public.bff_roles; current_ids uuid[];
begin
  revision:=public.bff_control_lock(p_actor,'System:Role:AssignPermission','roles');
  select tenant_id into tenant from public.bff_members where id=p_actor;
  select * into target from public.bff_roles where id=p_role and tenant_id=tenant for update;
  if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if target.builtin_type is not null then raise exception 'BFF_BUILTIN_PROTECTED'; end if;
  if not public.bff_role_within_authority(p_actor,p_role) then raise exception 'BFF_FORBIDDEN'; end if;
  select coalesce(array_agg(menu_id order by menu_id),array[]::uuid[]) into current_ids from public.bff_role_menus where role_id=p_role and tenant_id=tenant;
  if p_revision is distinct from revision or p_role_version is distinct from target.version or p_expected is null or
    current_ids is distinct from array(select unnest(p_expected) order by 1) or
    p_menu_revision is distinct from coalesce((select version from public.bff_resource_revisions where tenant_id=tenant and resource='menus'),1)
  then raise exception 'BFF_CONFLICT'; end if;
  if p_ids is null or cardinality(p_ids)>2000 or cardinality(p_ids)<>(select count(distinct x) from unnest(p_ids) x) then raise exception 'BFF_INVALID_GRANTS'; end if;
  if exists(select 1 from unnest(p_ids) requested where not exists(select 1 from public.bff_menus where id=requested and tenant_id=tenant)) then raise exception 'BFF_NOT_FOUND'; end if;
  if exists(select 1 from public.bff_menus where id=any(p_ids) and type='button' and not public.bff_actor_can(p_actor,name)) then raise exception 'BFF_FORBIDDEN'; end if;
  -- A page checkbox is presentation only. Each operation, including View, is explicit.
  delete from public.bff_role_menus where role_id=p_role and tenant_id=tenant and not(menu_id=any(p_ids));
  insert into public.bff_role_menus(tenant_id,role_id,menu_id,create_by) select tenant,p_role,id,p_actor from unnest(p_ids) id on conflict do nothing;
  update public.bff_roles set version=version+1,update_by=p_actor,update_time=now() where id=p_role;
  revision:=public.bff_control_advance(p_actor,'roles','role.permissions',p_role,jsonb_build_object('count',cardinality(p_ids)));
  return jsonb_build_object('saved',true,'revision',revision);
end $$;

create or replace function public.bff_read_role_users(p_actor uuid,p_role uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare tenant uuid;
begin
  select tenant_id into tenant from public.bff_members where id=p_actor and enabled;
  if tenant is null or not public.bff_actor_can(p_actor,'System:Role:AssignUser') then raise exception 'BFF_FORBIDDEN'; end if;
  if not exists(select 1 from public.bff_roles where id=p_role and tenant_id=tenant) then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_role_within_authority(p_actor,p_role) then raise exception 'BFF_FORBIDDEN'; end if;
  return jsonb_build_object('records',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'nickName',m.display_name,'userName',m.email,'userEmail',m.email,
    'avatar',null,'status',case when m.enabled then '1' else '2' end,'assigned',exists(select 1 from public.bff_member_roles where member_id=m.id and role_id=p_role)) order by m.created_at,m.id)
    from public.bff_members m where m.tenant_id=tenant),'[]'::jsonb));
end $$;

create or replace function public.bff_set_role_users(p_actor uuid,p_role uuid,p_ids uuid[],p_expected uuid[])
returns jsonb language plpgsql security invoker set search_path='' as $$
declare tenant uuid; revision bigint; target public.bff_roles; current_ids uuid[]; actor_admin boolean;
begin
  revision:=public.bff_control_lock(p_actor,'System:Role:AssignUser','roles');
  select tenant_id,role='admin' into tenant,actor_admin from public.bff_members where id=p_actor;
  select * into target from public.bff_roles where id=p_role and tenant_id=tenant for update;
  if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if target.builtin_type is not null then raise exception 'BFF_BUILTIN_PROTECTED'; end if;
  if not public.bff_role_within_authority(p_actor,p_role) then raise exception 'BFF_FORBIDDEN'; end if;
  select coalesce(array_agg(member_id order by member_id),array[]::uuid[]) into current_ids from public.bff_member_roles where role_id=p_role and tenant_id=tenant;
  if p_expected is null or current_ids is distinct from array(select unnest(p_expected) order by 1) then raise exception 'BFF_CONFLICT'; end if;
  if p_ids is null or cardinality(p_ids)>500 or cardinality(p_ids)<>(select count(distinct x) from unnest(p_ids) x) then raise exception 'BFF_INVALID_GRANTS'; end if;
  if exists(select 1 from unnest(p_ids) requested where not exists(select 1 from public.bff_members where id=requested and tenant_id=tenant and enabled)) then raise exception 'BFF_NOT_FOUND'; end if;
  if not actor_admin and exists(select 1 from public.bff_members where tenant_id=tenant and role='admin' and id=any(p_ids||current_ids)) then raise exception 'BFF_FORBIDDEN'; end if;
  delete from public.bff_member_roles where role_id=p_role and tenant_id=tenant and not(member_id=any(p_ids));
  insert into public.bff_member_roles(tenant_id,role_id,member_id,create_by) select tenant,p_role,id,p_actor from unnest(p_ids) id on conflict do nothing;
  update public.bff_roles set version=version+1,update_by=p_actor,update_time=now() where id=p_role;
  revision:=public.bff_control_advance(p_actor,'roles','role.members',p_role,jsonb_build_object('count',cardinality(p_ids)));
  return jsonb_build_object('saved',true,'revision',revision);
end $$;

create or replace function public.bff_read_members(p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare tenant uuid;
begin
  select tenant_id into tenant from public.bff_members where id=p_actor and enabled;
  if tenant is null or not public.bff_actor_can(p_actor,'System:Member:View') then raise exception 'BFF_FORBIDDEN'; end if;
  return jsonb_build_object('revision',coalesce((select version from public.bff_resource_revisions where tenant_id=tenant and resource='members'),1),
    'records',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'displayName',m.display_name,'email',m.email,'role',m.role,'enabled',m.enabled,'version',m.version,
      'roleNames',coalesce((select jsonb_agg(r.role_name order by r.role_name) from public.bff_member_roles mr join public.bff_roles r on r.id=mr.role_id where mr.member_id=m.id and mr.tenant_id=tenant),'[]'::jsonb),
      'applicationCount',(select count(*) from public.bff_application_members where member_id=m.id and tenant_id=tenant),
      'sessionCount',(select count(*) from public.bff_sessions where member_id=m.id and expires_at>now()),'createdAt',m.created_at,'updatedAt',m.updated_at) order by m.created_at,m.id)
      from public.bff_members m where m.tenant_id=tenant),'[]'::jsonb));
end $$;

create or replace function public.bff_write_member(p_actor uuid,p_definition jsonb,p_revision bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare tenant uuid; actor_admin boolean; revision bigint; target public.bff_members; target_role text:=p_definition->>'role'; target_enabled boolean:=(p_definition->>'enabled')::boolean;
begin
  revision:=public.bff_control_lock(p_actor,'System:Member:Edit','members');
  if p_revision is distinct from revision then raise exception 'BFF_CONFLICT'; end if;
  select tenant_id,role='admin' into tenant,actor_admin from public.bff_members where id=p_actor;
  select * into target from public.bff_members where id=(p_definition->>'id')::uuid and tenant_id=tenant for update;
  if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if target.version is distinct from (p_definition->>'version')::integer then raise exception 'BFF_CONFLICT'; end if;
  if target_role is null or target_role not in ('admin','viewer') or target_enabled is null then raise exception 'BFF_INVALID_MEMBER'; end if;
  if not actor_admin and (target.role='admin' or target_role<>target.role) then raise exception 'BFF_FORBIDDEN'; end if;
  if target_role='admin' and target.role<>'admin' and not target.enabled then raise exception 'BFF_INVALID_MEMBER'; end if;
  if target.id=p_actor and (not target_enabled or target_role<>target.role) then raise exception 'BFF_SELF_LOCKOUT'; end if;
  if target.role='admin' and target.enabled and (not target_enabled or target_role<>'admin') and
    not exists(select 1 from public.bff_members where tenant_id=tenant and enabled and role='admin' and id<>target.id)
  then raise exception 'BFF_LAST_ADMIN'; end if;
  update public.bff_members set role=target_role,enabled=target_enabled,version=version+1,updated_by=p_actor,updated_at=now() where id=target.id;
  if not target_enabled then
    delete from public.bff_sessions where member_id=target.id;
    delete from public.bff_application_members where member_id=target.id and tenant_id=tenant;
    delete from public.bff_member_roles where member_id=target.id and tenant_id=tenant;
    -- Any open role assignment snapshot must observe revocation before it can save.
    insert into public.bff_resource_revisions(tenant_id,resource) values(tenant,'roles') on conflict do nothing;
    update public.bff_resource_revisions set version=version+1 where tenant_id=tenant and resource='roles';
  end if;
  revision:=public.bff_control_advance(p_actor,'members','member.update',target.id,jsonb_build_object('enabled',target_enabled,'role',target_role,'revoked',not target_enabled));
  return public.bff_read_members(p_actor);
end $$;
revoke all on function public.bff_guard_member_identity(),public.bff_read_roles(uuid),public.bff_role_within_authority(uuid,uuid),public.bff_write_role(uuid,text,jsonb,bigint),
 public.bff_read_role_menus(uuid,uuid),public.bff_set_role_menus(uuid,uuid,uuid[],uuid[],bigint,bigint,integer),public.bff_read_role_users(uuid,uuid),public.bff_set_role_users(uuid,uuid,uuid[],uuid[]),
 public.bff_read_members(uuid),public.bff_write_member(uuid,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.bff_guard_member_identity(),public.bff_read_roles(uuid),public.bff_role_within_authority(uuid,uuid),public.bff_write_role(uuid,text,jsonb,bigint),
 public.bff_read_role_menus(uuid,uuid),public.bff_set_role_menus(uuid,uuid,uuid[],uuid[],bigint,bigint,integer),public.bff_read_role_users(uuid,uuid),public.bff_set_role_users(uuid,uuid,uuid[],uuid[]),
 public.bff_read_members(uuid),public.bff_write_member(uuid,jsonb,bigint) to service_role;

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
    (a.role='admin' or (n.name='BffApplications' and public.bff_actor_can(p_actor,'BffApplication:View')) or
      (n.name='BffAlertInstances' and public.bff_actor_can(p_actor,'BffAlert:View')) or exists(
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
  if tenant is null or p_resource not in ('role','menu','dict_type','dictionary') or not public.bff_actor_can(p_actor,
    case when p_resource='role' then 'System:Role:Delete' when p_resource='menu' then 'System:Menu:Delete' else 'DataCenter:Dict:Delete' end)
  then raise exception 'BFF_FORBIDDEN'; end if;
  if coalesce(cardinality(p_ids),0) not between 1 and 500 then raise exception 'BFF_INVALID_DELETE'; end if;
  if exists(select 1 from unnest(p_ids) requested where not exists(
    select 1 from public.bff_menus where p_resource='menu' and id=requested and tenant_id=tenant
    union all select 1 from public.bff_dictionary_types where p_resource='dict_type' and id=requested and tenant_id=tenant
    union all select 1 from public.bff_dictionary_items where p_resource='dictionary' and id=requested and tenant_id=tenant
    union all select 1 from public.bff_roles where p_resource='role' and id=requested and tenant_id=tenant
  )) then raise exception 'BFF_NOT_FOUND'; end if;
  with dependencies as (
    select r.id as resource_id,'sys_role'::text as source_table,r.id,r.role_name as label,'系统预置角色，需保留'::text as summary,r.update_time as created_at
      from public.bff_roles r where p_resource='role' and r.tenant_id=tenant and r.id=any(p_ids) and r.builtin_type is not null
    union all select mr.role_id,'sys_user',m.id,m.display_name,'已分配的 BFF 成员',mr.create_time
      from public.bff_member_roles mr join public.bff_members m on m.id=mr.member_id and m.tenant_id=mr.tenant_id
      where p_resource='role' and mr.tenant_id=tenant and mr.role_id=any(p_ids)
    union all
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
    when p_resource='role' then 'role_user_assignment'
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
    update public.bff_menus set name=case component when '/shared/system/menu' then 'Menu' when '/bff/system/member/index' then 'User' else 'Dict' end,
      version=version+1,update_by=actor.id,update_time=now()
      where tenant_id=actor.tenant_id and builtin and
        ((component='/shared/system/menu' and name<>'Menu') or (component='/shared/data-center/dict' and name<>'Dict') or
         (component='/bff/system/member/index' and name<>'User'));
    get diagnostics normalized=row_count;
    if normalized>0 then
      insert into public.bff_resource_revisions(tenant_id,resource) values(actor.tenant_id,'menus') on conflict do nothing;
      perform public.bff_control_advance(actor.id,'menus','menu.bootstrap',null,jsonb_build_object('normalized',normalized));
    end if;
    for entry in select * from (values
      ('BffApplications',null::text,'/applications','/bff/applications/index','应用管理','ri:apps-2-line','menu',1),
      ('BffSystem',null,'/system','/index/index','系统管理','ri:settings-3-line','folder',90),
      ('Menu','BffSystem','/system/menu','/shared/system/menu','菜单管理','ri:menu-2-line','menu',1),
      ('Role','BffSystem','/system/role','/shared/system/role','角色与权限','ri:shield-user-line','menu',2),
      ('User','BffSystem','/system/member','/bff/system/member/index','成员管理','ri:team-line','menu',3),
      ('BffBranding','BffSystem','/system/website-config','/shared/system/website-config','系统配置','ri:palette-line','menu',4),
      ('BffServiceManagement',null,'/services','/index/index','服务管理','ri:server-line','folder',60),
      ('BffUpstreams','BffServiceManagement','/upstreams','/bff/upstreams/index','上游服务','ri:links-line','menu',1),
      ('BffInterfaces','BffServiceManagement','/interfaces','/bff/interfaces/index','接口编排','ri:flow-chart','menu',2),
      ('BffReleases','BffServiceManagement','/releases','/bff/releases/index','版本发布','ri:git-branch-line','menu',3),
      ('BffObservability',null,'/observability','/index/index','运行观测','ri:line-chart-line','folder',70),
      ('BffCalls','BffObservability','/calls','/bff/calls/index','调用日志','ri:file-search-line','menu',1),
      ('BffAlerts','BffObservability','/alerts','/index/index','告警中心','ri:alarm-warning-line','folder',2),
      ('BffAlertRules','BffAlerts','/alerts/rules','/bff/alerts/rules/index','告警规则','ri:settings-4-line','menu',1),
      ('BffAlertInstances','BffAlerts','/alerts/instances','/bff/alerts/index','告警事件','ri:notification-3-line','menu',2),
      ('BffDataCenter',null,'/data-center','/index/index','数据中心','ri:database-2-line','folder',91),
      ('Dict','BffDataCenter','/data-center/dict','/shared/data-center/dict','字典管理','ri:book-2-line','menu',1),
      ('BffResources','BffDataCenter','/data-center/attachment','/shared/data-center/attachment','资源管理','ri:attachment-2','menu',2)
    ) as installed(name,parent_name,path,component,title,icon,type,sort) loop
      parent:=null;
      if entry.parent_name is not null then select id into parent from public.bff_menus where tenant_id=actor.tenant_id and name=entry.parent_name; end if;
      insert into public.bff_menus(tenant_id,parent_id,name,path,component,type,sort,meta,builtin,create_by,update_by)
        values(actor.tenant_id,parent,entry.name,entry.path,entry.component,entry.type,entry.sort,jsonb_build_object('title',entry.title,'icon',entry.icon,
          'isEnable',entry.name not in ('BffInterfaces','BffReleases','BffBranding','BffResources','BffObservability','BffCalls','BffAlerts','BffAlertRules','BffAlertInstances'),'keepAlive',true),true,actor.id,actor.id)
        on conflict (tenant_id,name) do nothing;
    end loop;
    for entry in select * from (values('BffApplications','BffApplication'),('Menu','System:Menu'),('Role','System:Role'),('User','System:Member'),
      ('BffUpstreams','BffUpstream'),('BffInterfaces','BffInterface'),
      ('BffReleases','BffRelease'),('BffBranding','BffBrand'),('BffResources','BffResource'),('BffCalls','BffCall'),
      ('BffAlertRules','BffAlert'),('BffAlertInstances','BffAlert'),('Dict','DataCenter:Dict')) as pages(name,mark) loop
      select id into page from public.bff_menus where tenant_id=actor.tenant_id and name=entry.name;
      foreach action in array case when entry.mark='BffApplication' then array['View','Add','Edit','Grant']
        when entry.mark='BffUpstream' then array['View','Add','Edit','ChangeStatus','Test','RotateSecret','Delete']
        when entry.mark='BffInterface' then array['View','Add','Edit','Validate','Test','TestWrite','Delete']
        when entry.mark='BffRelease' then array['View','Publish','Rollback','ChangeStatus']
        when entry.mark='BffBrand' then array['View','Edit']
        when entry.mark='BffResource' then array['View','Add','Edit','Delete']
        when entry.name='BffCalls' then array['View']
        when entry.name='BffAlertRules' then array['View','Add','Edit','ChangeStatus','Archive','Evaluate']
        when entry.name='BffAlertInstances' then array['View','Acknowledge']
        when entry.mark='System:Role' then array['View','Add','Edit','Delete','AssignPermission','AssignUser']
        when entry.mark='System:Member' then array['View','Edit'] else array['View','Add','Edit','Delete'] end loop
        insert into public.bff_menus(tenant_id,parent_id,name,type,meta,builtin,create_by,update_by)
          values(actor.tenant_id,page,case when entry.name='BffAlertRules' and action='View' then 'BffAlertRule:View' else entry.mark||':'||action end,'button',jsonb_build_object('title',case action when 'View' then '查看' when 'Add' then '新增' when 'Edit' then '编辑' when 'Grant' then '访问授权' when 'AssignPermission' then '分配权限' when 'AssignUser' then '分配成员' when 'ChangeStatus' then '切换状态' when 'Archive' then '归档' when 'Acknowledge' then '确认告警' when 'Evaluate' then '立即评估' when 'Publish' then '发布版本' when 'Rollback' then '回滚版本' when 'Test' then case when entry.mark='BffInterface' then '试运行' else '连通性检测' end when 'TestWrite' then '试运行写入' when 'Validate' then '结构校验' when 'RotateSecret' then '更换凭据' else '删除' end,
            'isEnable',entry.mark not in ('BffInterface','BffRelease','BffBrand','BffCall','BffAlert','BffResource')),true,actor.id,actor.id)
          on conflict (tenant_id,name) do nothing;
      end loop;
      if entry.mark='BffInterface' then
        foreach action in array array['Invoke','InvokeWrite'] loop
          insert into public.bff_menus(tenant_id,parent_id,name,type,meta,builtin,create_by,update_by)
            values(actor.tenant_id,page,entry.mark||':'||action,'button',
              jsonb_build_object('title',case action when 'Invoke' then '调用接口' else '调用写入接口' end,
                'isEnable',false),true,actor.id,actor.id)
            on conflict (tenant_id,name) do nothing;
        end loop;
      end if;
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
      ('bffRuntimeEnvironment','运行环境','BffCommon',true),
      ('sysWatermarkContentType','水印内容','BffCommon',true),
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
      ('bffRuntimeEnvironment','development','开发环境',1,'info'),('bffRuntimeEnvironment','staging','预发布环境',2,'warning'),('bffRuntimeEnvironment','production','生产环境',3,'success'),
      ('sysWatermarkContentType','username','当前用户',1,'info'),
      ('sysWatermarkContentType','username_time','用户与时间',2,'info'),
      ('sysWatermarkContentType','site_name','系统名称',3,'primary'),
      ('sysWatermarkContentType','custom','自定义内容',4,'warning'),
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
create or replace function public.bff_read_branding(p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; result jsonb;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  select jsonb_build_object('id',actor.tenant_id,'version',coalesce(s.version,0),
    'config',coalesce(s.config,'{}'::jsonb),'createdAt',s.created_at,'updatedAt',s.updated_at,
    'updatedByName',coalesce(m.display_name,'')) into result
    from (select actor.tenant_id as id) tenant
    left join public.bff_platform_settings s on s.tenant_id=tenant.id
    left join public.bff_members m on m.id=s.updated_by and m.tenant_id=tenant.id;
  return result;
end $$;
create or replace function public.bff_write_branding(p_actor uuid,p_version integer,p_config jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; current_record public.bff_platform_settings; revision bigint; changed jsonb;
  branding_url text; resource_id bigint;
begin
  if p_version is null or p_version<0 or not public.bff_valid_branding(p_config)
  then raise exception 'BFF_INVALID_BRANDING'; end if;
  revision:=public.bff_control_lock(p_actor,'BffBrand:Edit','branding');
  select * into actor from public.bff_members where id=p_actor and enabled;
  select * into current_record from public.bff_platform_settings where tenant_id=actor.tenant_id for update;
  if coalesce(current_record.version,0)<>p_version then raise exception 'BFF_CONFLICT'; end if;
  foreach branding_url in array array[p_config->>'logoUrl',p_config->>'faviconUrl'] loop
    if left(branding_url,15)='/api/resources/' then
      if branding_url !~ '^/api/resources/[1-9][0-9]*/content$' then raise exception 'BFF_INVALID_BRANDING_RESOURCE'; end if;
      begin resource_id:=pg_catalog.split_part(branding_url,'/',4)::bigint;
      exception when others then raise exception 'BFF_INVALID_BRANDING_RESOURCE'; end;
      if not exists(select 1 from public.bff_resources r where r.id=resource_id and r.tenant_id=actor.tenant_id and
        r.status='ready' and r.mime_type in ('image/png','image/jpeg','image/webp','image/gif',
          'image/x-icon','image/vnd.microsoft.icon'))
      then raise exception 'BFF_INVALID_BRANDING_RESOURCE'; end if;
    end if;
  end loop;
  select coalesce(jsonb_agg(entry.field order by entry.field),'[]'::jsonb) into changed
    from jsonb_object_keys(p_config) as entry(field)
    where p_config->entry.field is distinct from current_record.config->entry.field;
  if current_record.tenant_id is null then
    insert into public.bff_platform_settings(tenant_id,config,created_by,updated_by)
      values(actor.tenant_id,p_config,p_actor,p_actor);
  else
    update public.bff_platform_settings set config=p_config,version=version+1,updated_by=p_actor,updated_at=now()
      where tenant_id=actor.tenant_id;
  end if;
  revision:=public.bff_control_advance(p_actor,'branding','branding.update',actor.tenant_id,
    jsonb_build_object('version',p_version+1,'fields',changed));
  return public.bff_read_branding(p_actor);
end $$;
create or replace function public.bff_session_context(p_actor uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('permissions',public.bff_actor_permissions(p_actor),
  'navigation',public.bff_navigation(p_actor),'branding',public.bff_read_branding(p_actor))
$$;
revoke all on function public.bff_valid_branding(jsonb),public.bff_guard_branding_identity(),public.bff_read_branding(uuid),
  public.bff_write_branding(uuid,integer,jsonb),public.bff_session_context(uuid) from public,anon,authenticated;
grant execute on function public.bff_valid_branding(jsonb),public.bff_guard_branding_identity(),public.bff_read_branding(uuid),
  public.bff_write_branding(uuid,integer,jsonb),public.bff_session_context(uuid) to service_role;
create or replace function public.bff_resource_public(p_id bigint)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('id',r.id,'tenantId',r.tenant_id,'originName',r.origin_name,
  'mimeType',r.mime_type,'suffix',r.suffix,'sizeByte',r.size_byte,
  'sizeInfo',pg_catalog.pg_size_pretty(r.size_byte),'url','/api/resources/'||r.id::text||'/content',
  'version',r.version,'createdAt',r.created_at,'updatedAt',r.updated_at)
from public.bff_resources r where r.id=p_id and r.status='ready'
$$;
create or replace function public.bff_resource_reserve(
  p_actor uuid,p_name text,p_mime text,p_suffix text,p_size bigint,p_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; saved public.bff_resources; token text; object_name text;
begin
  if p_name is null or length(pg_catalog.btrim(p_name)) not between 1 and 255 or
    p_name ~ '[[:cntrl:]/\\]' or p_size not between 1 and 10485760 or
    p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or
    p_suffix is null or p_suffix !~ '^[a-z0-9]{1,10}$' or
    lower(pg_catalog.btrim(p_name)) not like '%.'||p_suffix or
    length(pg_catalog.btrim(p_name))<=length(p_suffix)+1 or
    p_mime is null or not exists(select 1 from storage.buckets b where b.id='bff-assets' and
      p_mime=any(b.allowed_mime_types))
  then raise exception 'BFF_INVALID_RESOURCE'; end if;
  perform public.bff_control_lock(p_actor,'BffResource:Add','resources');
  select * into actor from public.bff_members where id=p_actor and enabled;
  token:=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8'),'sha256'),'hex');
  object_name:=gen_random_uuid()::text||'.'||p_suffix;
  insert into public.bff_resources(tenant_id,storage_path,object_name,origin_name,mime_type,suffix,
    size_byte,hash,upload_token_hash,created_by,updated_by)
    values(actor.tenant_id,actor.tenant_id::text,object_name,pg_catalog.btrim(p_name),p_mime,p_suffix,
      p_size,p_hash,pg_catalog.encode(extensions.digest(pg_catalog.convert_to(token,'UTF8'),'sha256'),'hex'),
      p_actor,p_actor) returning * into saved;
  perform public.bff_control_advance(p_actor,'resources','resource.reserve',null,
    jsonb_build_object('resourceId',saved.id,'sizeByte',saved.size_byte));
  return jsonb_build_object('id',saved.id,'storageBucket',saved.storage_bucket,
    'objectKey',saved.storage_path||'/'||saved.object_name,'uploadToken',token);
end $$;
create or replace function public.bff_resource_complete(p_actor uuid,p_id bigint,p_token text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; saved public.bff_resources;
begin
  if p_id is null or p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'BFF_INVALID_RESOURCE'; end if;
  perform public.bff_control_lock(p_actor,'BffResource:Add','resources');
  select * into actor from public.bff_members where id=p_actor and enabled;
  select * into saved from public.bff_resources where id=p_id and tenant_id=actor.tenant_id for update;
  if saved.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if saved.status<>'pending' or saved.created_by<>p_actor or saved.created_at<=now()-interval '1 hour' or
    saved.upload_token_hash is distinct from
      pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_token,'UTF8'),'sha256'),'hex')
  then raise exception 'BFF_RESOURCE_RESERVATION_EXPIRED'; end if;
  update public.bff_resources set status='ready',upload_token_hash=null,version=version+1,
    updated_by=p_actor,updated_at=now() where id=p_id;
  perform public.bff_control_advance(p_actor,'resources','resource.complete',null,
    jsonb_build_object('resourceId',p_id));
  return public.bff_resource_public(p_id);
end $$;
create or replace function public.bff_read_resources(
  p_actor uuid,p_from integer default 0,p_to integer default 29,p_name text default '',p_suffixes text[] default array[]::text[])
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; total integer; records jsonb;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null or not public.bff_actor_can(p_actor,'BffResource:View') then raise exception 'BFF_FORBIDDEN'; end if;
  if p_from is null or p_to is null or p_from<0 or p_to<p_from or p_to-p_from>99 or p_to>1000000 or
    p_name is null or length(p_name)>100 or p_suffixes is null or cardinality(p_suffixes)>50 or
    exists(select 1 from unnest(p_suffixes) as suffix(value) where suffix.value is null or
      suffix.value !~ '^[a-z0-9]{1,10}$')
  then raise exception 'BFF_INVALID_FILTER'; end if;
  select count(*) into total from public.bff_resources r where r.tenant_id=actor.tenant_id and r.status='ready' and
    (p_name='' or r.origin_name ilike '%'||p_name||'%') and
    (cardinality(p_suffixes)=0 or r.suffix=any(p_suffixes));
  select coalesce(jsonb_agg(public.bff_resource_public(q.id) order by q.created_at desc,q.id desc),'[]'::jsonb)
    into records from (select r.id,r.created_at from public.bff_resources r
      where r.tenant_id=actor.tenant_id and r.status='ready' and
        (p_name='' or r.origin_name ilike '%'||p_name||'%') and
        (cardinality(p_suffixes)=0 or r.suffix=any(p_suffixes))
      order by r.created_at desc,r.id desc limit p_to-p_from+1 offset p_from) q;
  return jsonb_build_object('data',records,'total',total);
end $$;
create or replace function public.bff_rename_resource(p_actor uuid,p_id bigint,p_version integer,p_name text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; saved public.bff_resources;
begin
  if p_id is null or p_version is null or p_version<1 or p_name is null or
    length(pg_catalog.btrim(p_name)) not between 1 and 255 or p_name ~ '[[:cntrl:]/\\]'
  then raise exception 'BFF_INVALID_RESOURCE'; end if;
  perform public.bff_control_lock(p_actor,'BffResource:Edit','resources');
  select * into actor from public.bff_members where id=p_actor and enabled;
  select * into saved from public.bff_resources where id=p_id and tenant_id=actor.tenant_id for update;
  if saved.id is null or saved.status<>'ready' then raise exception 'BFF_NOT_FOUND'; end if;
  if saved.version<>p_version then raise exception 'BFF_CONFLICT'; end if;
  if lower(pg_catalog.btrim(p_name)) not like '%.'||saved.suffix or
    length(pg_catalog.btrim(p_name))<=length(saved.suffix)+1
  then raise exception 'BFF_INVALID_RESOURCE'; end if;
  update public.bff_resources set origin_name=pg_catalog.btrim(p_name),version=version+1,
    updated_by=p_actor,updated_at=now() where id=p_id;
  perform public.bff_control_advance(p_actor,'resources','resource.rename',null,
    jsonb_build_object('resourceId',p_id));
  return public.bff_resource_public(p_id);
end $$;
create or replace function public.bff_resource_references(p_actor uuid,p_ids bigint[])
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; result jsonb;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null or not public.bff_actor_can(p_actor,'BffResource:Delete') then raise exception 'BFF_FORBIDDEN'; end if;
  if p_ids is null or cardinality(p_ids) not between 1 and 100 or
    exists(select 1 from unnest(p_ids) as requested(id) where requested.id is null or
      not exists(select 1 from public.bff_resources r where r.id=requested.id and
        r.tenant_id=actor.tenant_id and r.status='ready'))
  then raise exception 'BFF_NOT_FOUND'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('resourceId',r.id,
    'sourceTable','bff_platform_settings','dependencyCode',field.name,
    'recordId',s.tenant_id,'targetId',r.id,'recordNo',s.config->>'siteName',
    'recordSummary',case field.name when 'logoUrl' then '系统 Logo 正在使用' else '浏览器图标正在使用' end,
    'createdAt',s.updated_at,'cleanupAllowed',false) order by r.id,field.name),'[]'::jsonb)
    into result from public.bff_resources r
    join public.bff_platform_settings s on s.tenant_id=r.tenant_id
    cross join lateral (values('logoUrl'::text),('faviconUrl'::text)) as field(name)
    where r.tenant_id=actor.tenant_id and r.id=any(p_ids) and
      s.config->>field.name='/api/resources/'||r.id::text||'/content';
  return result;
end $$;
create or replace function public.bff_resource_delete_begin(p_actor uuid,p_id bigint,p_version integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; saved public.bff_resources; token text;
begin
  if p_id is null or p_version is null or p_version<1 then raise exception 'BFF_INVALID_RESOURCE'; end if;
  perform public.bff_control_lock(p_actor,'BffResource:Delete','resources');
  select * into actor from public.bff_members where id=p_actor and enabled;
  -- Brand writers take the same tenant control lock, then brand row, then resource row.
  perform 1 from public.bff_platform_settings where tenant_id=actor.tenant_id for update;
  select * into saved from public.bff_resources where id=p_id and tenant_id=actor.tenant_id for update;
  if saved.id is null or saved.status<>'ready' then raise exception 'BFF_NOT_FOUND'; end if;
  if saved.version<>p_version then raise exception 'BFF_CONFLICT'; end if;
  if public.bff_resource_references(p_actor,array[p_id])<>'[]'::jsonb then raise exception 'BFF_REFERENCED'; end if;
  token:=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8'),'sha256'),'hex');
  update public.bff_resources set status='deleting',version=version+1,
    cleanup_token_hash=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(token,'UTF8'),'sha256'),'hex'),
    cleanup_lease_until=now()+interval '2 minutes',updated_by=p_actor,updated_at=now()
    where id=p_id;
  perform public.bff_control_advance(p_actor,'resources','resource.delete_begin',null,
    jsonb_build_object('resourceId',p_id));
  return jsonb_build_object('id',p_id,'storageBucket',saved.storage_bucket,
    'objectKey',saved.storage_path||'/'||saved.object_name,'cleanupToken',token);
end $$;
create or replace function public.bff_resource_content(p_actor uuid,p_id bigint)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; saved public.bff_resources; is_brand boolean;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  select * into saved from public.bff_resources where id=p_id and tenant_id=actor.tenant_id and status='ready';
  if saved.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  select exists(select 1 from public.bff_platform_settings s where s.tenant_id=actor.tenant_id and
    (s.config->>'logoUrl'='/api/resources/'||p_id::text||'/content' or
      s.config->>'faviconUrl'='/api/resources/'||p_id::text||'/content')) into is_brand;
  if not public.bff_actor_can(p_actor,'BffResource:View') and not
    (is_brand and saved.mime_type in ('image/png','image/jpeg','image/webp','image/gif',
      'image/x-icon','image/vnd.microsoft.icon'))
  then raise exception 'BFF_FORBIDDEN'; end if;
  return jsonb_build_object('id',saved.id,'storageBucket',saved.storage_bucket,
    'objectKey',saved.storage_path||'/'||saved.object_name,'mimeType',saved.mime_type,
    'sizeByte',saved.size_byte,'originName',saved.origin_name);
end $$;
create or replace function public.bff_resource_names(p_actor uuid,p_ids bigint[])
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; result jsonb; can_view boolean;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  if p_ids is null or cardinality(p_ids)>50 or exists(select 1 from unnest(p_ids) as requested(id)
    where requested.id is null or requested.id<1 or requested.id>9007199254740991)
  then raise exception 'BFF_INVALID_RESOURCE'; end if;
  can_view:=public.bff_actor_can(p_actor,'BffResource:View');
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'originName',r.origin_name)
    order by requested.ordinality),'[]'::jsonb) into result
    from unnest(p_ids) with ordinality as requested(id,ordinality)
    join public.bff_resources r on r.id=requested.id and r.tenant_id=actor.tenant_id and r.status='ready'
    where can_view or (r.mime_type in ('image/png','image/jpeg','image/webp','image/gif',
      'image/x-icon','image/vnd.microsoft.icon') and exists(select 1 from public.bff_platform_settings s
        where s.tenant_id=actor.tenant_id and
          (s.config->>'logoUrl'='/api/resources/'||r.id::text||'/content' or
           s.config->>'faviconUrl'='/api/resources/'||r.id::text||'/content')));
  return result;
end $$;
create or replace function public.bff_resource_cleanup_claim(p_limit integer default 20)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare candidate public.bff_resources; token text; results jsonb:='[]'::jsonb;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'BFF_INVALID_LIMIT'; end if;
  for candidate in select * from public.bff_resources where
    ((status='pending' and created_at<=now()-interval '1 hour') or status='deleting') and
    (cleanup_lease_until is null or cleanup_lease_until<=now())
    order by created_at,id limit p_limit for update skip locked
  loop
    token:=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8'),'sha256'),'hex');
    update public.bff_resources set status='deleting',upload_token_hash=null,
      cleanup_token_hash=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(token,'UTF8'),'sha256'),'hex'),
      cleanup_lease_until=now()+interval '2 minutes',
      version=case when status='pending' then version+1 else version end,updated_at=now()
      where id=candidate.id;
    results:=results||jsonb_build_array(jsonb_build_object('id',candidate.id,
      'storageBucket',candidate.storage_bucket,
      'objectKey',candidate.storage_path||'/'||candidate.object_name,'cleanupToken',token));
  end loop;
  return results;
end $$;
create or replace function public.bff_resource_cleanup_finish(p_id bigint,p_token text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare saved public.bff_resources;
begin
  if p_id is null or p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'BFF_INVALID_RESOURCE'; end if;
  select * into saved from public.bff_resources where id=p_id for update;
  if saved.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if saved.status='deleted' then return jsonb_build_object('deleted',true); end if;
  if saved.status<>'deleting' or saved.cleanup_token_hash is distinct from
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_token,'UTF8'),'sha256'),'hex')
  then raise exception 'BFF_RESOURCE_CLEANUP_LEASE'; end if;
  update public.bff_resources set status='deleted',deleted_at=now(),cleanup_token_hash=null,
    cleanup_lease_until=null,version=version+1,updated_at=now() where id=p_id;
  return jsonb_build_object('deleted',true);
end $$;
revoke all on function public.bff_guard_resource_identity(),public.bff_resource_public(bigint),
  public.bff_resource_reserve(uuid,text,text,text,bigint,text),public.bff_resource_complete(uuid,bigint,text),
  public.bff_read_resources(uuid,integer,integer,text,text[]),public.bff_rename_resource(uuid,bigint,integer,text),
  public.bff_resource_references(uuid,bigint[]),public.bff_resource_delete_begin(uuid,bigint,integer),
  public.bff_resource_content(uuid,bigint),public.bff_resource_names(uuid,bigint[]),
  public.bff_resource_cleanup_claim(integer),public.bff_resource_cleanup_finish(bigint,text)
  from public,anon,authenticated;
grant execute on function public.bff_guard_resource_identity(),public.bff_resource_public(bigint),
  public.bff_resource_reserve(uuid,text,text,text,bigint,text),public.bff_resource_complete(uuid,bigint,text),
  public.bff_read_resources(uuid,integer,integer,text,text[]),public.bff_rename_resource(uuid,bigint,integer,text),
  public.bff_resource_references(uuid,bigint[]),public.bff_resource_delete_begin(uuid,bigint,integer),
  public.bff_resource_content(uuid,bigint),public.bff_resource_names(uuid,bigint[]),
  public.bff_resource_cleanup_claim(integer),public.bff_resource_cleanup_finish(bigint,text)
  to service_role;
-- Application reads re-evaluate the current member and role grants in the same
-- database statement that selects data. A cached HTTP session is not authority.
create or replace function public.bff_read_applications(p_actor uuid,p_page integer,p_size integer,p_keyword text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; can_manage boolean; result jsonb;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  if p_page not between 1 and 100000 or p_size not between 1 and 100 or length(coalesce(p_keyword,''))>100 then
    raise exception 'BFF_INVALID_PAGE';
  end if;
  can_manage:=actor.role='admin' or public.bff_actor_can(p_actor,'BffApplication:Edit')
    or public.bff_actor_can(p_actor,'BffApplication:Grant');
  with visible as materialized (
    select a.* from public.bff_applications a where a.tenant_id=actor.tenant_id
      and (actor.role='admin' or
        (exists(select 1 from public.bff_application_members am
          where am.application_id=a.id and am.member_id=p_actor) and (a.enabled or can_manage)))
      and (coalesce(p_keyword,'')='' or pg_catalog.strpos(pg_catalog.lower(a.name),pg_catalog.lower(p_keyword))>0)
  ), page as (
    select * from visible order by created_at desc,id desc limit p_size offset (p_page::bigint-1)*p_size
  )
  select jsonb_build_object(
    'records',coalesce((select jsonb_agg(jsonb_build_object('id',id,'code',code,'name',name,
      'description',description,'homeUrl',home_url,'enabled',enabled,'version',version,
      'createdAt',created_at,'updatedAt',updated_at) order by created_at desc,id desc) from page),'[]'::jsonb),
    'total',(select count(*) from visible),'current',p_page,'size',p_size
  ) into result;
  return result;
end $$;
create or replace function public.bff_read_application_members(p_actor uuid,p_application uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; app public.bff_applications; result jsonb;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  select * into app from public.bff_applications where id=p_application and tenant_id=actor.tenant_id;
  if app.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if actor.role<>'admin' and (not public.bff_actor_can(p_actor,'BffApplication:Grant') or
    not exists(select 1 from public.bff_application_members
      where application_id=app.id and member_id=p_actor)) then raise exception 'BFF_FORBIDDEN'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.display_name,'email',m.email,
    'role',m.role,'enabled',m.enabled,'granted',am.member_id is not null) order by m.created_at,m.id),'[]'::jsonb)
    into result from public.bff_members m left join public.bff_application_members am
      on am.member_id=m.id and am.application_id=app.id where m.tenant_id=actor.tenant_id;
  return result;
end $$;
create or replace function public.bff_save_application(p_actor uuid,p_id uuid,p_version integer,p_code text,p_name text,p_description text,p_home_url text,p_enabled boolean)
returns public.bff_applications language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; existing public.bff_applications; saved public.bff_applications;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  -- Role/member mutations take this same tenant lock before changing grants.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bff-control:'||actor.tenant_id::text,0));
  select * into actor from public.bff_members where id=p_actor and tenant_id=actor.tenant_id and enabled for share;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  if p_id is null then
    if actor.role<>'admin' and not public.bff_actor_can(p_actor,'BffApplication:Add') then raise exception 'BFF_FORBIDDEN'; end if;
    insert into public.bff_applications(tenant_id,code,name,description,home_url,enabled,created_by,updated_by)
    values(actor.tenant_id,p_code,p_name,p_description,p_home_url,p_enabled,p_actor,p_actor) returning * into saved;
    insert into public.bff_application_members(application_id,member_id,created_by,tenant_id)
      values(saved.id,p_actor,p_actor,actor.tenant_id);
  else
    select * into existing from public.bff_applications where id=p_id and tenant_id=actor.tenant_id for update;
    if existing.id is null then raise exception 'BFF_CONFLICT'; end if;
    if actor.role<>'admin' and (not public.bff_actor_can(p_actor,'BffApplication:Edit') or
      not exists(select 1 from public.bff_application_members
        where application_id=existing.id and member_id=p_actor)) then raise exception 'BFF_FORBIDDEN'; end if;
    update public.bff_applications set name=p_name,description=p_description,home_url=p_home_url,enabled=p_enabled,
      version=version+1,updated_by=p_actor,updated_at=now()
      where id=p_id and tenant_id=actor.tenant_id and version=p_version and code=p_code returning * into saved;
    if saved.id is null then raise exception 'BFF_CONFLICT'; end if;
  end if;
  insert into public.bff_audit_events(tenant_id,actor_id,action,application_id)
    values(actor.tenant_id,p_actor,case when p_id is null then 'application.create' else 'application.update' end,saved.id);
  return saved;
end $$;
create or replace function public.bff_set_application_member(p_actor uuid,p_application uuid,p_member uuid,p_granted boolean)
returns void language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; app public.bff_applications; target public.bff_members;
begin
  if p_granted is null then raise exception 'BFF_INVALID_GRANT'; end if;
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bff-control:'||actor.tenant_id::text,0));
  select * into actor from public.bff_members where id=p_actor and tenant_id=actor.tenant_id and enabled for share;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  select * into app from public.bff_applications where id=p_application and tenant_id=actor.tenant_id for update;
  if app.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  if actor.role<>'admin' and (not public.bff_actor_can(p_actor,'BffApplication:Grant') or
    not exists(select 1 from public.bff_application_members
      where application_id=app.id and member_id=p_actor)) then raise exception 'BFF_FORBIDDEN'; end if;
  select * into target from public.bff_members where id=p_member and tenant_id=actor.tenant_id;
  if target.id is null or (p_granted and not target.enabled) then raise exception 'BFF_FORBIDDEN'; end if;
  if p_granted then
    insert into public.bff_application_members(application_id,member_id,created_by,tenant_id)
      values(p_application,p_member,p_actor,actor.tenant_id) on conflict do nothing;
  else
    delete from public.bff_application_members where application_id=p_application and member_id=p_member;
  end if;
  insert into public.bff_audit_events(tenant_id,actor_id,action,application_id)
    values(actor.tenant_id,p_actor,case when p_granted then 'application.grant' else 'application.revoke' end,p_application);
end $$;
revoke all on function public.bff_read_applications(uuid,integer,integer,text),
  public.bff_read_application_members(uuid,uuid),public.bff_save_application(uuid,uuid,integer,text,text,text,text,boolean),
  public.bff_set_application_member(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.bff_read_applications(uuid,integer,integer,text),
  public.bff_read_application_members(uuid,uuid),public.bff_save_application(uuid,uuid,integer,text,text,text,text,boolean),
  public.bff_set_application_member(uuid,uuid,uuid,boolean) to service_role;
create or replace function public.bff_upstream_scope(p_actor uuid,p_application uuid,p_permission text)
returns boolean language sql stable security invoker set search_path='' as $$
select exists(select 1 from public.bff_members m join public.bff_applications a
  on a.id=p_application and a.tenant_id=m.tenant_id
  where m.id=p_actor and m.enabled and public.bff_actor_can(p_actor,p_permission) and
    (m.role='admin' or exists(select 1 from public.bff_application_members am
      where am.application_id=a.id and am.member_id=m.id and am.tenant_id=m.tenant_id)))
$$;
create or replace function public.bff_read_upstreams(p_actor uuid,p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; app_id uuid; record_id uuid; env text; state text; keyword text; page_no integer; page_size integer; result jsonb;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null or not public.bff_actor_can(p_actor,'BffUpstream:View') then raise exception 'BFF_FORBIDDEN'; end if;
  if jsonb_typeof(p_filters) is distinct from 'object' then raise exception 'BFF_INVALID_FILTER'; end if;
  app_id:=nullif(p_filters->>'applicationId','')::uuid;
  record_id:=nullif(p_filters->>'recordId','')::uuid;
  env:=nullif(p_filters->>'environment','');
  state:=nullif(p_filters->>'status','');
  keyword:=pg_catalog.btrim(coalesce(p_filters->>'name',''));
  page_no:=coalesce((p_filters->>'current')::integer,1);
  page_size:=coalesce((p_filters->>'size')::integer,20);
  if page_no not between 1 and 100000 or page_size not between 1 and 100 or length(keyword)>100 or
    (env is not null and env not in ('development','staging','production')) or
    (state is not null and state not in ('draft','active','disabled')) then raise exception 'BFF_INVALID_FILTER'; end if;
  with scoped as materialized (
    select u.*,a.code as application_code,a.name as application_name,a.enabled as application_enabled,
      exists(select 1 from public.bff_upstream_credentials c where c.service_id=u.id and c.tenant_id=u.tenant_id) as credential_configured
    from public.bff_upstream_services u join public.bff_applications a
      on a.id=u.application_id and a.tenant_id=u.tenant_id
    where u.tenant_id=actor.tenant_id and u.deleted_at is null and (app_id is null or u.application_id=app_id)
      and (record_id is null or u.id=record_id)
      and (env is null or u.environment=env)
      and (keyword='' or pg_catalog.strpos(pg_catalog.lower(u.name),pg_catalog.lower(keyword))>0 or
        pg_catalog.strpos(pg_catalog.lower(u.code),pg_catalog.lower(keyword))>0)
      and (actor.role='admin' or exists(select 1 from public.bff_application_members am
        where am.application_id=u.application_id and am.member_id=p_actor and am.tenant_id=actor.tenant_id))
  ), filtered as materialized (select * from scoped where state is null or status=state),
  page_rows as (select * from filtered order by created_at desc,id desc limit page_size offset (page_no::bigint-1)*page_size)
  select jsonb_build_object(
    'records',coalesce((select jsonb_agg(jsonb_build_object('id',id,'applicationId',application_id,
      'application',jsonb_build_object('id',application_id,'code',application_code,'name',application_name,'enabled',application_enabled),
      'code',code,'name',name,'description',description,'environment',environment,
      'status',status,'baseUrl',base_url,'authType',auth_type,'headerName',header_name,'timeoutMs',timeout_ms,
      'version',version,'configVersion',config_version,'credentialVersion',credential_version,
      'credentialConfigured',credential_configured,'healthStatus',health_status,'lastCheckedAt',last_checked_at,
      'lastStatusCode',last_status_code,'lastDurationMs',last_duration_ms,'lastHealthCode',last_message_code,
      'createdAt',created_at,'updatedAt',updated_at) order by created_at desc,id desc) from page_rows),'[]'::jsonb),
    'total',(select count(*) from filtered),'current',page_no,'size',page_size,
    'summary',jsonb_build_object('total',(select count(*) from scoped),
      'active',(select count(*) from scoped where status='active'),
      'draft',(select count(*) from scoped where status='draft'),
      'disabled',(select count(*) from scoped where status='disabled'),
      'reachable',(select count(*) from scoped where health_status='reachable'),
      'failed',(select count(*) from scoped where health_status='failed'))
  ) into result;
  return result;
end $$;
create or replace function public.bff_upstream_options(p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null or not (public.bff_actor_can(p_actor,'BffUpstream:View') or public.bff_actor_can(p_actor,'BffUpstream:Add'))
    then raise exception 'BFF_FORBIDDEN'; end if;
  return jsonb_build_object('applications',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'enabled',a.enabled)
    order by a.name,a.id) from public.bff_applications a where a.tenant_id=actor.tenant_id and
    (actor.role='admin' or exists(select 1 from public.bff_application_members am where am.application_id=a.id and am.member_id=p_actor and am.tenant_id=actor.tenant_id))),'[]'::jsonb),
    'environments',coalesce((select jsonb_agg(jsonb_build_object('value',i.value,'label',i.label)
      order by i.sort,i.id) from public.bff_dictionary_types t join public.bff_dictionary_items i
      on i.type_id=t.id and i.tenant_id=t.tenant_id where t.tenant_id=actor.tenant_id and
      t.code='bffRuntimeEnvironment' and t.builtin and t.status='1' and i.builtin and i.status='1'),'[]'::jsonb));
end $$;
create or replace function public.bff_upstream_public(p_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('id',s.id,'applicationId',s.application_id,
  'application',jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'enabled',a.enabled),
  'code',s.code,'name',s.name,'description',s.description,
  'environment',s.environment,'status',s.status,'baseUrl',s.base_url,'authType',s.auth_type,
  'headerName',s.header_name,'timeoutMs',s.timeout_ms,'version',s.version,
  'configVersion',s.config_version,'credentialVersion',s.credential_version,
  'credentialConfigured',exists(select 1 from public.bff_upstream_credentials c where c.service_id=s.id),
  'healthStatus',s.health_status,'lastCheckedAt',s.last_checked_at,'lastStatusCode',s.last_status_code,
  'lastDurationMs',s.last_duration_ms,'lastHealthCode',s.last_message_code,
  'createdAt',s.created_at,'updatedAt',s.updated_at)
from public.bff_upstream_services s join public.bff_applications a on a.id=s.application_id and a.tenant_id=s.tenant_id
where s.id=p_id
$$;
create or replace function public.bff_upstream_target(p_actor uuid,p_id uuid,p_permission text default 'BffUpstream:View')
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; target public.bff_upstream_services;
begin
  if p_permission is null or p_permission not in ('BffUpstream:View','BffUpstream:Edit','BffUpstream:ChangeStatus',
    'BffUpstream:Test','BffUpstream:RotateSecret','BffUpstream:Delete') then raise exception 'BFF_INVALID_PERMISSION'; end if;
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  select * into target from public.bff_upstream_services where id=p_id and tenant_id=actor.tenant_id and deleted_at is null;
  if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_upstream_scope(p_actor,target.application_id,p_permission) then raise exception 'BFF_FORBIDDEN'; end if;
  return public.bff_upstream_public(target.id);
end $$;
create or replace function public.bff_upstream_probe_target(p_actor uuid,p_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
select public.bff_upstream_target(p_actor,p_id,'BffUpstream:Test')
$$;
create or replace function public.bff_upstream_references(p_actor uuid,p_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare target jsonb; result jsonb:='[]'::jsonb; bound jsonb; historical jsonb;
begin
  target:=public.bff_upstream_target(p_actor,p_id,'BffUpstream:Delete');
  if target->>'status'='active' then
    result:=jsonb_build_array(jsonb_build_object('resourceId',p_id,'sourceTable','bff_upstream_services',
      'dependencyCode','upstream_active','recordId',p_id,'targetId',p_id,'recordNo',target->>'code',
      'recordSummary','先停用服务后再删除','createdAt',target->>'createdAt','cleanupAllowed',false));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('resourceId',p_id,'sourceTable','bff_interfaces',
    'dependencyCode','upstream_interface_binding','recordId',i.id,'targetId',i.id,'recordNo',i.code,
    'recordSummary','接口草稿仍在引用上游服务','createdAt',i.created_at,'cleanupAllowed',false)
    order by i.created_at,i.id),'[]'::jsonb) into bound
    from public.bff_interfaces i
    where i.application_id=(target->>'applicationId')::uuid and i.deleted_at is null and exists(
      select 1 from public.bff_interface_upstreams b where b.interface_id=i.id and b.tenant_id=i.tenant_id and
        b.application_id=i.application_id and b.service_id=p_id);
  select coalesce(jsonb_agg(jsonb_build_object('resourceId',p_id,'sourceTable','bff_interface_versions',
    'dependencyCode','upstream_published_version','recordId',v.id,'targetId',v.interface_id,
    'recordNo',v.code||' v'||v.number,'recordSummary','历史发布版本仍在引用上游服务',
    'createdAt',v.created_at,'cleanupAllowed',false) order by v.created_at,v.id),'[]'::jsonb)
    into historical from public.bff_interface_versions v
    where v.application_id=(target->>'applicationId')::uuid and exists(
      select 1 from public.bff_interface_version_upstreams b where b.version_id=v.id and b.service_id=p_id);
  return result||bound||historical;
end $$;
create or replace function public.bff_write_upstream(p_actor uuid,p_operation text,p_id uuid,p_version integer,
  p_definition jsonb,p_credential jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; app public.bff_applications; saved public.bff_upstream_services;
  permission text; revision bigint; requested_app uuid; desired_status text; next_auth text; auth_changed boolean;
  clear_credential boolean; ciphertext text; key_id text; next_credential_version integer; had_credential boolean;
begin
  if p_operation is null or p_operation not in ('create','update','status','credential','delete') or p_id is null then
    raise exception 'BFF_INVALID_OPERATION'; end if;
  permission:=case p_operation when 'create' then 'BffUpstream:Add' when 'update' then 'BffUpstream:Edit'
    when 'status' then 'BffUpstream:ChangeStatus' when 'credential' then 'BffUpstream:RotateSecret'
    else 'BffUpstream:Delete' end;
  revision:=public.bff_control_lock(p_actor,permission,'upstreams');
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  -- A credential rotation updates its master version before the encrypted row.
  -- Existing callers may have SET CONSTRAINTS ALL IMMEDIATE in their transaction.
  set constraints all deferred;
  if p_credential is not null then
    if jsonb_typeof(p_credential)<>'object' then raise exception 'BFF_INVALID_CREDENTIAL'; end if;
    clear_credential:=coalesce(p_credential->'clear'='true'::jsonb,false);
    if clear_credential then
      if p_credential ? 'ciphertext' or p_credential ? 'keyId' then raise exception 'BFF_INVALID_CREDENTIAL'; end if;
    else
      ciphertext:=p_credential->>'ciphertext'; key_id:=p_credential->>'keyId';
      if ciphertext is null or length(ciphertext) not between 16 and 32768 or
        key_id is null or key_id !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'BFF_INVALID_CREDENTIAL'; end if;
    end if;
  end if;
  if p_operation in ('status','delete') and p_credential is not null then raise exception 'BFF_INVALID_CREDENTIAL'; end if;
  if p_operation='create' then
    if p_version is not null or jsonb_typeof(p_definition)<>'object' or p_credential->'clear'='true'::jsonb then
      raise exception 'BFF_INVALID_CREATE'; end if;
    requested_app:=nullif(p_definition->>'applicationId','')::uuid;
    if requested_app is null or not public.bff_upstream_scope(p_actor,requested_app,permission) then raise exception 'BFF_FORBIDDEN'; end if;
    select * into app from public.bff_applications where id=requested_app and tenant_id=actor.tenant_id;
    next_auth:=p_definition->>'authType';
    if next_auth='none' and p_credential is not null then raise exception 'BFF_INVALID_CREDENTIAL'; end if;
    if p_credential is not null and (p_credential->>'version')::integer is distinct from 1 then raise exception 'BFF_INVALID_CREDENTIAL_VERSION'; end if;
    insert into public.bff_upstream_services(id,tenant_id,application_id,code,name,description,environment,base_url,
      auth_type,header_name,timeout_ms,credential_version,created_by,updated_by)
      values(p_id,actor.tenant_id,app.id,p_definition->>'code',p_definition->>'name',coalesce(p_definition->>'description',''),
        p_definition->>'environment',p_definition->>'baseUrl',next_auth,coalesce(p_definition->>'headerName',''),
        (p_definition->>'timeoutMs')::integer,case when p_credential is null then 0 else 1 end,p_actor,p_actor)
      returning * into saved;
    if p_credential is not null then
      insert into public.bff_upstream_credentials(service_id,tenant_id,application_id,ciphertext,key_id,credential_version,updated_by)
        values(saved.id,saved.tenant_id,saved.application_id,ciphertext,key_id,1,p_actor);
    end if;
    insert into public.bff_upstream_service_revisions(service_id,tenant_id,application_id,config_version,code,name,description,
      environment,base_url,auth_type,header_name,timeout_ms,created_by)
      values(saved.id,saved.tenant_id,saved.application_id,1,saved.code,saved.name,saved.description,saved.environment,
        saved.base_url,saved.auth_type,saved.header_name,saved.timeout_ms,p_actor);
  else
    select * into saved from public.bff_upstream_services where id=p_id and tenant_id=actor.tenant_id and deleted_at is null for update;
    if saved.id is null then raise exception 'BFF_NOT_FOUND'; end if;
    if not public.bff_upstream_scope(p_actor,saved.application_id,permission) then raise exception 'BFF_FORBIDDEN'; end if;
    if p_version is distinct from saved.version then raise exception 'BFF_CONFLICT'; end if;
    select * into app from public.bff_applications where id=saved.application_id and tenant_id=saved.tenant_id;
    if p_operation='update' then
      if jsonb_typeof(p_definition)<>'object' or
        (p_definition ? 'applicationId' and (p_definition->>'applicationId')::uuid is distinct from saved.application_id) or
        (p_definition ? 'code' and p_definition->>'code' is distinct from saved.code) or
        (p_definition ? 'environment' and p_definition->>'environment' is distinct from saved.environment)
      then raise exception 'BFF_UPSTREAM_IDENTITY_IMMUTABLE'; end if;
      next_auth:=p_definition->>'authType'; auth_changed:=next_auth is distinct from saved.auth_type;
      select exists(select 1 from public.bff_upstream_credentials where service_id=saved.id) into had_credential;
      if (p_credential is not null or auth_changed or saved.header_name is distinct from coalesce(p_definition->>'headerName','') or
        (had_credential and saved.base_url is distinct from p_definition->>'baseUrl')) and
        not public.bff_actor_can(p_actor,'BffUpstream:RotateSecret') then raise exception 'BFF_FORBIDDEN'; end if;
      next_credential_version:=saved.credential_version+case when auth_changed or p_credential is not null then 1 else 0 end;
      if p_credential is not null and not clear_credential and (p_credential->>'version')::integer is distinct from next_credential_version
      then raise exception 'BFF_INVALID_CREDENTIAL_VERSION'; end if;
      if next_auth='none' and p_credential is not null and not clear_credential then raise exception 'BFF_INVALID_CREDENTIAL'; end if;
      if saved.status='active' and next_auth<>'none' and (clear_credential or (auth_changed and p_credential is null))
      then raise exception 'BFF_UPSTREAM_ACTIVE'; end if;
      update public.bff_upstream_services set name=p_definition->>'name',description=coalesce(p_definition->>'description',''),
        base_url=p_definition->>'baseUrl',auth_type=next_auth,header_name=coalesce(p_definition->>'headerName',''),
        timeout_ms=(p_definition->>'timeoutMs')::integer,version=version+1,config_version=config_version+1,
        credential_version=next_credential_version,health_status='stale',updated_by=p_actor,updated_at=now()
        where id=saved.id returning * into saved;
      if auth_changed or clear_credential then delete from public.bff_upstream_credentials where service_id=saved.id; end if;
      if p_credential is not null and not clear_credential then
        insert into public.bff_upstream_credentials(service_id,tenant_id,application_id,ciphertext,key_id,credential_version,updated_by)
          values(saved.id,saved.tenant_id,saved.application_id,ciphertext,key_id,next_credential_version,p_actor)
          on conflict(service_id) do update set ciphertext=excluded.ciphertext,key_id=excluded.key_id,
            credential_version=excluded.credential_version,updated_by=excluded.updated_by,updated_at=now();
      end if;
      insert into public.bff_upstream_service_revisions(service_id,tenant_id,application_id,config_version,code,name,description,
        environment,base_url,auth_type,header_name,timeout_ms,created_by)
        values(saved.id,saved.tenant_id,saved.application_id,saved.config_version,saved.code,saved.name,saved.description,
          saved.environment,saved.base_url,saved.auth_type,saved.header_name,saved.timeout_ms,p_actor);
    elsif p_operation='status' then
      desired_status:=p_definition->>'status';
      if desired_status is null or desired_status not in ('active','disabled') then raise exception 'BFF_INVALID_STATUS'; end if;
      if desired_status='active' and (not app.enabled or (saved.auth_type<>'none' and not exists(
        select 1 from public.bff_upstream_credentials where service_id=saved.id and credential_version=saved.credential_version)))
      then raise exception 'BFF_UPSTREAM_NOT_READY'; end if;
      update public.bff_upstream_services set status=desired_status,version=version+1,updated_by=p_actor,updated_at=now()
        where id=saved.id returning * into saved;
    elsif p_operation='credential' then
      if p_credential is null then raise exception 'BFF_INVALID_CREDENTIAL'; end if;
      if clear_credential and saved.status='active' and saved.auth_type<>'none'
      then raise exception 'BFF_UPSTREAM_ACTIVE'; end if;
      if saved.auth_type='none' and not clear_credential then raise exception 'BFF_INVALID_CREDENTIAL'; end if;
      next_credential_version:=saved.credential_version+1;
      if not clear_credential and (p_credential->>'version')::integer is distinct from next_credential_version
      then raise exception 'BFF_INVALID_CREDENTIAL_VERSION'; end if;
      update public.bff_upstream_services set credential_version=next_credential_version,version=version+1,
        health_status='stale',updated_by=p_actor,updated_at=now() where id=saved.id returning * into saved;
      if clear_credential then delete from public.bff_upstream_credentials where service_id=saved.id;
      else
        insert into public.bff_upstream_credentials(service_id,tenant_id,application_id,ciphertext,key_id,credential_version,updated_by)
          values(saved.id,saved.tenant_id,saved.application_id,ciphertext,key_id,next_credential_version,p_actor)
          on conflict(service_id) do update set ciphertext=excluded.ciphertext,key_id=excluded.key_id,
            credential_version=excluded.credential_version,updated_by=excluded.updated_by,updated_at=now();
      end if;
    else
      if saved.status='active' then raise exception 'BFF_UPSTREAM_ACTIVE'; end if;
      if exists(select 1 from public.bff_interface_upstreams b join public.bff_interfaces i
        on i.id=b.interface_id and i.tenant_id=b.tenant_id and i.application_id=b.application_id
        where b.service_id=saved.id and b.tenant_id=saved.tenant_id and i.deleted_at is null)
        or exists(select 1 from public.bff_interface_version_upstreams b
          where b.service_id=saved.id and b.tenant_id=saved.tenant_id)
      then raise exception 'BFF_REFERENCED'; end if;
      select exists(select 1 from public.bff_upstream_credentials where service_id=saved.id) into had_credential;
      delete from public.bff_upstream_credentials where service_id=saved.id;
      update public.bff_upstream_services set deleted_at=now(),version=version+1,
        credential_version=credential_version+case when had_credential then 1 else 0 end,
        updated_by=p_actor,updated_at=now() where id=saved.id returning * into saved;
    end if;
  end if;
  set constraints all immediate;
  revision:=public.bff_control_advance(p_actor,'upstreams','upstream.'||p_operation,saved.id,
    jsonb_build_object('applicationId',saved.application_id,'code',saved.code,'status',saved.status,
      'version',saved.version,'configVersion',saved.config_version,'credentialVersion',saved.credential_version,
      'credentialChanged',p_credential is not null or coalesce(auth_changed,false)));
  if p_operation='delete' then return jsonb_build_object('saved',true,'revision',revision); end if;
  return public.bff_upstream_public(saved.id);
end $$;
create or replace function public.bff_record_upstream_probe(p_actor uuid,p_id uuid,p_version integer,p_result jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; target public.bff_upstream_services; state text; probe_code text; http_status integer; duration integer;
begin
  if jsonb_typeof(p_result) is distinct from 'object' then raise exception 'BFF_INVALID_PROBE'; end if;
  state:=p_result->>'status'; probe_code:=p_result->>'code';
  http_status:=nullif(p_result->>'statusCode','')::integer;
  duration:=(p_result->>'durationMs')::integer;
  if state is null or probe_code is null or duration is null or state not in ('reachable','failed') or
    probe_code not in ('reachable','invalid_url','invalid_policy','invalid_timeout','target_not_allowed',
      'target_blocked','dns_failed','connection_failed','timeout','redirect_blocked','response_too_large') or
    duration not between 0 and 60000 or (http_status is not null and http_status not between 100 and 599) or
    (state='reachable' and probe_code<>'reachable') or (state='failed' and probe_code='reachable')
  then raise exception 'BFF_INVALID_PROBE'; end if;
  perform public.bff_control_lock(p_actor,'BffUpstream:Test','upstreams');
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  select * into target from public.bff_upstream_services where id=p_id and tenant_id=actor.tenant_id for update;
  if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_upstream_scope(p_actor,target.application_id,'BffUpstream:Test') then raise exception 'BFF_FORBIDDEN'; end if;
  if target.deleted_at is not null or p_version is distinct from target.version then
    insert into public.bff_audit_events(tenant_id,actor_id,action,resource_type,resource_id,summary)
      values(target.tenant_id,p_actor,'upstream.probe.stale','upstreams',target.id,
        jsonb_build_object('expectedVersion',p_version,'currentVersion',target.version,'code','stale'));
    return public.bff_upstream_public(target.id)||jsonb_build_object('stale',true);
  end if;
  update public.bff_upstream_services set health_status=state,last_checked_at=now(),last_status_code=http_status,
    last_duration_ms=duration,last_message_code=probe_code where id=target.id;
  insert into public.bff_audit_events(tenant_id,actor_id,action,resource_type,resource_id,summary)
    values(target.tenant_id,p_actor,'upstream.probe','upstreams',target.id,
      jsonb_build_object('status',state,'code',probe_code,'statusCode',http_status,'durationMs',duration,
        'version',target.version));
  return public.bff_upstream_public(target.id)||jsonb_build_object('stale',false);
end $$;
revoke all on function public.bff_upstream_scope(uuid,uuid,text),public.bff_read_upstreams(uuid,jsonb),
  public.bff_upstream_options(uuid),public.bff_upstream_public(uuid),public.bff_upstream_target(uuid,uuid,text),
  public.bff_upstream_probe_target(uuid,uuid),public.bff_upstream_references(uuid,uuid),
  public.bff_write_upstream(uuid,text,uuid,integer,jsonb,jsonb),public.bff_record_upstream_probe(uuid,uuid,integer,jsonb)
  from public,anon,authenticated;
grant execute on function public.bff_upstream_scope(uuid,uuid,text),public.bff_read_upstreams(uuid,jsonb),
  public.bff_upstream_options(uuid),public.bff_upstream_public(uuid),public.bff_upstream_target(uuid,uuid,text),
  public.bff_upstream_probe_target(uuid,uuid),public.bff_upstream_references(uuid,uuid),
  public.bff_write_upstream(uuid,text,uuid,integer,jsonb,jsonb),public.bff_record_upstream_probe(uuid,uuid,integer,jsonb)
  to service_role;
create or replace function public.bff_interface_scope(p_actor uuid,p_application uuid,p_permission text)
returns boolean language sql stable security invoker set search_path='' as $$
select exists(select 1 from public.bff_members m join public.bff_applications a
  on a.id=p_application and a.tenant_id=m.tenant_id
  where m.id=p_actor and m.enabled and public.bff_actor_can(p_actor,p_permission) and
    (m.role='admin' or exists(select 1 from public.bff_application_members am
      where am.application_id=a.id and am.member_id=m.id and am.tenant_id=m.tenant_id)))
$$;
create or replace function public.bff_interface_public(p_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('id',i.id,'applicationId',i.application_id,
  'application',jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'enabled',a.enabled),
  'environment',i.environment,'code',i.code,'name',i.name,'description',i.description,
  'method',i.method,'path',i.path,'definition',i.definition,'version',i.version,
  'validationStatus',i.validation_status,'validatedVersion',i.validated_version,
  'validationIssues',i.validation_issues,'lastValidatedAt',i.last_validated_at,
  'lastTestStatus',i.last_test_status,'lastTestVersion',i.last_test_version,'lastTestAt',i.last_test_at,
  'createdAt',i.created_at,'updatedAt',i.updated_at)
from public.bff_interfaces i join public.bff_applications a on a.id=i.application_id and a.tenant_id=i.tenant_id
where i.id=p_id
$$;
create or replace function public.bff_read_interfaces(p_actor uuid,p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; app_id uuid; record_id uuid; env text; validation text; keyword text;
  page_no integer; page_size integer; result jsonb;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null or not public.bff_actor_can(p_actor,'BffInterface:View') then raise exception 'BFF_FORBIDDEN'; end if;
  if jsonb_typeof(p_filters) is distinct from 'object' then raise exception 'BFF_INVALID_FILTER'; end if;
  app_id:=nullif(p_filters->>'applicationId','')::uuid;
  record_id:=nullif(p_filters->>'recordId','')::uuid;
  env:=nullif(p_filters->>'environment','');
  validation:=nullif(p_filters->>'validationStatus','');
  keyword:=pg_catalog.btrim(coalesce(p_filters->>'name',''));
  page_no:=coalesce((p_filters->>'current')::integer,1);
  page_size:=coalesce((p_filters->>'size')::integer,20);
  if page_no not between 1 and 100000 or page_size not between 1 and 100 or length(keyword)>100 or
    (env is not null and env not in ('development','staging','production')) or
    (validation is not null and validation not in ('unvalidated','valid','invalid'))
  then raise exception 'BFF_INVALID_FILTER'; end if;
  with scoped as materialized (
    select i.*,a.code as application_code,a.name as application_name,a.enabled as application_enabled
    from public.bff_interfaces i join public.bff_applications a
      on a.id=i.application_id and a.tenant_id=i.tenant_id
    where i.tenant_id=actor.tenant_id and i.deleted_at is null and (app_id is null or i.application_id=app_id)
      and (record_id is null or i.id=record_id) and (env is null or i.environment=env)
      and (keyword='' or pg_catalog.strpos(pg_catalog.lower(i.name),pg_catalog.lower(keyword))>0 or
        pg_catalog.strpos(pg_catalog.lower(i.code),pg_catalog.lower(keyword))>0)
      and (actor.role='admin' or exists(select 1 from public.bff_application_members am
        where am.application_id=i.application_id and am.member_id=p_actor and am.tenant_id=actor.tenant_id))
  ), filtered as materialized (select * from scoped where validation is null or validation_status=validation),
  page_rows as (select * from filtered order by created_at desc,id desc limit page_size offset (page_no::bigint-1)*page_size)
  select jsonb_build_object(
    'records',coalesce((select jsonb_agg(jsonb_build_object('id',id,'applicationId',application_id,
      'application',jsonb_build_object('id',application_id,'code',application_code,'name',application_name,'enabled',application_enabled),
      'environment',environment,'code',code,'name',name,'description',description,'method',method,'path',path,
      'definition',definition,'version',version,'validationStatus',validation_status,'validatedVersion',validated_version,
      'validationIssues',validation_issues,'lastValidatedAt',last_validated_at,'lastTestStatus',last_test_status,
      'lastTestVersion',last_test_version,'lastTestAt',last_test_at,'createdAt',created_at,'updatedAt',updated_at)
      order by created_at desc,id desc) from page_rows),'[]'::jsonb),
    'total',(select count(*) from filtered),'current',page_no,'size',page_size,
    'summary',jsonb_build_object('total',(select count(*) from scoped),
      'valid',(select count(*) from scoped where validation_status='valid' and validated_version=version),
      'unvalidated',(select count(*) from scoped where validation_status='unvalidated' or validated_version is distinct from version),
      'tested',(select count(*) from scoped where last_test_status in ('passed','failed') and last_test_version=version))) into result;
  return result;
end $$;
create or replace function public.bff_interface_options(p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null or not public.bff_actor_can(p_actor,'BffInterface:View') then raise exception 'BFF_FORBIDDEN'; end if;
  return jsonb_build_object(
    'applications',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'enabled',a.enabled)
      order by a.name,a.id) from public.bff_applications a where a.tenant_id=actor.tenant_id and
      (actor.role='admin' or exists(select 1 from public.bff_application_members am
        where am.application_id=a.id and am.member_id=p_actor and am.tenant_id=actor.tenant_id))),'[]'::jsonb),
    'environments',coalesce((select jsonb_agg(jsonb_build_object('value',d.value,'label',d.label) order by d.sort,d.id)
      from public.bff_dictionary_types t join public.bff_dictionary_items d on d.type_id=t.id and d.tenant_id=t.tenant_id
      where t.tenant_id=actor.tenant_id and t.code='bffRuntimeEnvironment' and t.builtin and t.status='1' and
        d.builtin and d.status='1'),'[]'::jsonb),
    'upstreams',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'applicationId',u.application_id,
      'environment',u.environment,'code',u.code,'name',u.name,'status',u.status,'configVersion',u.config_version,
      'authType',u.auth_type,'credentialConfigured',exists(select 1 from public.bff_upstream_credentials c where c.service_id=u.id))
      order by u.name,u.id) from public.bff_upstream_services u where u.tenant_id=actor.tenant_id and u.deleted_at is null and
      (actor.role='admin' or exists(select 1 from public.bff_application_members am
        where am.application_id=u.application_id and am.member_id=p_actor and am.tenant_id=actor.tenant_id))),'[]'::jsonb));
end $$;
create or replace function public.bff_interface_target(p_actor uuid,p_id uuid,p_permission text default 'BffInterface:View')
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; target public.bff_interfaces;
begin
  if p_permission is null or p_permission not in ('BffInterface:View','BffInterface:Edit','BffInterface:Validate',
    'BffInterface:Test','BffInterface:TestWrite','BffInterface:Delete') then raise exception 'BFF_INVALID_PERMISSION'; end if;
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  select * into target from public.bff_interfaces where id=p_id and tenant_id=actor.tenant_id and deleted_at is null;
  if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_interface_scope(p_actor,target.application_id,p_permission) then raise exception 'BFF_FORBIDDEN'; end if;
  return public.bff_interface_public(target.id);
end $$;
create or replace function public.bff_interface_references(p_actor uuid,p_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare record jsonb;
begin
  record:=public.bff_interface_target(p_actor,p_id,'BffInterface:Delete');
  return coalesce((select jsonb_agg(jsonb_build_object('resourceId',p_id,
    'sourceTable','bff_interface_versions','dependencyCode','interface_published_version',
    'recordId',v.id,'targetId',p_id,'recordNo',record->>'code'||' v'||v.number,
    'recordSummary','已发布版本需保留，接口不能归档','createdAt',v.created_at,'cleanupAllowed',false)
    order by v.number desc) from public.bff_interface_versions v where v.interface_id=p_id),'[]'::jsonb);
end $$;
create or replace function public.bff_write_interface(p_actor uuid,p_operation text,p_id uuid,p_version integer,p_definition jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; saved public.bff_interfaces; requested_app uuid; permission text; revision bigint;
  details jsonb; step jsonb; step_key text; bound_service_id uuid; config_number integer;
begin
  if p_operation is null or p_operation not in ('create','update','delete') or p_id is null then raise exception 'BFF_INVALID_OPERATION'; end if;
  permission:=case p_operation when 'create' then 'BffInterface:Add' when 'update' then 'BffInterface:Edit' else 'BffInterface:Delete' end;
  revision:=public.bff_control_lock(p_actor,permission,'interfaces');
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  set constraints all deferred;
  if p_operation='create' then
    if p_version is not null or jsonb_typeof(p_definition) is distinct from 'object' then raise exception 'BFF_INVALID_CREATE'; end if;
    requested_app:=nullif(p_definition->>'applicationId','')::uuid;
    if requested_app is null or not public.bff_interface_scope(p_actor,requested_app,permission) then raise exception 'BFF_FORBIDDEN'; end if;
  else
    select * into saved from public.bff_interfaces where id=p_id and tenant_id=actor.tenant_id and deleted_at is null for update;
    if saved.id is null then raise exception 'BFF_NOT_FOUND'; end if;
    if not public.bff_interface_scope(p_actor,saved.application_id,permission) then raise exception 'BFF_FORBIDDEN'; end if;
    if p_version is distinct from saved.version then raise exception 'BFF_CONFLICT'; end if;
  end if;
  if p_operation in ('create','update') then
    if jsonb_typeof(p_definition) is distinct from 'object' or jsonb_typeof(p_definition->'definition') is distinct from 'object'
      then raise exception 'BFF_INVALID_DEFINITION'; end if;
    details:=p_definition->'definition';
    if jsonb_typeof(details->'inputs') is distinct from 'array' or
      jsonb_typeof(details->'steps') is distinct from 'array' or
      jsonb_typeof(details->'outputs') is distinct from 'array'
      then raise exception 'BFF_INVALID_DEFINITION'; end if;
    if jsonb_array_length(details->'inputs')>32 or jsonb_array_length(details->'steps') not between 1 and 8 or
      jsonb_array_length(details->'outputs') not between 1 and 32 or
      exists(select 1 from jsonb_array_elements(details->'steps') as entry(value) where
        jsonb_typeof(entry.value) is distinct from 'object' or entry.value->>'key' !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$') or
      exists(select 1 from jsonb_array_elements(details->'steps') as entry(value)
        group by entry.value->>'key' having count(*)>1)
      then raise exception 'BFF_INVALID_DEFINITION'; end if;
    if p_operation='create' then
      insert into public.bff_interfaces(id,tenant_id,application_id,environment,code,name,description,method,path,definition,created_by,updated_by)
        values(p_id,actor.tenant_id,requested_app,p_definition->>'environment',p_definition->>'code',p_definition->>'name',
          coalesce(p_definition->>'description',''),p_definition->>'method',p_definition->>'path',details,p_actor,p_actor)
        returning * into saved;
    else
      if (p_definition ? 'applicationId' and (p_definition->>'applicationId')::uuid is distinct from saved.application_id) or
        (p_definition ? 'environment' and p_definition->>'environment' is distinct from saved.environment) or
        (p_definition ? 'code' and p_definition->>'code' is distinct from saved.code)
      then raise exception 'BFF_INTERFACE_IDENTITY_IMMUTABLE'; end if;
      update public.bff_interfaces set name=p_definition->>'name',description=coalesce(p_definition->>'description',''),
        method=p_definition->>'method',path=p_definition->>'path',definition=details,version=version+1,
        validation_status='unvalidated',validated_version=null,validation_issues='[]'::jsonb,last_validated_at=null,
        last_test_status=case when last_test_status in ('passed','failed') then 'stale' else 'not_tested' end,
        last_test_upstreams='[]'::jsonb,
        updated_by=p_actor,updated_at=now() where id=saved.id returning * into saved;
      delete from public.bff_interface_upstreams where interface_id=saved.id;
    end if;
    for step in select value from jsonb_array_elements(details->'steps') loop
      step_key:=step->>'key';
      bound_service_id:=nullif(step->>'upstreamId','')::uuid;
      config_number:=(step->>'configVersion')::integer;
      if step_key is null or bound_service_id is null or config_number is null or config_number<1 or
        not exists(select 1 from public.bff_upstream_services u join public.bff_upstream_service_revisions r
          on r.service_id=u.id and r.config_version=config_number and r.tenant_id=u.tenant_id and
            r.application_id=u.application_id and r.environment=u.environment
          where u.id=bound_service_id and u.tenant_id=saved.tenant_id and u.application_id=saved.application_id and
            u.environment=saved.environment and u.deleted_at is null and u.config_version=config_number)
      then raise exception 'BFF_INTERFACE_UPSTREAM_INVALID'; end if;
      insert into public.bff_interface_upstreams(interface_id,step_key,service_id,config_version,tenant_id,
        application_id,environment,created_by)
        values(saved.id,step_key,bound_service_id,config_number,saved.tenant_id,saved.application_id,saved.environment,p_actor);
    end loop;
  else
    if exists(select 1 from public.bff_interface_versions where interface_id=saved.id)
    then raise exception 'BFF_REFERENCED'; end if;
    update public.bff_interfaces set deleted_at=now(),version=version+1,updated_by=p_actor,updated_at=now()
      where id=saved.id returning * into saved;
  end if;
  set constraints all immediate;
  revision:=public.bff_control_advance(p_actor,'interfaces','interface.'||p_operation,saved.id,
    jsonb_build_object('applicationId',saved.application_id,'code',saved.code,'version',saved.version,
      'method',saved.method,'path',saved.path,'stepCount',jsonb_array_length(saved.definition->'steps')));
  if p_operation='delete' then return jsonb_build_object('saved',true,'revision',revision); end if;
  return public.bff_interface_public(saved.id);
end $$;
create or replace function public.bff_record_interface_validation(p_actor uuid,p_id uuid,p_version integer,p_issues jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; target public.bff_interfaces; revision bigint;
begin
  if jsonb_typeof(p_issues) is distinct from 'array' then raise exception 'BFF_INVALID_ISSUES'; end if;
  if jsonb_array_length(p_issues)>40 or exists(select 1 from jsonb_array_elements(p_issues) as issue(value)
    where jsonb_typeof(issue.value) is distinct from 'string' or length(issue.value#>>'{}')>500)
  then raise exception 'BFF_INVALID_ISSUES'; end if;
  revision:=public.bff_control_lock(p_actor,'BffInterface:Validate','interfaces');
  select * into actor from public.bff_members where id=p_actor and enabled;
  select * into target from public.bff_interfaces where id=p_id and tenant_id=actor.tenant_id and deleted_at is null for update;
  if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_interface_scope(p_actor,target.application_id,'BffInterface:Validate') then raise exception 'BFF_FORBIDDEN'; end if;
  if p_version is distinct from target.version then raise exception 'BFF_CONFLICT'; end if;
  if jsonb_array_length(p_issues)=0 and exists(select 1 from public.bff_interface_upstreams b
    left join public.bff_upstream_services u on u.id=b.service_id and u.tenant_id=b.tenant_id and u.application_id=b.application_id
    where b.interface_id=p_id and (u.id is null or u.deleted_at is not null or u.config_version<>b.config_version))
  then raise exception 'BFF_INTERFACE_UPSTREAM_CHANGED'; end if;
  update public.bff_interfaces set validation_status=case when jsonb_array_length(p_issues)=0 then 'valid' else 'invalid' end,
    validated_version=p_version,validation_issues=p_issues,last_validated_at=now(),updated_by=p_actor,updated_at=now()
    where id=p_id;
  revision:=public.bff_control_advance(p_actor,'interfaces','interface.validate',p_id,
    jsonb_build_object('version',p_version,'issueCount',jsonb_array_length(p_issues)));
  return public.bff_interface_public(p_id);
end $$;
create or replace function public.bff_record_interface_test(p_actor uuid,p_id uuid,p_version integer,p_passed boolean,
  p_upstream_versions jsonb default '[]'::jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; target public.bff_interfaces; stale_result boolean; observed jsonb;
  observed_id uuid; observed_config integer; observed_credential integer; observed_ids uuid[]:=array[]::uuid[];
begin
  if p_passed is null or jsonb_typeof(p_upstream_versions) is distinct from 'array' then raise exception 'BFF_INVALID_TEST_RESULT'; end if;
  if jsonb_array_length(p_upstream_versions)>8 then raise exception 'BFF_INVALID_TEST_RESULT'; end if;
  perform public.bff_control_lock(p_actor,'BffInterface:Test','interfaces');
  select * into actor from public.bff_members where id=p_actor and enabled;
  select * into target from public.bff_interfaces where id=p_id and tenant_id=actor.tenant_id and deleted_at is null for update;
  if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_interface_scope(p_actor,target.application_id,'BffInterface:Test') then raise exception 'BFF_FORBIDDEN'; end if;
  if (p_passed or jsonb_array_length(p_upstream_versions)>0) and
    exists(select 1 from jsonb_array_elements(target.definition->'steps') as step(value)
      where step.value->>'method'<>'GET') then
    if target.environment='production' then raise exception 'BFF_INTERFACE_WRITE_PRODUCTION'; end if;
    if not public.bff_actor_can(p_actor,'BffInterface:TestWrite') then raise exception 'BFF_FORBIDDEN'; end if;
  end if;
  stale_result:=p_version is distinct from target.version or
    not exists(select 1 from public.bff_applications a where a.id=target.application_id and a.tenant_id=target.tenant_id and a.enabled) or
    exists(select 1 from public.bff_interface_upstreams b
    left join public.bff_upstream_services u on u.id=b.service_id and u.tenant_id=b.tenant_id and u.application_id=b.application_id
    where b.interface_id=p_id and (u.id is null or u.deleted_at is not null or u.config_version<>b.config_version));
  for observed in select value from jsonb_array_elements(p_upstream_versions) loop
    if jsonb_typeof(observed) is distinct from 'object' then raise exception 'BFF_INVALID_TEST_RESULT'; end if;
    observed_id:=nullif(observed->>'id','')::uuid;
    observed_config:=(observed->>'configVersion')::integer;
    observed_credential:=(observed->>'credentialVersion')::integer;
    if observed_id is null or observed_config is null or observed_credential is null or observed_id=any(observed_ids) or
      not exists(select 1 from public.bff_interface_upstreams where interface_id=p_id and service_id=observed_id)
    then raise exception 'BFF_INVALID_TEST_RESULT'; end if;
    observed_ids:=pg_catalog.array_append(observed_ids,observed_id);
    if not exists(select 1 from public.bff_interface_upstreams b join public.bff_upstream_services u
      on u.id=b.service_id and u.tenant_id=b.tenant_id and u.application_id=b.application_id
      where b.interface_id=p_id and b.service_id=observed_id and u.deleted_at is null and u.status='active' and
        b.config_version=observed_config and u.config_version=observed_config and u.credential_version=observed_credential)
    then stale_result:=true; end if;
  end loop;
  if p_passed and cardinality(observed_ids) is distinct from
    (select count(distinct service_id) from public.bff_interface_upstreams where interface_id=p_id)
  then stale_result:=true; end if;
  if (p_passed or cardinality(observed_ids)>0) and exists(select 1 from public.bff_interface_upstreams b
    join public.bff_upstream_services u on u.id=b.service_id and u.tenant_id=b.tenant_id and u.application_id=b.application_id
    where b.interface_id=p_id and u.status<>'active') then stale_result:=true; end if;
  if stale_result then
    insert into public.bff_audit_events(tenant_id,actor_id,action,resource_type,resource_id,summary)
      values(target.tenant_id,p_actor,'interface.test.stale','interfaces',p_id,
        jsonb_build_object('expectedVersion',p_version,'currentVersion',target.version,'observedServices',cardinality(observed_ids)));
    return public.bff_interface_public(p_id)||jsonb_build_object('stale',true);
  end if;
  if target.validation_status<>'valid' or target.validated_version is distinct from target.version
  then raise exception 'BFF_INTERFACE_NOT_VALIDATED'; end if;
  update public.bff_interfaces set last_test_status=case when p_passed then 'passed' else 'failed' end,
    last_test_version=p_version,last_test_at=now(),
    last_test_upstreams=case when p_passed then p_upstream_versions else '[]'::jsonb end,
    updated_by=p_actor,updated_at=now() where id=p_id;
  insert into public.bff_audit_events(tenant_id,actor_id,action,resource_type,resource_id,summary)
    values(target.tenant_id,p_actor,'interface.test','interfaces',p_id,
      jsonb_build_object('version',p_version,'passed',p_passed));
  return public.bff_interface_public(p_id)||jsonb_build_object('stale',false);
end $$;
revoke all on function public.bff_interface_scope(uuid,uuid,text),public.bff_interface_public(uuid),
  public.bff_read_interfaces(uuid,jsonb),public.bff_interface_options(uuid),public.bff_interface_target(uuid,uuid,text),
  public.bff_interface_references(uuid,uuid),public.bff_write_interface(uuid,text,uuid,integer,jsonb),
  public.bff_record_interface_validation(uuid,uuid,integer,jsonb),public.bff_record_interface_test(uuid,uuid,integer,boolean,jsonb)
  from public,anon,authenticated;
grant execute on function public.bff_interface_scope(uuid,uuid,text),public.bff_interface_public(uuid),
  public.bff_read_interfaces(uuid,jsonb),public.bff_interface_options(uuid),public.bff_interface_target(uuid,uuid,text),
  public.bff_interface_references(uuid,uuid),public.bff_write_interface(uuid,text,uuid,integer,jsonb),
  public.bff_record_interface_validation(uuid,uuid,integer,jsonb),public.bff_record_interface_test(uuid,uuid,integer,boolean,jsonb)
  to service_role;
create or replace function public.bff_release_scope(p_actor uuid,p_application uuid,p_permission text)
returns boolean language sql stable security invoker set search_path='' as $$
select public.bff_interface_scope(p_actor,p_application,p_permission)
$$;
create or replace function public.bff_release_record(p_interface uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object(
  'interfaceId',i.id,'applicationId',i.application_id,
  'application',jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'enabled',a.enabled),
  'environment',i.environment,'code',i.code,'name',i.name,'description',i.description,
  'draftVersion',i.version,'draftMethod',i.method,'draftPath',i.path,
  'validationStatus',i.validation_status,'lastTestStatus',i.last_test_status,
  'lastTestVersion',i.last_test_version,
  'versionCount',(select count(*) from public.bff_interface_versions v where v.interface_id=i.id),
  'deployment',case when d.interface_id is null then null else jsonb_build_object(
    'version',d.version,'enabled',d.enabled,'activeVersionId',d.active_version_id,
    'activeVersionNumber',v.number,'method',d.method,'path',d.path,
    'updatedAt',d.updated_at,'updatedByName',coalesce(editor.display_name,'')) end)
from public.bff_interfaces i
join public.bff_applications a on a.id=i.application_id and a.tenant_id=i.tenant_id
left join public.bff_interface_deployments d on d.interface_id=i.id
left join public.bff_interface_versions v on v.id=d.active_version_id
left join public.bff_members editor on editor.id=d.updated_by and editor.tenant_id=i.tenant_id
where i.id=p_interface and i.deleted_at is null
$$;
create or replace function public.bff_release_version_public(p_version uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('id',v.id,'interfaceId',v.interface_id,'number',v.number,
  'draftVersion',v.draft_version,'checksum',v.checksum,'notes',v.notes,
  'applicationId',v.application_id,'environment',v.environment,'code',v.code,
  'name',v.name,'description',v.description,'method',v.method,'path',v.path,
  'definition',v.definition,'createdAt',v.created_at,
  'createdByName',coalesce(m.display_name,''))
from public.bff_interface_versions v
join public.bff_members m on m.id=v.created_by and m.tenant_id=v.tenant_id
where v.id=p_version
$$;
create or replace function public.bff_release_target(
  p_actor uuid,p_interface uuid,p_permission text default 'BffRelease:View')
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; draft public.bff_interfaces;
begin
  if p_permission is null or p_permission not in
    ('BffRelease:View','BffRelease:Publish','BffRelease:Rollback','BffRelease:ChangeStatus')
  then raise exception 'BFF_INVALID_PERMISSION'; end if;
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  select * into draft from public.bff_interfaces where id=p_interface and tenant_id=actor.tenant_id and deleted_at is null;
  if draft.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_release_scope(p_actor,draft.application_id,p_permission) then raise exception 'BFF_FORBIDDEN'; end if;
  return public.bff_release_record(draft.id);
end $$;
create or replace function public.bff_release_history_unchecked(
  p_interface uuid,p_version_page integer default 1,p_event_page integer default 1,p_size integer default 20)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_version_page not between 1 and 100000 or p_event_page not between 1 and 100000 or
    p_size not between 1 and 50 then raise exception 'BFF_INVALID_PAGE'; end if;
  select jsonb_build_object('record',public.bff_release_record(p_interface),
    'versionsTotal',(select count(*) from public.bff_interface_versions where interface_id=p_interface),
    'eventsTotal',(select count(*) from public.bff_interface_release_events where interface_id=p_interface),
    'versionPage',p_version_page,'eventPage',p_event_page,'size',p_size,
    'versions',coalesce((select jsonb_agg(public.bff_release_version_public(v.id) order by v.number desc)
      from (select id,number from public.bff_interface_versions
        where interface_id=p_interface order by number desc limit p_size offset (p_version_page-1)*p_size) v),'[]'::jsonb),
    'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,
      'fromVersionNumber',old_v.number,'toVersionNumber',new_v.number,
      'deploymentVersion',e.deployment_version,'notes',e.notes,'createdAt',e.created_at,
      'actorName',coalesce(m.display_name,'')) order by e.created_at desc,e.id desc)
      from (select * from public.bff_interface_release_events where interface_id=p_interface
        order by created_at desc,id desc limit p_size offset (p_event_page-1)*p_size) e
      left join public.bff_interface_versions old_v on old_v.id=e.from_version_id
      join public.bff_interface_versions new_v on new_v.id=e.to_version_id
      join public.bff_members m on m.id=e.actor_id and m.tenant_id=e.tenant_id),'[]'::jsonb))
    into result;
  return result;
end $$;
create or replace function public.bff_release_history(
  p_actor uuid,p_interface uuid,p_version_page integer default 1,p_event_page integer default 1,
  p_size integer default 20)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
  perform public.bff_release_target(p_actor,p_interface,'BffRelease:View');
  return public.bff_release_history_unchecked(p_interface,p_version_page,p_event_page,p_size);
end $$;
create or replace function public.bff_read_releases(p_actor uuid,p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; page integer; page_size integer; total integer; summary jsonb; records jsonb;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null or not public.bff_actor_can(p_actor,'BffRelease:View') then raise exception 'BFF_FORBIDDEN'; end if;
  page:=greatest(1,least(100000,coalesce(nullif(p_filters->>'current','')::integer,1)));
  page_size:=greatest(1,least(100,coalesce(nullif(p_filters->>'size','')::integer,20)));
  with scoped as (
    select i.id,d.enabled,d.interface_id as deployment_id from public.bff_interfaces i
    left join public.bff_interface_deployments d on d.interface_id=i.id
    where i.tenant_id=actor.tenant_id and i.deleted_at is null and
      public.bff_release_scope(p_actor,i.application_id,'BffRelease:View') and
      (nullif(p_filters->>'name','') is null or
        lower(i.name) like '%'||lower(p_filters->>'name')||'%' or lower(i.code) like '%'||lower(p_filters->>'name')||'%') and
      (nullif(p_filters->>'applicationId','') is null or i.application_id=(p_filters->>'applicationId')::uuid) and
      (nullif(p_filters->>'environment','') is null or i.environment=p_filters->>'environment') and
      (nullif(p_filters->>'recordId','') is null or i.id=(p_filters->>'recordId')::uuid) and
      (nullif(p_filters->>'status','') is null or
        (p_filters->>'status'='unpublished' and d.interface_id is null) or
        (p_filters->>'status'='enabled' and d.enabled) or
        (p_filters->>'status'='disabled' and d.interface_id is not null and not d.enabled))
  )
  select count(*),jsonb_build_object('total',count(*),
    'enabled',count(*) filter(where deployment_id is not null and enabled),
    'disabled',count(*) filter(where deployment_id is not null and not enabled),
    'unpublished',count(*) filter(where deployment_id is null))
    into total,summary from scoped;
  select coalesce(jsonb_agg(public.bff_release_record(i.id) order by i.created_at desc,i.id),'[]'::jsonb)
    into records from (
      select i.id,i.created_at from public.bff_interfaces i
      left join public.bff_interface_deployments d on d.interface_id=i.id
      where i.tenant_id=actor.tenant_id and i.deleted_at is null and
        public.bff_release_scope(p_actor,i.application_id,'BffRelease:View') and
        (nullif(p_filters->>'name','') is null or lower(i.name) like '%'||lower(p_filters->>'name')||'%' or
          lower(i.code) like '%'||lower(p_filters->>'name')||'%') and
        (nullif(p_filters->>'applicationId','') is null or i.application_id=(p_filters->>'applicationId')::uuid) and
        (nullif(p_filters->>'environment','') is null or i.environment=p_filters->>'environment') and
        (nullif(p_filters->>'recordId','') is null or i.id=(p_filters->>'recordId')::uuid) and
        (nullif(p_filters->>'status','') is null or
          (p_filters->>'status'='unpublished' and d.interface_id is null) or
          (p_filters->>'status'='enabled' and d.enabled) or
          (p_filters->>'status'='disabled' and d.interface_id is not null and not d.enabled))
      order by i.created_at desc,i.id limit page_size offset (page-1)*page_size
    ) i;
  return jsonb_build_object('records',records,'total',total,'current',page,'size',page_size,'summary',summary);
end $$;
create or replace function public.bff_release_options(p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null or not public.bff_actor_can(p_actor,'BffRelease:View') then raise exception 'BFF_FORBIDDEN'; end if;
  return jsonb_build_object(
    'applications',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'enabled',a.enabled)
      order by a.name,a.id) from public.bff_applications a where a.tenant_id=actor.tenant_id and
      (actor.role='admin' or exists(select 1 from public.bff_application_members am
        where am.application_id=a.id and am.member_id=p_actor and am.tenant_id=actor.tenant_id))),'[]'::jsonb),
    'environments',coalesce((select jsonb_agg(jsonb_build_object('value',d.value,'label',d.label) order by d.sort,d.id)
      from public.bff_dictionary_types t join public.bff_dictionary_items d on d.type_id=t.id and d.tenant_id=t.tenant_id
      where t.tenant_id=actor.tenant_id and t.code='bffRuntimeEnvironment' and t.builtin and t.status='1' and
        d.builtin and d.status='1'),'[]'::jsonb));
end $$;
create or replace function public.bff_release_snapshot(
  p_actor uuid,p_interface uuid,p_version_id uuid default null,p_permission text default 'BffRelease:View')
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare record jsonb; selected public.bff_interface_versions; deployment public.bff_interface_deployments;
begin
  record:=public.bff_release_target(p_actor,p_interface,p_permission);
  select * into deployment from public.bff_interface_deployments where interface_id=p_interface;
  select * into selected from public.bff_interface_versions
    where interface_id=p_interface and id=coalesce(p_version_id,deployment.active_version_id);
  if selected.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  return jsonb_build_object('interfaceId',selected.interface_id,'versionId',selected.id,'versionNumber',selected.number,
    'deploymentVersion',case when deployment.interface_id is null then 0 else deployment.version end,
    'applicationId',selected.application_id,'environment',selected.environment,'code',selected.code,
    'name',selected.name,'description',selected.description,'method',selected.method,'path',selected.path,
    'definition',selected.definition,
    'upstreams',coalesce((select jsonb_agg(jsonb_build_object('stepKey',b.step_key,'id',b.service_id,
      'configVersion',b.config_version,'credentialVersion',b.credential_version,'authType',b.auth_type,
      'headerName',b.header_name) order by b.step_key)
      from public.bff_interface_version_upstreams b where b.version_id=selected.id),'[]'::jsonb));
end $$;
create or replace function public.bff_release_prepare_snapshot(
  p_actor uuid,p_interface uuid,p_purpose text,p_version_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare draft public.bff_interfaces; deployment public.bff_interface_deployments;
  selected public.bff_interface_versions; snapshot jsonb; targets jsonb; permission text;
  route_method text; route_path text; desired_shape text; conflict boolean;
begin
  if p_purpose not in ('publish','rollback','enable') then raise exception 'BFF_INVALID_OPERATION'; end if;
  permission:=case p_purpose when 'publish' then 'BffRelease:Publish'
    when 'rollback' then 'BffRelease:Rollback' else 'BffRelease:ChangeStatus' end;
  perform public.bff_release_target(p_actor,p_interface,permission);
  select * into draft from public.bff_interfaces where id=p_interface and deleted_at is null;
  select * into deployment from public.bff_interface_deployments where interface_id=p_interface;
  if p_purpose='publish' then
    if p_version_id is not null then raise exception 'BFF_INVALID_OPERATION'; end if;
    snapshot:=jsonb_build_object('applicationId',draft.application_id,'environment',draft.environment,
      'code',draft.code,'name',draft.name,'description',draft.description,
      'method',draft.method,'path',draft.path,'definition',draft.definition);
  else
    if p_purpose='enable' and p_version_id is not null or
      p_purpose='rollback' and p_version_id is null then raise exception 'BFF_INVALID_OPERATION'; end if;
    select * into selected from public.bff_interface_versions where id=case when p_purpose='enable'
      then deployment.active_version_id else p_version_id end and interface_id=draft.id and
      tenant_id=draft.tenant_id and application_id=draft.application_id and environment=draft.environment;
    if selected.id is null then raise exception 'BFF_NOT_FOUND'; end if;
    snapshot:=jsonb_build_object('applicationId',selected.application_id,'environment',selected.environment,
      'code',selected.code,'name',selected.name,'description',selected.description,
      'method',selected.method,'path',selected.path,'definition',selected.definition);
  end if;
  route_method:=snapshot->>'method'; route_path:=snapshot->>'path';
  desired_shape:=pg_catalog.regexp_replace(route_path,'\{[A-Za-z][A-Za-z0-9_]*\}','{}','g');
  select exists(select 1 from public.bff_interface_deployments d where d.tenant_id=draft.tenant_id and
    d.application_id=draft.application_id and d.environment=draft.environment and d.enabled and
    d.method=route_method and d.route_shape=desired_shape and d.interface_id<>draft.id) into conflict;
  select coalesce(jsonb_agg(jsonb_build_object(
    'stepKey',step.value->>'key','id',coalesce(b.service_id,vb.service_id),
    'configVersion',coalesce(b.config_version,vb.config_version),
    'currentConfigVersion',u.config_version,'credentialVersion',u.credential_version,
    'baseUrl',rev.base_url,'timeoutMs',rev.timeout_ms,'authType',rev.auth_type,'headerName',rev.header_name,
    'credential',case when readiness.code='ready' and rev.auth_type<>'none' then
      jsonb_build_object('ciphertext',c.ciphertext,'keyId',c.key_id,'version',c.credential_version)
      else null end,'readinessCode',readiness.code) order by step.ordinality),'[]'::jsonb)
    into targets
  from jsonb_array_elements(snapshot->'definition'->'steps') with ordinality as step(value,ordinality)
  left join public.bff_interface_upstreams b on p_purpose='publish' and b.interface_id=draft.id and
    b.tenant_id=draft.tenant_id and b.application_id=draft.application_id and
    b.environment=draft.environment and b.step_key=step.value->>'key'
  left join public.bff_interface_version_upstreams vb on p_purpose<>'publish' and
    vb.version_id=selected.id and vb.interface_id=draft.id and vb.tenant_id=draft.tenant_id and
    vb.application_id=draft.application_id and vb.environment=draft.environment and vb.step_key=step.value->>'key'
  left join public.bff_upstream_services u on u.id=coalesce(b.service_id,vb.service_id) and
    u.tenant_id=draft.tenant_id and u.application_id=draft.application_id and u.environment=draft.environment
  left join public.bff_upstream_service_revisions rev on rev.service_id=coalesce(b.service_id,vb.service_id) and
    rev.config_version=coalesce(b.config_version,vb.config_version) and rev.tenant_id=draft.tenant_id and
    rev.application_id=draft.application_id and rev.environment=draft.environment
  left join public.bff_upstream_credentials c on c.service_id=u.id and c.tenant_id=u.tenant_id and
    c.application_id=u.application_id and c.credential_version=u.credential_version
  left join public.bff_applications a on a.id=draft.application_id and a.tenant_id=draft.tenant_id
  cross join lateral (select case
    when coalesce(b.service_id,vb.service_id) is null or u.id is null then 'missing'
    when u.deleted_at is not null or u.status<>'active' or not a.enabled then 'inactive'
    when rev.service_id is null or u.auth_type<>rev.auth_type or u.header_name<>rev.header_name or
      (p_purpose='publish' and u.config_version<>b.config_version) or
      (p_purpose<>'publish' and (vb.auth_type<>rev.auth_type or vb.header_name<>rev.header_name))
      then 'incompatible'
    when rev.auth_type<>'none' and c.service_id is null then 'credential_missing'
    else 'ready' end as code) readiness;
  return jsonb_build_object('record',public.bff_release_record(draft.id),'snapshot',snapshot,
    'validatedVersion',case when p_purpose='publish' then draft.validated_version else null end,
    'lastTestUpstreams',case when p_purpose='publish' then draft.last_test_upstreams else '[]'::jsonb end,
    'routeConflict',conflict,'targets',targets);
end $$;
create or replace function public.bff_release_targets_ready(
  p_interface uuid,p_version_id uuid,p_observed jsonb,p_publish boolean)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare item jsonb; bound record; observed_ids uuid[]:=array[]::uuid[]; observed_id uuid;
  pinned integer; current_config integer; credential integer; expected_count integer;
begin
  if jsonb_typeof(p_observed) is distinct from 'array' or jsonb_array_length(p_observed)>8 then return false; end if;
  select count(distinct service_id) into expected_count from (
    select service_id from public.bff_interface_upstreams where interface_id=p_interface and p_publish
    union all
    select service_id from public.bff_interface_version_upstreams
      where interface_id=p_interface and version_id=p_version_id and not p_publish
  ) expected;
  if jsonb_array_length(p_observed)<>expected_count or expected_count<1 then return false; end if;
  for item in select value from jsonb_array_elements(p_observed) loop
    if jsonb_typeof(item) is distinct from 'object' then return false; end if;
    begin
      observed_id:=(item->>'id')::uuid;
      pinned:=(item->>'configVersion')::integer;
      current_config:=(item->>'currentConfigVersion')::integer;
      credential:=(item->>'credentialVersion')::integer;
    exception when others then return false;
    end;
    if observed_id is null or pinned is null or current_config is null or credential is null or
      observed_id=any(observed_ids) then return false; end if;
    observed_ids:=pg_catalog.array_append(observed_ids,observed_id);
    if p_publish then
      select b.service_id,b.config_version,r.auth_type,r.header_name into bound
      from public.bff_interface_upstreams b join public.bff_upstream_service_revisions r
        on r.service_id=b.service_id and r.config_version=b.config_version and r.tenant_id=b.tenant_id and
          r.application_id=b.application_id and r.environment=b.environment
      where b.interface_id=p_interface and b.service_id=observed_id limit 1;
    else
      select b.service_id,b.config_version,b.auth_type,b.header_name into bound
      from public.bff_interface_version_upstreams b
      where b.interface_id=p_interface and b.version_id=p_version_id and b.service_id=observed_id limit 1;
    end if;
    if bound.service_id is null or bound.config_version<>pinned or
      (p_publish and current_config<>pinned) or
      not exists(select 1 from public.bff_upstream_services u
        join public.bff_applications a on a.id=u.application_id and a.tenant_id=u.tenant_id
        where u.id=observed_id and u.status='active' and u.deleted_at is null and a.enabled and
          u.config_version=current_config and u.credential_version=credential and
          u.auth_type=bound.auth_type and u.header_name=bound.header_name and
          (u.auth_type='none' or exists(select 1 from public.bff_upstream_credentials c
            where c.service_id=u.id and c.tenant_id=u.tenant_id and
              c.application_id=u.application_id and c.credential_version=credential)))
    then return false; end if;
    if p_publish and not exists(
      select 1 from public.bff_interfaces i,
        jsonb_array_elements(i.last_test_upstreams) as tested(value)
      where i.id=p_interface and tested.value->>'id'=observed_id::text and
        (tested.value->>'configVersion')::integer=pinned and
        (tested.value->>'credentialVersion')::integer=credential)
    then return false; end if;
  end loop;
  return true;
end $$;
create or replace function public.bff_write_release(
  p_actor uuid,p_operation text,p_interface uuid,p_draft_version integer,p_deployment_version integer,
  p_target_version uuid,p_notes text,p_upstream_versions jsonb default '[]'::jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; draft public.bff_interfaces; deployment public.bff_interface_deployments;
  target public.bff_interface_versions; old_version uuid; new_number integer; permission text; notes text;
  metadata jsonb; new_shape text; current_revision bigint;
begin
  if p_operation is null or p_operation not in ('publish','rollback','enable','disable') or
    p_interface is null or p_deployment_version is null or p_deployment_version<0
  then raise exception 'BFF_INVALID_OPERATION'; end if;
  notes:=pg_catalog.btrim(coalesce(p_notes,''));
  if length(notes) not between 1 and 1000 then raise exception 'BFF_INVALID_NOTES'; end if;
  permission:=case p_operation when 'publish' then 'BffRelease:Publish'
    when 'rollback' then 'BffRelease:Rollback' else 'BffRelease:ChangeStatus' end;
  current_revision:=public.bff_control_lock(p_actor,permission,'releases');
  select * into actor from public.bff_members where id=p_actor and enabled;
  select * into draft from public.bff_interfaces
    where id=p_interface and tenant_id=actor.tenant_id and deleted_at is null for update;
  if draft.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_release_scope(p_actor,draft.application_id,permission) then raise exception 'BFF_FORBIDDEN'; end if;
  select * into deployment from public.bff_interface_deployments where interface_id=p_interface for update;
  if coalesce(deployment.version,0)<>p_deployment_version then raise exception 'BFF_CONFLICT'; end if;
  if p_operation<>'disable' and not exists(select 1 from public.bff_applications
    where id=draft.application_id and tenant_id=draft.tenant_id and enabled)
  then raise exception 'BFF_RELEASE_APP_DISABLED'; end if;
  old_version:=deployment.active_version_id;
  if p_operation='publish' then
    if p_draft_version is distinct from draft.version or p_target_version is not null
    then raise exception 'BFF_CONFLICT'; end if;
    if draft.validation_status<>'valid' or draft.validated_version is distinct from draft.version or
      draft.last_test_status<>'passed' or draft.last_test_version is distinct from draft.version or
      jsonb_array_length(draft.last_test_upstreams)=0
    then raise exception 'BFF_RELEASE_NOT_TESTED'; end if;
    if draft.method='GET' and exists(select 1 from jsonb_array_elements(draft.definition->'steps') as step(value)
      where step.value->>'method'<>'GET') then raise exception 'BFF_RELEASE_GET_WRITE_STEP'; end if;
    if not public.bff_release_targets_ready(p_interface,null,p_upstream_versions,true)
    then raise exception 'BFF_RELEASE_UPSTREAM_CHANGED'; end if;
    select coalesce(max(number),0)+1 into new_number from public.bff_interface_versions where interface_id=p_interface;
    metadata:=jsonb_build_object('applicationId',draft.application_id,'environment',draft.environment,
      'code',draft.code,'name',draft.name,'description',draft.description,'method',draft.method,
      'path',draft.path,'definition',draft.definition);
    insert into public.bff_interface_versions(interface_id,tenant_id,application_id,environment,
      number,draft_version,code,name,description,method,path,definition,checksum,notes,created_by)
      values(draft.id,draft.tenant_id,draft.application_id,draft.environment,new_number,draft.version,
        draft.code,draft.name,draft.description,draft.method,draft.path,draft.definition,
        pg_catalog.encode(extensions.digest(pg_catalog.convert_to(metadata::text,'UTF8'),'sha256'),'hex'),
        notes,p_actor) returning * into target;
    insert into public.bff_interface_version_upstreams(version_id,interface_id,step_key,service_id,
      config_version,credential_version,auth_type,header_name,tenant_id,application_id,environment,created_by)
      select target.id,draft.id,b.step_key,b.service_id,b.config_version,
        (observed.value->>'credentialVersion')::integer,r.auth_type,r.header_name,
        b.tenant_id,b.application_id,b.environment,p_actor
      from public.bff_interface_upstreams b
      join public.bff_upstream_service_revisions r on r.service_id=b.service_id and
        r.config_version=b.config_version and r.tenant_id=b.tenant_id and
        r.application_id=b.application_id and r.environment=b.environment
      join jsonb_array_elements(p_upstream_versions) as observed(value)
        on observed.value->>'id'=b.service_id::text
      where b.interface_id=draft.id;
  else
    if deployment.interface_id is null then raise exception 'BFF_RELEASE_UNPUBLISHED'; end if;
    if p_operation='rollback' then
      if p_target_version is null or p_target_version=deployment.active_version_id
      then raise exception 'BFF_RELEASE_TARGET_INVALID'; end if;
      select * into target from public.bff_interface_versions
        where id=p_target_version and interface_id=p_interface;
      if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
    else
      if p_target_version is not null then raise exception 'BFF_INVALID_OPERATION'; end if;
      select * into target from public.bff_interface_versions where id=deployment.active_version_id;
    end if;
    if p_operation in ('rollback','enable') then
      if target.method='GET' and exists(select 1 from jsonb_array_elements(target.definition->'steps') as step(value)
        where step.value->>'method'<>'GET') then raise exception 'BFF_RELEASE_GET_WRITE_STEP'; end if;
      if not public.bff_release_targets_ready(p_interface,target.id,p_upstream_versions,false)
      then raise exception 'BFF_RELEASE_UPSTREAM_CHANGED'; end if;
    end if;
    if p_operation='enable' and deployment.enabled or p_operation='disable' and not deployment.enabled
    then raise exception 'BFF_CONFLICT'; end if;
  end if;
  if p_operation='disable' then
    update public.bff_interface_deployments set enabled=false,version=version+1,
      updated_by=p_actor,updated_at=now() where interface_id=p_interface returning * into deployment;
  else
    new_shape:=pg_catalog.regexp_replace(target.path,'\{[A-Za-z][A-Za-z0-9_]*\}','{}','g');
    if deployment.interface_id is null then
      insert into public.bff_interface_deployments(interface_id,tenant_id,application_id,environment,
        active_version_id,enabled,method,path,route_shape,created_by,updated_by)
        values(draft.id,draft.tenant_id,draft.application_id,draft.environment,target.id,true,
          target.method,target.path,new_shape,p_actor,p_actor) returning * into deployment;
    else
      update public.bff_interface_deployments set active_version_id=target.id,
        enabled=case when p_operation='rollback' then enabled else true end,
        method=target.method,path=target.path,route_shape=new_shape,version=version+1,
        updated_by=p_actor,updated_at=now() where interface_id=p_interface returning * into deployment;
    end if;
  end if;
  insert into public.bff_interface_release_events(interface_id,tenant_id,application_id,environment,
    action,from_version_id,to_version_id,deployment_version,notes,actor_id)
    values(draft.id,draft.tenant_id,draft.application_id,draft.environment,p_operation,old_version,
      deployment.active_version_id,deployment.version,notes,p_actor);
  current_revision:=public.bff_control_advance(p_actor,'releases','release.'||p_operation,p_interface,
    jsonb_build_object('fromVersionId',old_version,'toVersionId',deployment.active_version_id,
      'deploymentVersion',deployment.version,'enabled',deployment.enabled));
  return public.bff_release_history_unchecked(p_interface);
end $$;
create or replace function public.bff_gateway_scope(
  p_actor uuid,p_application uuid,p_method text)
returns boolean language sql stable security invoker set search_path='' as $$
select exists(select 1 from public.bff_members m
  join public.bff_applications a on a.id=p_application and a.tenant_id=m.tenant_id and a.enabled
  where m.id=p_actor and m.enabled and public.bff_actor_can(p_actor,'BffInterface:Invoke') and
    (p_method='GET' or public.bff_actor_can(p_actor,'BffInterface:InvokeWrite')) and
    (m.role='admin' or exists(select 1 from public.bff_application_members am
      where am.application_id=a.id and am.member_id=m.id and am.tenant_id=m.tenant_id)))
$$;
create or replace function public.bff_route_matches(p_template text,p_actual text)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare pattern text:='^'; cursor integer:=1; close_at integer; token text; letter text;
begin
  if p_actual is null or left(p_actual,1)<>'/' or p_actual ~ '[?#[:cntrl:]]' then return false; end if;
  if p_template is null or length(p_template)>500 then return false; end if;
  while cursor<=length(p_template) loop
    letter:=substr(p_template,cursor,1);
    if letter='{' then
      close_at:=pg_catalog.strpos(substr(p_template,cursor+1),'}');
      if close_at<2 then return false; end if;
      token:=substr(p_template,cursor+1,close_at-1);
      if token !~ '^[A-Za-z][A-Za-z0-9_]*$' then return false; end if;
      pattern:=pattern||'[^/]+';
      cursor:=cursor+close_at+1;
    elsif letter='}' then
      return false;
    else
      if pg_catalog.strpos('.^$*+?()[]|\',letter)>0 then pattern:=pattern||'\'; end if;
      pattern:=pattern||letter;
      cursor:=cursor+1;
    end if;
  end loop;
  return p_actual ~ (pattern||'$');
end $$;
create or replace function public.bff_gateway_public(p_interface uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('interfaceId',i.id,'versionId',v.id,'versionNumber',v.number,
  'deploymentVersion',d.version,'applicationId',i.application_id,'environment',i.environment,
  'code',v.code,'name',v.name,'description',v.description,'method',v.method,'path',v.path,
  'definition',v.definition)
from public.bff_interface_deployments d
join public.bff_interfaces i on i.id=d.interface_id and i.tenant_id=d.tenant_id and
  i.application_id=d.application_id and i.environment=d.environment
join public.bff_interface_versions v on v.id=d.active_version_id and v.interface_id=i.id
where i.id=p_interface and i.deleted_at is null and d.enabled
$$;
create or replace function public.bff_gateway_candidates(
  p_actor uuid,p_app_code text,p_environment text,p_method text,p_path text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; app public.bff_applications; results jsonb;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  select * into app from public.bff_applications
    where tenant_id=actor.tenant_id and code=p_app_code and enabled;
  if app.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_gateway_scope(p_actor,app.id,p_method) then raise exception 'BFF_FORBIDDEN'; end if;
  select coalesce(jsonb_agg(public.bff_gateway_public(d.interface_id)
    order by length(d.route_shape) desc,d.path,d.interface_id),'[]'::jsonb) into results
    from public.bff_interface_deployments d
    join public.bff_interfaces i on i.id=d.interface_id and i.tenant_id=d.tenant_id and
      i.application_id=d.application_id and i.environment=d.environment
    where d.tenant_id=actor.tenant_id and d.application_id=app.id and
      d.environment=p_environment and d.enabled and i.deleted_at is null and d.method=p_method and
      public.bff_route_matches(d.path,p_path);
  return results;
end $$;
create or replace function public.bff_gateway_target(
  p_actor uuid,p_interface uuid,p_version_id uuid,p_deployment_version integer)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; deployment public.bff_interface_deployments; draft public.bff_interfaces;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  select * into draft from public.bff_interfaces where id=p_interface and tenant_id=actor.tenant_id and deleted_at is null;
  select * into deployment from public.bff_interface_deployments
    where interface_id=p_interface and tenant_id=actor.tenant_id and enabled;
  if draft.id is null or deployment.interface_id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if deployment.active_version_id is distinct from p_version_id or
    deployment.version is distinct from p_deployment_version then raise exception 'BFF_CONFLICT'; end if;
  if not public.bff_gateway_scope(p_actor,draft.application_id,deployment.method)
  then raise exception 'BFF_FORBIDDEN'; end if;
  return public.bff_gateway_public(p_interface);
end $$;
create or replace function public.bff_gateway_step_targets(
  p_actor uuid,p_interface uuid,p_version_id uuid,p_deployment_version integer,p_step_keys text[])
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare publication jsonb; expected_count integer; resolved_count integer; targets jsonb;
begin
  if p_step_keys is null or cardinality(p_step_keys) not between 1 and 8 or
    exists(select 1 from unnest(p_step_keys) as requested(key)
      where requested.key is null or requested.key !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$') or
    (select count(distinct requested.key) from unnest(p_step_keys) as requested(key))<>cardinality(p_step_keys)
  then raise exception 'BFF_INVALID_STEP_KEYS'; end if;
  publication:=public.bff_gateway_target(p_actor,p_interface,p_version_id,p_deployment_version);
  select count(*) into expected_count from public.bff_interface_version_upstreams b
    where b.version_id=p_version_id and b.interface_id=p_interface and b.step_key=any(p_step_keys);
  if expected_count<>cardinality(p_step_keys) then raise exception 'BFF_INVALID_STEP_KEYS'; end if;
  select count(*),coalesce(jsonb_agg(jsonb_build_object(
    'stepKey',b.step_key,'id',b.service_id,'configVersion',b.config_version,
    'currentConfigVersion',u.config_version,'credentialVersion',u.credential_version,
    'baseUrl',r.base_url,'timeoutMs',r.timeout_ms,'authType',r.auth_type,'headerName',r.header_name,
    'credential',case when r.auth_type='none' then null else
      jsonb_build_object('ciphertext',c.ciphertext,'keyId',c.key_id,'version',c.credential_version) end)
    order by requested.ordinal),'[]'::jsonb) into resolved_count,targets
    from unnest(p_step_keys) with ordinality as requested(step_key,ordinal)
    join public.bff_interface_version_upstreams b on b.version_id=p_version_id and
      b.interface_id=p_interface and b.step_key=requested.step_key and
      b.tenant_id=(select tenant_id from public.bff_members where id=p_actor and enabled) and
      b.application_id=(publication->>'applicationId')::uuid and b.environment=publication->>'environment'
    join public.bff_upstream_services u on u.id=b.service_id and u.tenant_id=b.tenant_id and
      u.application_id=b.application_id and u.environment=b.environment and
      u.deleted_at is null and u.status='active' and u.auth_type=b.auth_type and u.header_name=b.header_name
    join public.bff_upstream_service_revisions r on r.service_id=b.service_id and
      r.config_version=b.config_version and r.tenant_id=b.tenant_id and
      r.application_id=b.application_id and r.environment=b.environment and
      r.auth_type=b.auth_type and r.header_name=b.header_name
    join public.bff_applications a on a.id=u.application_id and a.tenant_id=u.tenant_id and a.enabled
    left join public.bff_upstream_credentials c on c.service_id=u.id and c.tenant_id=u.tenant_id and
      c.application_id=u.application_id and c.credential_version=u.credential_version
    where r.auth_type='none' or c.service_id is not null;
  if resolved_count<>cardinality(p_step_keys) then raise exception 'BFF_RELEASE_UPSTREAM_CHANGED'; end if;
  return targets;
end $$;
create or replace function public.bff_gateway_begin(
  p_actor uuid,p_interface uuid,p_version_id uuid,p_deployment_version integer,
  p_request_id uuid,p_idempotency_hash text,p_input_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; publication jsonb; existing public.bff_interface_calls;
  method text; actor_recent integer; tenant_recent integer; actor_running integer; tenant_running integer;
begin
  if p_request_id is null or p_input_hash is null or p_input_hash !~ '^[0-9a-f]{64}$' or
    (p_idempotency_hash is not null and p_idempotency_hash !~ '^[0-9a-f]{64}$')
  then raise exception 'BFF_INVALID_REQUEST'; end if;
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bff-control:'||actor.tenant_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bff-gateway:'||actor.tenant_id::text,0));
  publication:=public.bff_gateway_target(p_actor,p_interface,p_version_id,p_deployment_version);
  method:=publication->>'method';
  if method<>'GET' and p_idempotency_hash is null then raise exception 'BFF_IDEMPOTENCY_REQUIRED'; end if;
  if p_idempotency_hash is not null then
    select * into existing from public.bff_interface_calls where tenant_id=actor.tenant_id and
      member_id=p_actor and idempotency_hash=p_idempotency_hash for update;
    if existing.request_id is not null then
      if existing.input_hash<>p_input_hash or existing.interface_id<>p_interface or
        existing.version_id<>p_version_id or existing.deployment_version<>p_deployment_version
      then raise exception 'BFF_IDEMPOTENCY_CONFLICT'; end if;
      if existing.status='running' and existing.expires_at<=now() then
        update public.bff_interface_calls set status='unknown',finished_at=now(),error_code='LEASE_EXPIRED',error_class='unknown',
          result_payload=null,result_expires_at=null where request_id=existing.request_id;
        return jsonb_build_object('kind','unknown','requestId',existing.request_id,
          'versionNumber',publication->'versionNumber');
      end if;
      if existing.status='running' then return jsonb_build_object('kind','running','requestId',existing.request_id,
        'versionNumber',publication->'versionNumber'); end if;
      if existing.status='succeeded' and existing.result_payload is not null and
        existing.result_expires_at>now() then
        return jsonb_build_object('kind','replay','requestId',existing.request_id,
          'versionNumber',publication->'versionNumber','resultPayload',existing.result_payload,
          'httpStatus',existing.http_status);
      end if;
      return jsonb_build_object('kind','unknown','requestId',existing.request_id,
        'versionNumber',publication->'versionNumber');
    end if;
  end if;
  update public.bff_interface_calls set status='unknown',finished_at=now(),error_code='LEASE_EXPIRED',error_class='unknown',
    result_payload=null,result_expires_at=null
    where tenant_id=actor.tenant_id and status='running' and expires_at<=now();
  update public.bff_interface_calls set result_payload=null,result_expires_at=null
    where tenant_id=actor.tenant_id and result_expires_at<=now() and result_payload is not null;
  select count(*) filter(where member_id=p_actor),count(*) into actor_recent,tenant_recent
    from public.bff_interface_calls where tenant_id=actor.tenant_id and started_at>now()-interval '1 minute';
  if actor_recent>=120 or tenant_recent>=600 then raise exception 'BFF_GATEWAY_RATE_LIMIT'; end if;
  select count(*) filter(where member_id=p_actor),count(*) into actor_running,tenant_running
    from public.bff_interface_calls where tenant_id=actor.tenant_id and status='running';
  if actor_running>=4 or tenant_running>=16 then raise exception 'BFF_GATEWAY_CONCURRENCY_LIMIT'; end if;
  insert into public.bff_interface_calls(request_id,tenant_id,application_id,environment,interface_id,
    version_id,member_id,deployment_version,method,path_template,idempotency_hash,input_hash)
    values(p_request_id,actor.tenant_id,(publication->>'applicationId')::uuid,publication->>'environment',
      p_interface,p_version_id,p_actor,p_deployment_version,method,publication->>'path',
      p_idempotency_hash,p_input_hash);
  return jsonb_build_object('kind','started','requestId',p_request_id,
    'versionNumber',publication->'versionNumber');
end $$;
drop function if exists public.bff_gateway_finish(uuid,uuid,boolean,integer,integer,text,jsonb,text,jsonb);
drop function if exists public.bff_gateway_finish(uuid,uuid,boolean,integer,integer,text,jsonb,text);
create or replace function public.bff_gateway_finish(
  p_actor uuid,p_request_id uuid,p_success boolean,p_http_status integer,p_duration_ms integer,
  p_error_code text,p_steps jsonb,p_result_payload text,p_upstream_versions jsonb,p_error_class text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; call_record public.bff_interface_calls; deployment public.bff_interface_deployments;
  stale boolean; item jsonb; observed_id uuid; pinned integer; current_config integer; credential integer;
  observed_ids uuid[]:=array[]::uuid[];
begin
  if p_request_id is null or p_success is null or p_http_status not between 100 and 599 or
    p_duration_ms not between 0 and 60000 or jsonb_typeof(p_steps) is distinct from 'array' or
    jsonb_array_length(p_steps)>8 or
    jsonb_typeof(p_upstream_versions) is distinct from 'array' or jsonb_array_length(p_upstream_versions)>8 or
    (p_error_code is not null and (length(p_error_code)>80 or p_error_code !~ '^[A-Z][A-Z0-9_]*$')) or
    (p_result_payload is not null and length(p_result_payload)>131072) or
    (p_error_class is not null and p_error_class not in
      ('timeout','upstream','unknown','authorization','validation','rate_limited')) or
    (p_success and p_error_class is not null)
  then raise exception 'BFF_INVALID_RESULT'; end if;
  for item in select value from jsonb_array_elements(p_steps) loop
    if jsonb_typeof(item) is distinct from 'object' or
      exists(select 1 from jsonb_object_keys(item) as key(name)
        where key.name not in ('key','name','status','statusCode','durationMs','code','errorClass')) or
      jsonb_typeof(item->'key') is distinct from 'string' or
      coalesce(item->>'key','') !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$' or
      (item ? 'name' and (jsonb_typeof(item->'name') is distinct from 'string' or length(item->>'name')>100)) or
      jsonb_typeof(item->'status') is distinct from 'string' or
      item->>'status' not in ('passed','failed','skipped') or
      (item ? 'statusCode' and item->'statusCode'<>'null'::jsonb and (jsonb_typeof(item->'statusCode') is distinct from 'number' or
        (item->>'statusCode')::numeric not between 100 and 599 or
        (item->>'statusCode')::numeric<>trunc((item->>'statusCode')::numeric))) or
      (item ? 'durationMs' and (jsonb_typeof(item->'durationMs') is distinct from 'number' or
        (item->>'durationMs')::numeric not between 0 and 60000 or
        (item->>'durationMs')::numeric<>trunc((item->>'durationMs')::numeric))) or
      (item ? 'code' and item->'code'<>'null'::jsonb and (jsonb_typeof(item->'code') is distinct from 'string' or
        length(item->>'code')>80 or item->>'code' !~ '^[A-Z][A-Z0-9_]*$')) or
      (item ? 'errorClass' and item->'errorClass'<>'null'::jsonb and (jsonb_typeof(item->'errorClass') is distinct from 'string' or
        item->>'errorClass' not in ('timeout','upstream','unknown','authorization','validation','rate_limited')))
    then raise exception 'BFF_INVALID_RESULT'; end if;
  end loop;
  select * into actor from public.bff_members where id=p_actor;
  if actor.id is null then raise exception 'BFF_FORBIDDEN'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bff-control:'||actor.tenant_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bff-gateway:'||actor.tenant_id::text,0));
  select * into call_record from public.bff_interface_calls
    where request_id=p_request_id and tenant_id=actor.tenant_id and member_id=p_actor for update;
  if call_record.request_id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if call_record.status<>'running' then return jsonb_build_object('stale',true); end if;
  select * into deployment from public.bff_interface_deployments where interface_id=call_record.interface_id;
  stale:=not actor.enabled or call_record.expires_at<=now() or deployment.interface_id is null or
    not deployment.enabled or deployment.active_version_id<>call_record.version_id or
    deployment.version<>call_record.deployment_version or
    not public.bff_gateway_scope(p_actor,call_record.application_id,call_record.method);
  for item in select value from jsonb_array_elements(p_upstream_versions) loop
    if jsonb_typeof(item) is distinct from 'object' then raise exception 'BFF_INVALID_RESULT'; end if;
    begin
      observed_id:=(item->>'id')::uuid;
      pinned:=(item->>'configVersion')::integer;
      current_config:=(item->>'currentConfigVersion')::integer;
      credential:=(item->>'credentialVersion')::integer;
    exception when others then raise exception 'BFF_INVALID_RESULT';
    end;
    if observed_id is null or pinned is null or current_config is null or credential is null or
      observed_id=any(observed_ids) or
      not exists(select 1 from public.bff_interface_version_upstreams b
        where b.version_id=call_record.version_id and b.interface_id=call_record.interface_id and
          b.service_id=observed_id)
    then raise exception 'BFF_INVALID_RESULT'; end if;
    observed_ids:=pg_catalog.array_append(observed_ids,observed_id);
    if not exists(select 1 from public.bff_interface_version_upstreams b
      join public.bff_upstream_services u on u.id=b.service_id and u.tenant_id=b.tenant_id and
        u.application_id=b.application_id and u.environment=b.environment
      join public.bff_applications a on a.id=u.application_id and a.tenant_id=u.tenant_id
      where b.version_id=call_record.version_id and b.interface_id=call_record.interface_id and
        b.tenant_id=call_record.tenant_id and b.application_id=call_record.application_id and
        b.service_id=observed_id and b.config_version=pinned and
        u.config_version=current_config and u.credential_version=credential and
        u.deleted_at is null and u.status='active' and a.enabled and
        u.auth_type=b.auth_type and u.header_name=b.header_name and
        (u.auth_type='none' or exists(select 1 from public.bff_upstream_credentials c
          where c.service_id=u.id and c.tenant_id=u.tenant_id and
            c.application_id=u.application_id and c.credential_version=credential)))
    then stale:=true; end if;
  end loop;
  if p_success and cardinality(observed_ids) is distinct from
    (select count(distinct service_id) from public.bff_interface_version_upstreams
      where version_id=call_record.version_id and interface_id=call_record.interface_id)
  then stale:=true; end if;
  if stale then
    update public.bff_interface_calls set status='unknown',finished_at=now(),error_code='STALE_DEPLOYMENT',error_class='unknown',
      result_payload=null,result_expires_at=null where request_id=p_request_id;
    return jsonb_build_object('stale',true);
  end if;
  if p_success and (p_result_payload is null or p_error_code is not null) or
    not p_success and p_result_payload is not null then raise exception 'BFF_INVALID_RESULT'; end if;
  update public.bff_interface_calls set status=case when p_success then 'succeeded' else 'failed' end,
    finished_at=now(),duration_ms=p_duration_ms,http_status=p_http_status,error_code=p_error_code,error_class=p_error_class,
    steps=p_steps,result_payload=case when p_success then p_result_payload else null end,
    result_expires_at=case when p_success then now()+interval '15 minutes' else null end
    where request_id=p_request_id;
  return jsonb_build_object('stale',false);
end $$;
create or replace function public.bff_call_public(p_request_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object(
  'requestId',c.request_id,'applicationId',c.application_id,'applicationName',a.name,
  'environment',c.environment,'interfaceId',c.interface_id,'interfaceName',v.name,
  'versionNumber',v.number,'method',c.method,'pathTemplate',c.path_template,
  'startedAt',c.started_at,'finishedAt',c.finished_at,'durationMs',c.duration_ms,
  'status',c.status,'httpStatus',c.http_status,'errorCode',c.error_code,'errorClass',c.error_class,
  'steps',coalesce((select jsonb_agg(jsonb_build_object(
    'key',s.value->>'key','status',s.value->>'status',
    'statusCode',case when jsonb_typeof(s.value->'statusCode')='number' then s.value->'statusCode' else 'null'::jsonb end,
    'durationMs',case when jsonb_typeof(s.value->'durationMs')='number' then s.value->'durationMs' else 'null'::jsonb end,
    'code',s.value->>'code',
    'errorClass',case when s.value->>'errorClass' in ('timeout','upstream','unknown','authorization','validation','rate_limited')
      then s.value->>'errorClass' else null end) order by s.ordinality)
    from jsonb_array_elements(c.steps) with ordinality as s(value,ordinality)),'[]'::jsonb))
from public.bff_interface_calls c
join public.bff_applications a on a.id=c.application_id and a.tenant_id=c.tenant_id
join public.bff_interface_versions v on v.id=c.version_id and v.tenant_id=c.tenant_id and v.interface_id=c.interface_id
where c.request_id=p_request_id
$$;
create or replace function public.bff_call_window(p_filters jsonb)
returns tstzrange language plpgsql stable security invoker set search_path='' as $$
declare from_at timestamptz; to_at timestamptz;
begin
  if p_filters is null or jsonb_typeof(p_filters)<>'object' then raise exception 'BFF_INVALID_FILTER'; end if;
  begin
    to_at:=coalesce(nullif(p_filters->>'to','')::timestamptz,now());
    from_at:=coalesce(nullif(p_filters->>'from','')::timestamptz,to_at-interval '24 hours');
  exception when others then raise exception 'BFF_INVALID_FILTER'; end;
  if from_at>=to_at or to_at>now()+interval '1 minute' or to_at-from_at>interval '30 days'
  then raise exception 'BFF_INVALID_FILTER'; end if;
  return tstzrange(from_at,to_at,'[)');
end $$;
create or replace function public.bff_read_calls(p_actor uuid,p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; bounds tstzrange; page integer; size integer; total integer;
  records jsonb; summary jsonb; filter_app uuid; filter_interface uuid; filter_request uuid;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null or not public.bff_actor_can(p_actor,'BffCall:View') then raise exception 'BFF_FORBIDDEN'; end if;
  bounds:=public.bff_call_window(p_filters);
  begin
    page:=coalesce(nullif(p_filters->>'current','')::integer,1);
    size:=coalesce(nullif(p_filters->>'size','')::integer,20);
    filter_app:=nullif(p_filters->>'applicationId','')::uuid;
    filter_interface:=nullif(p_filters->>'interfaceId','')::uuid;
    filter_request:=nullif(p_filters->>'requestId','')::uuid;
  exception when others then raise exception 'BFF_INVALID_FILTER'; end;
  if page not between 1 and 100000 or size not between 1 and 100 or
    (p_filters ? 'environment' and nullif(p_filters->>'environment','') is not null and
      p_filters->>'environment' not in ('development','staging','production')) or
    (p_filters ? 'status' and nullif(p_filters->>'status','') is not null and
      p_filters->>'status' not in ('running','succeeded','failed','unknown')) or
    (p_filters ? 'method' and nullif(p_filters->>'method','') is not null and
      p_filters->>'method' not in ('GET','POST','PUT','PATCH','DELETE')) or
    (p_filters ? 'errorClass' and nullif(p_filters->>'errorClass','') is not null and
      p_filters->>'errorClass' not in ('timeout','upstream','unknown','authorization','validation','rate_limited','unclassified'))
  then raise exception 'BFF_INVALID_FILTER'; end if;
  with scoped as (
    select c.request_id,c.status,c.error_class from public.bff_interface_calls c
    where c.tenant_id=actor.tenant_id and c.started_at<@bounds and
      public.bff_interface_scope(p_actor,c.application_id,'BffCall:View') and
      (filter_app is null or c.application_id=filter_app) and
      (filter_interface is null or c.interface_id=filter_interface) and
      (filter_request is null or c.request_id=filter_request) and
      (nullif(p_filters->>'environment','') is null or c.environment=p_filters->>'environment') and
      (nullif(p_filters->>'status','') is null or c.status=p_filters->>'status') and
      (nullif(p_filters->>'method','') is null or c.method=p_filters->>'method') and
      (nullif(p_filters->>'errorClass','') is null or
        (p_filters->>'errorClass'='unclassified' and c.error_class is null) or c.error_class=p_filters->>'errorClass')
  ) select count(*),jsonb_build_object('total',count(*),
      'running',count(*) filter(where status='running'),
      'succeeded',count(*) filter(where status='succeeded'),
      'failed',count(*) filter(where status='failed'),
      'unknown',count(*) filter(where status='unknown'),
      'timeout',count(*) filter(where error_class='timeout')) into total,summary from scoped;
  select coalesce(jsonb_agg(public.bff_call_public(q.request_id) order by q.started_at desc,q.request_id desc),'[]'::jsonb)
    into records from (select c.request_id,c.started_at from public.bff_interface_calls c
      where c.tenant_id=actor.tenant_id and c.started_at<@bounds and
        public.bff_interface_scope(p_actor,c.application_id,'BffCall:View') and
        (filter_app is null or c.application_id=filter_app) and
        (filter_interface is null or c.interface_id=filter_interface) and
        (filter_request is null or c.request_id=filter_request) and
        (nullif(p_filters->>'environment','') is null or c.environment=p_filters->>'environment') and
        (nullif(p_filters->>'status','') is null or c.status=p_filters->>'status') and
        (nullif(p_filters->>'method','') is null or c.method=p_filters->>'method') and
        (nullif(p_filters->>'errorClass','') is null or
          (p_filters->>'errorClass'='unclassified' and c.error_class is null) or c.error_class=p_filters->>'errorClass')
      order by c.started_at desc,c.request_id desc limit size offset (page-1)*size) q;
  return jsonb_build_object('records',records,'total',total,'current',page,'size',size,'summary',summary);
end $$;
create or replace function public.bff_call_detail(p_actor uuid,p_request_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare target public.bff_interface_calls;
begin
  select * into target from public.bff_interface_calls where request_id=p_request_id and
    tenant_id=(select tenant_id from public.bff_members where id=p_actor and enabled);
  if target.request_id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_interface_scope(p_actor,target.application_id,'BffCall:View') then raise exception 'BFF_FORBIDDEN'; end if;
  return public.bff_call_public(p_request_id);
end $$;
create or replace function public.bff_call_options(p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null or not public.bff_actor_can(p_actor,'BffCall:View') then raise exception 'BFF_FORBIDDEN'; end if;
  return jsonb_build_object(
    'applications',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'enabled',a.enabled) order by a.name,a.id)
      from public.bff_applications a where a.tenant_id=actor.tenant_id and
        public.bff_interface_scope(p_actor,a.id,'BffCall:View')),'[]'::jsonb),
    'environments',jsonb_build_array(jsonb_build_object('value','development','label','开发'),
      jsonb_build_object('value','staging','label','预发'),jsonb_build_object('value','production','label','生产')),
    'interfaces',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'applicationId',i.application_id,
      'environment',i.environment,'code',i.code,'name',i.name) order by i.name,i.id)
      from public.bff_interfaces i where i.tenant_id=actor.tenant_id and
        public.bff_interface_scope(p_actor,i.application_id,'BffCall:View')),'[]'::jsonb),
    'statuses',jsonb_build_array(jsonb_build_object('value','running','label','执行中'),
      jsonb_build_object('value','succeeded','label','成功'),jsonb_build_object('value','failed','label','失败'),
      jsonb_build_object('value','unknown','label','结果未知')),
    'errorClasses',jsonb_build_array(jsonb_build_object('value','timeout','label','超时'),
      jsonb_build_object('value','upstream','label','上游故障'),jsonb_build_object('value','unknown','label','未知'),
      jsonb_build_object('value','authorization','label','授权'),jsonb_build_object('value','validation','label','校验'),
      jsonb_build_object('value','rate_limited','label','限流'),jsonb_build_object('value','unclassified','label','未分类')));
end $$;
create or replace function public.bff_alert_rule_public(p_rule uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('id',r.id,'applicationId',r.application_id,'applicationName',a.name,
  'environment',r.environment,'interfaceId',r.interface_id,'interfaceName',i.name,
  'name',r.name,'metric',r.metric,'windowMinutes',r.window_minutes,'threshold',r.threshold,
  'minCalls',r.min_calls,'severity',r.severity,'enabled',r.enabled,'quietMinutes',r.quiet_minutes,
  'version',r.version,'archivedAt',r.archived_at,'lastEvaluatedAt',r.last_evaluated_at,
  'createdAt',r.created_at,'updatedAt',r.updated_at)
from public.bff_alert_rules r
join public.bff_applications a on a.id=r.application_id and a.tenant_id=r.tenant_id
left join public.bff_interfaces i on i.id=r.interface_id and i.tenant_id=r.tenant_id
where r.id=p_rule
$$;
create or replace function public.bff_alert_instance_public(p_instance uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('id',n.id,'ruleId',n.rule_id,'ruleName',r.name,
  'applicationId',n.application_id,'applicationName',a.name,'environment',n.environment,
  'interfaceId',n.interface_id,'interfaceName',i.name,'metric',n.metric,'severity',n.severity,
  'state',n.state,'observedValue',n.observed_value,'knownCalls',n.known_calls,
  'failedCalls',n.failed_calls,'unknownCalls',n.unknown_calls,
  'windowStartedAt',n.window_started_at,'windowEndedAt',n.window_ended_at,
  'openedAt',n.opened_at,'acknowledgedAt',n.acknowledged_at,
  'acknowledgedByName',m.display_name,'recoveredAt',n.recovered_at,'closedAt',n.closed_at,
  'closedReason',n.closed_reason,'version',n.version,'lastObservedAt',n.last_observed_at)
from public.bff_alert_instances n
join public.bff_alert_rules r on r.id=n.rule_id and r.tenant_id=n.tenant_id
join public.bff_applications a on a.id=n.application_id and a.tenant_id=n.tenant_id
left join public.bff_interfaces i on i.id=n.interface_id and i.tenant_id=n.tenant_id
left join public.bff_members m on m.id=n.acknowledged_by and m.tenant_id=n.tenant_id
where n.id=p_instance
$$;
create or replace function public.bff_read_alert_rules(p_actor uuid,p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; page integer; size integer; filter_app uuid; filter_interface uuid; filter_rule uuid;
  total integer; summary jsonb; records jsonb; archived boolean;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null or not public.bff_actor_can(p_actor,'BffAlertRule:View') then raise exception 'BFF_FORBIDDEN'; end if;
  if p_filters is null or jsonb_typeof(p_filters)<>'object' then raise exception 'BFF_INVALID_FILTER'; end if;
  begin
    page:=coalesce(nullif(p_filters->>'current','')::integer,1);
    size:=coalesce(nullif(p_filters->>'size','')::integer,20);
    filter_app:=nullif(p_filters->>'applicationId','')::uuid;
    filter_interface:=nullif(p_filters->>'interfaceId','')::uuid;
    filter_rule:=nullif(p_filters->>'ruleId','')::uuid;
    archived:=coalesce(nullif(p_filters->>'archived','')::boolean,false);
  exception when others then raise exception 'BFF_INVALID_FILTER'; end;
  if page not between 1 and 100000 or size not between 1 and 100 or
    (nullif(p_filters->>'environment','') is not null and p_filters->>'environment' not in ('development','staging','production')) or
    (nullif(p_filters->>'metric','') is not null and p_filters->>'metric' not in ('failure_count','failure_rate','timeout_count','unknown_count')) or
    (nullif(p_filters->>'severity','') is not null and p_filters->>'severity' not in ('warning','critical')) or
    (nullif(p_filters->>'enabled','') is not null and p_filters->>'enabled' not in ('true','false')) or
    length(coalesce(p_filters->>'name',''))>100
  then raise exception 'BFF_INVALID_FILTER'; end if;
  with scoped as (
    select r.id,r.enabled,r.archived_at from public.bff_alert_rules r
    where r.tenant_id=actor.tenant_id and public.bff_interface_scope(p_actor,r.application_id,'BffAlertRule:View') and
      (filter_app is null or r.application_id=filter_app) and (filter_interface is null or r.interface_id=filter_interface) and
      (filter_rule is null or r.id=filter_rule) and
      (archived=(r.archived_at is not null)) and
      (nullif(p_filters->>'environment','') is null or r.environment=p_filters->>'environment') and
      (nullif(p_filters->>'metric','') is null or r.metric=p_filters->>'metric') and
      (nullif(p_filters->>'severity','') is null or r.severity=p_filters->>'severity') and
      (nullif(p_filters->>'enabled','') is null or r.enabled=(p_filters->>'enabled')::boolean) and
      (nullif(p_filters->>'name','') is null or lower(r.name) like '%'||lower(p_filters->>'name')||'%')
  ) select count(*),jsonb_build_object('total',count(*),
      'enabled',count(*) filter(where enabled and archived_at is null),
      'disabled',count(*) filter(where not enabled and archived_at is null),
      'archived',count(*) filter(where archived_at is not null)) into total,summary from scoped;
  select coalesce(jsonb_agg(public.bff_alert_rule_public(q.id) order by q.created_at desc,q.id desc),'[]'::jsonb)
    into records from (select r.id,r.created_at from public.bff_alert_rules r
      where r.tenant_id=actor.tenant_id and public.bff_interface_scope(p_actor,r.application_id,'BffAlertRule:View') and
        (filter_app is null or r.application_id=filter_app) and (filter_interface is null or r.interface_id=filter_interface) and
        (filter_rule is null or r.id=filter_rule) and (archived=(r.archived_at is not null)) and
        (nullif(p_filters->>'environment','') is null or r.environment=p_filters->>'environment') and
        (nullif(p_filters->>'metric','') is null or r.metric=p_filters->>'metric') and
        (nullif(p_filters->>'severity','') is null or r.severity=p_filters->>'severity') and
        (nullif(p_filters->>'enabled','') is null or r.enabled=(p_filters->>'enabled')::boolean) and
        (nullif(p_filters->>'name','') is null or lower(r.name) like '%'||lower(p_filters->>'name')||'%')
      order by r.created_at desc,r.id desc limit size offset (page-1)*size) q;
  return jsonb_build_object('records',records,'total',total,'current',page,'size',size,'summary',summary);
end $$;
create or replace function public.bff_read_alert_instances(p_actor uuid,p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare actor public.bff_members; page integer; size integer; filter_app uuid; filter_interface uuid; filter_rule uuid;
  filter_instance uuid; bounds tstzrange; explicit_bounds boolean; total integer; summary jsonb; records jsonb;
begin
  select * into actor from public.bff_members where id=p_actor and enabled;
  if actor.id is null or not public.bff_actor_can(p_actor,'BffAlert:View') then raise exception 'BFF_FORBIDDEN'; end if;
  if p_filters is null or jsonb_typeof(p_filters)<>'object' then raise exception 'BFF_INVALID_FILTER'; end if;
  explicit_bounds:=nullif(p_filters->>'from','') is not null or nullif(p_filters->>'to','') is not null;
  if explicit_bounds then bounds:=public.bff_call_window(p_filters); end if;
  begin
    page:=coalesce(nullif(p_filters->>'current','')::integer,1);
    size:=coalesce(nullif(p_filters->>'size','')::integer,20);
    filter_app:=nullif(p_filters->>'applicationId','')::uuid;
    filter_interface:=nullif(p_filters->>'interfaceId','')::uuid;
    filter_rule:=nullif(p_filters->>'ruleId','')::uuid;
    filter_instance:=nullif(p_filters->>'instanceId','')::uuid;
  exception when others then raise exception 'BFF_INVALID_FILTER'; end;
  if page not between 1 and 100000 or size not between 1 and 100 or
    (nullif(p_filters->>'environment','') is not null and p_filters->>'environment' not in ('development','staging','production')) or
    (nullif(p_filters->>'state','') is not null and p_filters->>'state' not in ('open','acknowledged','recovered','closed')) or
    (nullif(p_filters->>'severity','') is not null and p_filters->>'severity' not in ('warning','critical'))
  then raise exception 'BFF_INVALID_FILTER'; end if;
  with scoped as (
    select n.id,n.state from public.bff_alert_instances n
    where n.tenant_id=actor.tenant_id and
      (case when explicit_bounds then n.opened_at<@bounds else
        n.state in ('open','acknowledged') or coalesce(n.recovered_at,n.closed_at,n.opened_at)>=now()-interval '30 days' end) and
      public.bff_interface_scope(p_actor,n.application_id,'BffAlert:View') and
      (filter_app is null or n.application_id=filter_app) and (filter_interface is null or n.interface_id=filter_interface) and
      (filter_rule is null or n.rule_id=filter_rule) and (filter_instance is null or n.id=filter_instance) and
      (nullif(p_filters->>'environment','') is null or n.environment=p_filters->>'environment') and
      (nullif(p_filters->>'state','') is null or n.state=p_filters->>'state') and
      (nullif(p_filters->>'severity','') is null or n.severity=p_filters->>'severity')
  ) select count(*),jsonb_build_object('total',count(*),
      'open',count(*) filter(where state='open'),'acknowledged',count(*) filter(where state='acknowledged'),
      'recovered',count(*) filter(where state='recovered'),'closed',count(*) filter(where state='closed'))
    into total,summary from scoped;
  select coalesce(jsonb_agg(public.bff_alert_instance_public(q.id) order by q.opened_at desc,q.id desc),'[]'::jsonb)
    into records from (select n.id,n.opened_at from public.bff_alert_instances n
      where n.tenant_id=actor.tenant_id and
        (case when explicit_bounds then n.opened_at<@bounds else
          n.state in ('open','acknowledged') or coalesce(n.recovered_at,n.closed_at,n.opened_at)>=now()-interval '30 days' end) and
        public.bff_interface_scope(p_actor,n.application_id,'BffAlert:View') and
        (filter_app is null or n.application_id=filter_app) and (filter_interface is null or n.interface_id=filter_interface) and
        (filter_rule is null or n.rule_id=filter_rule) and (filter_instance is null or n.id=filter_instance) and
        (nullif(p_filters->>'environment','') is null or n.environment=p_filters->>'environment') and
        (nullif(p_filters->>'state','') is null or n.state=p_filters->>'state') and
        (nullif(p_filters->>'severity','') is null or n.severity=p_filters->>'severity')
      order by n.opened_at desc,n.id desc limit size offset (page-1)*size) q;
  return jsonb_build_object('records',records,'total',total,'current',page,'size',size,'summary',summary);
end $$;
create or replace function public.bff_alert_detail(p_actor uuid,p_instance uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare target public.bff_alert_instances;
begin
  select * into target from public.bff_alert_instances where id=p_instance and
    tenant_id=(select tenant_id from public.bff_members where id=p_actor and enabled);
  if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_interface_scope(p_actor,target.application_id,'BffAlert:View') then raise exception 'BFF_FORBIDDEN'; end if;
  return public.bff_alert_instance_public(p_instance);
end $$;
create or replace function public.bff_alert_options(p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
  if not (public.bff_actor_can(p_actor,'BffAlertRule:View') or public.bff_actor_can(p_actor,'BffAlert:View'))
  then raise exception 'BFF_FORBIDDEN'; end if;
  -- Rebuild scope using alert permission; call visibility need not be granted to alert operators.
  return jsonb_build_object(
    'applications',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'enabled',a.enabled) order by a.name,a.id)
      from public.bff_applications a join public.bff_members m on m.id=p_actor and m.enabled and m.tenant_id=a.tenant_id
      where public.bff_interface_scope(p_actor,a.id,'BffAlertRule:View') or
        public.bff_interface_scope(p_actor,a.id,'BffAlert:View')),'[]'::jsonb),
    'environments',jsonb_build_array(jsonb_build_object('value','development','label','开发'),
      jsonb_build_object('value','staging','label','预发'),jsonb_build_object('value','production','label','生产')),
    'interfaces',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'applicationId',i.application_id,
      'environment',i.environment,'code',i.code,'name',i.name) order by i.name,i.id)
      from public.bff_interfaces i join public.bff_members m on m.id=p_actor and m.enabled and m.tenant_id=i.tenant_id
      where i.deleted_at is null and (public.bff_interface_scope(p_actor,i.application_id,'BffAlertRule:View') or
        public.bff_interface_scope(p_actor,i.application_id,'BffAlert:View'))),'[]'::jsonb),
    'metrics',jsonb_build_array(jsonb_build_object('value','failure_count','label','失败次数'),
      jsonb_build_object('value','failure_rate','label','失败率'),
      jsonb_build_object('value','timeout_count','label','超时次数'),
      jsonb_build_object('value','unknown_count','label','结果未知次数')),
    'severities',jsonb_build_array(jsonb_build_object('value','warning','label','警告'),
      jsonb_build_object('value','critical','label','严重')),
    'statuses',jsonb_build_array(jsonb_build_object('value','open','label','待处理'),
      jsonb_build_object('value','acknowledged','label','已确认'),
      jsonb_build_object('value','recovered','label','已恢复'),
      jsonb_build_object('value','closed','label','已关闭')),
    'errorClasses',jsonb_build_array(jsonb_build_object('value','timeout','label','超时'),
      jsonb_build_object('value','unknown','label','未知')));
end $$;
create or replace function public.bff_write_alert_rule(
  p_actor uuid,p_operation text,p_rule uuid,p_version integer,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; saved public.bff_alert_rules; app_id uuid; selected_interface uuid;
  revision bigint; permission text; changed boolean; closed_count integer; next_enabled boolean;
begin
  if p_operation not in ('create','update','enable','disable','archive') or
    p_payload is null or jsonb_typeof(p_payload)<>'object' or
    exists(select 1 from jsonb_object_keys(p_payload) as k(name) where k.name not in
      ('applicationId','environment','interfaceId','name','metric','windowMinutes','threshold','minCalls','severity','enabled','quietMinutes'))
  then raise exception 'BFF_INVALID_ALERT'; end if;
  permission:=case p_operation when 'create' then 'BffAlert:Add' when 'update' then 'BffAlert:Edit'
    when 'archive' then 'BffAlert:Archive' else 'BffAlert:ChangeStatus' end;
  revision:=public.bff_control_lock(p_actor,permission,'alerts');
  select * into actor from public.bff_members where id=p_actor and enabled;
  if p_operation='create' then
    if p_rule is not null or p_version is not null and p_version<>0 or
      not (p_payload ?& array['applicationId','environment','name','metric','windowMinutes','threshold','minCalls','severity','enabled','quietMinutes'])
    then raise exception 'BFF_INVALID_ALERT'; end if;
    begin
      app_id:=(p_payload->>'applicationId')::uuid;
      selected_interface:=nullif(p_payload->>'interfaceId','')::uuid;
    exception when others then raise exception 'BFF_INVALID_ALERT'; end;
    if app_id is null or not public.bff_interface_scope(p_actor,app_id,permission) then raise exception 'BFF_FORBIDDEN'; end if;
    if jsonb_typeof(p_payload->'enabled')<>'boolean' or
      jsonb_typeof(p_payload->'windowMinutes')<>'number' or
      jsonb_typeof(p_payload->'threshold')<>'number' or
      jsonb_typeof(p_payload->'minCalls')<>'number' or
      jsonb_typeof(p_payload->'quietMinutes')<>'number' or
      p_payload->>'environment' not in ('development','staging','production') or
      p_payload->>'metric' not in ('failure_count','failure_rate','timeout_count','unknown_count') or
      p_payload->>'severity' not in ('warning','critical')
    then raise exception 'BFF_INVALID_ALERT'; end if;
    begin
      insert into public.bff_alert_rules(tenant_id,application_id,environment,interface_id,name,
        metric,window_minutes,threshold,min_calls,severity,enabled,quiet_minutes,created_by,updated_by)
      values(actor.tenant_id,app_id,p_payload->>'environment',selected_interface,p_payload->>'name',
        p_payload->>'metric',(p_payload->>'windowMinutes')::integer,(p_payload->>'threshold')::numeric,
        (p_payload->>'minCalls')::integer,p_payload->>'severity',(p_payload->>'enabled')::boolean,
        (p_payload->>'quietMinutes')::integer,p_actor,p_actor) returning * into saved;
    exception when check_violation or foreign_key_violation or invalid_text_representation or numeric_value_out_of_range
      then raise exception 'BFF_INVALID_ALERT'; end;
  else
    if p_rule is null or p_version is null or p_version<1 then raise exception 'BFF_INVALID_ALERT'; end if;
    select * into saved from public.bff_alert_rules where id=p_rule and tenant_id=actor.tenant_id for update;
    if saved.id is null then raise exception 'BFF_NOT_FOUND'; end if;
    if saved.archived_at is not null then raise exception 'BFF_ALERT_ARCHIVED'; end if;
    if not public.bff_interface_scope(p_actor,saved.application_id,permission) then raise exception 'BFF_FORBIDDEN'; end if;
    if saved.version<>p_version then raise exception 'BFF_CONFLICT'; end if;
    if p_operation='update' then
      if not (p_payload ?& array['applicationId','environment','name','metric','windowMinutes','threshold','minCalls','severity','enabled','quietMinutes'])
      then raise exception 'BFF_INVALID_ALERT'; end if;
      begin
        app_id:=(p_payload->>'applicationId')::uuid;
        selected_interface:=nullif(p_payload->>'interfaceId','')::uuid;
      exception when others then raise exception 'BFF_INVALID_ALERT'; end;
      if app_id is distinct from saved.application_id or p_payload->>'environment' is distinct from saved.environment or
        jsonb_typeof(p_payload->'enabled')<>'boolean' or
        jsonb_typeof(p_payload->'windowMinutes')<>'number' or
        jsonb_typeof(p_payload->'threshold')<>'number' or
        jsonb_typeof(p_payload->'minCalls')<>'number' or
        jsonb_typeof(p_payload->'quietMinutes')<>'number' or
        p_payload->>'metric' not in ('failure_count','failure_rate','timeout_count','unknown_count') or
        p_payload->>'severity' not in ('warning','critical')
      then raise exception 'BFF_INVALID_ALERT'; end if;
      begin
        changed:=selected_interface is distinct from saved.interface_id or p_payload->>'metric' is distinct from saved.metric or
          (p_payload->>'windowMinutes')::integer is distinct from saved.window_minutes or
          (p_payload->>'threshold')::numeric is distinct from saved.threshold or
          (p_payload->>'minCalls')::integer is distinct from saved.min_calls or
          p_payload->>'severity' is distinct from saved.severity;
        update public.bff_alert_rules set interface_id=selected_interface,name=p_payload->>'name',metric=p_payload->>'metric',
          window_minutes=(p_payload->>'windowMinutes')::integer,threshold=(p_payload->>'threshold')::numeric,
          min_calls=(p_payload->>'minCalls')::integer,severity=p_payload->>'severity',
          enabled=(p_payload->>'enabled')::boolean,quiet_minutes=(p_payload->>'quietMinutes')::integer,
          version=version+1,updated_by=p_actor,updated_at=now(),
          last_evaluated_at=case when changed then null else last_evaluated_at end
          where id=p_rule returning * into saved;
      exception when check_violation or foreign_key_violation or invalid_text_representation or numeric_value_out_of_range
        then raise exception 'BFF_INVALID_ALERT'; end;
    else
      if p_payload<>'{}'::jsonb then raise exception 'BFF_INVALID_ALERT'; end if;
      next_enabled:=p_operation='enable';
      update public.bff_alert_rules set enabled=next_enabled,
        archived_at=case when p_operation='archive' then now() else archived_at end,
        version=version+1,updated_by=p_actor,updated_at=now(),last_evaluated_at=null
      where id=p_rule returning * into saved;
    end if;
    if p_operation in ('disable','archive') or (p_operation='update' and (changed or not saved.enabled)) then
      update public.bff_alert_instances set state='closed',closed_at=now(),
        closed_reason=case when p_operation='archive' then 'archived'
          when p_operation='disable' or not saved.enabled then 'disabled' else 'reconfigured' end,
        version=version+1,last_observed_at=now()
      where rule_id=p_rule and state in ('open','acknowledged');
      get diagnostics closed_count=row_count;
    end if;
  end if;
  perform public.bff_control_advance(p_actor,'alerts','alert_rule.'||p_operation,saved.id,
    jsonb_build_object('version',saved.version,'closedCount',coalesce(closed_count,0)));
  return public.bff_alert_rule_public(saved.id);
end $$;
create or replace function public.bff_acknowledge_alert(p_actor uuid,p_instance uuid,p_version integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; target public.bff_alert_instances;
begin
  if p_instance is null or p_version is null or p_version<1 then raise exception 'BFF_INVALID_ALERT'; end if;
  perform public.bff_control_lock(p_actor,'BffAlert:Acknowledge','alerts');
  select * into actor from public.bff_members where id=p_actor and enabled;
  select * into target from public.bff_alert_instances where id=p_instance and tenant_id=actor.tenant_id for update;
  if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_interface_scope(p_actor,target.application_id,'BffAlert:Acknowledge') then raise exception 'BFF_FORBIDDEN'; end if;
  if target.version<>p_version then raise exception 'BFF_CONFLICT'; end if;
  if target.state<>'open' then raise exception 'BFF_ALERT_STATE'; end if;
  update public.bff_alert_instances set state='acknowledged',acknowledged_at=now(),
    acknowledged_by=p_actor,version=version+1 where id=p_instance;
  perform public.bff_control_advance(p_actor,'alerts','alert.acknowledge',p_instance,
    jsonb_build_object('ruleId',target.rule_id));
  return public.bff_alert_instance_public(p_instance);
end $$;
create or replace function public.bff_alert_evaluate_locked(p_rule uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare rule public.bff_alert_rules; active public.bff_alert_instances; known_count integer;
  failed_count integer; unknown_count integer; timeout_count integer; observed numeric(10,2);
  triggered boolean; instance_id uuid; opened integer:=0; updated integer:=0; recovered integer:=0;
  window_end timestamptz:=now();
begin
  select * into rule from public.bff_alert_rules where id=p_rule for update;
  if rule.id is null or not rule.enabled or rule.archived_at is not null
  then return jsonb_build_object('evaluated',0,'opened',0,'updated',0,'recovered',0,'closed',0,'instanceId',null); end if;
  select count(*) filter(where c.status in ('succeeded','failed')),
    count(*) filter(where c.status='failed'),count(*) filter(where c.status='unknown'),
    count(*) filter(where c.status='failed' and c.error_class='timeout')
    into known_count,failed_count,unknown_count,timeout_count
    from public.bff_interface_calls c where c.tenant_id=rule.tenant_id and
      c.application_id=rule.application_id and c.environment=rule.environment and
      (rule.interface_id is null or c.interface_id=rule.interface_id) and
      c.started_at>=window_end-pg_catalog.make_interval(mins=>rule.window_minutes) and c.started_at<window_end;
  observed:=case rule.metric when 'failure_count' then failed_count
    when 'timeout_count' then timeout_count when 'unknown_count' then unknown_count
    else case when known_count=0 then 0 else round(100.0*failed_count/known_count,2) end end;
  triggered:=observed>=rule.threshold and (rule.metric='unknown_count' or known_count>=rule.min_calls);
  select * into active from public.bff_alert_instances where rule_id=rule.id and state in ('open','acknowledged') for update;
  if triggered and active.id is null and
    (rule.last_triggered_at is null or rule.last_triggered_at+pg_catalog.make_interval(mins=>rule.quiet_minutes)<=window_end)
  then
    insert into public.bff_alert_instances(rule_id,tenant_id,application_id,environment,interface_id,
      metric,severity,state,observed_value,known_calls,failed_calls,unknown_calls,
      window_started_at,window_ended_at,last_observed_at)
    values(rule.id,rule.tenant_id,rule.application_id,rule.environment,rule.interface_id,
      rule.metric,rule.severity,'open',observed,known_count,failed_count,unknown_count,
      window_end-pg_catalog.make_interval(mins=>rule.window_minutes),window_end,window_end)
    returning id into instance_id;
    update public.bff_alert_rules set last_triggered_at=window_end where id=rule.id;
    opened:=1;
  elsif triggered and active.id is not null then
    update public.bff_alert_instances set observed_value=observed,known_calls=known_count,
      failed_calls=failed_count,unknown_calls=unknown_count,
      window_started_at=window_end-pg_catalog.make_interval(mins=>rule.window_minutes),
      window_ended_at=window_end,last_observed_at=window_end
      where id=active.id;
    instance_id:=active.id;
    updated:=1;
  elsif not triggered and active.id is not null then
    update public.bff_alert_instances set state='recovered',recovered_at=window_end,
      observed_value=observed,known_calls=known_count,failed_calls=failed_count,
      unknown_calls=unknown_count,
      window_started_at=window_end-pg_catalog.make_interval(mins=>rule.window_minutes),
      window_ended_at=window_end,last_observed_at=window_end,version=version+1
      where id=active.id;
    instance_id:=active.id;
    recovered:=1;
  end if;
  update public.bff_alert_rules set last_evaluated_at=window_end where id=rule.id;
  return jsonb_build_object('evaluated',1,'opened',opened,'updated',updated,
    'recovered',recovered,'closed',0,'instanceId',instance_id);
end $$;
create or replace function public.bff_alert_expire_calls(p_tenant uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare expired integer; cleared integer;
begin
  update public.bff_interface_calls set status='unknown',finished_at=now(),
    error_code='LEASE_EXPIRED',error_class='unknown',result_payload=null,result_expires_at=null
    where request_id in (select request_id from public.bff_interface_calls
      where tenant_id=p_tenant and status='running' and expires_at<=now()
      order by expires_at,request_id limit 100 for update skip locked);
  get diagnostics expired=row_count;
  update public.bff_interface_calls set result_payload=null,result_expires_at=null
    where request_id in (select request_id from public.bff_interface_calls
      where tenant_id=p_tenant and result_payload is not null and result_expires_at<=now()
      order by result_expires_at,request_id limit 100 for update skip locked);
  get diagnostics cleared=row_count;
  -- Operational metadata is retained for 90 days, well beyond the 60-minute
  -- alert window and 15-minute replay cache. Alert instances retain aggregates,
  -- not foreign keys to individual calls.
  delete from public.bff_interface_calls where request_id in (
    select request_id from public.bff_interface_calls
    where tenant_id=p_tenant and status in ('succeeded','failed','unknown') and
      started_at<now()-interval '90 days' and
      (result_payload is null or result_expires_at<=now())
    order by started_at,request_id limit 1000 for update skip locked);
  return jsonb_build_object('expired',expired,'clearedReplay',cleared);
end $$;
create or replace function public.bff_evaluate_alert_rule(p_actor uuid,p_rule uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.bff_members; target public.bff_alert_rules; results jsonb; cleanup jsonb;
begin
  if p_rule is null then raise exception 'BFF_INVALID_ALERT'; end if;
  perform public.bff_control_lock(p_actor,'BffAlert:Evaluate','alerts');
  select * into actor from public.bff_members where id=p_actor and enabled;
  select * into target from public.bff_alert_rules where id=p_rule and tenant_id=actor.tenant_id;
  if target.id is null then raise exception 'BFF_NOT_FOUND'; end if;
  if not public.bff_interface_scope(p_actor,target.application_id,'BffAlert:Evaluate') then raise exception 'BFF_FORBIDDEN'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bff-gateway:'||actor.tenant_id::text,0));
  cleanup:=public.bff_alert_expire_calls(actor.tenant_id);
  results:=public.bff_alert_evaluate_locked(p_rule);
  insert into public.bff_audit_events(tenant_id,actor_id,action,resource_type,resource_id,summary)
    values(actor.tenant_id,p_actor,'alert.evaluate','alerts',p_rule,
      jsonb_build_object('opened',results->'opened','recovered',results->'recovered'));
  return results||cleanup;
end $$;
create or replace function public.bff_alert_evaluate_batch(p_limit integer default 100)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare candidate record; tenant_to_clean uuid; locked uuid; results jsonb; cleanup jsonb;
  cleaned_tenants uuid[]:=array[]::uuid[];
  evaluated integer:=0; opened integer:=0; updated integer:=0; recovered integer:=0;
  expired integer:=0; cleared integer:=0; cleaned_count integer:=0;
  scan_limit integer; rotation bigint;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'BFF_INVALID_LIMIT'; end if;
  scan_limit:=least(2000,greatest(100,p_limit*20));
  rotation:=pg_catalog.floor(extract(epoch from now())/60)::bigint;
  for tenant_to_clean in select tenant_id from public.bff_interface_calls
    where (status='running' and expires_at<=now()) or
      (result_payload is not null and result_expires_at<=now()) or
      (status in ('succeeded','failed','unknown') and started_at<now()-interval '90 days')
    group by tenant_id
    order by pg_catalog.hashtextextended(tenant_id::text,rotation),tenant_id
    limit scan_limit
  loop
    exit when cleaned_count>=p_limit;
    if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('bff-control:'||tenant_to_clean::text,0))
    then continue; end if;
    if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('bff-gateway:'||tenant_to_clean::text,0))
    then continue; end if;
    cleanup:=public.bff_alert_expire_calls(tenant_to_clean);
    expired:=expired+(cleanup->>'expired')::integer;
    cleared:=cleared+(cleanup->>'clearedReplay')::integer;
    cleaned_tenants:=pg_catalog.array_append(cleaned_tenants,tenant_to_clean);
    cleaned_count:=cleaned_count+1;
  end loop;
  -- Offer each tenant its oldest rule before taking its second. Rotate ties so
  -- a bounded scan cannot repeatedly favor the same locked tenants.
  for candidate in select id,tenant_id from (
    select r.id,r.tenant_id,r.last_evaluated_at,
      row_number() over(partition by r.tenant_id order by r.last_evaluated_at nulls first,r.id) as tenant_rank
    from public.bff_alert_rules r where r.enabled and r.archived_at is null
  ) ranked
    order by tenant_rank,pg_catalog.hashtextextended(tenant_id::text,rotation),
      last_evaluated_at nulls first,id limit scan_limit
  loop
    exit when evaluated>=p_limit;
    if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('bff-control:'||candidate.tenant_id::text,0))
    then continue; end if;
    if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('bff-gateway:'||candidate.tenant_id::text,0))
    then continue; end if;
    select id into locked from public.bff_alert_rules
      where id=candidate.id and enabled and archived_at is null for update skip locked;
    if locked is null then continue; end if;
    if not(candidate.tenant_id=any(cleaned_tenants)) then
      cleanup:=public.bff_alert_expire_calls(candidate.tenant_id);
      expired:=expired+(cleanup->>'expired')::integer;
      cleared:=cleared+(cleanup->>'clearedReplay')::integer;
      cleaned_tenants:=pg_catalog.array_append(cleaned_tenants,candidate.tenant_id);
    end if;
    results:=public.bff_alert_evaluate_locked(locked);
    evaluated:=evaluated+(results->>'evaluated')::integer;
    opened:=opened+(results->>'opened')::integer;
    updated:=updated+(results->>'updated')::integer;
    recovered:=recovered+(results->>'recovered')::integer;
  end loop;
  return jsonb_build_object('evaluated',evaluated,'opened',opened,'updated',updated,
    'recovered',recovered,'closed',0,'expired',expired,'clearedReplay',cleared);
end $$;
revoke all on function public.bff_release_scope(uuid,uuid,text),public.bff_release_record(uuid),
  public.bff_release_version_public(uuid),public.bff_release_history_unchecked(uuid,integer,integer,integer),
  public.bff_release_history(uuid,uuid,integer,integer,integer),public.bff_read_releases(uuid,jsonb),
  public.bff_release_options(uuid),public.bff_release_target(uuid,uuid,text),
  public.bff_release_snapshot(uuid,uuid,uuid,text),public.bff_release_prepare_snapshot(uuid,uuid,text,uuid),
  public.bff_release_targets_ready(uuid,uuid,jsonb,boolean),
  public.bff_write_release(uuid,text,uuid,integer,integer,uuid,text,jsonb),
  public.bff_gateway_scope(uuid,uuid,text),public.bff_route_matches(text,text),
  public.bff_gateway_public(uuid),public.bff_gateway_candidates(uuid,text,text,text,text),
  public.bff_gateway_target(uuid,uuid,uuid,integer),
  public.bff_gateway_step_targets(uuid,uuid,uuid,integer,text[]),
  public.bff_gateway_begin(uuid,uuid,uuid,integer,uuid,text,text),
  public.bff_gateway_finish(uuid,uuid,boolean,integer,integer,text,jsonb,text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.bff_release_scope(uuid,uuid,text),public.bff_release_record(uuid),
  public.bff_release_version_public(uuid),public.bff_release_history_unchecked(uuid,integer,integer,integer),
  public.bff_release_history(uuid,uuid,integer,integer,integer),public.bff_read_releases(uuid,jsonb),
  public.bff_release_options(uuid),public.bff_release_target(uuid,uuid,text),
  public.bff_release_snapshot(uuid,uuid,uuid,text),public.bff_release_prepare_snapshot(uuid,uuid,text,uuid),
  public.bff_release_targets_ready(uuid,uuid,jsonb,boolean),
  public.bff_write_release(uuid,text,uuid,integer,integer,uuid,text,jsonb),
  public.bff_gateway_scope(uuid,uuid,text),public.bff_route_matches(text,text),
  public.bff_gateway_public(uuid),public.bff_gateway_candidates(uuid,text,text,text,text),
  public.bff_gateway_target(uuid,uuid,uuid,integer),
  public.bff_gateway_step_targets(uuid,uuid,uuid,integer,text[]),
  public.bff_gateway_begin(uuid,uuid,uuid,integer,uuid,text,text),
  public.bff_gateway_finish(uuid,uuid,boolean,integer,integer,text,jsonb,text,jsonb,text)
  to service_role;
revoke all on function public.bff_call_public(uuid),public.bff_call_window(jsonb),
  public.bff_read_calls(uuid,jsonb),public.bff_call_detail(uuid,uuid),public.bff_call_options(uuid),
  public.bff_alert_rule_public(uuid),public.bff_alert_instance_public(uuid),
  public.bff_read_alert_rules(uuid,jsonb),public.bff_read_alert_instances(uuid,jsonb),
  public.bff_alert_detail(uuid,uuid),public.bff_alert_options(uuid),
  public.bff_write_alert_rule(uuid,text,uuid,integer,jsonb),public.bff_acknowledge_alert(uuid,uuid,integer),
  public.bff_alert_evaluate_locked(uuid),public.bff_alert_expire_calls(uuid),
  public.bff_evaluate_alert_rule(uuid,uuid),public.bff_alert_evaluate_batch(integer)
  from public,anon,authenticated;
grant execute on function public.bff_call_public(uuid),public.bff_call_window(jsonb),
  public.bff_read_calls(uuid,jsonb),public.bff_call_detail(uuid,uuid),public.bff_call_options(uuid),
  public.bff_alert_rule_public(uuid),public.bff_alert_instance_public(uuid),
  public.bff_read_alert_rules(uuid,jsonb),public.bff_read_alert_instances(uuid,jsonb),
  public.bff_alert_detail(uuid,uuid),public.bff_alert_options(uuid),
  public.bff_write_alert_rule(uuid,text,uuid,integer,jsonb),public.bff_acknowledge_alert(uuid,uuid,integer),
  public.bff_alert_evaluate_locked(uuid),public.bff_alert_expire_calls(uuid),
  public.bff_evaluate_alert_rule(uuid,uuid),public.bff_alert_evaluate_batch(integer)
  to service_role;
alter table public.bff_members enable row level security;
alter table public.bff_applications enable row level security;
alter table public.bff_application_members enable row level security;
alter table public.bff_auth_transactions enable row level security;
alter table public.bff_sessions enable row level security;
alter table public.bff_audit_events enable row level security;
revoke all on public.bff_members,public.bff_applications,public.bff_application_members,public.bff_auth_transactions,public.bff_sessions,public.bff_audit_events from anon,authenticated;
revoke all on public.bff_members,public.bff_applications,public.bff_application_members,public.bff_auth_transactions,public.bff_sessions,public.bff_audit_events from service_role;
grant select,insert,update,delete on public.bff_members,public.bff_applications,public.bff_application_members,public.bff_auth_transactions,public.bff_sessions,public.bff_audit_events to service_role;
alter table public.bff_upstream_services enable row level security;
alter table public.bff_upstream_credentials enable row level security;
alter table public.bff_upstream_service_revisions enable row level security;
revoke all on public.bff_upstream_services,public.bff_upstream_credentials,public.bff_upstream_service_revisions from public,anon,authenticated;
revoke all on public.bff_upstream_services,public.bff_upstream_credentials,public.bff_upstream_service_revisions from service_role;
grant select,insert,update,delete on public.bff_upstream_services,public.bff_upstream_credentials,public.bff_upstream_service_revisions to service_role;
alter table public.bff_interfaces enable row level security;
alter table public.bff_interface_upstreams enable row level security;
revoke all on public.bff_interfaces,public.bff_interface_upstreams from public,anon,authenticated;
revoke all on public.bff_interfaces,public.bff_interface_upstreams from service_role;
grant select,insert,update,delete on public.bff_interfaces,public.bff_interface_upstreams to service_role;
alter table public.bff_interface_versions enable row level security;
alter table public.bff_interface_version_upstreams enable row level security;
alter table public.bff_interface_deployments enable row level security;
alter table public.bff_interface_release_events enable row level security;
alter table public.bff_interface_calls enable row level security;
alter table public.bff_alert_rules enable row level security;
alter table public.bff_alert_instances enable row level security;
alter table public.bff_resources enable row level security;
revoke all on public.bff_interface_versions,public.bff_interface_version_upstreams,
  public.bff_interface_deployments,public.bff_interface_release_events,public.bff_interface_calls
  from public,anon,authenticated;
revoke all on public.bff_interface_versions,public.bff_interface_version_upstreams,
  public.bff_interface_deployments,public.bff_interface_release_events,public.bff_interface_calls
  from service_role;
grant select,insert,update,delete on public.bff_interface_versions,public.bff_interface_version_upstreams,
  public.bff_interface_deployments,public.bff_interface_release_events,public.bff_interface_calls
  to service_role;
revoke all on public.bff_alert_rules,public.bff_alert_instances from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.bff_alert_rules,public.bff_alert_instances to service_role;
revoke all on public.bff_resources from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.bff_resources to service_role;
alter table public.bff_resource_revisions enable row level security;
alter table public.bff_platform_settings enable row level security;
revoke all on public.bff_platform_settings from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.bff_platform_settings to service_role;
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

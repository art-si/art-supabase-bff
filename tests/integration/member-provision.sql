-- Runs inside the canonical schema validation transaction and is rolled back.
do $test$
declare tenant uuid:=gen_random_uuid(); other_tenant uuid:=gen_random_uuid();
  actor uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid(); target_subject uuid:=gen_random_uuid();
  other_subject uuid:=gen_random_uuid(); other_member uuid:=gen_random_uuid();
  identity jsonb; result jsonb;
begin
  insert into public.bff_members(id,issuer,subject,tenant_id,role) values
    (actor,'urn:member-provision-test',actor::text,tenant,'admin'),
    (viewer,'urn:member-provision-test',viewer::text,tenant,'viewer'),
    (other_member,'urn:member-provision-test',other_subject::text,other_tenant,'viewer');
  identity:=jsonb_build_object('issuer','urn:member-provision-test','subject',target_subject,
    'tenantId',tenant,'identityTenantId',other_tenant,'email','fixture@example.test','displayName','Fixture');
  begin
    perform public.bff_provision_member(viewer,identity,1);
    raise exception 'Viewer opened membership';
  exception when raise_exception then if sqlerrm<>'BFF_FORBIDDEN' then raise; end if; end;
  begin
    perform public.bff_provision_member(actor,identity||jsonb_build_object('tenantId',other_tenant),1);
    raise exception 'Cross-tenant membership created';
  exception when raise_exception then if sqlerrm<>'BFF_INVALID_IDENTITY' then raise; end if; end;
  begin
    perform public.bff_provision_member(actor,identity||jsonb_build_object('subject',other_subject),1);
    raise exception 'Existing identity in another BFF tenant was reassigned';
  exception when raise_exception then if sqlerrm<>'BFF_MEMBER_EXISTS' then raise; end if; end;
  result:=public.bff_provision_member(actor,identity,1);
  if result->>'revision'<>'2' or not exists(select 1 from public.bff_members
    where subject=target_subject::text and email='fixture@example.test' and tenant_id=tenant and role='viewer' and enabled and updated_by=actor)
    then raise exception 'Provisioned member state invalid'; end if;
  if not exists(select 1 from public.bff_audit_events where tenant_id=tenant and
    resource_type='members' and action='member.provision' and summary->>'identityTenantId'=other_tenant::text)
  then raise exception 'Foreign identity tenant was not retained as audit context'; end if;
  if exists(select 1 from public.bff_member_roles mr join public.bff_members m on m.id=mr.member_id
      where m.issuer='urn:member-provision-test' and m.subject=target_subject::text) or
    exists(select 1 from public.bff_application_members am join public.bff_members m on m.id=am.member_id
      where m.issuer='urn:member-provision-test' and m.subject=target_subject::text)
  then raise exception 'Provisioning unexpectedly granted a role or application'; end if;
  begin
    perform public.bff_provision_member(actor,identity,2);
    raise exception 'Duplicate membership accepted';
  exception when raise_exception then if sqlerrm<>'BFF_MEMBER_EXISTS' then raise; end if; end;
  begin
    perform public.bff_provision_member(actor,identity,1);
    raise exception 'Stale revision accepted';
  exception when raise_exception then if sqlerrm<>'BFF_CONFLICT' then raise; end if; end;
  if has_function_privilege('anon','public.bff_provision_member(uuid,jsonb,bigint)','execute') or
    has_function_privilege('authenticated','public.bff_provision_member(uuid,jsonb,bigint)','execute')
    then raise exception 'Provision endpoint exposed to browser roles'; end if;
end $test$;

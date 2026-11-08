-- Execute only inside the scoped BFF project; fixtures and assertions always roll back.
begin;
do $$
declare
  tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid();
  member_a uuid:=gen_random_uuid(); member_b uuid:=gen_random_uuid();
  hash_a text:=md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text);
  hash_b text:=md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text);
  lease_a uuid:=gen_random_uuid(); lease_b uuid:=gen_random_uuid();
  result jsonb; lease_until timestamptz; function_name text;
begin
  insert into public.bff_members(id,issuer,subject,tenant_id,role)
    values (member_a,'https://session-fixture.invalid',member_a::text,tenant_a,'viewer'),
           (member_b,'https://session-fixture.invalid',member_b::text,tenant_b,'viewer');
  insert into public.bff_sessions(token_hash,member_id,payload,csrf_token,expires_at)
    values (hash_a,member_a,'sealed-before','fixture-csrf',clock_timestamp()+interval '1 hour'),
           (hash_b,member_b,'sealed-other-tenant','fixture-csrf',clock_timestamp()+interval '1 hour');

  result:=public.bff_session_refresh_claim(hash_a,'sealed-before',lease_a);
  if result->>'status'<>'claimed' then raise exception 'First lease not acquired'; end if;
  select refresh_lease_until into lease_until from public.bff_sessions where token_hash=hash_a;
  perform public.bff_session_refresh_claim(hash_a,'sealed-before',lease_a);
  if (select refresh_lease_until from public.bff_sessions where token_hash=hash_a) is distinct from lease_until then
    raise exception 'Claim replay extended the lease';
  end if;
  if public.bff_session_refresh_claim(hash_a,'sealed-before',lease_b)->>'status'<>'busy' then
    raise exception 'Concurrent owner acquired an active lease';
  end if;
  if public.bff_session_refresh_finish(hash_a,'sealed-before',lease_b,'forged-result')->>'status'<>'busy' then
    raise exception 'Non-owner finished a refresh';
  end if;
  if public.bff_session_refresh_claim(hash_b,'sealed-other-tenant',lease_b)->>'status'<>'claimed' then
    raise exception 'Another tenant was blocked by an unrelated session lease';
  end if;

  result:=public.bff_session_refresh_finish(hash_a,'sealed-before',lease_a,'sealed-after');
  if result->>'status'<>'updated' or result->>'payload'<>'sealed-after' then
    raise exception 'Holder failed to commit the refreshed ciphertext';
  end if;
  if exists(select 1 from public.bff_sessions where token_hash=hash_a and
    (refresh_lease_id is not null or refresh_lease_until is not null)) then
    raise exception 'Successful refresh retained a lease';
  end if;
  result:=public.bff_session_refresh_finish(hash_a,'sealed-before',lease_a,null);
  if result->>'status'<>'updated' or result->>'payload'<>'sealed-after' then
    raise exception 'Stale invalid grant erased the current session';
  end if;
  if (select payload from public.bff_sessions where token_hash=hash_b)<>'sealed-other-tenant' then
    raise exception 'Refresh modified another tenant';
  end if;

  perform public.bff_session_refresh_claim(hash_a,'sealed-after',lease_a);
  update public.bff_sessions set refresh_lease_until=clock_timestamp()-interval '1 second'
    where token_hash=hash_a;
  if public.bff_session_refresh_claim(hash_a,'sealed-after',lease_b)->>'status'<>'claimed' then
    raise exception 'Expired lease could not be recovered';
  end if;
  if public.bff_session_refresh_finish(hash_a,'sealed-after',lease_a,null)->>'status'<>'busy' then
    raise exception 'Expired holder revoked its successor';
  end if;
  if public.bff_session_refresh_finish(hash_a,'sealed-after',lease_a,'sealed-late')->>'status'<>'busy' then
    raise exception 'Expired holder overwrote its successor';
  end if;
  perform public.bff_session_refresh_finish(hash_a,'sealed-after',lease_b,'sealed-current');

  perform public.bff_session_refresh_claim(hash_a,'sealed-current',lease_a);
  update public.bff_members set enabled=false where id=member_a;
  if public.bff_session_refresh_finish(hash_a,'sealed-current',lease_a,'disabled-result')->>'status'<>'missing' then
    raise exception 'Disabled membership retained refresh authority';
  end if;
  update public.bff_members set enabled=true where id=member_a;
  delete from public.bff_sessions where token_hash=hash_a;
  if public.bff_session_refresh_finish(hash_a,'sealed-current',lease_a,'resurrected')->>'status'<>'missing'
    or exists(select 1 from public.bff_sessions where token_hash=hash_a) then
    raise exception 'Logout was reversed by a late refresh';
  end if;

  perform public.bff_session_refresh_finish(hash_b,'sealed-other-tenant',lease_b,null);
  if exists(select 1 from public.bff_sessions where token_hash=hash_b) then
    raise exception 'Invalid grant did not revoke its held session';
  end if;
  insert into public.bff_sessions(token_hash,member_id,payload,csrf_token,expires_at)
    values (hash_a,member_a,'sealed-expiry','fixture-csrf',clock_timestamp()+interval '1 hour');
  begin
    update public.bff_sessions set refresh_lease_id=lease_a where token_hash=hash_a;
    raise exception 'Partial lease state was accepted';
  exception when check_violation then null;
  end;
  perform public.bff_session_refresh_claim(hash_a,'sealed-expiry',lease_a);
  update public.bff_sessions set expires_at=clock_timestamp()-interval '1 second' where token_hash=hash_a;
  if public.bff_session_refresh_claim(hash_a,'sealed-expiry',lease_b)->>'status'<>'missing'
    or public.bff_session_refresh_finish(hash_a,'sealed-expiry',lease_a,'extended')->>'status'<>'missing'
    or (select payload from public.bff_sessions where token_hash=hash_a)<>'sealed-expiry' then
    raise exception 'Refresh extended an expired session';
  end if;
  begin
    perform public.bff_session_refresh_claim('invalid-hash','payload',lease_a);
    raise exception 'Invalid session hash was accepted';
  exception when invalid_parameter_value then null;
  end;
  if not (select relrowsecurity from pg_class where oid='public.bff_sessions'::regclass)
    or has_table_privilege('anon','public.bff_sessions','select,insert,update,delete')
    or has_table_privilege('authenticated','public.bff_sessions','select,insert,update,delete') then
    raise exception 'Session table browser isolation changed';
  end if;
  foreach function_name in array array[
    'public.bff_session_refresh_claim(text,text,uuid)',
    'public.bff_session_refresh_finish(text,text,uuid,text)'
  ] loop
    if has_function_privilege('anon',function_name,'execute')
      or has_function_privilege('authenticated',function_name,'execute')
      or not has_function_privilege('service_role',function_name,'execute') then
      raise exception 'Session refresh RPC privileges are invalid';
    end if;
  end loop;
end $$;
rollback;

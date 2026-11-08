-- Execute inside a transaction and always roll back the synthetic isolation fixtures.
do $$
declare actor record; required record; snapshot jsonb; fixture_a uuid:=gen_random_uuid();
  fixture_b uuid:=gen_random_uuid(); tenant_a uuid:=gen_random_uuid(); tenant_b uuid:=gen_random_uuid();
  type_a uuid; type_b uuid; snapshot_a jsonb; snapshot_b jsonb;
begin
  for actor in select distinct on (tenant_id) id,tenant_id from public.bff_members
    where enabled and role='admin' order by tenant_id,created_at,id loop
    snapshot:=public.bff_read_dictionaries(actor.id,true);
    for required in select * from (values
      ('sysWebsiteLanguage','BffSystemConfiguration',2),('sysCaptchaProvider','BffSystemConfiguration',1),
      ('sysTurnstileSize','BffSystemConfiguration',4),('sysTurnstileTheme','BffSystemConfiguration',3),
      ('sysWatermarkContentType','BffSystemConfiguration',4),
      ('bffApplicationStatus','BffApplicationManagement',2),
      ('bffMemberAccessStatus','BffMemberManagement',2),('bffMemberRole','BffMemberManagement',2),
      ('bffUpstreamStatus','BffUpstreamManagement',3),('bffUpstreamAuthType','BffUpstreamManagement',3),
      ('bffCredentialAction','BffUpstreamManagement',2),('bffInterfaceMethod','BffInterfaceManagement',5),
      ('bffInterfaceValidationStatus','BffInterfaceManagement',3),('bffInterfaceInputLocation','BffInterfaceManagement',3),
      ('bffInterfaceValueType','BffInterfaceManagement',3),('bffInterfaceBindingSource','BffInterfaceManagement',3),
      ('bffResponseContractMode','BffInterfaceManagement',2),('bffPaginationMode','BffInterfaceManagement',2),
      ('bffPageTotalSource','BffInterfaceManagement',2)
    ) as expected(code,directory,item_count) loop
      if not exists(select 1 from public.bff_dictionary_types t join public.bff_dictionary_types p on p.id=t.parent_id
        where t.tenant_id=actor.tenant_id and p.tenant_id=actor.tenant_id and t.node_type='dictionary'
          and t.code=required.code and p.code=required.directory and t.builtin and t.status='1') then
        raise exception 'Missing module dictionary %',required.code;
      end if;
      if (select count(*) from jsonb_array_elements(snapshot->'items') item
        where item->'dictTypeTable'->>'code'=required.code and item->>'status'='1') < required.item_count then
        raise exception 'Missing dictionary options %',required.code;
      end if;
    end loop;
  end loop;
  if has_table_privilege('anon','public.bff_dictionary_items','select') or
    has_table_privilege('authenticated','public.bff_dictionary_items','select') or
    has_function_privilege('authenticated','public.bff_read_dictionaries(uuid,boolean)','execute') then
    raise exception 'Dictionary transport boundary permissions changed';
  end if;
  insert into public.bff_members(id,issuer,subject,tenant_id,role) values
    (fixture_a,'https://dictionary-test.invalid',fixture_a::text,tenant_a,'viewer'),
    (fixture_b,'https://dictionary-test.invalid',fixture_b::text,tenant_b,'viewer');
  insert into public.bff_dictionary_types(tenant_id,node_type,name,code,create_by,update_by)
    values(tenant_a,'dictionary','隔离测试','bffIsolationFixture',fixture_a,fixture_a) returning id into type_a;
  insert into public.bff_dictionary_types(tenant_id,node_type,name,code,create_by,update_by)
    values(tenant_b,'dictionary','隔离测试','bffIsolationFixture',fixture_b,fixture_b) returning id into type_b;
  insert into public.bff_dictionary_items(tenant_id,type_id,label,value,create_by,update_by) values
    (tenant_a,type_a,'租户甲选项','a',fixture_a,fixture_a),
    (tenant_b,type_b,'租户乙选项','b',fixture_b,fixture_b);
  snapshot_a:=public.bff_read_dictionaries(fixture_a,true);
  snapshot_b:=public.bff_read_dictionaries(fixture_b,true);
  if jsonb_array_length(snapshot_a->'items')<>1 or snapshot_a->'items'->0->>'value'<>'a' or
    jsonb_array_length(snapshot_b->'items')<>1 or snapshot_b->'items'->0->>'value'<>'b' then
    raise exception 'Dictionary options crossed tenant boundary';
  end if;
  update public.bff_dictionary_items set status='2' where type_id=type_a;
  snapshot_a:=public.bff_read_dictionaries(fixture_a,true);
  if jsonb_array_length(snapshot_a->'items')<>0 then raise exception 'Disabled option remained selectable'; end if;
end $$;
select 'BFF module dictionary coverage, enabled options, tenant isolation and browser grants passed' as verification;

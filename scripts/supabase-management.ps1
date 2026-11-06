param(
  [ValidateSet('Inspect','InspectAuthorization','InspectConsent','InspectDesignReferences','InspectBff','InspectMembers','VerifyBff','ValidateBffSchema','ApplyCanonicalBff','ApplyBffSchema','EnableOAuth','RegisterOAuth','PrepareEnvironment','ProvisionMember')][string]$Action = 'Inspect',
  [string]$Login,
  [ValidateSet('admin','viewer')][string]$MemberRole = 'viewer',
  [string]$AppOrigin = 'http://localhost:3010',
  [string]$AuthorizationId
)
$ErrorActionPreference = 'Stop'
# Use the same Windows Credential Manager entry as the authenticated Supabase CLI.
# Credentials stay in memory and are never written to command arguments or output.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BffSupabaseCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Credential {
  public uint Flags; public uint Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint BlobSize;
  public IntPtr Blob; public uint Persist; public uint AttributeCount; public IntPtr Attributes;
  public string TargetAlias; public string UserName;
 }
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target,uint type,int flags,out IntPtr pointer);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr pointer);
 public static string Get(string target) {
  IntPtr pointer; if (!Read(target,1,0,out pointer)) return null;
  try { var item=Marshal.PtrToStructure<Credential>(pointer); var bytes=new byte[item.BlobSize]; Marshal.Copy(item.Blob,bytes,0,bytes.Length); return System.Text.Encoding.UTF8.GetString(bytes); } finally { CredFree(pointer); }
 }
}
'@
$taskToken = $env:SUPABASE_ACCESS_TOKEN
if (!$taskToken) { $taskToken = [BffSupabaseCredential]::Get('Supabase CLI:supabase') }
if (!$taskToken) { $taskToken = [BffSupabaseCredential]::Get('Supabase CLI:access-token') }
if (!$taskToken) { throw 'Authenticated Supabase CLI credential unavailable.' }
$taskHeaders = @{ Authorization = "Bearer $taskToken" }
$proRef = 'ckbftoopuyophiebamwy'
$bffRef = 'bksbwnxdurmuolygiofh'
if ($Action -eq 'InspectDesignReferences') {
  # Read only: design preferences belong to pro; BFF schema operations remain scoped below.
  $taskQuery = @'
select jsonb_strip_nulls(jsonb_build_object(
  'route', j->'route_path_pattern', 'title', j->'page_title', 'tags', j->'preference_tags',
  'note', j->'note', 'style', j->'style_snapshot', 'updated_at', j->'update_time'
)) as reference
from (select to_jsonb(r) as j from public.ai_ui_design_reference r) source
order by j->>'update_time' desc nulls last limit 60
'@
  Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$proRef/database/query" -Headers $taskHeaders -ContentType 'application/json' -Body (@{query=$taskQuery} | ConvertTo-Json -Compress) | ConvertTo-Json -Depth 15
  exit
}
if ($Action -eq 'InspectConsent') {
  if (!$Login) { throw 'Provide the account email to inspect.' }
  $taskExpectedLogin = $Login.Trim().Replace("'", "''")
  $taskClientId = ([IO.File]::ReadAllLines((Join-Path (Get-Location) '.env.local')) | Where-Object { $_.StartsWith('BFF_AUTH_CLIENT_ID=') }) -replace '^BFF_AUTH_CLIENT_ID=', ''
  if ($taskClientId -notmatch '^[a-fA-F0-9-]{36}$') { throw 'Configured OAuth client identifier is invalid.' }
  $taskQuery = "select exists(select 1 from auth.oauth_consents c join auth.users u on u.id=c.user_id where lower(u.email)=lower('$taskExpectedLogin') and c.client_id::text='$taskClientId' and c.revoked_at is null and string_to_array(c.scopes,' ') @> array['email','profile']) as already_authorized"
  Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$proRef/database/query" -Headers $taskHeaders -ContentType 'application/json' -Body (@{query=$taskQuery} | ConvertTo-Json -Compress) | ConvertTo-Json -Depth 5
  exit
}
if ($Action -eq 'InspectAuthorization') {
  $taskQuery = "select table_name,column_name from information_schema.columns where table_schema='auth' and table_name like '%authoriz%' order by table_name,ordinal_position"
  $taskColumns = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$proRef/database/query" -Headers $taskHeaders -ContentType 'application/json' -Body (@{query=$taskQuery} | ConvertTo-Json -Compress)
  if (!$AuthorizationId -and !$Login) { $taskColumns | ConvertTo-Json -Depth 5; exit }
  if ($AuthorizationId -and $AuthorizationId -notmatch '^[A-Za-z0-9_-]{1,512}$') { throw 'Invalid authorization request identifier.' }
  $taskTable = @($taskColumns | ForEach-Object { $_.table_name } | Select-Object -Unique | Where-Object { $_ -in @('oauth_authorizations','oauth_server_authorizations') })
  if ($taskTable.Count -ne 1) { throw 'Unable to identify the OAuth authorization table.' }
  if (!$AuthorizationId) {
    $taskExpectedLogin = $Login.Trim().Replace("'", "''")
    $taskCallback = "$AppOrigin/api/auth/callback".Replace("'", "''")
    $taskQuery = "select a.status,a.created_at,a.expires_at,a.user_id::text as subject,coalesce(lower(u.email)=lower('$taskExpectedLogin'),false) as matches_expected_account from auth.$($taskTable[0]) a left join auth.users u on u.id=a.user_id where a.redirect_uri='$taskCallback' and a.user_id is not null order by a.created_at desc limit 1"
    $taskRecent = @(Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$proRef/database/query" -Headers $taskHeaders -ContentType 'application/json' -Body (@{query=$taskQuery} | ConvertTo-Json -Compress))
    $taskMembers = @(Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$bffRef/database/query" -Headers $taskHeaders -ContentType 'application/json' -Body (@{query="select subject,enabled,role from public.bff_members where lower(email)=lower('$taskExpectedLogin')"} | ConvertTo-Json -Compress))
    foreach ($taskRecentItem in $taskRecent) {
      [PSCustomObject]@{ status=$taskRecentItem.status; matches_expected_account=$taskRecentItem.matches_expected_account; matches_provisioned_member=(@($taskMembers | Where-Object { $_.subject -eq $taskRecentItem.subject -and $_.enabled }).Count -gt 0); expected_member_count=$taskMembers.Count } | ConvertTo-Json -Compress
    }
    exit
  }
  $taskQuery = "select status,expires_at,user_id is not null as user_linked,expires_at < now() as expired from auth.$($taskTable[0]) where authorization_id='$AuthorizationId'"
  Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$proRef/database/query" -Headers $taskHeaders -ContentType 'application/json' -Body (@{query=$taskQuery} | ConvertTo-Json -Compress) | ConvertTo-Json -Depth 5
  exit
}
function Invoke-BffQuery([string]$Query) {
  $taskBody = [Text.Encoding]::UTF8.GetBytes((@{query=$Query} | ConvertTo-Json -Compress))
  $taskResult = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$bffRef/database/query" -Headers $taskHeaders -ContentType 'application/json; charset=utf-8' -Body $taskBody
  return $taskResult
}
if ($Action -in @('ValidateBffSchema','ApplyCanonicalBff')) {
  $taskSql = Get-Content -Raw -Encoding UTF8 -LiteralPath 'server/database/schema.sql'
  if ($taskSql -notmatch 'exclusively for project bksbwnxdurmuolygiofh' -or $taskSql -notmatch 'begin;' -or $taskSql -notmatch 'commit;\s*$') {
    throw 'The canonical BFF schema must declare its project and one complete transaction.'
  }
  $taskMcp = Get-Content -Raw -LiteralPath '.mcp.json' | ConvertFrom-Json
  if ($taskMcp.mcpServers.supabase.url -notmatch 'project_ref=bksbwnxdurmuolygiofh(?:&|$)') { throw 'BFF project scope mismatch.' }
  $taskTables = @(Invoke-BffQuery "select tablename from pg_tables where schemaname='public' and tablename ~ '^bff_[a-z_]+$' order by tablename")
  $taskDataQueries = @()
  foreach ($taskTable in $taskTables) {
    $taskName = [string]$taskTable.tablename
    if ($taskName -notmatch '^bff_[a-z_]+$') { throw 'Invalid BFF table identifier.' }
    $taskDataQueries += "select '$taskName'::text as name,coalesce(jsonb_agg(to_jsonb(record)),'[]'::jsonb) as rows from public.$taskName record"
  }
  $taskFunctionQuery = "select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,p.proacl as grants from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname ~ '^bff_[a-z_]+$' and p.prokind='f'"
  $taskStructureQuery = @'
select c.relname as name,c.relrowsecurity as rls,c.relforcerowsecurity as force_rls,c.relacl as grants,
  pg_get_userbyid(c.relowner) as owner,
  (select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
    'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) order by a.attnum)
    from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns,
  (select coalesce(jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated)),'[]'::jsonb)
    from pg_constraint k where k.conrelid=c.oid) as constraints,
  (select coalesce(jsonb_agg(jsonb_build_object('name',i.relname,'definition',pg_get_indexdef(i.oid),
    'constraint_owned',exists(select 1 from pg_constraint k where k.conindid=i.oid))),'[]'::jsonb)
    from pg_index x join pg_class i on i.oid=x.indexrelid where x.indrelid=c.oid) as indexes,
  (select coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid,true))),'[]'::jsonb)
    from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal) as triggers,
  (select coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and c.relname ~ '^bff_[a-z_]+$' order by c.relname
'@
  $taskDataQuery = if ($taskDataQueries.Count) { $taskDataQueries -join ' union all ' } else { "select null::text as name,'[]'::jsonb as rows where false" }
  # One PostgreSQL statement captures related rows and live definitions in the same MVCC snapshot.
  $taskSnapshotQuery = @"
with data_rows as materialized ($taskDataQuery),structures as ($taskStructureQuery),functions as ($taskFunctionQuery)
select jsonb_build_object(
  'capturedAt',statement_timestamp(),
  'tables',(select coalesce(jsonb_object_agg(name,rows),'{}'::jsonb) from data_rows),
  'rowCounts',(select coalesce(jsonb_object_agg(name,jsonb_array_length(rows)),'{}'::jsonb) from data_rows),
  'structures',(select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) from structures s),
  'functions',(select coalesce(jsonb_agg(to_jsonb(f)),'[]'::jsonb) from functions f)
) as snapshot
"@
  $taskDatabaseSnapshots = @(Invoke-BffQuery $taskSnapshotQuery)
  if ($taskDatabaseSnapshots.Count -ne 1) { throw 'BFF database snapshot response is invalid.' }
  $taskDatabaseSnapshot = $taskDatabaseSnapshots[0].snapshot
  $taskBeforeSource = (& git show HEAD:server/database/schema.sql) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'Cannot capture the committed schema recovery baseline.' }
  $taskBackupDirectory = Join-Path (Get-Location) '.artifacts/database'
  New-Item -ItemType Directory -Path $taskBackupDirectory -Force | Out-Null
  $taskBackupPath = Join-Path $taskBackupDirectory ('bff-core-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '.json')
  $taskSnapshot = @{ project=$bffRef; capturedAt=$taskDatabaseSnapshot.capturedAt; sourceSnapshot=$taskBeforeSource; structures=$taskDatabaseSnapshot.structures; tables=$taskDatabaseSnapshot.tables; functions=$taskDatabaseSnapshot.functions; rowCounts=$taskDatabaseSnapshot.rowCounts }
  [IO.File]::WriteAllText($taskBackupPath,($taskSnapshot | ConvertTo-Json -Depth 60),[Text.Encoding]::UTF8)
  $taskBackup = Get-Content -Raw -LiteralPath $taskBackupPath | ConvertFrom-Json
  if ($taskBackup.project -ne $bffRef -or @($taskBackup.tables.PSObject.Properties).Count -ne $taskTables.Count -or @($taskBackup.structures).Count -ne $taskTables.Count) { throw 'BFF recovery baseline verification failed.' }
  foreach ($taskTable in $taskTables) {
    $taskName = [string]$taskTable.tablename
    if (@($taskBackup.tables.$taskName).Count -ne [int]$taskDatabaseSnapshot.rowCounts.$taskName) { throw 'BFF recovery row counts do not match.' }
  }
  $taskVerification = ''
  foreach ($taskVerificationPath in @('tests/integration/control-plane-schema.sql','tests/integration/role-access.sql','tests/integration/application-authorization.sql')) {
    if (Test-Path -LiteralPath $taskVerificationPath) {
      $taskVerificationPart = Get-Content -Raw -Encoding UTF8 -LiteralPath $taskVerificationPath
      if ($taskVerificationPart -match '(?im)^\s*(begin|commit|rollback)\s*;') { throw 'Schema verification cannot control the outer transaction.' }
      $taskVerification += "`n" + $taskVerificationPart
    }
  }
  $taskCommit = [regex]::Match($taskSql, 'commit;\s*$')
  $taskValidationSql = $taskSql.Substring(0,$taskCommit.Index) + $taskVerification + "`nset constraints all immediate; rollback;"
  $null = Invoke-BffQuery $taskValidationSql
  if ($Action -eq 'ValidateBffSchema') {
    Write-Output ('Canonical schema validated with ROLLBACK for BFF ' + $bffRef + '; recovery baseline verified for ' + $taskTables.Count + ' tables. No schema change committed.')
    exit
  }
  $null = Invoke-BffQuery $taskSql
  $taskPermissions = Invoke-BffQuery "select c.relname as name,c.relrowsecurity as rls,has_table_privilege('anon',c.oid,'select,insert,update,delete') as anon_access,has_table_privilege('authenticated',c.oid,'select,insert,update,delete') as authenticated_access from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname ~ '^bff_[a-z_]+$' order by c.relname"
  if (@($taskPermissions | Where-Object { -not $_.rls -or $_.anon_access -or $_.authenticated_access }).Count) { throw 'BFF table permission verification failed.' }
  Write-Output ('Canonical schema applied only to BFF ' + $bffRef + '; RLS and browser-role read denial verified for ' + @($taskPermissions).Count + ' tables.')
  exit
}
if ($Action -eq 'InspectMembers') {
  Invoke-BffQuery "select m.email,m.display_name,m.role,m.enabled,count(am.application_id)::integer as application_grants,(select count(*)::integer from public.bff_sessions s where s.member_id=m.id and s.expires_at>now()) as active_sessions from public.bff_members m left join public.bff_application_members am on am.member_id=m.id group by m.id order by m.created_at,m.email" | ConvertTo-Json -Depth 5
  exit
}
if ($Action -eq 'VerifyBff') {
  Invoke-BffQuery (Get-Content -Raw -LiteralPath 'tests/integration/database-security.sql') | ConvertTo-Json -Depth 5
  exit
}
if ($Action -eq 'ProvisionMember') {
  if ([string]::IsNullOrWhiteSpace($Login)) { throw 'Provide the exact existing pro username or email with -Login.' }
  $taskIdentifier = $Login.Trim().Replace("'", "''")
  $taskQuery = "select auth_user_id,tenant_id,coalesce(nullif(nick_name,''),user_name) as display_name,coalesce(user_email,'') as email,status from public.sys_user where deleted_at is null and (user_name='$taskIdentifier' or lower(user_email)=lower('$taskIdentifier'))"
  $taskUsers = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$proRef/database/query" -Headers $taskHeaders -ContentType 'application/json' -Body (@{query=$taskQuery} | ConvertTo-Json -Compress)
  if ($taskUsers.Count -ne 1) { throw 'The identifier must resolve to exactly one existing pro account.' }
  $taskUser = $taskUsers[0]
  if (!$taskUser.auth_user_id -or !$taskUser.tenant_id -or $taskUser.status -ne '1') { throw 'The pro account must be active and have an Auth identity and tenant.' }
  $taskSubject = ([guid]$taskUser.auth_user_id).ToString()
  $taskTenant = ([guid]$taskUser.tenant_id).ToString()
  $taskDisplay = ([string]$taskUser.display_name).Replace("'", "''")
  $taskEmail = ([string]$taskUser.email).Replace("'", "''")
  $taskProvision = "insert into public.bff_members(issuer,subject,tenant_id,display_name,email,role) values('https://ckbftoopuyophiebamwy.supabase.co/auth/v1','$taskSubject','$taskTenant','$taskDisplay','$taskEmail','$MemberRole') on conflict(issuer,subject) do nothing returning id"
  $taskCreated = Invoke-BffQuery $taskProvision
  if ($taskCreated.Count -eq 0) { Write-Output 'BFF member already exists; no role or account fields changed.' } else { Write-Output 'Existing pro identity provisioned in BFF. Pro account and password unchanged.' }
  exit
}
if ($Action -in @('InspectBff','ApplyBffSchema')) {
  $taskBaseline = Invoke-BffQuery "select tablename from pg_tables where schemaname='public' order by tablename"
  if ($Action -eq 'InspectBff') { @{ project=$bffRef; tables=$taskBaseline } | ConvertTo-Json -Depth 5; exit }
  if ($taskBaseline.Count -ne 0) { throw 'BFF schema bootstrap requires an empty public schema; inspect and back up existing data before further changes.' }
  New-Item -ItemType Directory -Path '.artifacts/database' -Force | Out-Null
  $taskSnapshotPath = Join-Path (Get-Location) '.artifacts/database/bff-before-bootstrap.json'
  @{project=$bffRef; capturedAt=[DateTime]::UtcNow.ToString('o'); publicTables=$taskBaseline} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskSnapshotPath
  $taskBackup = Get-Content -Raw -LiteralPath $taskSnapshotPath | ConvertFrom-Json
  if ($taskBackup.project -ne $bffRef -or @($taskBackup.publicTables).Count -ne 0) { throw 'Empty-schema recovery baseline verification failed.' }
  $taskSql = Get-Content -Raw -LiteralPath 'server/database/schema.sql'
  $null = Invoke-BffQuery ($taskSql -replace 'commit;\s*$', 'rollback;')
  $null = Invoke-BffQuery $taskSql
  Invoke-BffQuery "select c.relname as name,c.relrowsecurity as rls,has_table_privilege('anon',c.oid,'select') as anon_select,has_table_privilege('authenticated',c.oid,'select') as authenticated_select from pg_class c join pg_namespace n on c.relnamespace=n.oid where n.nspname='public' and c.relkind='r' and c.relname like 'bff_%' order by c.relname" | ConvertTo-Json
  exit
}
$taskConfig = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$proRef/config/auth" -Headers $taskHeaders
if ($Action -eq 'Inspect') {
  $taskConfig | Select-Object site_url,uri_allow_list,oauth_server_enabled,oauth_server_authorization_path,oauth_server_allow_dynamic_registration | ConvertTo-Json
  exit
}
if ($Action -eq 'PrepareEnvironment') {
  $taskKeys = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$bffRef/api-keys" -Headers $taskHeaders
  $taskService = ($taskKeys | Where-Object name -eq 'service_role').api_key
  if (!$taskService) { throw 'BFF service key unavailable.' }
  $taskSessionKey = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
  $taskLocal = @(
    'BFF_ORIGIN=http://localhost:3010', 'BFF_PORT=3010',
    'BFF_AUTH_ISSUER=https://ckbftoopuyophiebamwy.supabase.co/auth/v1',
    'BFF_AUTH_CLIENT_ID=', 'BFF_AUTH_CLIENT_SECRET=',
    "BFF_SESSION_KEY=$taskSessionKey", 'BFF_SUPABASE_URL=https://bksbwnxdurmuolygiofh.supabase.co',
    "BFF_SUPABASE_SERVICE_KEY=$taskService"
  )
  if (Test-Path -LiteralPath '.env.local') { throw '.env.local already exists; refusing to replace local credentials.' }
  [IO.File]::WriteAllLines((Join-Path (Get-Location) '.env.local'), $taskLocal)
  Write-Output 'BFF server environment prepared. No credentials printed.'
  exit
}
if ($Action -eq 'EnableOAuth') {
  # Run only after the additive pro consent route has been deployed and verified.
  $taskExpectedPath = '/#/auth/oauth-consent'
  $taskExpectedSite = 'https://art-si.github.io/art-supabase-pro/'
  if ($taskConfig.site_url -notin @('https://869123771.github.io/art-supabase-pro/',$taskExpectedSite)) { throw 'Unexpected pro site URL. Inspect the current deployment before changing authentication URLs.' }
  if ($taskConfig.oauth_server_enabled -and $taskConfig.oauth_server_authorization_path -ne $taskExpectedPath) { throw 'An existing OAuth authorization path is already in use; do not replace it.' }
  New-Item -ItemType Directory -Path '.artifacts/pro-auth' -Force | Out-Null
  $taskRestorePath = Join-Path (Get-Location) '.artifacts/pro-auth/oauth-config-before.json'
  if (!(Test-Path -LiteralPath $taskRestorePath)) {
    $taskConfig | Select-Object site_url,uri_allow_list,oauth_server_enabled,oauth_server_authorization_path,oauth_server_allow_dynamic_registration | ConvertTo-Json | Set-Content -LiteralPath $taskRestorePath
  }
  $taskRestore = Get-Content -Raw -LiteralPath $taskRestorePath | ConvertFrom-Json
  if ($null -eq $taskRestore.oauth_server_enabled -or !$taskRestore.site_url) { throw 'OAuth configuration recovery baseline is invalid.' }
  $taskAllowedUris = [string]$taskConfig.uri_allow_list
  $taskCanonicalUri = 'https://art-si.github.io/art-supabase-pro/**'
  if ($taskCanonicalUri -notin $taskAllowedUris.Split(',')) { $taskAllowedUris = ($taskAllowedUris.TrimEnd(',') + ',' + $taskCanonicalUri).TrimStart(',') }
  $taskPatch = @{site_url=$taskExpectedSite;uri_allow_list=$taskAllowedUris;oauth_server_enabled=$true;oauth_server_authorization_path=$taskExpectedPath;oauth_server_allow_dynamic_registration=$false}
  $null = Invoke-RestMethod -Method Patch -Uri "https://api.supabase.com/v1/projects/$proRef/config/auth" -Headers $taskHeaders -ContentType 'application/json' -Body ($taskPatch | ConvertTo-Json)
  $taskAfter = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$proRef/config/auth" -Headers $taskHeaders
  $taskAllowed = @('site_url','uri_allow_list','oauth_server_enabled','oauth_server_authorization_path','oauth_server_allow_dynamic_registration','updated_at')
  foreach ($taskProperty in $taskConfig.PSObject.Properties) {
    if ($taskProperty.Name -in $taskAllowed) { continue }
    $taskBeforeValue = $taskProperty.Value | ConvertTo-Json -Depth 10 -Compress
    $taskAfterValue = $taskAfter.($taskProperty.Name) | ConvertTo-Json -Depth 10 -Compress
    if ($taskBeforeValue -ne $taskAfterValue) { throw "Unexpected non-OAuth configuration change: $($taskProperty.Name). Inspect before proceeding." }
  }
  if (!$taskAfter.oauth_server_enabled -or $taskAfter.oauth_server_authorization_path -ne $taskExpectedPath -or $taskAfter.oauth_server_allow_dynamic_registration -or $taskAfter.site_url -ne $taskExpectedSite -or $taskAfter.uri_allow_list -ne $taskAllowedUris) { throw 'Auth URL and OAuth settings did not persist as requested.' }
  Write-Output 'OAuth enabled; default URL corrected to the verified current pro site and old allowed URLs preserved. Other Auth configuration verified unchanged.'
  exit
}
if ($Action -eq 'RegisterOAuth') {
  if (!$taskConfig.oauth_server_enabled -or $taskConfig.oauth_server_authorization_path -ne '/#/auth/oauth-consent') { throw 'Deploy and enable the verified pro consent route first.' }
  $taskOrigin = [uri]$AppOrigin
  if ($taskOrigin.Scheme -ne 'https' -and $taskOrigin.Host -notin @('localhost','127.0.0.1')) { throw 'OAuth application origins must use HTTPS outside localhost.' }
  if ($taskOrigin.AbsolutePath -ne '/' -or $taskOrigin.Query -or $taskOrigin.Fragment -or $taskOrigin.UserInfo) { throw 'Provide an origin without a path, query, fragment or credentials.' }
  $taskCallback = $taskOrigin.GetLeftPart([UriPartial]::Authority) + '/api/auth/callback'
  $taskKeys = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$proRef/api-keys" -Headers $taskHeaders
  $taskProService = ($taskKeys | Where-Object name -eq 'service_role').api_key
  if (!$taskProService) { throw 'Pro Auth administration credential unavailable.' }
  $taskProHeaders = @{Authorization="Bearer $taskProService";apikey=$taskProService}
  $taskClientEndpoint = "https://$proRef.supabase.co/auth/v1/admin/oauth/clients"
  $taskExisting = Invoke-RestMethod -Uri "$taskClientEndpoint`?page=1&per_page=1000" -Headers $taskProHeaders
  $taskMatches = @($taskExisting.clients | Where-Object { $taskCallback -in $_.redirect_uris })
  $taskEnvPath = Join-Path (Get-Location) '.env.local'
  if (!(Test-Path -LiteralPath $taskEnvPath)) { throw 'Prepare the BFF local server environment first.' }
  $taskEnvLines = [IO.File]::ReadAllLines($taskEnvPath)
  if ($taskMatches.Count -gt 0) {
    $taskConfiguredId = ($taskEnvLines | Where-Object { $_.StartsWith('BFF_AUTH_CLIENT_ID=') }) -replace '^BFF_AUTH_CLIENT_ID=', ''
    $taskConfiguredSecret = ($taskEnvLines | Where-Object { $_.StartsWith('BFF_AUTH_CLIENT_SECRET=') }) -replace '^BFF_AUTH_CLIENT_SECRET=', ''
    if ($taskMatches.Count -eq 1 -and $taskConfiguredId -eq $taskMatches[0].client_id -and $taskConfiguredSecret) { Write-Output 'BFF OAuth client already registered and configured.'; exit }
    throw 'The callback is already registered but local client credentials do not match. Refusing duplicate registration or automatic secret rotation.'
  }
  $taskClientRequest = @{client_name="BFF Platform ($($taskOrigin.Host))";client_uri=$taskOrigin.GetLeftPart([UriPartial]::Authority);redirect_uris=@($taskCallback);grant_types=@('authorization_code','refresh_token');response_types=@('code');scope='email profile';token_endpoint_auth_method='client_secret_post'}
  $taskClient = Invoke-RestMethod -Method Post -Uri $taskClientEndpoint -Headers $taskProHeaders -ContentType 'application/json; charset=utf-8' -Body ($taskClientRequest | ConvertTo-Json)
  if (!$taskClient.client_id -or !$taskClient.client_secret) { throw 'Client registration returned no usable credentials. Inspect the existing client before retrying.' }
  $taskNewLines = $taskEnvLines | ForEach-Object {
    if ($_.StartsWith('BFF_AUTH_CLIENT_ID=')) { "BFF_AUTH_CLIENT_ID=$($taskClient.client_id)" }
    elseif ($_.StartsWith('BFF_AUTH_CLIENT_SECRET=')) { "BFF_AUTH_CLIENT_SECRET=$($taskClient.client_secret)" }
    else { $_ }
  }
  [IO.File]::WriteAllLines($taskEnvPath,$taskNewLines)
  Write-Output 'BFF confidential OAuth client registered. Credentials saved only to ignored .env.local; no secret printed.'
  exit
}

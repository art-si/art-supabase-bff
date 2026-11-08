param(
  [ValidateSet('SyncWordmarkPermission','PrepareMemberDirectory','InspectBusinessDictionaries','SyncBusinessDictionaries','Inspect','InspectAuthorization','InspectConsent','InspectDesignReferences','InspectBff','InspectMembers','InspectResources','InspectBffActivity','AuditBffSecurity','VerifyBff','ValidateBffSchema','ApplyCanonicalBff','ApplyBffSchema','EnableOAuth','RegisterOAuth','PrepareEnvironment','ProvisionMember','CleanupUpstreamFixtures','EnableUpstreamNavigation','EnableInterfaceNavigation','EnableReleaseNavigation','DisableReleaseNavigation','EnableBrandingNavigation','DisableBrandingNavigation','EnableResourceNavigation','DisableResourceNavigation','EnableObservabilityNavigation','DisableObservabilityNavigation')][string]$Action = 'Inspect',
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
if ($Action -eq 'PrepareMemberDirectory') {
  $taskEnvPath = Join-Path (Get-Location) '.env.local'
  if (!(Test-Path -LiteralPath $taskEnvPath)) { throw 'Configure the BFF environment first.' }
  $taskEnvLines = [IO.File]::ReadAllLines($taskEnvPath)
  if (@($taskEnvLines | Where-Object { $_ -match '^BFF_IDENTITY_DIRECTORY_SERVICE_KEY=.+$' }).Count) {
    Write-Output 'Server-side member directory already configured.'
    exit
  }
  $taskKeys = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$proRef/api-keys" -Headers $taskHeaders
  $taskDirectoryKey = ($taskKeys | Where-Object name -eq 'service_role').api_key
  if (!$taskDirectoryKey) { throw 'Identity directory credential unavailable.' }
  $taskEnvLines = @($taskEnvLines | Where-Object { ! $_.StartsWith('BFF_IDENTITY_DIRECTORY_SERVICE_KEY=') }) + ('BFF_IDENTITY_DIRECTORY_SERVICE_KEY=' + $taskDirectoryKey)
  [IO.File]::WriteAllLines($taskEnvPath,$taskEnvLines,[Text.UTF8Encoding]::new($false))
  Write-Output 'Member directory configured only in ignored server environment; no credentials printed.'
  exit
}
function Read-Utf8JsonResponse($Response) {
  # Windows PowerShell 5 may decode JSON without a response charset as Latin-1.
  # Parse the original UTF-8 bytes so recovery snapshots preserve Chinese data.
  $taskUtf8Json = [Text.Encoding]::UTF8.GetString($Response.RawContentStream.ToArray())
  return (ConvertFrom-Json -InputObject $taskUtf8Json)
}
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
  $taskResponse = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "https://api.supabase.com/v1/projects/$proRef/database/query" -Headers $taskHeaders -ContentType 'application/json' -Body (@{query=$taskQuery} | ConvertTo-Json -Compress)
  Read-Utf8JsonResponse $taskResponse | ConvertTo-Json -Depth 15
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
  if ($bffRef -ne 'bksbwnxdurmuolygiofh' -or $taskToken -notmatch '^[A-Za-z0-9._-]{20,4096}$') {
    throw 'BFF management scope or credential format is invalid.'
  }
  $taskRequestDir = Join-Path (Get-Location) '.artifacts/database'
  New-Item -ItemType Directory -Path $taskRequestDir -Force | Out-Null
  $taskRequestPath = Join-Path $taskRequestDir ('query-' + [guid]::NewGuid().ToString('N') + '.json')
  # The request file contains reviewed SQL only. The management token goes to curl on stdin,
  # never a command argument or a file. A lost response is never retried automatically.
  [IO.File]::WriteAllText($taskRequestPath, (@{query=$Query} | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  try {
    $taskRaw = ('header = "Authorization: Bearer ' + $taskToken + '"') |
      & curl.exe --config - --request POST --header 'Content-Type: application/json; charset=utf-8' --data-binary "@$taskRequestPath" --silent --show-error --fail-with-body --connect-timeout 20 --max-time 360 "https://api.supabase.com/v1/projects/$bffRef/database/query"
    if ($LASTEXITCODE -ne 0) { throw "BFF management query transport failed (curl exit $LASTEXITCODE); inspect live state before retrying a mutation." }
    return (ConvertFrom-Json -InputObject ($taskRaw -join "`n"))
  } finally {
    [IO.File]::Delete($taskRequestPath)
  }
}
if ($Action -eq 'InspectBffActivity') {
  $taskMcp = Get-Content -Raw -LiteralPath '.mcp.json' | ConvertFrom-Json
  if ($taskMcp.mcpServers.supabase.url -notmatch 'project_ref=bksbwnxdurmuolygiofh(?:&|$)') { throw 'BFF project scope mismatch.' }
  $taskActivityQuery = @'
select pid,state,wait_event_type,wait_event,
  greatest(0,extract(epoch from now()-query_start)::integer) as age_seconds,
  pg_blocking_pids(pid) as blocking_pids,application_name,backend_type
from pg_stat_activity
where datname=current_database() and pid<>pg_backend_pid() and state is distinct from 'idle'
order by query_start nulls last,pid limit 50
'@
  Invoke-BffQuery $taskActivityQuery | ConvertTo-Json -Depth 8
  exit
}
if ($Action -eq 'AuditBffSecurity') {
  $taskMcp = Get-Content -Raw -LiteralPath '.mcp.json' | ConvertFrom-Json
  if ($taskMcp.mcpServers.supabase.url -notmatch 'project_ref=bksbwnxdurmuolygiofh(?:&|$)') { throw 'BFF project scope mismatch.' }
  $taskResponse = Invoke-WebRequest -UseBasicParsing -Method Get -Uri "https://api.supabase.com/v1/projects/$bffRef/advisors/security" -Headers $taskHeaders
  $taskAudit = Read-Utf8JsonResponse $taskResponse
  $taskAuditDir = Join-Path (Get-Location) '.artifacts/database'
  New-Item -ItemType Directory -Path $taskAuditDir -Force | Out-Null
  $taskAuditPath = Join-Path $taskAuditDir ('advisors-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '.json')
  [IO.File]::WriteAllText($taskAuditPath,([Text.Encoding]::UTF8.GetString($taskResponse.RawContentStream.ToArray())),[Text.Encoding]::UTF8)
  $taskFindings = if ($taskAudit -is [array]) { @($taskAudit) }
    elseif ($taskAudit.PSObject.Properties['lints']) { @($taskAudit.lints) }
    elseif ($taskAudit.PSObject.Properties['advisors']) { @($taskAudit.advisors) }
    elseif ($taskAudit.PSObject.Properties['data']) { @($taskAudit.data) }
    else { throw 'Unexpected security advisor response; full response saved for local review.' }
  $taskCounts = @($taskFindings | Group-Object { [string]$_.level + ' / ' + [string]$_.name } |
    Sort-Object Name | ForEach-Object { [PSCustomObject]@{ levelAndName=$_.Name; count=$_.Count } })
  $taskResourceFindings = @($taskFindings | Where-Object {
    ($_ | ConvertTo-Json -Depth 20 -Compress) -match '(?i)bff_resources|bff-assets|bff_resource|storage[.]objects|storage[.]buckets'
  })
  $taskResourceWarnings = @($taskResourceFindings | Where-Object { $_.level -in @('WARN','ERROR') })
  [PSCustomObject]@{
    project = $bffRef
    savedTo = $taskAuditPath
    findingCount = $taskFindings.Count
    byLevelAndName = $taskCounts
    resourceFindingCount = $taskResourceFindings.Count
    resourceFindingNames = @($taskResourceFindings | ForEach-Object { [string]$_.name } | Sort-Object -Unique)
    resourceWarningCount = $taskResourceWarnings.Count
    resourceConclusion = if ($taskResourceWarnings.Count -eq 0) { 'No resource-related WARN or ERROR findings' } else { 'Review resource-related WARN or ERROR findings in saved report' }
    warningEntities = @($taskFindings | Where-Object { $_.level -in @('WARN','ERROR') } |
      ForEach-Object { [string]$_.metadata.schema + '.' + [string]$_.metadata.name } | Sort-Object -Unique)
  } | ConvertTo-Json -Depth 8
  exit
}
if ($Action -eq 'InspectResources') {
  $taskMcp = Get-Content -Raw -LiteralPath '.mcp.json' | ConvertFrom-Json
  if ($taskMcp.mcpServers.supabase.url -notmatch 'project_ref=bksbwnxdurmuolygiofh(?:&|$)') { throw 'BFF project scope mismatch.' }
  $taskQuery = @'
select jsonb_build_object(
  'servicePrivileges',jsonb_build_object(
    'bucketSelect',has_table_privilege('service_role','storage.buckets','SELECT'),
    'objectSelect',has_table_privilege('service_role','storage.objects','SELECT'),
    'resourceInsert',has_table_privilege('service_role','public.bff_resources','INSERT'),
    'revisionWrite',has_table_privilege('service_role','public.bff_resource_revisions','INSERT,UPDATE'),
    'reserveExecute',has_function_privilege('service_role',
      'public.bff_resource_reserve(uuid,text,text,text,bigint,text)','EXECUTE')),
  'sequence',jsonb_build_object(
    'name',pg_get_serial_sequence('public.bff_resources','id'),
    'serviceUsage',has_sequence_privilege('service_role',pg_get_serial_sequence('public.bff_resources','id'),'USAGE'),
    'serviceSelect',has_sequence_privilege('service_role',pg_get_serial_sequence('public.bff_resources','id'),'SELECT'),
    'anonUsage',has_sequence_privilege('anon',pg_get_serial_sequence('public.bff_resources','id'),'USAGE'),
    'authenticatedUsage',has_sequence_privilege('authenticated',pg_get_serial_sequence('public.bff_resources','id'),'USAGE')),
  'bucket',(select jsonb_build_object('private',not public,'fileSizeLimit',file_size_limit,
    'allowedMimeTypes',allowed_mime_types) from storage.buckets where id='bff-assets'),
  'objectPolicyCount',(select count(*) from pg_policies where schemaname='storage' and tablename='objects'),
  'storagePolicies',(select coalesce(jsonb_agg(jsonb_build_object('table',tablename,'name',policyname,
    'cmd',cmd,'roles',roles,'using',qual,'check',with_check) order by tablename,policyname),'[]'::jsonb)
    from pg_policies where schemaname='storage' and tablename in ('objects','buckets'))
) as inspection
'@
  Invoke-BffQuery $taskQuery | ConvertTo-Json -Depth 20
  exit
}
if ($Action -eq 'SyncWordmarkPermission') {
  $taskMcp = Get-Content -Raw -LiteralPath '.mcp.json' | ConvertFrom-Json
  if ($bffRef -ne 'bksbwnxdurmuolygiofh' -or $taskMcp.mcpServers.supabase.url -notmatch 'project_ref=bksbwnxdurmuolygiofh(?:&|$)') {
    throw 'BFF wordmark project scope mismatch.'
  }
  $taskSource = Get-Content -Raw -Encoding UTF8 -LiteralPath 'server/database/schema.sql'
  $taskBlock = [regex]::Match($taskSource,'(?s)-- BEGIN BFF WORDMARK PERMISSION\r?\n(.*?)-- END BFF WORDMARK PERMISSION')
  if (!$taskBlock.Success) { throw 'Canonical wordmark permission seed is missing.' }
  $taskBefore = @(Invoke-BffQuery @'
select jsonb_build_object('menus',(select coalesce(jsonb_agg(to_jsonb(m)),'[]'::jsonb) from public.bff_menus m),
  'revisions',(select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from public.bff_resource_revisions r where resource='menus')) as snapshot
'@)
  if ($taskBefore.Count -ne 1 -or $null -eq $taskBefore[0].snapshot.menus) { throw 'Menu recovery snapshot is invalid.' }
  $taskBackupDirectory = Join-Path (Get-Location) '.artifacts/database'
  New-Item -ItemType Directory -Path $taskBackupDirectory -Force | Out-Null
  $taskBackupPath = Join-Path $taskBackupDirectory ('bff-wordmark-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '.json')
  [IO.File]::WriteAllText($taskBackupPath,(@{project=$bffRef;snapshot=$taskBefore[0].snapshot}|ConvertTo-Json -Depth 50),[Text.Encoding]::UTF8)
  $taskRecovery = Get-Content -Raw -LiteralPath $taskBackupPath | ConvertFrom-Json
  if ($taskRecovery.project -ne $bffRef -or @($taskRecovery.snapshot.menus).Count -ne @($taskBefore[0].snapshot.menus).Count) {
    throw 'Menu recovery verification failed.'
  }
  $taskAssertions = Get-Content -Raw -Encoding UTF8 -LiteralPath 'tests/integration/wordmark-permission.sql'
  $taskSeed = $taskBlock.Groups[1].Value
  $null = Invoke-BffQuery ("begin;`n"+$taskSeed+"`n"+$taskSeed+"`n"+$taskAssertions+"`nrollback;")
  $null = Invoke-BffQuery ("begin;`n"+$taskSeed+"`ncommit;")
  Invoke-BffQuery ("begin;`n"+$taskAssertions+"`nrollback;") | ConvertTo-Json -Depth 5
  exit
}
if ($Action -in @('InspectBusinessDictionaries','SyncBusinessDictionaries')) {
  $taskMcp = Get-Content -Raw -LiteralPath '.mcp.json' | ConvertFrom-Json
  if ($bffRef -ne 'bksbwnxdurmuolygiofh' -or $taskMcp.mcpServers.supabase.url -notmatch 'project_ref=bksbwnxdurmuolygiofh(?:&|$)') {
    throw 'BFF dictionary project scope mismatch.'
  }
  if ($Action -eq 'SyncBusinessDictionaries') {
    $taskSource = Get-Content -Raw -Encoding UTF8 -LiteralPath 'server/database/schema.sql'
    $taskBlock = [regex]::Match($taskSource, '(?s)-- BEGIN BFF MODULE DICTIONARIES\r?\n(.*?)-- END BFF MODULE DICTIONARIES')
    if (!$taskBlock.Success) { throw 'Canonical module dictionary seed is missing.' }
    $taskSeed = $taskBlock.Groups[1].Value
    $taskBefore = @(Invoke-BffQuery @'
select jsonb_build_object(
  'types',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.bff_dictionary_types t),
  'items',(select coalesce(jsonb_agg(to_jsonb(i)),'[]'::jsonb) from public.bff_dictionary_items i),
  'revisions',(select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from public.bff_resource_revisions r where resource='dictionaries')
) as snapshot
'@)
    if ($taskBefore.Count -ne 1 -or $null -eq $taskBefore[0].snapshot.types -or $null -eq $taskBefore[0].snapshot.items) {
      throw 'Dictionary recovery snapshot is invalid.'
    }
    $taskBackupDirectory = Join-Path (Get-Location) '.artifacts/database'
    New-Item -ItemType Directory -Path $taskBackupDirectory -Force | Out-Null
    $taskBackupPath = Join-Path $taskBackupDirectory ('bff-dictionaries-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '.json')
    [IO.File]::WriteAllText($taskBackupPath, (@{ project=$bffRef; snapshot=$taskBefore[0].snapshot } | ConvertTo-Json -Depth 50), [Text.Encoding]::UTF8)
    $taskRecovery = Get-Content -Raw -LiteralPath $taskBackupPath | ConvertFrom-Json
    if ($taskRecovery.project -ne $bffRef -or @($taskRecovery.snapshot.items).Count -ne @($taskBefore[0].snapshot.items).Count) {
      throw 'Dictionary recovery snapshot verification failed.'
    }
    $taskAssertions = Get-Content -Raw -Encoding UTF8 -LiteralPath 'tests/integration/business-dictionaries.sql'
    # Validate twice in one rollback transaction to verify idempotency before applying.
    $null = Invoke-BffQuery ("begin;`n" + $taskSeed + "`n" + $taskSeed + "`n" + $taskAssertions + "`nrollback;")
    $null = Invoke-BffQuery ("begin;`n" + $taskSeed + "`ncommit;")
    Invoke-BffQuery ("begin;`n" + $taskAssertions + "`nrollback;") | ConvertTo-Json -Depth 5
    $taskAfter = @(Invoke-BffQuery 'select id,label,value,status,sort from public.bff_dictionary_items')
    foreach ($taskOriginal in $taskBefore[0].snapshot.items) {
      $taskSaved = @($taskAfter | Where-Object { $_.id -eq $taskOriginal.id })
      if ($taskSaved.Count -ne 1 -or $taskSaved[0].label -ne $taskOriginal.label -or $taskSaved[0].value -ne $taskOriginal.value -or
        $taskSaved[0].status -ne $taskOriginal.status -or $taskSaved[0].sort -ne $taskOriginal.sort) {
        throw 'An existing dictionary item changed during seeding. Inspect recovery snapshot.'
      }
    }
    Write-Output 'BFF module dictionaries synchronized; existing labels, values, status and ordering preserved.'
  }
  Invoke-BffQuery @'
select p.code as module,t.code,t.name,count(i.id) as options
from public.bff_dictionary_types t join public.bff_dictionary_types p on p.id=t.parent_id and p.tenant_id=t.tenant_id
left join public.bff_dictionary_items i on i.type_id=t.id and i.tenant_id=t.tenant_id
where p.code in ('BffApplicationManagement','BffMemberManagement','BffUpstreamManagement','BffInterfaceManagement','BffSystemConfiguration')
group by p.code,t.code,t.name order by p.code,t.code
'@ | ConvertTo-Json -Depth 5
  exit
}
if ($Action -in @('EnableObservabilityNavigation','DisableObservabilityNavigation')) {
  if ([string]::IsNullOrWhiteSpace($Login)) { throw 'Provide the existing BFF administrator email.' }
  foreach ($taskUiPath in @('src/views/calls/index.vue','src/views/alerts/rules/index.vue','src/views/alerts/index.vue')) {
    if (!(Test-Path -LiteralPath $taskUiPath)) { throw "Install and verify the observability UI: $taskUiPath" }
  }
  $taskNavigationValue = if ($Action -eq 'DisableObservabilityNavigation') { 'false' } else { 'true' }
  $taskHealth = Invoke-RestMethod -Uri ($AppOrigin.TrimEnd('/') + '/api/health')
  if ($taskHealth.status -ne 'ok' -or ($taskNavigationValue -eq 'true' -and
    ('calls' -notin $taskHealth.capabilities -or 'alerts' -notin $taskHealth.capabilities))) {
    throw 'The running BFF host does not declare calls and alerts capabilities.'
  }
  $taskAccount = $Login.Trim().Replace("'", "''")
  $taskNavigationSql = @"
begin;
do `$`$
declare actor public.bff_members; changed integer; observability uuid;
begin
  if (select count(*) from public.bff_members where lower(email)=lower('$taskAccount') and enabled and role='admin'
    and issuer='https://ckbftoopuyophiebamwy.supabase.co/auth/v1')<>1
  then raise exception 'Exactly one active existing BFF administrator is required'; end if;
  select * into actor from public.bff_members where lower(email)=lower('$taskAccount') and enabled and role='admin'
    and issuer='https://ckbftoopuyophiebamwy.supabase.co/auth/v1';
  perform public.bff_control_lock(actor.id,'System:Menu:Edit','menus');
  if (with expected(name,parent_name,path,component,type) as (values
      ('BffObservability',null::text,'/observability','/index/index','folder'),
      ('BffCalls','BffObservability','/calls','/bff/calls/index','menu'),
      ('BffAlerts','BffObservability','/alerts','/index/index','folder'),
      ('BffAlertRules','BffAlerts','/alerts/rules','/bff/alerts/rules/index','menu'),
      ('BffAlertInstances','BffAlerts','/alerts/instances','/bff/alerts/index','menu'))
    select count(*) from expected e join public.bff_menus m on m.tenant_id=actor.tenant_id and
      m.name=e.name and m.path=e.path and m.component=e.component and m.type=e.type and m.builtin
    left join public.bff_menus p on p.id=m.parent_id and p.tenant_id=actor.tenant_id
    where (e.parent_name is null and m.parent_id is null) or p.name=e.parent_name)<>5
  then raise exception 'Reviewed observability navigation entries are missing'; end if;
  if (with expected(page_name,permission) as (values
      ('BffCalls','BffCall:View'),
      ('BffAlertRules','BffAlertRule:View'),
      ('BffAlertRules','BffAlert:Add'),('BffAlertRules','BffAlert:Edit'),
      ('BffAlertRules','BffAlert:ChangeStatus'),('BffAlertRules','BffAlert:Archive'),
      ('BffAlertRules','BffAlert:Evaluate'),
      ('BffAlertInstances','BffAlert:View'),('BffAlertInstances','BffAlert:Acknowledge'))
    select count(*) from expected e join public.bff_menus p on p.tenant_id=actor.tenant_id and p.name=e.page_name
    join public.bff_menus b on b.parent_id=p.id and b.tenant_id=actor.tenant_id and b.name=e.permission
      and b.type='button' and b.builtin)<>9
  then raise exception 'Reviewed observability permission entries are missing'; end if;
  select id into observability from public.bff_menus where tenant_id=actor.tenant_id and name='BffObservability';
  -- This feature owns its root. Shared BffServiceManagement and its pages are never toggled here.
  update public.bff_menus set meta=jsonb_set(meta,'{isEnable}','$taskNavigationValue'::jsonb),
    version=version+1,update_by=actor.id,update_time=now()
    where tenant_id=actor.tenant_id and builtin and
      (name in ('BffObservability','BffCalls','BffAlerts','BffAlertRules','BffAlertInstances') or
        (type='button' and name in ('BffCall:View','BffAlertRule:View','BffAlert:Add',
          'BffAlert:Edit','BffAlert:ChangeStatus','BffAlert:Archive','BffAlert:Evaluate',
          'BffAlert:View','BffAlert:Acknowledge')))
      and meta->'isEnable' is distinct from '$taskNavigationValue'::jsonb;
  get diagnostics changed=row_count;
  if changed>0 then perform public.bff_control_advance(actor.id,'menus','menu.capability.enable',observability,
    jsonb_build_object('capability','observability','enabled','$taskNavigationValue'::boolean,'changed',changed)); end if;
end `$`$;
commit;
"@
  $null = Invoke-BffQuery $taskNavigationSql
  Write-Output "Reviewed observability navigation set to $taskNavigationValue for the existing administrator tenant."
  exit
}
if ($Action -in @('EnableUpstreamNavigation','EnableInterfaceNavigation','EnableReleaseNavigation','DisableReleaseNavigation','EnableBrandingNavigation','DisableBrandingNavigation','EnableResourceNavigation','DisableResourceNavigation')) {
  if ([string]::IsNullOrWhiteSpace($Login)) { throw 'Provide the existing BFF administrator email.' }
  $taskCapability = switch ($Action) { { $_ -in @('EnableReleaseNavigation','DisableReleaseNavigation') } { 'releases' }; { $_ -in @('EnableBrandingNavigation','DisableBrandingNavigation') } { 'branding' }; { $_ -in @('EnableResourceNavigation','DisableResourceNavigation') } { 'resources' }; 'EnableInterfaceNavigation' { 'interfaces' }; default { 'upstreams' } }
  $taskNavigationValue = if ($Action.StartsWith('Disable')) { 'false' } else { 'true' }
  $taskPageName = switch ($taskCapability) { 'branding' { 'BffBranding' }; 'resources' { 'BffResources' }; 'releases' { 'BffReleases' }; 'interfaces' { 'BffInterfaces' }; default { 'BffUpstreams' } }
  $taskPermissionPrefix = switch ($taskCapability) { 'branding' { 'System:WebsiteConfig' }; 'resources' { 'BffResource' }; 'releases' { 'BffRelease' }; 'interfaces' { 'BffInterface' }; default { 'BffUpstream' } }
  $taskActions = switch ($taskCapability) { 'branding' { @('View','Publish','GenerateWordmark') }; 'resources' { @('View','Add','Edit','Delete') }; 'releases' { @('View','Publish','Rollback','ChangeStatus') }; 'interfaces' { @('View','Add','Edit','Validate','Test','TestWrite','Delete') }; default { @('View','Add','Edit','ChangeStatus','Test','RotateSecret','Delete') } }
  $taskParentName = switch ($taskCapability) { 'branding' { 'BffSystem' }; 'resources' { 'BffDataCenter' }; default { 'BffServiceManagement' } }
  $taskParentPath = switch ($taskCapability) { 'branding' { '/system' }; 'resources' { '/data-center' }; default { '/services' } }
  $taskPagePath = switch ($taskCapability) { 'branding' { '/system/website-config' }; 'resources' { '/data-center/attachment' }; default { "/$taskCapability" } }
  $taskComponent = switch ($taskCapability) { 'branding' { '/shared/system/website-config' }; 'resources' { '/shared/data-center/attachment' }; default { "/bff/$taskCapability/index" } }
  $taskPermissionSql = ($taskActions | ForEach-Object { "'$($taskPermissionPrefix):$_'" }) -join ','
  $taskUiPath = switch ($taskCapability) { 'branding' { 'node_modules/art-supabase-pro/src/views/system/website-config/index.vue' }; 'resources' { 'node_modules/art-supabase-pro/src/views/data-center/attachment/index.vue' }; default { "src/views/$taskCapability/index.vue" } }
  if (!(Test-Path -LiteralPath $taskUiPath)) { throw 'Install and verify the capability UI before enabling navigation.' }
  $taskHealth = Invoke-RestMethod -Uri ($AppOrigin.TrimEnd('/') + '/api/health')
  if ($taskHealth.status -ne 'ok' -or ($taskNavigationValue -eq 'true' -and $taskCapability -notin $taskHealth.capabilities)) { throw 'The running BFF host does not declare this capability.' }
  $taskAccount = $Login.Trim().Replace("'", "''")
  $taskGatewayPermissions = if ($taskCapability -eq 'releases') { @"
  if (select count(*) from public.bff_menus m join public.bff_menus p on p.id=m.parent_id
    where m.tenant_id=actor.tenant_id and m.builtin and m.type='button' and p.name='BffInterfaces'
    and m.name in ('BffInterface:Invoke','BffInterface:InvokeWrite'))<>2
  then raise exception 'Reviewed gateway permission entries are missing'; end if;
  update public.bff_menus set meta=jsonb_set(meta,'{isEnable}','$taskNavigationValue'::jsonb),version=version+1,
    update_by=actor.id,update_time=now() where tenant_id=actor.tenant_id and builtin and type='button'
    and name in ('BffInterface:Invoke','BffInterface:InvokeWrite') and meta->'isEnable' is distinct from '$taskNavigationValue'::jsonb;
  get diagnostics gateway_changed=row_count;
"@ } else { '' }
  $taskEnableSql = @"
begin;
do `$`$
declare actor public.bff_members; changed integer; gateway_changed integer:=0; page uuid;
begin
  if (select count(*) from public.bff_members where lower(email)=lower('$taskAccount') and enabled and role='admin'
    and issuer='https://ckbftoopuyophiebamwy.supabase.co/auth/v1')<>1
  then raise exception 'Exactly one active existing BFF administrator is required'; end if;
  select * into actor from public.bff_members where lower(email)=lower('$taskAccount') and enabled and role='admin'
    and issuer='https://ckbftoopuyophiebamwy.supabase.co/auth/v1';
  perform public.bff_control_lock(actor.id,'System:Menu:Edit','menus');
  if (select count(*) from public.bff_menus where tenant_id=actor.tenant_id and builtin and
    ((name='$taskParentName' and path='$taskParentPath' and type='folder') or
     (name='$taskPageName' and path='$taskPagePath' and component='$taskComponent' and type='menu')))<>2
  then raise exception 'Reviewed navigation entries are missing'; end if;
  select id into page from public.bff_menus where tenant_id=actor.tenant_id and name='$taskPageName';
  if (select count(*) from public.bff_menus where tenant_id=actor.tenant_id and parent_id=page and builtin and type='button'
    and name in ($taskPermissionSql))<>$($taskActions.Count)
  then raise exception 'Reviewed permission entries are missing'; end if;
  update public.bff_menus set meta=jsonb_set(meta,'{isEnable}','$taskNavigationValue'::jsonb),version=version+1,
    update_by=actor.id,update_time=now() where tenant_id=actor.tenant_id and builtin
    and (name='$taskPageName' or (name='$taskParentName' and '$taskNavigationValue'='true') or (parent_id=page and type='button' and
      name in ($taskPermissionSql)))
    and meta->'isEnable' is distinct from '$taskNavigationValue'::jsonb;
  get diagnostics changed=row_count;
  $taskGatewayPermissions
  changed:=changed+gateway_changed;
  if changed>0 then perform public.bff_control_advance(actor.id,'menus','menu.capability.enable',page,
    jsonb_build_object('capability','$taskCapability','enabled','$taskNavigationValue'::boolean,'changed',changed)); end if;
end `$`$;
commit;
"@
  $null = Invoke-BffQuery $taskEnableSql
  Write-Output "Reviewed navigation state set to $taskNavigationValue for the existing administrator tenant."
  exit
}
if ($Action -eq 'CleanupUpstreamFixtures') {
  $taskManifestPath = Join-Path (Get-Location) '.artifacts/upstream-http-fixtures.json'
  if (!(Test-Path -LiteralPath $taskManifestPath)) { Write-Output 'No upstream fixture manifest to clean.'; exit }
  $taskManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $taskManifestPath | ConvertFrom-Json
  $taskTenantIds = @($taskManifest.tenantIds)
  $taskMemberIds = @($taskManifest.memberIds)
  if ($taskTenantIds.Count -ne 2 -or $taskMemberIds.Count -lt 2 -or $taskMemberIds.Count -gt 10 -or
    @($taskTenantIds | Select-Object -Unique).Count -ne 2 -or
    @($taskMemberIds | Select-Object -Unique).Count -ne $taskMemberIds.Count) { throw 'Invalid isolated fixture manifest.' }
  foreach ($taskId in @($taskTenantIds + $taskMemberIds)) {
    if ([string]$taskId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'Fixture identifiers must be UUIDs.' }
  }
  $taskTenantSql = 'array[' + (($taskTenantIds | ForEach-Object { "'$([guid]$_)'::uuid" }) -join ',') + ']'
  $taskMemberSql = 'array[' + (($taskMemberIds | ForEach-Object { "'$([guid]$_)'::uuid" }) -join ',') + ']'
  $taskNonceInstalled = @(Invoke-BffQuery "select to_regclass('public.bff_pro_bridge_nonces') is not null as present")
  if ($taskNonceInstalled.Count -ne 1) { throw 'Cannot verify bridge nonce table before fixture cleanup.' }
  $taskBridgeNonceCleanup = if ($taskNonceInstalled[0].present) {
    "delete from public.bff_pro_bridge_nonces where tenant_id=any($taskTenantSql);"
  } else { '' }
  $taskCleanupSql = @"
begin;
set constraints all deferred;
do `$`$
declare tenants uuid[]:=$taskTenantSql; members uuid[]:=$taskMemberSql; tenant uuid;
begin
  foreach tenant in array tenants loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bff-control:'||tenant::text,0));
  end loop;
  if exists(select 1 from public.bff_members m where m.tenant_id=any(tenants) and
    (not(m.id=any(members)) or
      not(m.subject='bff-upstream-fixture:'||m.id::text or
        (m.issuer='https://ckbftoopuyophiebamwy.supabase.co/auth/v1' and
         m.subject=m.id::text and m.display_name like 'bff-pro-bridge-fixture:%')) or
      m.email not like '%@example.test')) or
    exists(select 1 from public.bff_members m where m.id=any(members) and not(m.tenant_id=any(tenants))) or
    exists(select 1 from public.bff_applications a where a.tenant_id=any(tenants) and not(a.created_by=any(members)))
  then raise exception 'Refusing cleanup: namespace contains non-fixture records'; end if;
end `$`$;
-- Owner maintenance only: the transaction lock prevents concurrent snapshot writes.
-- The runtime role retains no ability to bypass the immutable revision trigger.
lock table public.bff_upstream_service_revisions in share row exclusive mode;
alter table public.bff_upstream_service_revisions disable trigger bff_upstream_revision_guard;
lock table public.bff_interface_versions,public.bff_interface_version_upstreams,public.bff_interface_release_events in share row exclusive mode;
alter table public.bff_interface_versions disable trigger bff_interface_versions_immutable;
alter table public.bff_interface_version_upstreams disable trigger bff_interface_version_upstreams_immutable;
alter table public.bff_interface_release_events disable trigger bff_interface_release_events_immutable;
$taskBridgeNonceCleanup
delete from public.bff_sessions where member_id=any($taskMemberSql);
delete from public.bff_platform_settings where tenant_id=any($taskTenantSql);
delete from public.bff_audit_events where tenant_id=any($taskTenantSql);
delete from public.bff_alert_instances where tenant_id=any($taskTenantSql);
delete from public.bff_alert_rules where tenant_id=any($taskTenantSql);
delete from public.bff_interface_calls where tenant_id=any($taskTenantSql);
delete from public.bff_interface_release_events where tenant_id=any($taskTenantSql);
delete from public.bff_interface_deployments where tenant_id=any($taskTenantSql);
delete from public.bff_interface_version_upstreams where tenant_id=any($taskTenantSql);
delete from public.bff_interface_versions where tenant_id=any($taskTenantSql);
delete from public.bff_interface_upstreams where tenant_id=any($taskTenantSql);
delete from public.bff_interfaces where tenant_id=any($taskTenantSql);
delete from public.bff_upstream_credentials where tenant_id=any($taskTenantSql);
delete from public.bff_upstream_service_revisions where tenant_id=any($taskTenantSql);
delete from public.bff_upstream_services where tenant_id=any($taskTenantSql);
delete from public.bff_role_menus where tenant_id=any($taskTenantSql);
delete from public.bff_member_roles where tenant_id=any($taskTenantSql);
delete from public.bff_roles where tenant_id=any($taskTenantSql);
delete from public.bff_menus where tenant_id=any($taskTenantSql);
delete from public.bff_dictionary_items where tenant_id=any($taskTenantSql);
delete from public.bff_dictionary_types where tenant_id=any($taskTenantSql);
delete from public.bff_application_members where tenant_id=any($taskTenantSql);
delete from public.bff_applications where tenant_id=any($taskTenantSql);
delete from public.bff_resource_revisions where tenant_id=any($taskTenantSql);
update public.bff_members set updated_by=null where tenant_id=any($taskTenantSql);
delete from public.bff_members where tenant_id=any($taskTenantSql);
set constraints all immediate;
alter table public.bff_interface_versions enable trigger bff_interface_versions_immutable;
alter table public.bff_interface_version_upstreams enable trigger bff_interface_version_upstreams_immutable;
alter table public.bff_interface_release_events enable trigger bff_interface_release_events_immutable;
alter table public.bff_upstream_service_revisions enable trigger bff_upstream_revision_guard;
do `$`$ begin
  if exists(select 1 from public.bff_members where tenant_id=any($taskTenantSql)) or
    exists(select 1 from pg_trigger where (tgrelid,tgname) in (
      ('public.bff_upstream_service_revisions'::regclass,'bff_upstream_revision_guard'),
      ('public.bff_interface_versions'::regclass,'bff_interface_versions_immutable'),
      ('public.bff_interface_version_upstreams'::regclass,'bff_interface_version_upstreams_immutable'),
      ('public.bff_interface_release_events'::regclass,'bff_interface_release_events_immutable')) and tgenabled<>'O')
  then raise exception 'Fixture cleanup verification failed'; end if;
end `$`$;
commit;
"@
  $null = Invoke-BffQuery $taskCleanupSql
  Remove-Item -LiteralPath $taskManifestPath
  Write-Output 'Isolated upstream fixtures removed; immutable snapshot guard verified enabled.'
  exit
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
  foreach ($taskVerificationPath in @('tests/integration/business-dictionaries.sql','tests/integration/control-plane-schema.sql','tests/integration/role-access.sql','tests/integration/application-authorization.sql','tests/integration/upstream-schema.sql','tests/integration/interface-schema.sql','tests/integration/release-schema.sql','tests/integration/branding-schema.sql','tests/integration/calls-alerts-schema.sql','tests/integration/resources-schema.sql','tests/integration/member-provision.sql','tests/integration/pro-bridge-schema.sql')) {
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
  if ($Action -eq 'InspectBff') {
    $taskReleaseContract = Invoke-BffQuery @'
select to_regclass('public.bff_interface_versions') is not null as releases_installed,
  coalesce(position('when p_operation=''rollback'' then enabled else true end' in pg_get_functiondef(to_regprocedure(
    'public.bff_write_release(uuid,text,uuid,integer,integer,uuid,text,jsonb)')))>0,false) as rollback_preserves_status,
  to_regclass('public.bff_interface_calls_tenant_time_idx') is not null as gateway_tenant_quota_index
'@
    @{ project=$bffRef; tables=$taskBaseline; releaseContract=$taskReleaseContract } | ConvertTo-Json -Depth 5
    exit
  }
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

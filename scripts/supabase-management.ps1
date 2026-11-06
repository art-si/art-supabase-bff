param(
  [ValidateSet('Inspect','InspectAuthorization','InspectConsent','InspectBff','InspectMembers','VerifyBff','ApplyBffSchema','EnableOAuth','RegisterOAuth','PrepareEnvironment','ProvisionMember')][string]$Action = 'Inspect',
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
  Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$bffRef/database/query" -Headers $taskHeaders -ContentType 'application/json' -Body (@{query=$Query} | ConvertTo-Json -Compress)
}
if ($Action -eq 'InspectMembers') {
  Invoke-BffQuery "select m.email,m.display_name,m.role,m.enabled,count(am.application_id)::integer as application_grants from public.bff_members m left join public.bff_application_members am on am.member_id=m.id group by m.id order by m.created_at,m.email" | ConvertTo-Json -Depth 5
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

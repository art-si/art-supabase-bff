[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = Join-Path $taskRoot '.artifacts'

function Assert-LocalArtifact([string] $target) {
  $resolved = (Resolve-Path -LiteralPath $target).Path
  if (-not $resolved.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Target is outside this workspace: $resolved"
  }
  if ((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Linked paths cannot be cleaned: $resolved"
  }
  return $resolved
}

if (Test-Path -LiteralPath $artifactRoot) {
  $artifactRoot = Assert-LocalArtifact $artifactRoot
  $backupRoot = Join-Path $artifactRoot 'backups'
  if ($PSCmdlet.ShouldProcess($backupRoot, 'Preserve configuration recovery backups')) {
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    foreach ($backup in @(
      @{ Source = 'pro-auth/oauth-config-before.json'; Name = 'pro-auth-config-before.json' },
      @{ Source = 'database/bff-before-bootstrap.json'; Name = 'bff-before-bootstrap.json' }
    )) {
      $source = Join-Path $artifactRoot $backup.Source
      if (Test-Path -LiteralPath $source) {
        Move-Item -LiteralPath (Assert-LocalArtifact $source) -Destination (Join-Path $backupRoot $backup.Name) -Force
      }
    }
  }
  $temporaryNames = @(
    'database', 'pro-auth', 'pro-auth-publish', 'pro-auth-release', 'theme-build', 'ui-quality',
    'github-release.mjs', 'prepare-pro-release.mjs', 'smoke-auth.ts', 'theme-build.log',
    'verify-pro-live.mjs', 'verify-startup.mjs', 'work-state.json', 'dev-metadata-check.txt'
  )
  foreach ($name in $temporaryNames) {
    $target = Join-Path $artifactRoot $name
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $target = Assert-LocalArtifact $target
    if ((Get-Item -LiteralPath $target).PSIsContainer) {
      $link = Get-ChildItem -LiteralPath $target -Recurse -Force -Attributes ReparsePoint | Select-Object -First 1
      if ($link) { throw "Temporary directory contains a link: $($link.FullName)" }
    }
    if ($PSCmdlet.ShouldProcess($target, 'Remove temporary verification or release artifact')) {
      Remove-Item -LiteralPath $target -Recurse -Force
    }
  }
}

foreach ($log in Get-ChildItem -LiteralPath $taskRoot -Force -File -Filter '.artifacts-*.log') {
  $target = Assert-LocalArtifact $log.FullName
  if ($PSCmdlet.ShouldProcess($target, 'Remove temporary verification log')) {
    Remove-Item -LiteralPath $target -Force
  }
}

# Older browser builds used dist; current production assets are tracked under docs.
$legacyBuild = Join-Path $taskRoot 'dist'
if (Test-Path -LiteralPath $legacyBuild) {
  $legacyBuild = Assert-LocalArtifact $legacyBuild
  $link = Get-ChildItem -LiteralPath $legacyBuild -Recurse -Force -Attributes ReparsePoint | Select-Object -First 1
  if ($link) { throw "Legacy build contains a link: $($link.FullName)" }
  if ($PSCmdlet.ShouldProcess($legacyBuild, 'Remove legacy browser build')) {
    Remove-Item -LiteralPath $legacyBuild -Recurse -Force
  }
}

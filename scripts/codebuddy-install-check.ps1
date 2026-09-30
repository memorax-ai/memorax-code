param(
  [Parameter(Mandatory = $true)][string]$TarballDirectory,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$CodeBuddyVersion,
  [ValidatePattern('^\d+\.\d+\.\d+$')][string]$PreviousVersion = '0.1.18'
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This wrapper requires Windows.' }
$repoRoot = Split-Path $PSScriptRoot -Parent
$npmCommand = (Get-Command npm.cmd).Source
$tarballs = @(Get-ChildItem -LiteralPath $TarballDirectory -File -Filter 'memorax-memorax-code-*.tgz')
if ($tarballs.Count -ne 1) { throw 'Expected exactly one MemoraX Code tarball.' }
$tarball = $tarballs[0].FullName
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('memorax-codebuddy-install-' + [guid]::NewGuid())
$prefix = Join-Path $testRoot 'npm'
$userRoot = Join-Path $testRoot 'user'
$tempRoot = Join-Path $testRoot 'tmp'
New-Item -ItemType Directory -Force $userRoot, $tempRoot, $prefix | Out-Null
[IO.File]::WriteAllText((Join-Path $prefix '.memorax-code-ci-owned'), "codebuddy-install-check`n")

. (Join-Path $PSScriptRoot 'codex-install-user-path.ps1')
Invoke-WithCodexTestUserPath -Prefix $prefix -Action {
  $allowedEnvironment = @('PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PSModulePath',
    'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE')
  foreach ($item in @(Get-ChildItem Env:)) {
    if ($item.Name -notin $allowedEnvironment) {
      [Environment]::SetEnvironmentVariable($item.Name, $null, 'Process')
    }
  }
  $env:HOME = $userRoot
  $env:USERPROFILE = $userRoot
  $env:APPDATA = Join-Path $userRoot 'AppData/Roaming'
  $env:LOCALAPPDATA = Join-Path $userRoot 'AppData/Local'
  $env:MEMORAX_CODE_HOME = Join-Path $testRoot 'state'
  $env:CODEBUDDY_CONFIG_DIR = Join-Path $testRoot 'codebuddy'
  $env:MEMORAX_CODE_AUTO_UPDATE = 'false'
  $env:MEMORAX_CODE_INSTALL_WATCHDOG = '0'
  $env:DISABLE_AUTOUPDATER = '1'
  $env:DISABLE_TELEMETRY = '1'
  $env:DISABLE_ERROR_REPORTING = '1'
  $env:CODEBUDDY_SKIP_BUILTIN_MARKETPLACE = '1'
  $env:CODEBUDDY_DISABLE_AUTO_MEMORY = '1'
  $env:npm_config_cache = Join-Path $testRoot 'npm-cache'
  $env:npm_config_userconfig = Join-Path $testRoot 'npm-user.config'
  $env:npm_config_globalconfig = Join-Path $testRoot 'npm-global.config'
  $env:TMP = $tempRoot
  $env:TEMP = $tempRoot

  Push-Location $userRoot
  try {
    & npm.cmd install --global --prefix $prefix --no-audit --no-fund `
      --registry=https://registry.npmjs.org/ "@tencent-ai/codebuddy-code@$CodeBuddyVersion" $tarball `
      *> (Join-Path $testRoot 'npm-install.log')
    if ($LASTEXITCODE -ne 0) { throw 'npm installation failed; isolated state retained.' }
    if ((Test-Path -LiteralPath (Join-Path $testRoot 'state/config.toml')) -or
      (Test-Path -LiteralPath (Join-Path $testRoot 'state/runtime/backend/backend.pid.json'))) {
      throw 'Fresh package installation unexpectedly configured or started MemoraX Code.'
    }
    & npm.cmd install --prefix (Join-Path $testRoot 'terminal') --no-audit --no-fund `
      --registry=https://registry.npmjs.org/ node-pty@1.1.0 *> (Join-Path $testRoot 'npm-terminal-install.log')
    if ($LASTEXITCODE -ne 0) { throw 'The test-only terminal dependency installation failed; isolated state retained.' }
    & (Join-Path $prefix 'memorax-code.cmd') --help *> (Join-Path $testRoot 'product-help.log')
    if ($LASTEXITCODE -ne 0) { throw 'The installed MemoraX Code command shim failed.' }
    & (Join-Path $prefix 'memorax-cli.cmd') --help *> (Join-Path $testRoot 'memory-help.log')
    if ($LASTEXITCODE -ne 0) { throw 'The installed MemoraX memory command shim failed.' }
    $versionOutput = (& (Join-Path $prefix 'codebuddy.cmd') --version 2> (Join-Path $testRoot 'codebuddy-version.log') | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionOutput -cne $CodeBuddyVersion) {
      throw 'Installed CodeBuddy Code version does not match the requested version.'
    }
    Write-Output "CodeBuddy Code requested: $CodeBuddyVersion; installed: $CodeBuddyVersion"
    & node (Join-Path $repoRoot 'scripts/codebuddy-lifecycle-check.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'codebuddy.cmd') `
      $tarball $npmCommand $PreviousVersion (Join-Path $testRoot 'terminal/node_modules/node-pty') `
      (Join-Path $repoRoot 'scripts/codebuddy-setup-pty.mjs') $CodeBuddyVersion
    if ($LASTEXITCODE -ne 0) { throw 'The CodeBuddy lifecycle suite failed; isolated state retained.' }
    & node (Join-Path $repoRoot 'scripts/codebuddy-install-interruption-check.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'codebuddy.cmd') `
      (Join-Path $testRoot 'terminal/node_modules/node-pty') $CodeBuddyVersion
    if ($LASTEXITCODE -ne 0) { throw 'The CodeBuddy setup interruption suite failed; isolated state retained.' }
    & node (Join-Path $repoRoot 'scripts/codebuddy-native-check.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'codebuddy.cmd') $CodeBuddyVersion
    if ($LASTEXITCODE -ne 0) { throw 'The CodeBuddy native suite failed; isolated state retained.' }
    & node (Join-Path $repoRoot 'scripts/codebuddy-permissions-check.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'codebuddy.cmd') $CodeBuddyVersion
    if ($LASTEXITCODE -ne 0) { throw 'The CodeBuddy permission suite failed; isolated state retained.' }
    & node (Join-Path $repoRoot 'scripts/codebuddy-background-check.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'codebuddy.cmd') $CodeBuddyVersion
    if ($LASTEXITCODE -ne 0) { throw 'The CodeBuddy background suite failed; isolated state retained.' }
  } catch {
    $originalFailure = $_
    try {
      & node (Join-Path $repoRoot 'scripts/codebuddy-install-cleanup.mjs') `
        (Join-Path $testRoot 'state') (Join-Path $prefix 'memorax-code.cmd') (Join-Path $PSHOME 'pwsh.exe')
      if ($LASTEXITCODE -ne 0) { Write-Warning 'Wrapper Backend cleanup failed; original failure and isolated state retained.' }
    } catch {
      Write-Warning 'Wrapper Backend cleanup failed; original failure and isolated state retained.'
    }
    throw $originalFailure
  } finally {
    Pop-Location
  }

  # Each suite confirms owned-process cleanup before removing this runtime.
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}

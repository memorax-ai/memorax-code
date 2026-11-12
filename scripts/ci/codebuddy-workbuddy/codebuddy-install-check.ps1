param(
  [Parameter(Mandatory = $true)][string]$TarballDirectory,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$CodeBuddyVersion,
  [ValidatePattern('^\d+\.\d+\.\d+$')][string]$PreviousVersion = '0.1.18',
  [ValidateSet('codebuddy', 'workbuddy')][string]$Client = 'codebuddy',
  [string]$WorkBuddyCommand
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This wrapper requires Windows.' }
$Client = $Client.ToLowerInvariant()
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
if ($Client -eq 'workbuddy') {
  if (-not $WorkBuddyCommand) { throw 'WorkBuddy requires its actual bundled command.' }
  $WorkBuddyCommand = (Resolve-Path -LiteralPath $WorkBuddyCommand).Path
  & node (Join-Path $PSScriptRoot 'workbuddy-bundled-command-check.mjs') $WorkBuddyCommand
  if ($LASTEXITCODE -ne 0) { throw 'Expected the actual WorkBuddy desktop bundled runtime.' }
} elseif ($WorkBuddyCommand) {
  throw 'Only WorkBuddy mode accepts a bundled command.'
}
$npmCommand = (Get-Command npm.cmd).Source
$tarballs = @(Get-ChildItem -LiteralPath $TarballDirectory -File -Filter 'memorax-memorax-code-*.tgz')
if ($tarballs.Count -ne 1) { throw 'Expected exactly one MemoraX Code tarball.' }
$tarball = $tarballs[0].FullName
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("memorax-$Client-install-" + [guid]::NewGuid())
$prefix = Join-Path $testRoot 'npm'
$userRoot = Join-Path $testRoot 'user'
$tempRoot = Join-Path $testRoot 'tmp'
New-Item -ItemType Directory -Force $userRoot, $tempRoot, $prefix | Out-Null
[IO.File]::WriteAllText((Join-Path $prefix '.memorax-code-ci-owned'), "$Client-install-check`n")

# Evidence stays outside the isolated runtime and never changes the native result.
. (Join-Path $PSScriptRoot '../shared/ci-evidence.ps1')
Initialize-CiEvidence -Tool (Join-Path $repoRoot 'scripts/ci/shared/ci-evidence.mjs') -RuntimeRoot $testRoot

. (Join-Path $PSScriptRoot '../shared/codex-install-user-path.ps1')
$plannedSuites = "codebuddy-lifecycle-check,codebuddy-install-interruption-check,$Client-native-check,codebuddy-background-check,codebuddy-permissions-check"
Write-CiLedger plan $plannedSuites
Write-CiLedger phase setup
try {
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
  $env:CODEBUDDY_CONFIG_DIR = Join-Path $testRoot $Client
  if ($Client -eq 'workbuddy') {
    $env:WORKBUDDY_HOME = $env:CODEBUDDY_CONFIG_DIR
    $env:WORKBUDDY_CONFIG_DIR = $env:CODEBUDDY_CONFIG_DIR
    $env:CODEBUDDY_HOME = Join-Path $userRoot '.codebuddy'
  }
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
    $packages = @($tarball)
    $nativeCommand = $WorkBuddyCommand
    if ($Client -eq 'codebuddy') {
      $packages = @("@tencent-ai/codebuddy-code@$CodeBuddyVersion", $tarball)
      $nativeCommand = Join-Path $prefix 'codebuddy.cmd'
    }
    & npm.cmd install --global --prefix $prefix --no-audit --no-fund `
      --registry=https://registry.npmjs.org/ @packages `
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
    if ($Client -eq 'codebuddy') {
      $versionOutput = (& $nativeCommand --version 2> (Join-Path $testRoot 'codebuddy-version.log') | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or $versionOutput -cne $CodeBuddyVersion) {
        throw 'Installed CodeBuddy Code version does not match the requested version.'
      }
      Write-Output "CodeBuddy Code requested: $CodeBuddyVersion; installed: $CodeBuddyVersion"
    }
    # Only test runners receive the evidence location after setup.
    if ($CiEvidenceDir) { $env:MEMORAX_CI_EVIDENCE_DIR = $CiEvidenceDir }
    Write-CiLedger phase suites
    Write-CiLedger start codebuddy-lifecycle-check
    & node (Join-Path $repoRoot 'scripts/ci/codebuddy-workbuddy/codebuddy-lifecycle-check.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') $nativeCommand `
      $tarball $npmCommand $PreviousVersion (Join-Path $testRoot 'terminal/node_modules/node-pty') `
      (Join-Path $repoRoot 'scripts/ci/codebuddy-workbuddy/codebuddy-setup-pty.mjs') $CodeBuddyVersion $Client
    $suiteExit = $LASTEXITCODE
    Write-CiLedger end codebuddy-lifecycle-check $suiteExit
    if ($suiteExit -ne 0) { throw 'The selected client lifecycle suite failed; isolated state retained.' }
    Write-CiLedger start codebuddy-install-interruption-check
    & node (Join-Path $repoRoot 'scripts/ci/codebuddy-workbuddy/codebuddy-install-interruption-check.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') $nativeCommand `
      (Join-Path $testRoot 'terminal/node_modules/node-pty') $CodeBuddyVersion $Client
    $suiteExit = $LASTEXITCODE
    Write-CiLedger end codebuddy-install-interruption-check $suiteExit
    if ($suiteExit -ne 0) { throw 'The selected client setup interruption suite failed; isolated state retained.' }
    Write-CiLedger start "$Client-native-check"
    & node (Join-Path $repoRoot "scripts/ci/codebuddy-workbuddy/$Client-native-check.mjs") `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') $nativeCommand $CodeBuddyVersion
    $suiteExit = $LASTEXITCODE
    Write-CiLedger end "$Client-native-check" $suiteExit
    if ($suiteExit -ne 0) { throw 'The selected client native suite failed; isolated state retained.' }
    Write-CiLedger start codebuddy-background-check
    & node (Join-Path $repoRoot 'scripts/ci/codebuddy-workbuddy/codebuddy-background-check.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') $nativeCommand $CodeBuddyVersion $Client
    $suiteExit = $LASTEXITCODE
    Write-CiLedger end codebuddy-background-check $suiteExit
    if ($suiteExit -ne 0) { throw 'The selected client background suite failed; isolated state retained.' }
    Write-CiLedger start codebuddy-permissions-check
    & node (Join-Path $repoRoot 'scripts/ci/codebuddy-workbuddy/codebuddy-permissions-check.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') $nativeCommand $CodeBuddyVersion $Client
    $suiteExit = $LASTEXITCODE
    Write-CiLedger end codebuddy-permissions-check $suiteExit
    if ($suiteExit -ne 0) { throw 'The selected client permission suite failed; isolated state retained.' }
  } catch {
    $originalFailure = $_
    # The wrapper cleanup drives product commands, which never receive the evidence location.
    [Environment]::SetEnvironmentVariable('MEMORAX_CI_EVIDENCE_DIR', $null, 'Process')
    try {
      & node (Join-Path $repoRoot 'scripts/ci/codebuddy-workbuddy/codebuddy-install-cleanup.mjs') `
        (Join-Path $testRoot 'state') (Join-Path $prefix 'memorax-code.cmd') (Join-Path $PSHOME 'pwsh.exe') $Client
      if ($LASTEXITCODE -ne 0) { Write-Warning 'Wrapper Backend cleanup failed; original failure and isolated state retained.' }
    } catch {
      Write-Warning 'Wrapper Backend cleanup failed; original failure and isolated state retained.'
    }
    throw $originalFailure
  } finally {
    Pop-Location
  }

  # Each suite confirms owned-process cleanup before removing this runtime.
  Write-CiLedger phase cleanup
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}
} finally {
  Write-CiLedger finalize $plannedSuites
}

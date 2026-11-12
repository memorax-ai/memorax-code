param(
  [Parameter(Mandatory = $true)][string]$TarballDirectory,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$CodexVersion,
  [ValidatePattern('^\d+\.\d+\.\d+$')][string]$PreviousVersion = '0.1.17'
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This wrapper requires Windows.' }
$npmCommand = (Get-Command npm.cmd).Source
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$tarballs = @(Get-ChildItem -LiteralPath $TarballDirectory -Filter 'memorax-memorax-code-*.tgz')
if ($tarballs.Count -ne 1) { throw 'Expected exactly one MemoraX Code tarball.' }
$tarball = $tarballs[0].FullName
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('memorax-codex-install-' + [guid]::NewGuid())
$prefix = Join-Path $testRoot 'npm'
$userRoot = Join-Path $testRoot 'user'
$tempRoot = Join-Path $testRoot 'tmp'
New-Item -ItemType Directory -Force $userRoot, $tempRoot, $prefix | Out-Null
New-Item -ItemType Directory -Force (Join-Path $testRoot 'codex') | Out-Null
[IO.File]::WriteAllText((Join-Path $prefix ".memorax-code-ci-owned"), "codex-install-check`n")

# Evidence lives outside the isolated runtime; an unusable location disables it without affecting the suites.
. (Join-Path $PSScriptRoot '../shared/ci-evidence.ps1')
Initialize-CiEvidence -Tool (Join-Path $repoRoot 'scripts/ci/shared/ci-evidence.mjs') -RuntimeRoot $testRoot

. (Join-Path $PSScriptRoot '../shared/codex-install-user-path.ps1')
$plannedSuites = 'codex-install-smoke,codex-native-check,codex-permissions-check,codex-install-interruption-check'
Write-CiLedger plan $plannedSuites
Write-CiLedger phase setup
Write-CiLedger skip codex-model-inheritance-check pending_implementation
try {
Invoke-WithCodexTestUserPath -Prefix $prefix -Action {
# This step owns its temporary account state; do not change machine settings.
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
$env:CODEX_HOME = Join-Path $testRoot 'codex'
$env:CLAUDE_CONFIG_DIR = Join-Path $testRoot 'claude'
$env:OPENCODE_CONFIG_DIR = Join-Path $testRoot 'opencode'
$env:MEMORAX_CODE_AUTO_UPDATE = 'false'
$env:MEMORAX_CODE_INSTALL_WATCHDOG = '0'
$env:npm_config_cache = Join-Path $testRoot 'npm-cache'
$env:TMP = $tempRoot
$env:TEMP = $tempRoot

& npm.cmd install --global --prefix $prefix --no-audit --no-fund "@openai/codex@$CodexVersion" $tarball
if ($LASTEXITCODE -ne 0) { throw 'npm installation failed.' }
& npm.cmd install --prefix (Join-Path $testRoot 'terminal') --no-audit --no-fund node-pty@1.1.0
if ($LASTEXITCODE -ne 0) { throw 'The test-only terminal dependency installation failed.' }
& (Join-Path $prefix 'memorax-code.cmd') --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The installed MemoraX Code command shim failed.' }
& (Join-Path $prefix 'codex.cmd') --version
if ($LASTEXITCODE -ne 0) { throw 'The installed Codex command shim failed.' }
# Only the test runners receive the evidence location; npm and product commands above do not.
if ($CiEvidenceDir) { $env:MEMORAX_CI_EVIDENCE_DIR = $CiEvidenceDir }
Write-CiLedger phase suites
Write-CiLedger start codex-install-smoke
& node (Join-Path $repoRoot 'scripts/ci/codex/codex-install-smoke.mjs') `
  (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'codex.cmd') `
  $tarball $npmCommand $PreviousVersion `
  (Join-Path $testRoot 'terminal/node_modules/node-pty') (Join-Path $repoRoot 'scripts/ci/codex/codex-setup-pty.mjs') $CodexVersion
$suiteExit = $LASTEXITCODE
Write-CiLedger end codex-install-smoke $suiteExit
if ($suiteExit -ne 0) { throw 'The Codex installation smoke failed; its runtime stays on this runner and is not exported.' }

Write-CiLedger start codex-native-check
& node (Join-Path $repoRoot 'scripts/ci/codex/codex-native-check.mjs') `
  (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'codex.cmd')
$suiteExit = $LASTEXITCODE
Write-CiLedger end codex-native-check $suiteExit
if ($suiteExit -ne 0) { throw 'The Codex native flow check failed; its runtime stays on this runner and is not exported.' }
Write-CiLedger start codex-permissions-check
& node (Join-Path $repoRoot 'scripts/ci/codex/codex-permissions-check.mjs') `
  (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'codex.cmd')
$suiteExit = $LASTEXITCODE
Write-CiLedger end codex-permissions-check $suiteExit
if ($suiteExit -ne 0) { throw 'The Codex permissions check failed; its runtime stays on this runner and is not exported.' }
Write-CiLedger start codex-install-interruption-check
& node (Join-Path $repoRoot 'scripts/ci/codex/codex-install-interruption-check.mjs') `
  (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'codex.cmd') `
  (Join-Path $testRoot 'terminal/node_modules/node-pty')
$suiteExit = $LASTEXITCODE
Write-CiLedger end codex-install-interruption-check $suiteExit
if ($suiteExit -ne 0) { throw 'The Codex interruption check failed; its runtime stays on this runner and is not exported.' }
Write-Output 'SKIP: foreground model/provider override inheritance is pending implementation (see CONTRIBUTING.md).'

# Remove the runtime only after the smoke has confirmed process shutdown.
Write-CiLedger phase cleanup
Remove-Item -LiteralPath $testRoot -Recurse -Force
}
} finally {
  Write-CiLedger finalize $plannedSuites
}

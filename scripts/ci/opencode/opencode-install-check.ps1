param(
  [Parameter(Mandatory = $true)][string]$TarballDirectory,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$OpenCodeVersion,
  [ValidatePattern('^\d+\.\d+\.\d+$')][string]$PreviousVersion = '0.1.18'
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This wrapper requires Windows.' }
$npmCommand = (Get-Command npm.cmd).Source
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$tarballs = @(Get-ChildItem -LiteralPath $TarballDirectory -Filter 'memorax-memorax-code-*.tgz')
if ($tarballs.Count -ne 1) { throw 'Expected exactly one MemoraX Code tarball.' }
$tarball = $tarballs[0].FullName
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('memorax-opencode-install-' + [guid]::NewGuid())
$prefix = Join-Path $testRoot 'npm'
$userRoot = Join-Path $testRoot 'user'
$tempRoot = Join-Path $testRoot 'tmp'
New-Item -ItemType Directory -Force $userRoot, $tempRoot, $prefix | Out-Null
[IO.File]::WriteAllText((Join-Path $prefix '.memorax-code-ci-owned'), "opencode-install-check`n")

# Both client suites share the existing, interruption-tested exact-prefix PATH guard.
. (Join-Path $PSScriptRoot '../shared/codex-install-user-path.ps1')
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
  $env:CODEX_HOME = Join-Path $testRoot 'codex'
  $env:CLAUDE_CONFIG_DIR = Join-Path $testRoot 'claude'
  $env:OPENCODE_CONFIG_DIR = Join-Path $testRoot 'opencode'
  $env:MEMORAX_CODE_AUTO_UPDATE = 'false'
  $env:MEMORAX_CODE_INSTALL_WATCHDOG = '0'
  $env:npm_config_cache = Join-Path $testRoot 'npm-cache'
  $env:MEMORAX_CODE_TEST_NPM_CACHE = $env:npm_config_cache
  $env:TMP = $tempRoot
  $env:TEMP = $tempRoot

  & npm.cmd install --global --prefix $prefix --no-audit --no-fund "opencode-ai@$OpenCodeVersion" $tarball
  if ($LASTEXITCODE -ne 0) { throw 'npm installation failed.' }
  & npm.cmd install --prefix (Join-Path $testRoot 'terminal') --no-audit --no-fund node-pty@1.1.0 @vscode/ripgrep@1.18.0
  if ($LASTEXITCODE -ne 0) { throw 'The test-only terminal dependency installation failed.' }
  $rgPath = & node -e 'process.stdout.write(require(process.argv[1]).rgPath)' (Join-Path $testRoot 'terminal/node_modules/@vscode/ripgrep')
  if ($LASTEXITCODE -ne 0) { throw 'The test-only ripgrep dependency is unavailable.' }
  $env:PATH = "$(Split-Path $rgPath -Parent);$env:PATH"
  & $rgPath --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'The test-only ripgrep executable failed.' }
  & (Join-Path $prefix 'memorax-code.cmd') --help | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'The installed MemoraX Code command shim failed.' }
  $actualVersion = (& (Join-Path $prefix 'opencode.cmd') --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $actualVersion -cne $OpenCodeVersion) {
    throw 'Installed OpenCode version does not match the requested version.'
  }
  Write-Output "OpenCode requested: $OpenCodeVersion; installed: $actualVersion"
  $packageRoot = Join-Path $prefix 'node_modules/@memorax/memorax-code'
  $openCode = Join-Path $prefix 'node_modules/opencode-ai/bin/opencode.exe'
  & node (Join-Path $repoRoot 'scripts/ci/opencode/opencode-install-smoke.mjs') `
    $packageRoot $openCode $tarball $npmCommand $PreviousVersion `
    (Join-Path $testRoot 'terminal/node_modules/node-pty') (Join-Path $repoRoot 'scripts/ci/opencode/opencode-setup-pty.mjs') $OpenCodeVersion
  if ($LASTEXITCODE -ne 0) { throw 'The OpenCode installation smoke failed; isolated state retained.' }
  foreach ($suite in @('opencode-native-check.mjs', 'opencode-permissions-check.mjs', 'opencode-server-check.mjs')) {
    & node (Join-Path $repoRoot "scripts/ci/opencode/$suite") $packageRoot $openCode
    if ($LASTEXITCODE -ne 0) { throw "The OpenCode $suite failed; isolated state retained." }
  }
  & node (Join-Path $repoRoot 'scripts/ci/opencode/opencode-install-interruption-check.mjs') `
    $packageRoot $openCode (Join-Path $testRoot 'terminal/node_modules/node-pty')
  if ($LASTEXITCODE -ne 0) { throw 'The OpenCode interruption check failed; isolated state retained.' }
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}

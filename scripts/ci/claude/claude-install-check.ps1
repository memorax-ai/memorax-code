param(
  [Parameter(Mandatory = $true)][string]$TarballDirectory,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$ClaudeVersion,
  [ValidatePattern('^\d+\.\d+\.\d+$')][string]$PreviousVersion = '0.1.18'
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This wrapper requires Windows.' }
$npmCommand = (Get-Command npm.cmd).Source
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$tarballs = @(Get-ChildItem -LiteralPath $TarballDirectory -File -Filter 'memorax-memorax-code-*.tgz')
if ($tarballs.Count -ne 1) { throw 'Expected exactly one MemoraX Code tarball.' }
$tarball = $tarballs[0].FullName
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('memorax-claude-install-' + [guid]::NewGuid())
$prefix = Join-Path $testRoot 'npm'
$userRoot = Join-Path $testRoot 'user'
$tempRoot = Join-Path $testRoot 'tmp'
New-Item -ItemType Directory -Force $userRoot, $tempRoot, $prefix | Out-Null
[IO.File]::WriteAllText((Join-Path $prefix '.memorax-code-ci-owned'), "claude-install-check`n")

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
  $env:CLAUDE_CONFIG_DIR = Join-Path $testRoot 'claude'
  $env:MEMORAX_CODE_AUTO_UPDATE = 'false'
  $env:MEMORAX_CODE_INSTALL_WATCHDOG = '0'
  $env:DISABLE_AUTOUPDATER = '1'
  $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  $env:npm_config_cache = Join-Path $testRoot 'npm-cache'
  $env:npm_config_userconfig = Join-Path $testRoot 'npm-user.config'
  $env:npm_config_globalconfig = Join-Path $testRoot 'npm-global.config'
  $env:TMP = $tempRoot
  $env:TEMP = $tempRoot

  Push-Location $userRoot
  try {
    & npm.cmd install --global --prefix $prefix --no-audit --no-fund `
      --registry=https://registry.npmjs.org/ "@anthropic-ai/claude-code@$ClaudeVersion" $tarball `
      *> (Join-Path $testRoot 'npm-install.log')
    if ($LASTEXITCODE -ne 0) { throw 'npm installation failed; isolated state retained.' }
    if ((Test-Path -LiteralPath (Join-Path $testRoot 'state/config.toml')) -or
      (Test-Path -LiteralPath (Join-Path $testRoot 'state/runtime/backend/backend.pid.json'))) {
      throw 'Fresh package installation unexpectedly configured or started MemoraX Code.'
    }
    & npm.cmd install --prefix (Join-Path $testRoot 'terminal') --no-audit --no-fund `
      --registry=https://registry.npmjs.org/ node-pty@1.1.0 `
      *> (Join-Path $testRoot 'npm-terminal-install.log')
    if ($LASTEXITCODE -ne 0) { throw 'The test-only terminal dependency installation failed; isolated state retained.' }
    & (Join-Path $prefix 'memorax-code.cmd') --help *> (Join-Path $testRoot 'product-help.log')
    if ($LASTEXITCODE -ne 0) { throw 'The installed MemoraX Code command shim failed.' }
    $versionOutput = (& (Join-Path $prefix 'claude.cmd') --version 2> (Join-Path $testRoot 'claude-version.log') | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionOutput -cne "$ClaudeVersion (Claude Code)") {
      throw 'Installed Claude Code version does not match the requested version.'
    }
    Write-Output "Claude Code requested: $ClaudeVersion; installed: $ClaudeVersion"
    & node (Join-Path $repoRoot 'scripts/ci/claude/claude-install-smoke.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'claude.cmd') `
      $tarball $npmCommand $PreviousVersion (Join-Path $testRoot 'terminal/node_modules/node-pty') `
      (Join-Path $repoRoot 'scripts/ci/claude/claude-setup-pty.mjs') $ClaudeVersion
    if ($LASTEXITCODE -ne 0) { throw 'The Claude installation smoke failed; isolated state retained.' }
    & node (Join-Path $repoRoot 'scripts/ci/claude/claude-install-interruption-check.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'claude.cmd') `
      (Join-Path $testRoot 'terminal/node_modules/node-pty') $ClaudeVersion
    if ($LASTEXITCODE -ne 0) { throw 'The Claude setup interruption check failed; isolated state retained.' }
    & node (Join-Path $repoRoot 'scripts/ci/claude/claude-native-check.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'claude.cmd') $ClaudeVersion
    if ($LASTEXITCODE -ne 0) { throw 'The Claude native flow check failed; isolated state retained.' }
    & node (Join-Path $repoRoot 'scripts/ci/claude/claude-permissions-check.mjs') `
      (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'claude.cmd') $ClaudeVersion
    if ($LASTEXITCODE -ne 0) { throw 'The Claude native permission check failed; isolated state retained.' }
  } finally {
    Pop-Location
  }

  # Each suite confirms owned process cleanup before removing this runtime.
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}

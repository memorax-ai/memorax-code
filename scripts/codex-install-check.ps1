param(
  [Parameter(Mandatory = $true)][string]$TarballDirectory,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$CodexVersion
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This wrapper requires Windows.' }
$repoRoot = Split-Path $PSScriptRoot -Parent
$tarballs = @(Get-ChildItem -LiteralPath $TarballDirectory -Filter 'memorax-memorax-code-*.tgz')
if ($tarballs.Count -ne 1) { throw 'Expected exactly one MemoraX Code tarball.' }
$tarball = $tarballs[0].FullName
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('memorax-codex-install-' + [guid]::NewGuid())
$prefix = Join-Path $testRoot 'npm'
$userRoot = Join-Path $testRoot 'user'
$tempRoot = Join-Path $testRoot 'tmp'
New-Item -ItemType Directory -Force $userRoot, $tempRoot | Out-Null

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
& (Join-Path $prefix 'memorax-code.cmd') --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The installed MemoraX Code command shim failed.' }
& (Join-Path $prefix 'codex.cmd') --version
if ($LASTEXITCODE -ne 0) { throw 'The installed Codex command shim failed.' }
& node (Join-Path $repoRoot 'scripts/codex-install-smoke.mjs') `
  (Join-Path $prefix 'node_modules/@memorax/memorax-code') (Join-Path $prefix 'codex.cmd')
if ($LASTEXITCODE -ne 0) { throw 'The Codex installation smoke failed; isolated state retained.' }

# Remove the runtime only after the smoke has confirmed process shutdown.
Remove-Item -LiteralPath $testRoot -Recurse -Force

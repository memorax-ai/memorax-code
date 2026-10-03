param([Parameter(Mandatory = $true)][string]$Destination)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$desktopVersion = '5.6.2.39298511'
$runtimeVersion = '2.147.0'
$sha256 = '627E5A565436D0876740AF69C2747759648662C52958D2A5DF1BA330A82C3025'
$url = 'https://download.codebuddy.cn/workbuddy/saas/win32-x64-user/WorkBuddy-win32-x64-user-5.6.2.39298511-37a65c0b.exe'
$command = 'WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy'
$owned = $false
$verified = $false
$failure = $null
$stage = 'WORKBUDDY_BUNDLE_WINDOWS_X64_REQUIRED'

try {
  if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw $stage }
  $stage = 'WORKBUDDY_BUNDLE_DESTINATION_INVALID'
  $directory = Get-Item -LiteralPath $Destination -Force
  if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw $stage }
  $Destination = $directory.FullName
  $stage = 'WORKBUDDY_BUNDLE_DESTINATION_NOT_EMPTY'
  if (@(Get-ChildItem -LiteralPath $Destination -Force).Count -ne 0) { throw $stage }
  $installer = Join-Path $Destination 'WorkBuddy.exe'
  $unpacked = Join-Path $Destination 'nsis'
  $bundle = Join-Path $Destination 'WorkBuddy'
  $owned = $true

  $stage = 'WORKBUDDY_BUNDLE_DOWNLOAD_FAILED'
  & curl.exe --disable --fail --silent --show-error --location `
    --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 600 `
    --retry 2 --retry-max-time 900 --output $installer $url *> $null
  if ($LASTEXITCODE -ne 0) { throw $stage }
  $stage = 'WORKBUDDY_BUNDLE_HASH_MISMATCH'
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $sha256) { throw $stage }
  $stage = 'WORKBUDDY_BUNDLE_SIGNATURE_INVALID'
  $signature = Get-AuthenticodeSignature -LiteralPath $installer
  if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
    $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) `
      -cne 'Tencent Technology (Shenzhen) Company Limited') { throw $stage }
  $stage = 'WORKBUDDY_BUNDLE_DESKTOP_VERSION_MISMATCH'
  # The immutable installer digest pins the full build; its PE product version is shorter.
  if ((Get-Item -LiteralPath $installer).VersionInfo.ProductVersion -cne '5.6.2') { throw $stage }

  $stage = 'WORKBUDDY_BUNDLE_EXTRACTION_FAILED'
  $sevenZip = (Get-Command 7z.exe -CommandType Application).Source
  New-Item -ItemType Directory $unpacked, $bundle | Out-Null
  # Extract only the observed nested NSIS payload, never launch the installer.
  & $sevenZip x -y -bd "-o$unpacked" $installer '$PLUGINSDIR/app-64.7z' *> $null
  if ($LASTEXITCODE -ne 0) { throw $stage }
  $payload = Join-Path $unpacked '$PLUGINSDIR/app-64.7z'
  if (-not (Test-Path -LiteralPath $payload -PathType Leaf)) { throw $stage }
  & $sevenZip x -y -bd "-o$bundle" $payload 'resources/app.asar.unpacked/cli/*' *> $null
  if ($LASTEXITCODE -ne 0) { throw $stage }

  $stage = 'WORKBUDDY_BUNDLE_LAYOUT_INVALID'
  if (@(Get-ChildItem -LiteralPath $bundle -Recurse -Force |
    Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -ne 0) { throw $stage }
  if (-not (Test-Path -LiteralPath (Join-Path $Destination $command) -PathType Leaf)) { throw $stage }
  $metadata = Get-Content -LiteralPath (Join-Path $bundle 'resources/app.asar.unpacked/cli/package.json') -Raw | ConvertFrom-Json
  $stage = 'WORKBUDDY_BUNDLE_RUNTIME_VERSION_MISMATCH'
  if ($metadata.publishConfig.customPackage.version -cne $runtimeVersion -or $metadata.bin.codebuddy -cne './bin/codebuddy') { throw $stage }
  $verified = $true
} catch {
  $failure = $stage
} finally {
  if ($owned) {
    try {
      foreach ($path in @($installer, $unpacked)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
      }
      if (-not $verified -and (Test-Path -LiteralPath $bundle)) { Remove-Item -LiteralPath $bundle -Recurse -Force }
    } catch { $failure = 'WORKBUDDY_BUNDLE_CLEANUP_FAILED' }
  }
}

if ($failure) {
  [Console]::Error.WriteLine($failure)
  exit 1
}
[ordered]@{ desktopVersion = $desktopVersion; runtimeVersion = $runtimeVersion; arch = 'x64';
  sha256 = $sha256.ToLowerInvariant(); command = $command } | ConvertTo-Json -Compress

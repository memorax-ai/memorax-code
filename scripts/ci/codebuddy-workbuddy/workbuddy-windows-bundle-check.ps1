param(
  [Parameter(Mandatory = $true)][string]$Destination,
  [string]$ReleaseFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
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

  $stage = 'WORKBUDDY_BUNDLE_RELEASE_INVALID'
  $releaseArgs = @((Join-Path $PSScriptRoot 'workbuddy-release-matrix.mjs'), 'select-json', 'win32-x64-user')
  if ($PSBoundParameters.ContainsKey('ReleaseFile')) { $releaseArgs += $ReleaseFile }
  $releaseJson = & node @releaseArgs 2>$null
  if ($LASTEXITCODE -ne 0) { throw $stage }
  $release = $releaseJson | ConvertFrom-Json
  $desktopVersion = $release.desktopVersion
  $sha256 = $release.sha256
  $url = $release.url
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
  # The verified installer digest selects the full build; its PE product version is shorter.
  if ((Get-Item -LiteralPath $installer).VersionInfo.ProductVersion -cne $release.productVersion) { throw $stage }

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
  if ($metadata.publishConfig.customPackage.name -isnot [string] -or
    $metadata.publishConfig.customPackage.name -cne '@tencent-ai/codebuddy-code' -or
    $metadata.bin.codebuddy -isnot [string] -or $metadata.bin.codebuddy -cne './bin/codebuddy') { throw $stage }
  $stage = 'WORKBUDDY_BUNDLE_RUNTIME_VERSION_MISMATCH'
  $runtimeVersion = $metadata.publishConfig.customPackage.version
  if ($runtimeVersion -isnot [string] -or $runtimeVersion -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z' -or
    ($null -ne $release.runtimeVersion -and $runtimeVersion -cne $release.runtimeVersion)) { throw $stage }
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

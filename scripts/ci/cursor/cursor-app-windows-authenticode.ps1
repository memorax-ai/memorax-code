param(
    [Parameter(Mandatory = $true)][ValidateSet('prepare', 'verify', 'installed')][string]$Operation,
    [Parameter(Mandatory = $true)][string]$Directory,
    [string]$ProfileRoot,
    [string]$AppDirectory,
    [string]$Version,
    [string]$Commit
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

function Assert-CursorPublisher($Signature) {
    if ($null -eq $Signature -or [string]$Signature.Status -cne 'Valid' -or
        [string]$Signature.SignatureType -cne 'Authenticode' -or $null -eq $Signature.SignerCertificate) {
        throw 'CURSOR_APP_WINDOWS_ARTIFACT_SIGNATURE'
    }
    try {
        $subject = $Signature.SignerCertificate.SubjectName
        if ($null -eq $subject -or $subject.RawData.Length -gt 65536) { throw 'invalid' }
        $values = @{}
        $count = 0
        foreach ($rdn in $subject.EnumerateRelativeDistinguishedNames()) {
            $count++
            if ($count -gt 32 -or $rdn.HasMultipleElements) { throw 'invalid' }
            $oid = $rdn.GetSingleElementType().Value
            if ($oid -ceq '2.5.4.3' -or $oid -ceq '2.5.4.10') {
                if ($values.ContainsKey($oid)) { throw 'invalid' }
                $values[$oid] = $rdn.GetSingleElementValue()
            }
        }
        if ($values.Count -ne 2 -or $values['2.5.4.3'] -cne 'Anysphere, Inc.' -or
            $values['2.5.4.10'] -cne 'Anysphere, Inc.') { throw 'invalid' }
    } catch { throw 'CURSOR_APP_WINDOWS_ARTIFACT_PUBLISHER' }
}

function Assert-PrivateDirectory([string]$Path, [bool]$Prepare) {
    $stage = 'PATH_SHAPE'
    try {
        if (-not [IO.Path]::IsPathFullyQualified($Path) -or [IO.Path]::GetFullPath($Path) -cne $Path) {
            throw 'invalid'
        }
        $stage = 'ITEM'
        $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $Path -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'invalid'
        }
        $stage = 'IDENTITY'
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try { $currentSid = $identity.User } finally { $identity.Dispose() }
        $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
        if ($Prepare) {
            $stage = 'NOT_EMPTY'
            if (@(Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $Path -Force).Count -ne 0) { throw 'invalid' }
            $stage = 'ACL_SET'
            $acl = [Security.AccessControl.DirectorySecurity]::new()
            $acl.SetOwner($currentSid)
            $acl.SetAccessRuleProtection($true, $false)
            foreach ($sid in @($currentSid, $systemSid)) {
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl',
                    'ContainerInherit, ObjectInherit', 'None', 'Allow'))
            }
            Microsoft.PowerShell.Security\Set-Acl -LiteralPath $Path -AclObject $acl
        }
        $stage = 'ACL_READ'
        $actual = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path
        $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        $stage = 'PROTECTION'
        if (-not $actual.AreAccessRulesProtected) { throw 'invalid' }
        $stage = 'OWNER'
        if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $currentSid.Value) { throw 'invalid' }
        $stage = 'RULE_COUNT'
        if ($rules.Count -ne 2) { throw 'invalid' }
        $stage = 'RULE_SHAPE'
        foreach ($sid in @($currentSid, $systemSid)) {
            $matching = @($rules | Where-Object { $_.IdentityReference.Value -ceq $sid.Value })
            if ($matching.Count -ne 1 -or $matching[0].IsInherited -or
                $matching[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                $matching[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
                $matching[0].InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
                $matching[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
                throw 'invalid'
            }
        }
    } catch { throw ('CURSOR_APP_WINDOWS_ARTIFACT_ROOT_' + $stage) }
}

function Assert-InstalledPath([string]$Path, [bool]$File) {
    try {
        if (-not [IO.Path]::IsPathFullyQualified($Path) -or [IO.Path]::GetFullPath($Path) -cne $Path -or
            $Path.Length -gt 4096 -or $Path -match '[\x00-\x1f]' -or $Path.StartsWith('\\')) { throw 'invalid' }
        $volume = [IO.Path]::GetPathRoot($Path)
        $parts = @($Path.Substring($volume.Length).Split([char[]]@([IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar), [StringSplitOptions]::RemoveEmptyEntries))
        if ($parts.Count -gt 64) { throw 'invalid' }
        $current = $volume
        foreach ($part in @('') + $parts) {
            if ($part.Contains(':')) { throw 'invalid' }
            if ($part -ne '') { $current = Join-Path $current $part }
            $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $current -Force
            $leaf = [StringComparer]::OrdinalIgnoreCase.Equals($current, $Path)
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                (($File -and $leaf) -eq [bool]$item.PSIsContainer)) { throw 'invalid' }
        }
    } catch { throw 'CURSOR_APP_WINDOWS_ARTIFACT_INSTALLED_PATH' }
}

function Assert-InstalledCursor([string]$Profile, [string]$App, [string]$ExpectedVersion, [string]$ExpectedCommit) {
    $stage = 'INSTALLED_PATH'
    $streams = [Collections.Generic.List[IO.FileStream]]::new()
    try {
        Assert-InstalledPath $Profile $false
        Assert-InstalledPath $App $false
        $expected = [IO.Path]::GetFullPath((Join-Path $Profile 'AppData/Local/Programs/Cursor'))
        if (-not [StringComparer]::OrdinalIgnoreCase.Equals($App, $expected)) { throw 'invalid' }
        $packagePath = [IO.Path]::Combine($App, 'resources', 'app', 'package.json')
        $productPath = [IO.Path]::Combine($App, 'resources', 'app', 'product.json')
        $executable = Join-Path $App 'Cursor.exe'
        foreach ($path in @($packagePath, $productPath, $executable)) { Assert-InstalledPath $path $true }
        $stage = 'PACKAGE'
        if ($ExpectedVersion -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or
            $ExpectedCommit -cnotmatch '^[a-f0-9]{40}$') { throw 'invalid' }
        $metadata = @()
        foreach ($path in @($packagePath, $productPath)) {
            $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $streams.Add($stream)
            if ($stream.Length -le 0 -or $stream.Length -gt 1048576) { throw 'invalid' }
            $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true), $true, 1024, $true)
            try { $metadata += ($reader.ReadToEnd() | ConvertFrom-Json -AsHashtable) } finally { $reader.Dispose() }
        }
        if ($metadata.Count -ne 2) { throw 'invalid' }
        foreach ($item in $metadata) {
            if ($item -isnot [Collections.IDictionary] -or -not $item.Contains('version') -or
                $item.version -isnot [string] -or $item.version -cne $ExpectedVersion) { throw 'invalid' }
        }
        if (-not $metadata[1].Contains('realCommit') -or $metadata[1].realCommit -isnot [string] -or
            $metadata[1].realCommit -cne $ExpectedCommit) { throw 'invalid' }
        $stage = 'ARCHITECTURE'
        $stream = [IO.File]::Open($executable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $streams.Add($stream)
        if ($stream.Length -lt 64 -or $stream.Length -gt 600000000) { throw 'invalid' }
        $binary = [IO.BinaryReader]::new($stream, [Text.Encoding]::UTF8, $true)
        try {
            if ($binary.ReadUInt16() -ne 0x5a4d) { throw 'invalid' }
            $stream.Position = 60
            $offset = $binary.ReadUInt32()
            if ($offset -lt 64 -or $offset -gt 1048576 -or $offset + 26 -gt $stream.Length) { throw 'invalid' }
            $stream.Position = $offset
            if ($binary.ReadUInt32() -ne 0x4550 -or $binary.ReadUInt16() -ne 0x8664) { throw 'invalid' }
            $sections = $binary.ReadUInt16()
            $stream.Position = $offset + 20
            $optionalLength = $binary.ReadUInt16()
            $characteristics = $binary.ReadUInt16()
            if ($sections -lt 1 -or $sections -gt 96 -or $optionalLength -lt 112 -or
                $offset + 24 + $optionalLength -gt $stream.Length -or
                -not ($characteristics -band 2) -or ($characteristics -band 0x2000) -or
                $binary.ReadUInt16() -ne 0x20b) { throw 'invalid' }
        } finally { $binary.Dispose() }
        $stage = 'SIGNATURE'
        $signatures = @(Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $executable -ErrorAction Stop)
        if ($signatures.Count -ne 1) { throw 'invalid' }
        Assert-CursorPublisher $signatures[0]
        foreach ($path in @($packagePath, $productPath, $executable)) { Assert-InstalledPath $path $true }
    } catch {
        $code = $_.Exception.Message
        if (@('CURSOR_APP_WINDOWS_ARTIFACT_INSTALLED_PATH', 'CURSOR_APP_WINDOWS_ARTIFACT_SIGNATURE',
            'CURSOR_APP_WINDOWS_ARTIFACT_PUBLISHER') -ccontains $code) { throw $code }
        throw ('CURSOR_APP_WINDOWS_ARTIFACT_' + $stage)
    } finally { foreach ($stream in $streams) { $stream.Dispose() } }
}

try {
    if (-not $IsWindows) { throw 'CURSOR_APP_WINDOWS_ARTIFACT_PLATFORM' }
    if ($Operation -cne 'installed') { Assert-PrivateDirectory $Directory ($Operation -ceq 'prepare') }
    if ($Operation -ceq 'prepare') {
        [Console]::WriteLine('{"status":"PASS","operation":"prepare","privateDirectory":true}')
    } elseif ($Operation -ceq 'installed') {
        Assert-InstalledCursor $ProfileRoot $AppDirectory $Version $Commit
        [Console]::WriteLine('{"status":"PASS","operation":"installed","appIdentityVerified":true,"appArchitectureVerified":true,"authenticodeVerified":true,"publisherVerified":true}')
    } else {
        $path = Join-Path $Directory 'CursorUserSetup.exe'
        $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $path -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -le 0 -or $item.Length -gt 600000000) { throw 'CURSOR_APP_WINDOWS_ARTIFACT_SIGNATURE' }
        $signatures = @(Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop)
        if ($signatures.Count -ne 1) { throw 'CURSOR_APP_WINDOWS_ARTIFACT_SIGNATURE' }
        Assert-CursorPublisher $signatures[0]
        [Console]::WriteLine('{"status":"PASS","operation":"verify","authenticodeVerified":true,"publisherVerified":true}')
    }
    exit 0
} catch {
    $code = $_.Exception.Message
    if (@('CURSOR_APP_WINDOWS_ARTIFACT_PLATFORM', 'CURSOR_APP_WINDOWS_ARTIFACT_SIGNATURE', 'CURSOR_APP_WINDOWS_ARTIFACT_PUBLISHER',
        'CURSOR_APP_WINDOWS_ARTIFACT_INSTALLED_PATH', 'CURSOR_APP_WINDOWS_ARTIFACT_PACKAGE', 'CURSOR_APP_WINDOWS_ARTIFACT_ARCHITECTURE',
        'CURSOR_APP_WINDOWS_ARTIFACT_ROOT_PATH_SHAPE', 'CURSOR_APP_WINDOWS_ARTIFACT_ROOT_ITEM',
        'CURSOR_APP_WINDOWS_ARTIFACT_ROOT_IDENTITY', 'CURSOR_APP_WINDOWS_ARTIFACT_ROOT_NOT_EMPTY',
        'CURSOR_APP_WINDOWS_ARTIFACT_ROOT_ACL_SET', 'CURSOR_APP_WINDOWS_ARTIFACT_ROOT_ACL_READ',
        'CURSOR_APP_WINDOWS_ARTIFACT_ROOT_PROTECTION', 'CURSOR_APP_WINDOWS_ARTIFACT_ROOT_OWNER',
        'CURSOR_APP_WINDOWS_ARTIFACT_ROOT_RULE_COUNT', 'CURSOR_APP_WINDOWS_ARTIFACT_ROOT_RULE_SHAPE') -cnotcontains $code) {
        $code = if ($Operation -ceq 'prepare') { 'CURSOR_APP_WINDOWS_ARTIFACT_HELPER' } else { 'CURSOR_APP_WINDOWS_ARTIFACT_SIGNATURE' }
    }
    [Console]::WriteLine(([ordered]@{ status = 'FAIL'; errorCode = $code } | ConvertTo-Json -Compress))
    exit 1
}

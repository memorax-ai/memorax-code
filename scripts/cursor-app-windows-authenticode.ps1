param(
    [Parameter(Mandatory = $true)][ValidateSet('prepare', 'verify')][string]$Operation,
    [Parameter(Mandatory = $true)][string]$Directory
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

try {
    if (-not $IsWindows) { throw 'CURSOR_APP_WINDOWS_ARTIFACT_PLATFORM' }
    Assert-PrivateDirectory $Directory ($Operation -ceq 'prepare')
    if ($Operation -ceq 'prepare') {
        [Console]::WriteLine('{"status":"PASS","operation":"prepare","privateDirectory":true}')
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

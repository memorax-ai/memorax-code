param([Parameter(Mandatory = $true)][string]$ReportPath)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

$report = [ordered]@{
    schemaVersion = 1; kind = 'network-isolation-proof'; platform = 'win32'
    scope = 'windows-wfp-user-direct-outbound-only'; status = 'FAIL'; stage = 'guard'
    dnsBrokerIsolation = 'not-verified'; otherSidBrokerIsolation = 'not-enforced'
    appStarted = $false; nativeAcceptance = $false; externalProbes = $false
    evidence = [ordered]@{ freshStandardUser = $false; baselineFixturesReachable = $false
        parentChildGrandchildSameSid = $false; allowedLoopback = $false; deniedLoopback = $false
        controllerStillReachesDenied = $false; filtersSurviveEngineClose = $false
        udpDenied = $false; mappedIpv6Denied = $false }
    counts = [ordered]@{ processLevels = 0; verifiedTokens = 0; deniedAttempts = 0 }
    observations = @()
    cleanup = [ordered]@{ bounded = $true; processHandlesClosed = $false; wfpObjectsRemoved = $false
        userRemoved = $false; ownedFilesRemoved = $false }
}
$root = $null; $user = $null; $userName = $null; $securePassword = $null; $node = $null; $probe = $null
$controllerRoot = $null; $wfp = $null; $wfpArguments = $null; $buildProcessesClosed = $true
$wfpProcessesClosed = $true
$canWriteReport = $false
$owned = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$errorCodes = @('CURSOR_APP_WINDOWS_HOST_UNSUPPORTED', 'CURSOR_APP_WINDOWS_REPORT_INVALID',
    'CURSOR_APP_WINDOWS_SETUP_FAILED', 'CURSOR_APP_WINDOWS_FIXTURES_FAILED',
    'CURSOR_APP_WINDOWS_PROBE_FAILED', 'CURSOR_APP_WINDOWS_PROBE_OUTPUT_INVALID',
    'CURSOR_APP_WINDOWS_IDENTITY_UNPROVEN', 'CURSOR_APP_WINDOWS_FIREWALL_FAILED',
    'CURSOR_APP_WINDOWS_BASELINE_UNREACHABLE', 'CURSOR_APP_WINDOWS_ALLOWED_LOOPBACK_FAILED',
    'CURSOR_APP_WINDOWS_LOOPBACK_NOT_RESTRICTED', 'CURSOR_APP_WINDOWS_DENIAL_UNPROVEN',
    'CURSOR_APP_WINDOWS_CONTROLLER_UNREACHABLE', 'CURSOR_APP_WINDOWS_CLEANUP_FAILED')

function Assert-HostedRunner {
    $report.failedGuard = 'platform'
    if (-not $IsWindows) { throw 'CURSOR_APP_WINDOWS_HOST_UNSUPPORTED' }
    $report.failedGuard = 'actions'
    if ($env:GITHUB_ACTIONS -cne 'true') { throw 'CURSOR_APP_WINDOWS_HOST_UNSUPPORTED' }
    $report.failedGuard = 'runnerEnvironment'
    if ($env:RUNNER_ENVIRONMENT -cne 'github-hosted') { throw 'CURSOR_APP_WINDOWS_HOST_UNSUPPORTED' }
    $report.failedGuard = 'runnerOs'
    if ($env:RUNNER_OS -cne 'Windows') { throw 'CURSOR_APP_WINDOWS_HOST_UNSUPPORTED' }
    $report.failedGuard = 'imageOs'
    # GitHub's Windows 2025 images expose these exact ImageOS values.
    if (@('win25', 'win25-vs2026') -cnotcontains $env:ImageOS) { throw 'CURSOR_APP_WINDOWS_HOST_UNSUPPORTED' }
    $report.failedGuard = 'runId'
    if ($env:GITHUB_RUN_ID -notmatch '^\d+$') {
        throw 'CURSOR_APP_WINDOWS_HOST_UNSUPPORTED'
    }
    $report.failedGuard = 'admin'
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'CURSOR_APP_WINDOWS_HOST_UNSUPPORTED'
        }
    } finally { $identity.Dispose() }
    $report.failedGuard = 'firewallService'
    if ((Get-Service MpsSvc).Status -ne 'Running') { throw 'CURSOR_APP_WINDOWS_HOST_UNSUPPORTED' }
    $report.failedGuard = 'firewallProfiles'
    if (@(Get-NetFirewallProfile | Where-Object { $_.Enabled -ne 'True' }).Count -ne 0) {
        throw 'CURSOR_APP_WINDOWS_HOST_UNSUPPORTED'
    }
    $report.Remove('failedGuard')
}

function Read-PrivateJson([string]$Path) {
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer -or $item.Length -gt 8192 -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'CURSOR_APP_WINDOWS_PROBE_OUTPUT_INVALID'
    }
    return [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json -AsHashtable
}

function Start-OwnedNode([string[]]$Arguments, [bool]$AsProbeUser = $false, [string]$Executable = $node,
    [string]$WorkingDirectory = $root) {
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Environment.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR', 'COMSPEC')) {
        $value = [System.Environment]::GetEnvironmentVariable($name)
        if ($value) { $info.Environment[$name] = $value }
    }
    $info.Environment['PATH'] = "$WorkingDirectory;$env:SystemRoot\System32"
    $info.Environment['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
    $info.Environment['HOME'] = (Join-Path $root 'home')
    $info.Environment['USERPROFILE'] = (Join-Path $root 'home')
    $info.Environment['APPDATA'] = (Join-Path $root 'home\AppData\Roaming')
    $info.Environment['LOCALAPPDATA'] = (Join-Path $root 'home\AppData\Local')
    $info.Environment['TEMP'] = (Join-Path $root 'tmp')
    $info.Environment['TMP'] = (Join-Path $root 'tmp')
    if ($AsProbeUser) {
        $info.UserName = $userName
        $info.Domain = $env:COMPUTERNAME
        $info.Password = $securePassword
        $info.LoadUserProfile = $false
    }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    if (-not $process.Start()) { $process.Dispose(); throw 'CURSOR_APP_WINDOWS_PROBE_FAILED' }
    $owned.Add($process)
    return $process
}

function Invoke-OwnedNode([string[]]$Arguments) {
    $process = Start-OwnedNode $Arguments
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(15000) -or $process.ExitCode -ne 0) { throw 'CURSOR_APP_WINDOWS_PROBE_FAILED' }
    $output = $process.StandardOutput.ReadToEnd()
    if ($output.Length -gt 8192 -or $process.StandardError.ReadToEnd().Length -ne 0) {
        throw 'CURSOR_APP_WINDOWS_PROBE_OUTPUT_INVALID'
    }
    return $output
}

function Wait-Ready([string]$Directory, [System.Diagnostics.Process]$Worker) {
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    while (@(0..2 | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Directory "ready-$_.json")) }).Count -ne 0) {
        if ($Worker.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'CURSOR_APP_WINDOWS_IDENTITY_UNPROVEN' }
        Start-Sleep -Milliseconds 100
    }
    $parentId = $PID
    foreach ($depth in 0..2) {
        $record = Read-PrivateJson (Join-Path $Directory "ready-$depth.json")
        if ($record.Count -ne 3 -or $record.depth -ne $depth -or
            ($record.pid -isnot [long] -and $record.pid -isnot [int]) -or $record.pid -le 0 -or
            $record.parentPid -ne $parentId -or ($depth -eq 0 -and $record.pid -ne $Worker.Id)) {
            throw 'CURSOR_APP_WINDOWS_IDENTITY_UNPROVEN'
        }
        $handle = if ($depth -eq 0) { $Worker } else { [System.Diagnostics.Process]::GetProcessById($record.pid) }
        $verified = $false
        try {
            # Retain the handle before inspecting identity; cleanup never kills a newly looked-up PID.
            $null = $handle.Handle
            $native = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)"
            $owner = Invoke-CimMethod -InputObject $native -MethodName GetOwnerSid
            if ($handle.HasExited -or $owner.ReturnValue -ne 0 -or $owner.Sid -cne $user.SID.Value -or
                $native.ParentProcessId -ne $parentId -or $native.ExecutablePath -ine $node) {
                throw 'CURSOR_APP_WINDOWS_IDENTITY_UNPROVEN'
            }
            $verified = $true
            if ($depth -ne 0) { $owned.Add($handle) }
            $report.counts.verifiedTokens++
        } finally { if (-not $verified -and $depth -ne 0) { $handle.Dispose() } }
        $parentId = $record.pid
    }
}

function Invoke-ProbeRun([string]$Mode) {
    $directory = Join-Path $root $Mode
    $null = New-Item -ItemType Directory -Path $directory
    Copy-Item -LiteralPath (Join-Path $root 'config.json') -Destination (Join-Path $directory 'config.json')
    $worker = Start-OwnedNode @($probe, 'level', $directory, '0') $true
    Wait-Ready $directory $worker
    [System.IO.File]::WriteAllText((Join-Path $directory 'start.pending'), '{"start":true}')
    [System.IO.File]::Move((Join-Path $directory 'start.pending'), (Join-Path $directory 'start.json'))
    if (-not $worker.WaitForExit(20000) -or $worker.ExitCode -ne 0) { throw 'CURSOR_APP_WINDOWS_PROBE_FAILED' }
    return (Invoke-OwnedNode @($probe, 'summarize', $directory, $Mode)) | ConvertFrom-Json -AsHashtable
}

function Build-WfpHelper([string]$Source, [string]$Destination) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $installation = @(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null)
    if ($LASTEXITCODE -ne 0 -or $installation.Count -ne 1) { throw 'CURSOR_APP_WINDOWS_SETUP_FAILED' }
    $developer = Join-Path $installation[0] 'Common7\Tools\VsDevCmd.bat'
    foreach ($path in @($Source, $Destination, $developer)) {
        if (-not [System.IO.Path]::IsPathFullyQualified($path) -or $path -match '["&|<>^%!\r\n]') {
            throw 'CURSOR_APP_WINDOWS_SETUP_FAILED'
        }
    }
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $env:COMSPEC
    $info.Arguments = '/d /s /c "call "' + $developer + '" -no_logo -arch=x64 -host_arch=x64 && cl.exe /nologo /W4 /WX /EHsc /std:c++17 /MT "' + $Source + '" /Fe:"' + $Destination + '" /Fo:"' + $Destination + '.obj" /link Fwpuclnt.lib Advapi32.lib Rpcrt4.lib"'
    $info.WorkingDirectory = [System.IO.Path]::GetDirectoryName($Destination)
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.Environment.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR', 'COMSPEC', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432')) {
        $value = [System.Environment]::GetEnvironmentVariable($name)
        if ($value) { $info.Environment[$name] = $value }
    }
    $info.Environment['PATH'] = "$env:SystemRoot\System32"
    $info.Environment['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
    $info.Environment['VSCMD_SKIP_SENDTELEMETRY'] = '1'
    $info.Environment['TEMP'] = $info.WorkingDirectory; $info.Environment['TMP'] = $info.WorkingDirectory
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    if (-not $process.Start()) { $process.Dispose(); throw 'CURSOR_APP_WINDOWS_SETUP_FAILED' }
    $owned.Add($process)
    $script:buildProcessesClosed = $false
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(60000) -or -not $stdout.Wait(1000) -or -not $stderr.Wait(1000)) {
        throw 'CURSOR_APP_WINDOWS_SETUP_FAILED'
    }
    $script:buildProcessesClosed = $true
    if ($process.ExitCode -ne 0 -or $stdout.Result.Length -gt 65536 -or $stderr.Result.Length -gt 65536 -or
        -not (Test-Path -LiteralPath $Destination -PathType Leaf)) { throw 'CURSOR_APP_WINDOWS_SETUP_FAILED' }
}

function Invoke-Wfp([string]$Action, [bool]$TrackDiagnostic = $true) {
    if (@('install', 'verify', 'remove') -cnotcontains $Action) { throw 'CURSOR_APP_WINDOWS_FIREWALL_FAILED' }
    $process = Start-OwnedNode (@($Action) + $wfpArguments) -Executable $wfp -WorkingDirectory $controllerRoot
    try {
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(15000)) { throw 'CURSOR_APP_WINDOWS_FIREWALL_FAILED' }
        $output = $process.StandardOutput.ReadToEnd()
        if ($output.Length -gt 2048 -or $process.StandardError.ReadToEnd().Length -ne 0) {
            throw 'CURSOR_APP_WINDOWS_FIREWALL_FAILED'
        }
        $result = $output | ConvertFrom-Json -AsHashtable
        if ($process.ExitCode -eq 0 -and $result.Count -eq 2 -and $result.status -ceq 'PASS' -and
            ($result.filterCount -is [long] -or $result.filterCount -is [int]) -and $result.filterCount -eq 4) { return }
        $steps = @('input', 'engine-open', 'transaction-begin', 'precheck', 'sublayer-add', 'filter-plan',
            'filter-add', 'verify-sublayer', 'verify-filter', 'verify-policy', 'transaction-commit',
            'engine-close', 'filter-delete', 'sublayer-delete', 'verify-removed', 'unexpected')
        if ($TrackDiagnostic -and $result.Count -eq 4 -and $result.status -ceq 'FAIL' -and
            $steps -ccontains $result.step -and @('none', 'ipv4', 'ipv6') -ccontains $result.family -and
            ($result.nativeErrorCode -is [long] -or $result.nativeErrorCode -is [int]) -and
            $result.nativeErrorCode -ge 0 -and $result.nativeErrorCode -le 4294967295) {
            $report.firewallDiagnostic = [ordered]@{ step = $result.step; family = $result.family; nativeErrorCode = $result.nativeErrorCode }
        }
        throw 'CURSOR_APP_WINDOWS_FIREWALL_FAILED'
    } finally {
        $closed = $false
        try {
            if (-not $process.HasExited) { $process.Kill() }
            $closed = $process.WaitForExit(5000)
        } catch {}
        if ($closed) { $null = $owned.Remove($process); $process.Dispose() }
        else { $script:wfpProcessesClosed = $false }
    }
}

try {
    if (-not [System.IO.Path]::IsPathFullyQualified($ReportPath) -or (Test-Path -LiteralPath $ReportPath) -or
        -not (Test-Path -LiteralPath ([System.IO.Path]::GetDirectoryName($ReportPath)) -PathType Container)) {
        throw 'CURSOR_APP_WINDOWS_REPORT_INVALID'
    }
    $canWriteReport = $true
    Assert-HostedRunner
    $report.stage = 'setup'
    $sourceNode = @(Get-Command node -CommandType Application)[0].Source
    if ([System.IO.Path]::GetFileName($sourceNode) -ine 'node.exe' -or -not $env:RUNNER_TEMP -or
        -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) { throw 'CURSOR_APP_WINDOWS_SETUP_FAILED' }
    $root = Join-Path $env:RUNNER_TEMP ('cursor-windows-proof-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $root
    foreach ($relative in @('home', 'home\AppData\Roaming', 'home\AppData\Local', 'tmp')) {
        $null = New-Item -ItemType Directory -Path (Join-Path $root $relative) -Force
    }
    $node = Join-Path $root 'node.exe'
    $probe = Join-Path $root 'cursor-app-windows-isolation-probe.mjs'
    Copy-Item -LiteralPath $sourceNode -Destination $node
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'cursor-app-windows-isolation-probe.mjs') -Destination $probe
    # Compare the selected binary and owned copy without publishing paths or command output.
    $report.nodeVersionPreflight = [ordered]@{ versionsMatch = $false }
    $versionOutputs = @{}
    foreach ($kind in @('source', 'copied')) {
        $diagnostic = [ordered]@{ classification = 'missing'; outputLength = 0; exitCode = $null }
        $report.nodeVersionPreflight[$kind] = $diagnostic
        $executable = if ($kind -eq 'source') { $sourceNode } else { $node }
        $process = Start-OwnedNode @('--version') -Executable $executable
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(15000)) { throw 'CURSOR_APP_WINDOWS_PROBE_FAILED' }
        $diagnostic.exitCode = $process.ExitCode
        $output = $process.StandardOutput.ReadToEnd()
        $diagnostic.outputLength = [Math]::Min($output.Length, 8192)
        $trimmed = $output.Trim()
        if ($output.Length -gt 8192) {
            $diagnostic.classification = 'oversized'
        } elseif ($trimmed.Length -ne 0) {
            $diagnostic.classification = 'non-semver'
            if ($trimmed -cmatch '^v([0-9]{1,6})\.([0-9]{1,6})\.([0-9]{1,6})$') {
                $diagnostic.classification = 'semver'
                $diagnostic.version = [ordered]@{ major = [int]$Matches[1]; minor = [int]$Matches[2]; patch = [int]$Matches[3] }
            }
        }
        if ($process.ExitCode -ne 0) { throw 'CURSOR_APP_WINDOWS_PROBE_FAILED' }
        if ($output.Length -gt 8192 -or $process.StandardError.ReadToEnd().Length -ne 0) {
            throw 'CURSOR_APP_WINDOWS_PROBE_OUTPUT_INVALID'
        }
        $versionOutputs[$kind] = $trimmed
    }
    $report.nodeVersionPreflight.versionsMatch = $report.nodeVersionPreflight.source.classification -eq 'semver' -and
        $report.nodeVersionPreflight.copied.classification -eq 'semver' -and $versionOutputs.source -ceq $versionOutputs.copied
    if ($versionOutputs.copied -notmatch '^v24\.\d+\.\d+$') { throw 'CURSOR_APP_WINDOWS_HOST_UNSUPPORTED' }
    $controllerRoot = Join-Path $env:RUNNER_TEMP ('cursor-windows-wfp-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $controllerRoot
    $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    try { $currentSid = $currentIdentity.User } finally { $currentIdentity.Dispose() }
    $controllerAcl = Get-Acl -LiteralPath $controllerRoot
    $controllerAcl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($currentSid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $controllerAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl',
            'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $controllerRoot -AclObject $controllerAcl
    $wfp = Join-Path $controllerRoot 'cursor-app-windows-wfp.exe'
    $wfpSource = Join-Path $controllerRoot 'cursor-app-windows-wfp.cpp'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'cursor-app-windows-wfp.cpp') -Destination $wfpSource
    Build-WfpHelper $wfpSource $wfp
    $userName = 'mxp' + [Guid]::NewGuid().ToString('N').Substring(0, 14)
    $password = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)) + 'Aa1!'
    $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
    $password = $null
    $user = New-LocalUser -Name $userName -Password $securePassword -AccountNeverExpires -UserMayNotChangePassword
    $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
    if (@(Get-LocalGroupMember -Group $usersGroup | Where-Object { $_.SID -eq $user.SID }).Count -eq 0) {
        Add-LocalGroupMember -Group $usersGroup -Member $user
    }
    if (@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID -eq $user.SID }).Count -ne 0) {
        throw 'CURSOR_APP_WINDOWS_IDENTITY_UNPROVEN'
    }
    $acl = Get-Acl -LiteralPath $root
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($currentSid,
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), $user.SID)) {
        $rights = if ($sid -eq $user.SID) { 'Modify' } else { 'FullControl' }
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights,
            'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $root -AclObject $acl
    $report.evidence.freshStandardUser = $true
    $report.stage = 'fixtures'
    $fixture = Start-OwnedNode @($probe, 'fixtures', (Join-Path $root 'config.json'))
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath (Join-Path $root 'config.json'))) {
        if ($fixture.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'CURSOR_APP_WINDOWS_FIXTURES_FAILED' }
        Start-Sleep -Milliseconds 100
    }
    $config = Read-PrivateJson (Join-Path $root 'config.json')
    $report.stage = 'baseline'
    $baseline = Invoke-ProbeRun 'baseline'
    if (-not $baseline.passed) { throw $baseline.errorCode }
    $report.evidence.baselineFixturesReachable = $true
    $report.stage = 'firewall'
    $wfpArguments = @($user.SID.Value, [Guid]::NewGuid().ToString(), [Guid]::NewGuid().ToString(),
        [Guid]::NewGuid().ToString(), [Guid]::NewGuid().ToString(), [Guid]::NewGuid().ToString(),
        [string]$config.allowed4, [string]$config.allowed6)
    Invoke-Wfp 'install'
    Invoke-Wfp 'verify'
    $report.evidence.filtersSurviveEngineClose = $true
    $report.stage = 'restricted'
    $restricted = Invoke-ProbeRun 'restricted'
    $report.counts.processLevels = $restricted.levelCount
    $report.counts.deniedAttempts = $restricted.deniedAttempts
    $report.observations = $restricted.observations
    $report.evidence.parentChildGrandchildSameSid = $report.counts.verifiedTokens -eq 6
    $report.evidence.allowedLoopback = @($restricted.observations | Where-Object {
        $_.allowed4 -ne 'CONNECTED' -or $_.allowed6 -ne 'CONNECTED' }).Count -eq 0 -and $restricted.levelCount -eq 3
    $report.evidence.udpDenied = @($restricted.observations | Where-Object {
        $_.udp4 -ne 'ACCESS_DENIED' -or $_.udp6 -ne 'ACCESS_DENIED' -or $_.mappedUdp -ne 'ACCESS_DENIED'
        }).Count -eq 0 -and $restricted.levelCount -eq 3
    $report.evidence.mappedIpv6Denied = @($restricted.observations | Where-Object {
        $_.mappedTcp -ne 'ACCESS_DENIED' -or $_.mappedUdp -ne 'ACCESS_DENIED'
        }).Count -eq 0 -and $restricted.levelCount -eq 3
    if (-not $restricted.passed) { throw $restricted.errorCode }
    $report.evidence.deniedLoopback = $true
    $control = (Invoke-OwnedNode @($probe, 'control', (Join-Path $root 'config.json'))) | ConvertFrom-Json -AsHashtable
    if ($control.reachable -ne $true) { throw 'CURSOR_APP_WINDOWS_CONTROLLER_UNREACHABLE' }
    $report.evidence.controllerStillReachesDenied = $true
    $report.status = 'PASS'
    $report.stage = 'done'
} catch {
    $code = $_.Exception.Message
    $report.errorCode = if ($errorCodes -ccontains $code) { $code } else {
        switch ($report.stage) {
            'guard' { 'CURSOR_APP_WINDOWS_HOST_UNSUPPORTED' }
            'setup' { 'CURSOR_APP_WINDOWS_SETUP_FAILED' }
            'fixtures' { 'CURSOR_APP_WINDOWS_FIXTURES_FAILED' }
            'firewall' { 'CURSOR_APP_WINDOWS_FIREWALL_FAILED' }
            default { 'CURSOR_APP_WINDOWS_PROBE_FAILED' }
        }
    }
} finally {
    $processesClosed = $buildProcessesClosed -and $wfpProcessesClosed
    foreach ($process in $owned) {
        try {
            if (-not $process.HasExited) { $process.Kill() }
            if (-not $process.WaitForExit(5000)) { $processesClosed = $false }
        } catch { $processesClosed = $false }
        finally { $process.Dispose() }
    }
    # A worker missed during a failed handshake has its own 30-second lifetime.
    # Read SID ownership, not possibly unavailable executable paths; never signal these PIDs.
    if ($root -and $user) {
        try {
            $deadline = [DateTime]::UtcNow.AddSeconds(35)
            do {
                $remaining = 0; $unproven = $false
                $candidates = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 5 -ErrorAction Stop)
                if ($candidates.Count -gt 32) { throw 'PROCESS_QUERY_UNBOUNDED' }
                foreach ($candidate in $candidates) {
                    $owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid -OperationTimeoutSec 5 -ErrorAction Stop
                    if ($owner.ReturnValue -ne 0 -or $owner.Sid -notmatch '^S-1-(\d+-)+\d+$') { $unproven = $true }
                    elseif ($owner.Sid -ceq $user.SID.Value) { $remaining++ }
                }
                if ($remaining -eq 0 -and -not $unproven) { break }
                Start-Sleep -Milliseconds 200
            } while ([DateTime]::UtcNow -lt $deadline)
            if ($remaining -ne 0 -or $unproven) { $processesClosed = $false }
        } catch { $processesClosed = $false }
    }
    $rulesRemoved = $false
    if ($processesClosed) {
        try {
            if ($wfpArguments) { Invoke-Wfp 'remove' $false }
            $rulesRemoved = $true
        } catch { $rulesRemoved = $false }
    }
    $processesClosed = $processesClosed -and $wfpProcessesClosed
    $report.cleanup.processHandlesClosed = $processesClosed
    $report.cleanup.wfpObjectsRemoved = $rulesRemoved
    try {
        if (-not $processesClosed -or -not $rulesRemoved) { throw 'PROCESS_CLEANUP_UNPROVEN' }
        if ($user) {
            $remainingUser = @(Get-LocalUser -ErrorAction Stop | Where-Object { $_.SID -eq $user.SID })
            if ($remainingUser.Count -gt 1) { throw 'USER_OWNERSHIP_CHANGED' }
            if ($remainingUser -and $remainingUser.Name -cne $userName) { throw 'USER_OWNERSHIP_CHANGED' }
            if ($remainingUser) { Remove-LocalUser -SID $user.SID }
            if (Get-LocalUser -ErrorAction Stop | Where-Object { $_.SID -eq $user.SID }) { throw 'USER_REMAINS' }
        } elseif ($userName -and (Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -ceq $userName })) {
            throw 'USER_OWNERSHIP_UNPROVEN'
        }
        $report.cleanup.userRemoved = $true
    } catch { $report.cleanup.userRemoved = $false }
    try {
        if (-not $processesClosed -or -not $rulesRemoved) { throw 'PROCESS_CLEANUP_UNPROVEN' }
        foreach ($directory in @($root, $controllerRoot)) {
            if ($directory -and (Test-Path -LiteralPath $directory)) { Remove-Item -LiteralPath $directory -Recurse -Force }
        }
        $report.cleanup.ownedFilesRemoved = $true
    } catch { $report.cleanup.ownedFilesRemoved = $false }
    if ($securePassword) { $securePassword.Dispose() }
    if (-not $processesClosed -or -not $rulesRemoved -or -not $report.cleanup.userRemoved -or -not $report.cleanup.ownedFilesRemoved) {
        if ($report.status -eq 'PASS') { $report.errorCode = 'CURSOR_APP_WINDOWS_CLEANUP_FAILED'; $report.stage = 'cleanup' }
        $report.status = 'FAIL'
    }
    try {
        if (-not $canWriteReport) { throw 'REPORT_DESTINATION_INVALID' }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 8 -Compress) + "`n")
        $stream = [System.IO.File]::Open($ReportPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    } catch { [Console]::Error.WriteLine('CURSOR_APP_WINDOWS_REPORT_FAILED'); $report.status = 'FAIL' }
}
if ($report.status -ne 'PASS') { exit 1 }
exit 0

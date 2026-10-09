$ErrorActionPreference = 'Stop'
$helperPath = Join-Path $PSScriptRoot 'codex-install-user-path.ps1'
. $helperPath

function Assert-That([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function New-PathStore([string]$Value) {
  $state = @{ Value = $Value; Writes = [Collections.Generic.List[string]]::new() }
  return @{
    State = $state
    Read = { $state.Value }.GetNewClosure()
    Write = {
      param($Value)
      $state.Value = $Value
      $state.Writes.Add($Value)
    }.GetNewClosure()
  }
}

$prefix = 'C:\Temp\codex-check\npm'
$baseline = 'C:\Windows\System32;; "D:\Kept Tools" '
$other = 'D:\InstalledWhileRunning'

$store = New-PathStore $baseline
$action = {
  $store.State.Value = "$baseline;${prefix}-other;$prefix\child;`"$($prefix.ToUpperInvariant())/`";$other"
  'action-result'
}.GetNewClosure()
$result = Invoke-WithCodexTestUserPath -Prefix $prefix -Action $action -ReadPath $store.Read -WritePath $store.Write
Assert-That ($result -ceq 'action-result') 'The guard must preserve action output.'
Assert-That ($store.State.Value -ceq "$baseline;${prefix}-other;$prefix\child;$other") `
  'Cleanup must remove only its exact prefix and preserve other entries verbatim.'

$existing = "$baseline; `"$($prefix.ToUpperInvariant())\`" "
$store = New-PathStore $existing
Invoke-WithCodexTestUserPath -Prefix $prefix -ReadPath $store.Read -WritePath $store.Write -Action ({
  $store.State.Value = "$existing;$other"
}.GetNewClosure())
Assert-That ($store.State.Value -ceq "$existing;$other" -and $store.State.Writes.Count -eq 0) `
  'A prefix present in the baseline must remain untouched.'

$store = New-PathStore $baseline
Invoke-WithCodexTestUserPath -Prefix $prefix -ReadPath $store.Read -WritePath $store.Write -Action {}
Assert-That ($store.State.Writes.Count -eq 0) 'Cleanup must not write when its prefix was never added.'

$store = New-PathStore $baseline
$caught = $null
try {
  Invoke-WithCodexTestUserPath -Prefix $prefix -ReadPath $store.Read -WritePath $store.Write -Action ({
    $store.State.Value = "$baseline;$prefix;$other"
    throw 'fixture-action-failed'
  }.GetNewClosure())
} catch { $caught = $_ }
Assert-That ($null -ne $caught -and $caught.Exception.Message -ceq 'fixture-action-failed') `
  'Cleanup must preserve the original action failure.'
Assert-That ($store.State.Value -ceq "$baseline;$other") 'A failing action must still remove its prefix.'

$store = New-PathStore $baseline
$store.State.Reads = 0
$readChangingPath = {
  $store.State.Reads += 1
  $observed = $store.State.Value
  if ($store.State.Reads -eq 2) { $store.State.Value += ";$other" }
  $observed
}.GetNewClosure()
Invoke-WithCodexTestUserPath -Prefix $prefix -ReadPath $readChangingPath -WritePath $store.Write -Action ({
  $store.State.Value = "$baseline;$prefix"
}.GetNewClosure())
Assert-That ($store.State.Value -ceq "$baseline;$other") 'A concurrent addition between cleanup reads must survive.'
Assert-That ($store.State.Writes.Count -eq 1 -and $store.State.Writes[0] -ceq "$baseline;$other") `
  'Cleanup must recompute from the changed PATH before writing.'

foreach ($failure in @('denied', 'not-persisted')) {
  $store = New-PathStore $baseline
  $writeFailingPath = {
    param($Value)
    $store.State.Writes.Add($Value)
    if ($failure -eq 'denied') { throw 'fixture-write-denied' }
  }.GetNewClosure()
  $caught = $null
  try {
    Invoke-WithCodexTestUserPath -Prefix $prefix -ReadPath $store.Read -WritePath $writeFailingPath -Action ({
      $store.State.Value = "$baseline;$prefix"
    }.GetNewClosure())
  } catch { $caught = $_ }
  Assert-That ($null -ne $caught) "Cleanup failure ($failure) must not report success."
  Assert-That ($store.State.Writes.Count -ge 1 -and $store.State.Writes.Count -le 3) `
    'Cleanup attempts must remain bounded.'
}

# Stop a real PowerShell pipeline. Shared memory records cleanup even when its
# output pipeline has stopped; no test accesses the persistent user environment.
$shared = [hashtable]::Synchronized(@{ Value = $baseline; Writes = 0 })
$ready = [Threading.ManualResetEventSlim]::new()
$runner = [PowerShell]::Create()
try {
  $script = {
    param($HelperPath, $Prefix, $Baseline, $Other, $Shared, $Ready)
    $ErrorActionPreference = 'Stop'
    . $HelperPath
    Invoke-WithCodexTestUserPath -Prefix $Prefix -ReadPath ({
      $Shared.Value
    }.GetNewClosure()) -WritePath ({
      param($Value)
      $Shared.Value = $Value
      $Shared.Writes += 1
    }.GetNewClosure()) -Action ({
      $Shared.Value = "$Baseline;$Prefix;$Other"
      $Ready.Set()
      while ($true) { Start-Sleep -Milliseconds 100 }
    }.GetNewClosure())
  }
  $null = $runner.AddScript($script.ToString()).AddArgument($helperPath).AddArgument($prefix)
  $null = $runner.AddArgument($baseline).AddArgument($other).AddArgument($shared).AddArgument($ready)
  $pending = $runner.BeginInvoke()
  Assert-That ($ready.Wait(5000)) 'The interruption fixture did not reach the guarded action.'
  $runner.Stop()
  try { $null = $runner.EndInvoke($pending) }
  catch {
    Assert-That ($_.Exception -is [Management.Automation.PipelineStoppedException] -or
      $_.Exception.InnerException -is [Management.Automation.PipelineStoppedException]) `
      'The interruption fixture failed for an unexpected reason.'
  }
  Assert-That ($runner.InvocationStateInfo.State -eq [Management.Automation.PSInvocationState]::Stopped) `
    'The interruption case must stop the real PowerShell pipeline.'
  Assert-That ($shared.Value -ceq "$baseline;$other" -and $shared.Writes -eq 1) `
    'Pipeline interruption must run cleanup and preserve unrelated additions.'
} finally {
  $runner.Stop()
  $runner.Dispose()
  $ready.Dispose()
}

Write-Output 'Codex install User PATH cleanup tests passed.'

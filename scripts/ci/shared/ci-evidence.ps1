# Evidence helpers shared by the native client PowerShell wrappers. They are best
# effort: every call restores the caller's $LASTEXITCODE, so a ledger failure never
# becomes the step result (GitHub's pwsh step exits with $LASTEXITCODE), and an
# unusable evidence directory only disables evidence.

function Save-CiExitCode {
  $variable = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
  # Copy the value: Get-Variable returns the live variable, which the next native command overwrites.
  if ($variable) { return @{ Defined = $true; Value = $variable.Value } }
  return @{ Defined = $false }
}

function Restore-CiExitCode($Saved) {
  if ($Saved.Defined) { $global:LASTEXITCODE = $Saved.Value }
  else { Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue }
}

function Initialize-CiEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Tool,
    [Parameter(Mandatory = $true)][string]$RuntimeRoot
  )
  $script:CiEvidenceTool = $Tool
  $script:CiEvidenceDir = $null
  if (-not $env:MEMORAX_CI_EVIDENCE_DIR) { return }
  $saved = Save-CiExitCode
  try {
    $prepared = & node $Tool prepare $env:MEMORAX_CI_EVIDENCE_DIR $RuntimeRoot
    if ($LASTEXITCODE -eq 0 -and $prepared) { $script:CiEvidenceDir = ([string]($prepared | Select-Object -Last 1)).Trim() }
  } catch {
  } finally {
    Restore-CiExitCode $saved
  }
  if (-not $script:CiEvidenceDir) { Write-Warning 'CI evidence disabled: the evidence directory is unusable.' }
}

function Write-CiLedger {
  if (-not $script:CiEvidenceDir) { return }
  $saved = Save-CiExitCode
  $recorded = $false
  try {
    & node $script:CiEvidenceTool ledger $script:CiEvidenceDir @args
    $recorded = $LASTEXITCODE -eq 0
  } catch {
  } finally {
    Restore-CiExitCode $saved
  }
  if (-not $recorded) { Write-Warning 'CI evidence ledger could not be updated.' }
}

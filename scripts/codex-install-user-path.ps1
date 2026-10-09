function ConvertTo-CodexTestPathKey {
  param([AllowNull()][string]$Value)
  if ($null -eq $Value) { return '' }
  return $Value.Trim().Trim('"').Replace('/', '\').TrimEnd('\')
}

function Invoke-WithCodexTestUserPath {
  param(
    [Parameter(Mandatory = $true)][string]$Prefix,
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [scriptblock]$ReadPath = { [Environment]::GetEnvironmentVariable('Path', 'User') },
    [scriptblock]$WritePath = { param($Value) [Environment]::SetEnvironmentVariable('Path', $Value, 'User') }
  )

  $target = ConvertTo-CodexTestPathKey $Prefix
  $original = & $ReadPath
  $wasPresent = @($original -split ';' | Where-Object {
    [string]::Equals((ConvertTo-CodexTestPathKey $_), $target, [StringComparison]::OrdinalIgnoreCase)
  }).Count -gt 0

  try {
    & $Action
  } finally {
    if (-not $wasPresent) {
      $cleaned = $false
      for ($attempt = 0; $attempt -lt 3; $attempt++) {
        $current = & $ReadPath
        $entries = @($current -split ';')
        $retained = @($entries | Where-Object {
          -not [string]::Equals((ConvertTo-CodexTestPathKey $_), $target, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($retained.Count -eq $entries.Count) { $cleaned = $true; break }
        $updated = $retained -join ';'
        if ($null -eq $original -and $updated -eq '') { $updated = $null }

        # Recompute from the latest value when another installer changes PATH.
        # Preserve every unrelated entry verbatim instead of restoring a snapshot.
        $latest = & $ReadPath
        if (-not [string]::Equals($current, $latest, [StringComparison]::Ordinal)) { continue }
        & $WritePath $updated
        $remaining = & $ReadPath
        if (@($remaining -split ';' | Where-Object {
          [string]::Equals((ConvertTo-CodexTestPathKey $_), $target, [StringComparison]::OrdinalIgnoreCase)
        }).Count -eq 0) { $cleaned = $true; break }
      }
      if (-not $cleaned) { throw 'Failed to remove the test npm prefix from the Windows user PATH.' }
    }
  }
}

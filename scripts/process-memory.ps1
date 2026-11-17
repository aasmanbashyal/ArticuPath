param([Parameter(Mandatory)][int] $RootProcessId)
$ErrorActionPreference = 'Stop'
$processes = Get-CimInstance Win32_Process
$ids = [Collections.Generic.HashSet[int]]::new()
[void] $ids.Add($RootProcessId)
do {
  $added = $false
  foreach ($entry in $processes) {
    if ($ids.Contains([int] $entry.ParentProcessId) -and $ids.Add([int] $entry.ProcessId)) { $added = $true }
  }
} while ($added)
$running = @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
@{
  processCount = $running.Count
  sumWorkingSetMiB = [math]::Round(($running | Measure-Object WorkingSet64 -Sum).Sum / 1MB, 2)
  sumPrivateMemoryMiB = [math]::Round(($running | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB, 2)
  note = 'App and descendant processes. Summed working sets can count shared pages more than once.'
} | ConvertTo-Json -Compress

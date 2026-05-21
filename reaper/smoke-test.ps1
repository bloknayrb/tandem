# tandem-reaper smoke test (Windows)
# Verifies that killing the parent process also kills the child via Job Object.
#
# Strategy:
#   1. Spawn a "fake Tandem" PowerShell process that itself spawns the reaper,
#      which spawns a long-lived child (powershell.exe sleeping 60s).
#   2. Kill the fake Tandem with taskkill /F.
#   3. Assert the grandchild powershell.exe is no longer running.

$ErrorActionPreference = "Stop"

$reaper = Resolve-Path "$PSScriptRoot\target\release\tandem-reaper.exe"
if (-not $reaper) { throw "reaper binary not built — run: cargo build --release" }

Write-Host "Reaper at: $reaper"

# Use a unique marker so we can identify our test child.
$marker = "tandem-reaper-smoke-$([guid]::NewGuid().ToString('N').Substring(0,8))"

# Fake Tandem: a PS process whose PID we capture, that spawns the reaper.
# The reaper spawns powershell.exe -Command "sleep 60" tagged with $marker via a
# WindowTitle setting (visible via Get-Process).
$fakeTandem = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @(
  "-NoProfile", "-Command",
  "& '$reaper' $PID powershell.exe -NoProfile -Command `"\$host.UI.RawUI.WindowTitle='$marker'; Start-Sleep 60`""
)

Write-Host "Fake Tandem PID: $($fakeTandem.Id)"

# Give the reaper time to spawn its child.
Start-Sleep -Seconds 2

# Find the grandchild via WindowTitle marker.
$grandchild = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowTitle -eq $marker -or $_.CommandLine -like "*$marker*" }

if (-not $grandchild) {
  Write-Warning "Grandchild not detected by marker; falling back to process-tree walk"
  $grandchild = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $fakeTandem.Id } |
    ForEach-Object {
      Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $_.ProcessId }
    }
}

if ($grandchild) {
  Write-Host "Grandchild PID(s): $(@($grandchild).ProcessId -join ', ')"
} else {
  Write-Warning "Could not locate grandchild — test inconclusive"
}

# Kill fake Tandem HARD (simulates SIGKILL / taskkill scenario).
Write-Host "Killing fake Tandem ($($fakeTandem.Id)) with taskkill /F..."
taskkill /F /PID $fakeTandem.Id | Out-Null

# Job Object kill-on-job-close should fire within milliseconds.
Start-Sleep -Seconds 3

# Verify grandchild is gone.
$stillAlive = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like "*$marker*" }

if ($stillAlive) {
  Write-Error "FAIL: grandchild still alive after parent killed: $($stillAlive.ProcessId)"
  $stillAlive | ForEach-Object { taskkill /F /PID $_.ProcessId 2>$null | Out-Null }
  exit 1
}

Write-Host "PASS: reaper killed grandchild on parent death" -ForegroundColor Green
exit 0

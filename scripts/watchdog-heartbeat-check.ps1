# Meta-watcher for the main watchdog.
#
# Scheduled to run every 2 minutes. Does one thing: reads
# logs/watchdog.heartbeat, and if its last write was > $StaleSeconds
# ago, kills the watchdog process recorded inside it. Task Scheduler's
# RestartInterval on the watchdog task then brings it back within a
# minute.
#
# This closes the loop where the watchdog process is alive but stuck
# — something Task Scheduler alone can't detect. Example seen in
# practice: Invoke-WebRequest hangs on a half-open socket past its
# own -TimeoutSec, main loop never advances, no log entries get
# written, watchdog process uptime keeps growing, stack outage goes
# unhandled.
#
# Idempotent: if the watchdog isn't installed, or the heartbeat file
# doesn't exist yet (fresh install), the meta-watcher silently exits.
# If the heartbeat is fresh, it does nothing. Either way: exit 0.

[CmdletBinding()]
param(
  [int]$StaleSeconds = 180,
  [string]$MetaLogName = 'watchdog-meta.log'
)

$ErrorActionPreference = 'Continue'

$Root          = Split-Path -Parent $PSScriptRoot
$LogDir        = Join-Path $Root 'logs'
$HeartbeatFile = Join-Path $LogDir 'watchdog.heartbeat'
$MetaLog       = Join-Path $LogDir $MetaLogName

function Write-MetaLog {
  param([string]$Level, [string]$Message)
  $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  try {
    Add-Content -Path $MetaLog -Value "$ts $Level $Message" -Encoding utf8 -ErrorAction Stop
  } catch { }
}

if (-not (Test-Path $HeartbeatFile)) {
  # First run after install, or watchdog never wrote. Don't scream —
  # Task Scheduler's own restart of the watchdog task will sort it.
  exit 0
}

try {
  $info = Get-Item $HeartbeatFile -ErrorAction Stop
} catch {
  Write-MetaLog 'WARN' "cannot stat heartbeat: $($_.Exception.Message)"
  exit 0
}

$ageSec = [int]((Get-Date) - $info.LastWriteTime).TotalSeconds
if ($ageSec -le $StaleSeconds) {
  # Healthy — stay silent.
  exit 0
}

# Stale. Read the pid the watchdog stamped and kill it.
$content = ''
try { $content = Get-Content -Path $HeartbeatFile -Raw -Encoding ascii -ErrorAction Stop } catch { }
$watchdogPid = $null
if ($content -match 'pid=(\d+)') { $watchdogPid = [int]$matches[1] }

Write-MetaLog 'STALE' "heartbeat age=${ageSec}s (threshold=${StaleSeconds}s) pid=$watchdogPid content='$($content.Trim())'"

if ($watchdogPid) {
  $proc = Get-Process -Id $watchdogPid -ErrorAction SilentlyContinue
  if ($proc) {
    try {
      Stop-Process -Id $watchdogPid -Force -ErrorAction Stop
      Write-MetaLog 'KILLED' "watchdog pid=$watchdogPid killed — Task Scheduler will auto-restart"
    } catch {
      Write-MetaLog 'ERROR' "Stop-Process pid=$watchdogPid failed: $($_.Exception.Message)"
    }
  } else {
    Write-MetaLog 'GONE' "watchdog pid=$watchdogPid not running (already died?)"
  }
} else {
  # Couldn't parse a pid — fall back to killing anything matching the
  # watchdog script path. Regex matches literal watchdog.ps1 with a
  # path separator in front so this script's own command line doesn't
  # self-match (watchdog-heartbeat-check.ps1 lacks the pattern).
  $orphans = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match '[\\/]watchdog\.ps1' }
  foreach ($p in $orphans) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      Write-MetaLog 'KILLED-ORPHAN' "pid=$($p.ProcessId)"
    } catch {
      Write-MetaLog 'ERROR' "Stop-Process pid=$($p.ProcessId) failed: $($_.Exception.Message)"
    }
  }
}

exit 0

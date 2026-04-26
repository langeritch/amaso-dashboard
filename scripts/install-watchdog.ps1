# Install/refresh the Amaso watchdog scheduled tasks.
#
# Registers two tasks:
#
#   AmasoDashboard-Watchdog      — the main long-lived loop. Probes
#                                  dashboard + tunnel + kokoro every
#                                  $IntervalSeconds and repairs drift.
#                                  AtStartup + AtLogOn triggers;
#                                  auto-restarts on crash forever.
#
#   AmasoDashboard-WatchdogMeta  — the meta-watcher. Fires every 2 min
#                                  indefinitely. Reads the heartbeat
#                                  file the main watchdog stamps each
#                                  tick; if it's stale > 3 min, kills
#                                  the wedged watchdog so Task
#                                  Scheduler can restart it. Tiny,
#                                  one-shot, never loops inside itself.
#
# Safe to re-run: both tasks are unregistered first, and any orphan
# watchdog child processes are reaped before re-registration.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1
#
# Verify afterwards:
#   Get-Content logs\watchdog.log -Tail 20 -Wait
#   Get-Content logs\watchdog-meta.log -Tail 20 -Wait
#   schtasks /Query /TN AmasoDashboard-Watchdog /V /FO LIST

[CmdletBinding()]
param(
  [string]$TaskName      = 'AmasoDashboard-Watchdog',
  [string]$MetaTaskName  = 'AmasoDashboard-WatchdogMeta',
  [int]$IntervalSeconds  = 30,
  [int]$MetaIntervalMinutes = 2,
  [int]$MetaStaleSeconds = 180
)

$ErrorActionPreference = 'Stop'

$Root       = Split-Path -Parent $PSScriptRoot
$Script     = Join-Path $Root 'scripts\watchdog.ps1'
$MetaScript = Join-Path $Root 'scripts\watchdog-heartbeat-check.ps1'
if (-not (Test-Path $Script))     { throw "watchdog script not found: $Script" }
if (-not (Test-Path $MetaScript)) { throw "meta watchdog script not found: $MetaScript" }

$psExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

# ── Unregister any existing instances first ─────────────────────────
foreach ($tn in @($TaskName, $MetaTaskName)) {
  try {
    Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction Stop
    Write-Host "Removed existing task $tn"
  } catch {
    # Not installed — nothing to remove.
  }
}

# Unregistering the main task does NOT stop the running child. Reap
# any orphan watchdog child processes so we don't end up with multiple
# loops after reinstall. Match on a path-anchored pattern so this
# installer (which contains "watchdog" in its own command line) isn't
# caught in the net.
$selfPid = $PID
$existing = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -match '[\\/]watchdog\.ps1' -and
    [int]$_.ProcessId -ne $selfPid
  }
foreach ($p in $existing) {
  Write-Host "Stopping orphan watchdog pid=$($p.ProcessId)"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

# ── MAIN WATCHDOG TASK ──────────────────────────────────────────────

$mainArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`" -IntervalSeconds $IntervalSeconds"

$mainAction = New-ScheduledTaskAction `
  -Execute $psExe -Argument $mainArgs -WorkingDirectory $Root

$trigStart = New-ScheduledTaskTrigger -AtStartup
$trigLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# LogonType S4U ("Service For User") = run whether user is logged on or not,
# but without storing a password. The task runs in session 0 with NO console
# window at all — not even a flash — so the desktop stays clean. Interactive
# logon type would still flash conhost even with -WindowStyle Hidden.
# RunLevel Limited keeps it non-elevated; S4U works fine for HTTP probes to
# 127.0.0.1 and for schtasks /End + /Run on tasks owned by the same user.
$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

# Settings: never stop trying. RestartInterval=1min means if the meta-
# watcher kills a wedged watchdog, it's back up within a minute.
$mainSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -RestartCount 9999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $mainAction `
  -Trigger @($trigStart, $trigLogon) `
  -Principal $principal `
  -Settings $mainSettings `
  -Description 'Monitors the Amaso Dashboard, Cloudflare Tunnel, and Kokoro TTS sidecar; restarts anything that drifts.' `
  | Out-Null

Write-Host "Registered $TaskName"

# ── META-WATCHER TASK ────────────────────────────────────────────────
# Lightweight one-shot that runs every $MetaIntervalMinutes via
# TriggerRepetition for the task's entire lifetime. Uses a trigger
# that starts right now and repeats indefinitely.

$metaArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$MetaScript`" -StaleSeconds $MetaStaleSeconds"

$metaAction = New-ScheduledTaskAction `
  -Execute $psExe -Argument $metaArgs -WorkingDirectory $Root

# One-time trigger starting 1 min from now, repeating every N minutes
# for a very long duration (Task Scheduler's notion of "indefinitely"
# requires a finite -RepetitionDuration; use something huge).
$start = (Get-Date).AddMinutes(1)
$metaTrig = New-ScheduledTaskTrigger -Once -At $start `
  -RepetitionInterval (New-TimeSpan -Minutes $MetaIntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

# Also fire at startup/logon so the meta-watcher runs immediately after
# reboot without waiting for the one-time trigger's start-time.
$metaTrigStart = New-ScheduledTaskTrigger -AtStartup
$metaTrigLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Each meta-watcher fire is a short script — constrain it to 1 minute
# max so a bug can't accidentally pin the task in a long run.
$metaSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $MetaTaskName `
  -Action $metaAction `
  -Trigger @($metaTrig, $metaTrigStart, $metaTrigLogon) `
  -Principal $principal `
  -Settings $metaSettings `
  -Description "Meta-watcher: kills the main Amaso watchdog if its heartbeat file is stale > ${MetaStaleSeconds}s. Runs every ${MetaIntervalMinutes} min." `
  | Out-Null

Write-Host "Registered $MetaTaskName (every $MetaIntervalMinutes min, stale-threshold ${MetaStaleSeconds}s)"

# ── Start everything now ────────────────────────────────────────────
Write-Host ""
Write-Host "Starting tasks..."
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $MetaTaskName
Start-Sleep -Seconds 1

Write-Host ""
foreach ($tn in @($TaskName, $MetaTaskName)) {
  $task = Get-ScheduledTask -TaskName $tn
  $info = Get-ScheduledTaskInfo -TaskName $tn
  Write-Host ("{0,-30} State={1}  Last=0x{2}" -f $tn, $task.State, [Convert]::ToString($info.LastTaskResult, 16))
}

Write-Host ""
Write-Host "Tail the logs with:"
Write-Host "  Get-Content '$(Join-Path $Root 'logs\watchdog.log')' -Tail 20 -Wait"
Write-Host "  Get-Content '$(Join-Path $Root 'logs\watchdog-meta.log')' -Tail 20 -Wait"

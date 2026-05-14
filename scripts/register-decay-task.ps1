# Install/refresh the Amaso topic-aware daily-log decay task.
#
# Registers a single scheduled task:
#
#   AmasoDashboard-DailyLogDecay — runs once per day at $RunAtTime
#                                  (default 03:30 local, 30 minutes
#                                  after AmasoDashboard-DailyExtraction
#                                  so yesterday's extraction has had
#                                  time to finish first). Invokes
#                                  `npm run compact-daily-logs`. Output
#                                  appends to logs/daily-log-decay.log
#                                  via the cmd redirect.
#
# Safe to re-run: the task is unregistered first if it already exists.
# Does NOT touch AmasoDashboard-DailyExtraction or AmasoDashboard-Watchdog.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-decay-task.ps1
#
# Verify afterwards:
#   schtasks /Query /TN AmasoDashboard-DailyLogDecay /V /FO LIST
#   Get-Content logs\daily-log-decay.log -Tail 40 -Wait

[CmdletBinding()]
param(
  [string]$TaskName  = 'AmasoDashboard-DailyLogDecay',
  # 03:30 local — late enough that the 03:00 extraction task has
  # finished writing facts before we walk the same files for decay.
  [string]$RunAtTime = '03:30'
)

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$ScriptRel = 'scripts\compact-daily-logs.ts'
$ScriptAbs = Join-Path $Root $ScriptRel
if (-not (Test-Path $ScriptAbs)) { throw "compactor not found: $ScriptAbs" }

# ── Unregister any existing instance first ──────────────────────────
try {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
  Write-Host "Removed existing task $TaskName"
} catch {
  # Not installed — nothing to remove.
}

# ── Resolve npm CLI (same shim hunt as the extraction task) ─────────
$npmCmd = "$env:ProgramFiles\nodejs\npm.cmd"
if (-not (Test-Path $npmCmd)) {
  $altA = "$env:APPDATA\npm\npm.cmd"
  $altB = "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd"
  if (Test-Path $altA) { $npmCmd = $altA }
  elseif (Test-Path $altB) { $npmCmd = $altB }
  else { throw "could not find npm.cmd on PATH; tried Program Files, APPDATA, LOCALAPPDATA" }
}

$cronLog = Join-Path $Root 'logs\daily-log-decay.log'
$action = New-ScheduledTaskAction `
  -Execute 'cmd.exe' `
  -Argument "/c `"$npmCmd`" run compact-daily-logs >> `"$cronLog`" 2>&1" `
  -WorkingDirectory $Root

# Daily trigger at the configured wall-clock time. If today's slot
# already passed, push the first run to tomorrow.
$today = [DateTime]::Today
$parts = $RunAtTime.Split(':')
if ($parts.Count -ne 2) { throw "RunAtTime must be HH:mm, got: $RunAtTime" }
$start = $today.AddHours([int]$parts[0]).AddMinutes([int]$parts[1])
if ($start -lt [DateTime]::Now) { $start = $start.AddDays(1) }
$trigger = New-ScheduledTaskTrigger -Daily -At $start

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 15) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Smart Topic System Layer 7: topic-aware daily-log decay. Walks daily/ + users/<slug>/daily/, classifies each file by age band, and rewrites via Haiku at the target detail level — bumping one level lighter when a section is tied to a hot topic. Runs $RunAtTime local, 30 minutes after AmasoDashboard-DailyExtraction." `
  | Out-Null

Write-Host "Registered $TaskName"
Write-Host "  command   : $npmCmd run compact-daily-logs"
Write-Host "  next run  : $start"
Write-Host "  cron log  : $cronLog"

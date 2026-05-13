# Install/refresh the Amaso nightly fact-extraction task.
#
# Registers a single scheduled task:
#
#   AmasoDashboard-DailyExtraction — runs once per day at $RunAtTime
#                                    (default 03:00 local). Invokes
#                                    `npm run extract-facts` against
#                                    yesterday's daily chat for the
#                                    default user (santi). Output
#                                    appends to logs/extraction-cron.log
#                                    via the cmd redirect.
#
# Safe to re-run: the task is unregistered first if it already exists.
# Does NOT touch AmasoDashboard-Watchdog or any other existing task.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-extraction-task.ps1
#
# Verify afterwards:
#   schtasks /Query /TN AmasoDashboard-DailyExtraction /V /FO LIST
#   Get-Content logs\daily-extractions.log -Tail 40 -Wait

[CmdletBinding()]
param(
  [string]$TaskName = 'AmasoDashboard-DailyExtraction',
  # Default 03:00 local — late enough that any spar message sent
  # around midnight has already landed and committed.
  [string]$RunAtTime = '03:00'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ScriptRel = 'scripts\extract-daily-facts.ts'
$ScriptAbs = Join-Path $Root $ScriptRel
if (-not (Test-Path $ScriptAbs)) { throw "extractor not found: $ScriptAbs" }

# ── Unregister any existing instance first ──────────────────────────
try {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
  Write-Host "Removed existing task $TaskName"
} catch {
  # Not installed — nothing to remove.
}

# ── Resolve npm CLI ─────────────────────────────────────────────────
# Use npm.cmd (the shim) rather than node directly so the task picks up
# whichever Node version `node --version` resolves to on Santi's box;
# the extractor lives behind `npm run extract-facts`. tsx is loaded by
# npm via the package.json scripts entry, so no manual flag plumbing.
$npmCmd = "$env:ProgramFiles\nodejs\npm.cmd"
if (-not (Test-Path $npmCmd)) {
  $altA = "$env:APPDATA\npm\npm.cmd"
  $altB = "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd"
  if (Test-Path $altA) { $npmCmd = $altA }
  elseif (Test-Path $altB) { $npmCmd = $altB }
  else { throw "could not find npm.cmd on PATH; tried Program Files, APPDATA, LOCALAPPDATA" }
}

# Redirect stdout + stderr into a per-run log so a Task Scheduler view
# isn't the only place that captures failures. The library also writes
# to logs/daily-extractions.log via its own logger; this cron log is
# the wrapping-process view (npm exit code, child stack traces).
$cronLog = Join-Path $Root 'logs\extraction-cron.log'
$action = New-ScheduledTaskAction `
  -Execute 'cmd.exe' `
  -Argument "/c `"$npmCmd`" run extract-facts >> `"$cronLog`" 2>&1" `
  -WorkingDirectory $Root

# Daily trigger at the configured wall-clock time. StartBoundary uses
# the script's "today" — Task Scheduler then repeats every 24h.
$today = [DateTime]::Today
$parts = $RunAtTime.Split(':')
if ($parts.Count -ne 2) { throw "RunAtTime must be HH:mm, got: $RunAtTime" }
$start = $today.AddHours([int]$parts[0]).AddMinutes([int]$parts[1])
# If today's slot already passed, push the first run to tomorrow.
if ($start -lt [DateTime]::Now) { $start = $start.AddDays(1) }
$trigger = New-ScheduledTaskTrigger -Daily -At $start

# S4U so the task fires when Santi isn't logged in. Limited run level
# is fine — the extractor only reads the local DB, writes to brain
# files inside Santi's home, and POSTs to api.anthropic.com.
$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

# Settings: retry a few times if the network is down at 03:00, give up
# after an hour so a wedged run doesn't sit in the queue past sunrise.
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
  -Description "Smart Topic System Layer 4: nightly extraction of durable facts from yesterday's spar daily chat into the brain files. Runs $RunAtTime local." `
  | Out-Null

Write-Host "Registered $TaskName"
Write-Host "  command   : $npmCmd run extract-facts"
Write-Host "  next run  : $start"
Write-Host "  cron log  : $cronLog"
Write-Host "  lib log   : logs\daily-extractions.log"

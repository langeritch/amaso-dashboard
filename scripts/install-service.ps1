# Amaso Dashboard — install Windows Scheduled Tasks for auto-start.
#
# Creates two tasks that run at user login:
#   1. AmasoDashboard-App    — the Next.js server (npm start)
#   2. AmasoDashboard-Tunnel — cloudflared serving dashboard.amaso.nl
#
# Run as your normal user in PowerShell. Tasks run whether or not you're
# logged in (on battery + AC), and restart automatically on failure.

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir      = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$configFile  = "$env:USERPROFILE\.cloudflared\amaso-dashboard.yml"
$tunnelName  = "amaso-dashboard"

$npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
if (-not $npm) { Write-Error "npm not found on PATH"; exit 1 }

# --- Task 1: the Next.js app ---------------------------------------------
$appAction = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$projectRoot\scripts\run-loop.cmd`"" `
    -WorkingDirectory $projectRoot

$appTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

# LogonType S4U ("Service For User") runs the task in session 0 — no
# desktop, no console window, nothing for the user to accidentally close.
# The cmd.exe still spawns, but it's invisible and its stdio goes to the
# log files as usual. RunLevel Limited keeps it non-elevated.
$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

Register-ScheduledTask `
    -TaskName "AmasoDashboard-App" `
    -Action $appAction `
    -Trigger $appTrigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host "Registered task: AmasoDashboard-App" -ForegroundColor Green

# --- Task 2: the Cloudflare Tunnel ---------------------------------------
if (-not (Test-Path $cloudflared)) {
    Write-Warning "cloudflared.exe not found — skipping tunnel task. Install cloudflared then re-run."
} elseif (-not (Test-Path $configFile)) {
    Write-Warning "Tunnel config $configFile not found. Run scripts/setup-tunnel.ps1 first."
} else {
    $tunnelAction = New-ScheduledTaskAction `
        -Execute $cloudflared `
        -Argument "tunnel --config `"$configFile`" run $tunnelName"

    $tunnelTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

    Register-ScheduledTask `
        -TaskName "AmasoDashboard-Tunnel" `
        -Action $tunnelAction `
        -Trigger $tunnelTrigger `
        -Settings $settings `
        -Principal $principal `
        -Force | Out-Null

    Write-Host "Registered task: AmasoDashboard-Tunnel" -ForegroundColor Green
}

Write-Host ""
Write-Host "Start both now:" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName AmasoDashboard-App"
Write-Host "  Start-ScheduledTask -TaskName AmasoDashboard-Tunnel"
Write-Host ""
Write-Host "Remove later with:" -ForegroundColor Cyan
Write-Host "  Unregister-ScheduledTask -TaskName AmasoDashboard-App    -Confirm:`$false"
Write-Host "  Unregister-ScheduledTask -TaskName AmasoDashboard-Tunnel -Confirm:`$false"

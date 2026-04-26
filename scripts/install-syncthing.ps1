# Amaso Dashboard — one-shot Syncthing installer for Windows.
#
# What this does:
#   1. Installs Syncthing via winget (skips if already present)
#   2. Registers a Scheduled Task so Syncthing auto-starts at login
#   3. Starts it, waits for the Web UI to come up, opens it in a browser
#   4. Prints the device ID so you can pair it from your Mac
#
# Your folder on this PC will live at: C:\Users\<you>\projects\neva17
# (Syncthing will create it when you accept the share from the Mac side.)

$ErrorActionPreference = "Stop"

# ---- 1. Install ---------------------------------------------------------
$existing = Get-Command syncthing.exe -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "==> syncthing already installed at $($existing.Source)" -ForegroundColor Green
    $stExe = $existing.Source
} else {
    Write-Host "==> Installing Syncthing via winget..." -ForegroundColor Cyan
    winget install --id Syncthing.Syncthing --silent --accept-source-agreements --accept-package-agreements
    # winget PATH update doesn't apply to the running session — locate the binary.
    $candidates = @(
        # winget-style package dir (where Syncthing.Syncthing actually lands)
        "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Syncthing.Syncthing_*\syncthing.exe",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Syncthing.Syncthing_*\*\syncthing.exe",
        # Classic installer locations in case someone grabbed the standalone .msi
        "$env:LOCALAPPDATA\Programs\Syncthing\syncthing.exe",
        "${env:ProgramFiles}\Syncthing\syncthing.exe"
    )
    foreach ($pattern in $candidates) {
        $found = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $stExe = $found.FullName; break }
    }
    if (-not $stExe) {
        Write-Error "syncthing.exe not found after install. Install manually from https://syncthing.net/"
        exit 1
    }
    Write-Host "   Found: $stExe" -ForegroundColor DarkGray
}

# ---- 2. Scheduled Task (auto-start at login) ----------------------------
$taskName = "Syncthing"
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existingTask) {
    Write-Host "==> Registering Scheduled Task '$taskName' (runs at login)" -ForegroundColor Cyan
    $action   = New-ScheduledTaskAction   -Execute $stExe -Argument "serve --no-browser --no-restart"
    $trigger  = New-ScheduledTaskTrigger  -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
}

# ---- 3. Start it + wait for the Web UI ---------------------------------
Write-Host "==> Starting Syncthing..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $taskName

$uiUrl = "http://localhost:8384"
$ready = $false
# First-run setup can take up to a minute while Syncthing generates certs
for ($i = 0; $i -lt 90; $i++) {
    try {
        Invoke-WebRequest -Uri $uiUrl -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop | Out-Null
        $ready = $true
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $ready) {
    Write-Warning "Syncthing didn't respond within 90s. It may still be starting — check $uiUrl in a moment."
}

# ---- 4. Device ID -------------------------------------------------------
# `syncthing --device-id` changed between versions, so read it via the
# REST API using the API key from the generated config.
$deviceId = $null
$configFile = Join-Path $env:LOCALAPPDATA "Syncthing\config.xml"
if (Test-Path $configFile) {
    try {
        [xml]$cfg = Get-Content $configFile
        $apiKey = $cfg.configuration.gui.apikey
        if ($apiKey) {
            $resp = Invoke-RestMethod -Uri "$uiUrl/rest/system/status" -Headers @{ "X-API-Key" = $apiKey } -TimeoutSec 5
            $deviceId = $resp.myID
        }
    } catch {
        Write-Warning "Couldn't read device ID automatically. Open $uiUrl and copy it from Actions → Show ID."
    }
}
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Syncthing is up." -ForegroundColor Green
Write-Host ""
Write-Host " This PC's device ID:" -ForegroundColor Cyan
Write-Host "   $deviceId" -ForegroundColor White
Write-Host ""
Write-Host " Web UI: $uiUrl (will open in your browser)" -ForegroundColor Cyan
Write-Host ""
Write-Host " Next, on your Mac:" -ForegroundColor Cyan
Write-Host "   1. Install Syncthing:   brew install --cask syncthing" -ForegroundColor White
Write-Host "      (or download from   https://syncthing.net/)" -ForegroundColor White
Write-Host "   2. Open http://localhost:8384 on the Mac" -ForegroundColor White
Write-Host "   3. Add Remote Device  →  paste the device ID above" -ForegroundColor White
Write-Host "   4. Share your NEVA17 folder with this PC" -ForegroundColor White
Write-Host "   5. Accept the share prompt that appears here on Windows" -ForegroundColor White
Write-Host "      and set the receive path to:" -ForegroundColor White
Write-Host "        C:\Users\$env:USERNAME\projects\neva17" -ForegroundColor Yellow
Write-Host ""
Write-Host " After it's done syncing, run this in the dashboard project:" -ForegroundColor Cyan
Write-Host "   # edit amaso.config.json → set neva17.path to the folder above" -ForegroundColor White
Write-Host "   # then restart the server to pick up the new watch root" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Green

Start-Process $uiUrl

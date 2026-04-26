# Amaso Dashboard — Cloudflare Tunnel setup
# One-time bootstrap. Run in PowerShell as your normal user.
#
#   1. Authenticate cloudflared to your Cloudflare account
#   2. Create a named tunnel
#   3. Route dashboard.amaso.nl -> the tunnel
#   4. Write a config pointing the tunnel at http://localhost:3000
#
# Afterwards: run scripts/install-service.ps1 to install the auto-start task.

$ErrorActionPreference = "Stop"

$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$tunnelName  = "amaso-dashboard"
$hostname    = "dashboard.amaso.nl"
$localPort   = 3737
$configDir   = "$env:USERPROFILE\.cloudflared"
$configFile  = "$configDir\amaso-dashboard.yml"

if (-not (Test-Path $cloudflared)) {
    Write-Error "cloudflared not found at $cloudflared. Install it first: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    exit 1
}

Write-Host "==> Step 1: Authenticate cloudflared (browser will open)" -ForegroundColor Cyan
& $cloudflared tunnel login

Write-Host "==> Step 2: Create tunnel '$tunnelName'" -ForegroundColor Cyan
try {
    & $cloudflared tunnel create $tunnelName
} catch {
    Write-Host "Tunnel may already exist, continuing." -ForegroundColor Yellow
}

# Find the credentials file that was just created
$credFile = Get-ChildItem "$configDir\*.json" |
    Where-Object { (Get-Content $_.FullName -Raw) -match "`"TunnelName`"\s*:\s*`"$tunnelName`"" } |
    Select-Object -First 1

if (-not $credFile) {
    # Fall back: list tunnels and pick the newest json whose name matches the id
    $list = & $cloudflared tunnel list
    Write-Host $list
    Write-Error "Could not locate credentials file for '$tunnelName' in $configDir. Please locate it manually and re-run step 3 by hand."
    exit 1
}

Write-Host "==> Step 3: Route DNS $hostname -> $tunnelName" -ForegroundColor Cyan
& $cloudflared tunnel route dns $tunnelName $hostname

Write-Host "==> Step 4: Write config to $configFile" -ForegroundColor Cyan
$credPath = $credFile.FullName
$config = @"
tunnel: $tunnelName
credentials-file: $credPath

ingress:
  - hostname: $hostname
    service: http://localhost:$localPort
    originRequest:
      noTLSVerify: true
  - service: http_status:404
"@
Set-Content -Path $configFile -Value $config -Encoding UTF8

Write-Host ""
Write-Host "Done. Test it by running:" -ForegroundColor Green
Write-Host "  & `"$cloudflared`" tunnel --config `"$configFile`" run $tunnelName" -ForegroundColor Green
Write-Host ""
Write-Host "Then install auto-start: scripts/install-service.ps1" -ForegroundColor Green

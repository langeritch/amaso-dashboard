# Amaso Dashboard watchdog.
#
# Runs as a Windows Scheduled Task (see scripts/install-watchdog.ps1).
# Every $IntervalSeconds it probes the three pieces of the stack and
# nudges whatever has drifted:
#
#   1. Dashboard — HTTP GET http://127.0.0.1:3737/login
#        Expected: 200. On failure, schtasks /End + /Run AmasoDashboard-App.
#   2. Tunnel    — HTTPS GET https://dashboard.amaso.nl/login
#        Expected: 200. On failure, schtasks /End + /Run AmasoDashboard-Tunnel.
#   3. Kokoro    — HTTP GET http://127.0.0.1:3939/health
#        Expected: 200 "ok". On failure, kill all kokoros and spawn one.
#        Also: if >1 kokoro interpreter is bound, kill the non-listeners.
#
# Every action is logged to logs/watchdog.log with UTC timestamps.
#
# STALL PROTECTION (new):
# - Every tick — at the very top, before any probe runs — the watchdog
#   stamps a UTC ISO timestamp into logs/watchdog.heartbeat. A separate
#   scheduled task (scripts/watchdog-heartbeat-check.ps1, fires every
#   2 min) reads that file and kills this process if the stamp is >
#   $HeartbeatStaleSeconds old. Task Scheduler's auto-restart then
#   brings the watchdog back up within a minute.
#
#   This catches the failure mode where Invoke-WebRequest hangs past
#   its -TimeoutSec on a half-open socket (seen in practice when a
#   dashboard restart produces a socket that accepts connections but
#   never sends response bytes).
#
# - Each HTTP probe runs in a background PowerShell Job with a hard
#   Wait-Job timeout that force-terminates the job. This makes the
#   timeout real — the main loop cannot be blocked indefinitely by
#   .NET socket primitives.

[CmdletBinding()]
param(
  [int]$IntervalSeconds = 30,
  [string]$DashboardUrl = 'http://127.0.0.1:3737/login',
  [string]$TunnelUrl    = 'https://dashboard.amaso.nl/login',
  [string]$KokoroUrl    = 'http://127.0.0.1:3939/health',
  [string]$DashboardTask = 'AmasoDashboard-App',
  [string]$TunnelTask    = 'AmasoDashboard-Tunnel',
  [string]$KokoroTask    = 'AmasoKokoroSidecar',
  # Soft (inside the job) + hard (Wait-Job cutoff) probe timeouts.
  # Hard must be > soft so a well-behaved probe gets a chance to return
  # its own error before the job is force-stopped.
  [int]$HttpSoftTimeoutSeconds = 8,
  [int]$HttpHardTimeoutSeconds = 12,
  # 3 consecutive fails (~90s of continuous badness) before we trigger a
  # repair. Was 2 — too trigger-happy: a single GC pause on the 3GB
  # Node mother process timed out one probe, the next probe hit a
  # half-compiled Next and failed too, and we killed a perfectly
  # recoverable server.
  [int]$FailureThreshold = 3,
  # After a repair action, skip probes of that component for this many
  # seconds. Next-dev with turbopack takes 30-60s to boot; cloudflared
  # takes ~5s; kokoro takes ~6s (model warm-up). Without this cooldown
  # the watchdog enters a flap loop: kill → probe mid-restart → "still
  # unhealthy" → kill the restarting process → loop for minutes. Seen
  # in practice at 2026-04-24T03:40-03:55Z — a single GC pause turned
  # into a 15-minute outage because each /Run was cut short by the next
  # /End.
  [int]$RepairCooldownDashboard = 120,
  [int]$RepairCooldownTunnel    = 60,
  [int]$RepairCooldownKokoro    = 60,
  [int]$MaxLogBytes = 2MB
)

$ErrorActionPreference = 'Continue'

$Root          = Split-Path -Parent $PSScriptRoot
$LogDir        = Join-Path $Root 'logs'
$Log           = Join-Path $LogDir 'watchdog.log'
$HeartbeatFile = Join-Path $LogDir 'watchdog.heartbeat'
# When run-loop-prod.cmd is rebuilding `.next` it drops this file at the
# start of `npm run build` and removes it when the build finishes. Builds
# can take 25-60s, during which the dashboard cannot answer probes. If
# the watchdog kills the task mid-build, the new run-loop instance just
# starts another fresh build — leading to a "perpetual rebuild" outage
# that we hit on 2026-04-26 ~14:08 UTC. Honour the lock by suppressing
# both the dashboard probe AND the tunnel probe (tunnel 502s while origin
# is down — same sentinel, same suppression).
$BuildLockFile = Join-Path $LogDir 'build.lock'
$BuildLockMaxAgeSeconds = 600

# ── Auto-fixer (preventive) ──────────────────────────────────────────
# These run at the TOP of every tick, before any HTTP probe. The probe
# layer reacts to symptoms; the auto-fixer fixes root causes we've
# already diagnosed in past incidents so we never see the symptom.
#
# Each fixer:
#   - is idempotent (safe to run every tick)
#   - is cheap (<50 ms typical) so we don't blow the tick budget
#   - logs only when it CHANGES state, so the log doesn't fill with no-ops
#
# What's covered today:
#   1. .env.local must contain AMASO_PROJECTS_ROOT — without it server.ts
#      validateEnv() exits ~50ms after boot and the run-loop spirals.
#      (2026-04-26 outage.)
#   2. .next\BUILD_ID must exist — without it `npm start` aborts in 1s,
#      run-loop sees the gap and rebuilds, watchdog's old logic killed
#      mid-build → perpetual rebuild. Pre-emptively trigger a build
#      ourselves and drop the build.lock so probes back off cleanly.
#   3. Crash-loop detector — if app.log shows ≥3 `[env] FATAL` lines in
#      the last 3 minutes the server is in a fast-respawn loop. The
#      env-fixer above SHOULD have already healed this; if it didn't,
#      page loudly so the operator sees it on the next status check.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvLocalFile = Join-Path $RepoRoot '.env.local'
$BuildIdFile  = Join-Path $RepoRoot '.next\BUILD_ID'
# Canonical baseline. If .env.local is ever wiped, these are the values
# we restore for required keys ONLY. We never write VAPID/TELEGRAM
# secrets — those live in the operator's password manager and a missing
# secret is a warn, not a crash.
$EnvLocalRequiredDefaults = @{
  'AMASO_PROJECTS_ROOT' = 'C:\Users\santi\projects'
}
$AppLogFile = Join-Path $LogDir 'app.log'
$LastFatalLoopAlertFile = Join-Path $LogDir 'fatal-loop.alerted'

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# ── Utilities ────────────────────────────────────────────────────────

function Get-UtcIso { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }

function Write-Log {
  param([string]$Level, [string]$Message)
  $line = "$(Get-UtcIso) $Level $Message"
  try {
    Add-Content -Path $Log -Value $line -Encoding utf8 -ErrorAction Stop
  } catch {
    # If the log file is locked or the disk is full, keep running —
    # the heartbeat file is a separate path and still tells the meta-
    # watcher we're alive.
  }
}

function Touch-Heartbeat {
  # Small, atomic-ish: write UTC timestamp + pid to the heartbeat file
  # every tick. Using Set-Content (not Add-Content) so the file stays
  # exactly one line. A stale heartbeat = a stalled watchdog.
  $payload = "$(Get-UtcIso) pid=$PID"
  try {
    Set-Content -Path $HeartbeatFile -Value $payload -Encoding ascii -ErrorAction Stop
  } catch {
    # Not fatal — meta-watcher will see staleness and recycle us.
  }
}

function Rotate-LogIfNeeded {
  if (-not (Test-Path $Log)) { return }
  try {
    $size = (Get-Item $Log -ErrorAction Stop).Length
  } catch { return }
  if ($size -lt $MaxLogBytes) { return }
  $log1 = "$Log.1"; $log2 = "$Log.2"
  if (Test-Path $log2) { Remove-Item $log2 -Force -ErrorAction SilentlyContinue }
  if (Test-Path $log1) { Move-Item $log1 $log2 -Force -ErrorAction SilentlyContinue }
  Move-Item $Log $log1 -Force -ErrorAction SilentlyContinue
}

function Probe-Http {
  param([string]$Url)
  # Hard-timeout probe. Runs Invoke-WebRequest inside a Start-Job and
  # Wait-Job's timeout force-kills the job if it exceeds the hard cap.
  # That makes -TimeoutSec hangs (which we've actually hit in prod)
  # impossible to propagate up to the main loop.
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $job = $null
  try {
    $job = Start-Job -ScriptBlock {
      param($u, $soft)
      $ErrorActionPreference = 'Stop'
      try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $u -MaximumRedirection 0 -TimeoutSec $soft
        return [pscustomobject]@{ ok = ([int]$r.StatusCode -ge 200 -and [int]$r.StatusCode -lt 400); status = [int]$r.StatusCode }
      } catch {
        $resp = $_.Exception.Response
        if ($resp) {
          try {
            $code = [int]$resp.StatusCode
            return [pscustomobject]@{ ok = ($code -ge 200 -and $code -lt 400); status = $code }
          } catch { }
        }
        return [pscustomobject]@{ ok = $false; status = $_.Exception.Message }
      }
    } -ArgumentList $Url, $HttpSoftTimeoutSeconds

    $finished = Wait-Job -Job $job -Timeout $HttpHardTimeoutSeconds
    if (-not $finished) {
      # Job still running past the hard timeout — kill it.
      Stop-Job -Job $job -ErrorAction SilentlyContinue | Out-Null
      Remove-Job -Job $job -Force -ErrorAction SilentlyContinue | Out-Null
      $sw.Stop()
      return @{ ok = $false; status = "HARD_TIMEOUT_${HttpHardTimeoutSeconds}s"; elapsedMs = [int]$sw.ElapsedMilliseconds }
    }
    $result = Receive-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue | Out-Null
    $sw.Stop()
    if ($null -eq $result) {
      return @{ ok = $false; status = "NO_RESULT"; elapsedMs = [int]$sw.ElapsedMilliseconds }
    }
    return @{ ok = [bool]$result.ok; status = $result.status; elapsedMs = [int]$sw.ElapsedMilliseconds }
  } catch {
    if ($job) { try { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue | Out-Null } catch {} }
    $sw.Stop()
    return @{ ok = $false; status = "PROBE_EXCEPTION: $($_.Exception.Message)"; elapsedMs = [int]$sw.ElapsedMilliseconds }
  }
}

function Get-KokoroProcesses {
  $listenerPid = $null
  $nl = netstat -ano | Select-String ':3939\s.*LISTENING'
  if ($nl) {
    $parts = ($nl[0].ToString()) -split '\s+'
    $listenerPid = [int]$parts[-1]
  }
  $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" |
    Where-Object { $_.CommandLine -match 'kokoro_server\.py' }
  $out = @()
  foreach ($p in $procs) {
    $dt = $null
    if ($p.CreationDate -is [DateTime]) {
      $dt = $p.CreationDate
    } elseif ($p.CreationDate) {
      try { $dt = [Management.ManagementDateTimeConverter]::ToDateTime([string]$p.CreationDate) } catch { $dt = $null }
    }
    $out += [pscustomobject]@{
      Pid         = [int]$p.ProcessId
      StartTime   = $dt
      IsListener  = ([int]$p.ProcessId -eq $listenerPid)
      ParentPid   = [int]$p.ParentProcessId
    }
  }
  return ,@($out)
}

function Start-Kokoro {
  $task = Get-ScheduledTask -TaskName $KokoroTask -ErrorAction SilentlyContinue
  if ($task) {
    try {
      & schtasks.exe /Run /TN $KokoroTask | Out-Null
      Write-Log 'INFO' "schtasks /Run $KokoroTask → exit=$LASTEXITCODE"
      return
    } catch {
      Write-Log 'WARN' "schtasks /Run $KokoroTask failed: $($_.Exception.Message) — falling back to manual spawn"
    }
  }
  $venvPy = 'C:\Users\santi\tools\tts\venv\Scripts\pythonw.exe'
  $script = Join-Path $Root 'scripts\kokoro_server.py'
  if (-not (Test-Path $venvPy)) { Write-Log 'ERROR' "kokoro venv missing: $venvPy"; return }
  if (-not (Test-Path $script)) { Write-Log 'ERROR' "kokoro script missing: $script"; return }
  $stdout = Join-Path $LogDir 'kokoro.log'
  $stderr = Join-Path $LogDir 'kokoro.err.log'
  try {
    $p = Start-Process -FilePath $venvPy -ArgumentList $script `
         -WorkingDirectory $Root `
         -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
         -WindowStyle Hidden -PassThru
    Write-Log 'INFO' "kokoro manual-spawn pid=$($p.Id)"
  } catch {
    Write-Log 'ERROR' "kokoro spawn failed: $($_.Exception.Message)"
  }
}

function Stop-KokoroDuplicates {
  $procs = Get-KokoroProcesses
  if ($procs.Count -le 0) { return }
  $listener = $procs | Where-Object { $_.IsListener } | Select-Object -First 1
  if (-not $listener) { return }
  $keep = @{}; $keep[$listener.Pid] = $true
  $cursor = $listener.ParentPid
  while ($cursor -and -not $keep.ContainsKey($cursor)) {
    $p = $procs | Where-Object { $_.Pid -eq $cursor } | Select-Object -First 1
    if (-not $p) { break }
    $keep[$p.Pid] = $true
    $cursor = $p.ParentPid
  }
  foreach ($p in $procs) {
    if ($keep.ContainsKey($p.Pid)) { continue }
    Write-Log 'WARN' "killing duplicate kokoro pid=$($p.Pid) (listener=$($listener.Pid))"
    Stop-Process -Id $p.Pid -Force -ErrorAction SilentlyContinue
  }
}

function Run-Repair {
  param([string]$TaskName)
  # /End first so a stuck process (npm dev compiling forever, cloudflared
  # in reconnect limbo) is forcibly terminated before /Run. Without
  # /End, schtasks /Run on an already-running task is a no-op and the
  # wedged process lives on.
  try {
    & schtasks.exe /End /TN $TaskName 2>$null | Out-Null
  } catch { }
  Start-Sleep -Milliseconds 500
  try {
    & schtasks.exe /Run /TN $TaskName | Out-Null
    Write-Log 'INFO' "schtasks /End;/Run $TaskName → exit=$LASTEXITCODE"
  } catch {
    Write-Log 'ERROR' "schtasks /Run $TaskName failed: $($_.Exception.Message)"
  }
}

# ── Failure counters + repair cooldowns ─────────────────────────────
$fails = @{ dashboard = 0; tunnel = 0; kokoro = 0 }

# cooldownUntil[$name] = Get-Date when the component is allowed to be
# probed again after a repair. During cooldown we skip the probe
# entirely so the restarting process isn't killed mid-boot.
$cooldownUntil = @{ dashboard = [DateTime]::MinValue; tunnel = [DateTime]::MinValue; kokoro = [DateTime]::MinValue }
$cooldownSeconds = @{ dashboard = $RepairCooldownDashboard; tunnel = $RepairCooldownTunnel; kokoro = $RepairCooldownKokoro }

function Test-BuildInProgress {
  # True if the build sentinel exists AND is fresh. A stale lock (from a
  # crashed cmd.exe that never reached `del logs\build.lock`) is treated
  # as absent so we don't hang forever waiting on a dead build.
  if (-not (Test-Path $BuildLockFile)) { return $false }
  try {
    $age = ((Get-Date) - (Get-Item $BuildLockFile).LastWriteTime).TotalSeconds
    if ($age -gt $BuildLockMaxAgeSeconds) {
      Write-Log 'WARN' "build.lock is stale ($([int]$age)s old) — ignoring"
      return $false
    }
    return $true
  } catch { return $false }
}

# ── Auto-fixer functions ─────────────────────────────────────────────

function Fix-EnvLocalMissingKeys {
  # Ensure required keys are present in .env.local. If anything is
  # missing, append it (don't overwrite — operator may have edited).
  # Returns $true if we changed the file.
  if (-not (Test-Path $EnvLocalFile)) {
    # No .env.local at all is a separate, scarier failure mode. Log loud
    # and create a minimal one so the dashboard can boot.
    Write-Log 'ACT' ".env.local missing entirely — creating minimal file"
    $minimal = $EnvLocalRequiredDefaults.GetEnumerator() | ForEach-Object {
      "$($_.Key)=$($_.Value)"
    }
    Set-Content -Path $EnvLocalFile -Value $minimal -Encoding ASCII
    return $true
  }
  $existing = Get-Content $EnvLocalFile -ErrorAction SilentlyContinue
  $changed = $false
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($l in $existing) { $lines.Add($l) | Out-Null }
  foreach ($k in $EnvLocalRequiredDefaults.Keys) {
    $hit = $existing | Where-Object { $_ -match "^\s*$([regex]::Escape($k))\s*=" }
    if (-not $hit) {
      Write-Log 'ACT' "restoring missing env key $k in .env.local"
      $lines.Add("$k=$($EnvLocalRequiredDefaults[$k])") | Out-Null
      $changed = $true
    }
  }
  if ($changed) {
    Set-Content -Path $EnvLocalFile -Value $lines -Encoding ASCII
  }
  return $changed
}

function Fix-MissingBuildId {
  # If `.next\BUILD_ID` is missing, the run-loop is about to rebuild
  # anyway. We could just let it — but during that ~25-60s window the
  # dashboard probe will fail. The build.lock sentinel handles probe
  # suppression IF the run-loop is running. If the App task is OFF for
  # any reason (manual /End, recent crash), nobody will rebuild.
  #
  # So: only act if BUILD_ID is missing AND the App task is NOT in
  # 'Running' state. We rebuild in-place and drop the same build.lock
  # so a subsequent task start hits a hot bundle.
  if (Test-Path $BuildIdFile) { return $false }
  $taskStatus = (schtasks /Query /TN $DashboardTask /FO LIST 2>$null |
                 Select-String -Pattern '^Status:\s*(.+)$' |
                 ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() } |
                 Select-Object -First 1)
  if ($taskStatus -eq 'Running') {
    # Run-loop is alive and either already building or about to. Honour
    # its build.lock instead of racing it.
    return $false
  }
  Write-Log 'ACT' ".next\BUILD_ID missing AND App task not running — pre-emptive build"
  "watchdog pre-build $(Get-UtcIso)" | Set-Content -Path $BuildLockFile -Encoding ASCII
  try {
    Push-Location $RepoRoot
    & npm.cmd run build *>> $AppLogFile
    Pop-Location
  } catch {
    Write-Log 'ERROR' "pre-emptive build failed: $($_.Exception.Message)"
  } finally {
    Remove-Item -Path $BuildLockFile -ErrorAction SilentlyContinue
  }
  return $true
}

function Fix-DetectFatalLoop {
  # If app.log has accumulated ≥3 `[env] FATAL` lines in the last 3
  # minutes the server is in a fast-respawn loop that the env-asserter
  # didn't catch (race? operator edited .env.local mid-loop?). Log a
  # loud one-shot alert + try a single re-assertion.
  if (-not (Test-Path $AppLogFile)) { return }
  try {
    # Cheap: read only the tail. Each FATAL block is ~3 lines so 200 is
    # plenty for 3 mins of crash-looping.
    $tail = Get-Content -Path $AppLogFile -Tail 200 -ErrorAction SilentlyContinue
    $fatalCount = ($tail | Select-String -Pattern '\[env\] FATAL' -SimpleMatch:$false).Count
    if ($fatalCount -lt 3) {
      # Healthy — clear any prior alert flag so the next loop alerts again.
      if (Test-Path $LastFatalLoopAlertFile) { Remove-Item $LastFatalLoopAlertFile -ErrorAction SilentlyContinue }
      return
    }
    # Suppress duplicate alerts within 10 minutes.
    if (Test-Path $LastFatalLoopAlertFile) {
      $age = ((Get-Date) - (Get-Item $LastFatalLoopAlertFile).LastWriteTime).TotalSeconds
      if ($age -lt 600) { return }
    }
    Write-Log 'ALERT' "FATAL crash-loop detected ($fatalCount FATAL lines in tail) — re-asserting env + rebuilding env file"
    Fix-EnvLocalMissingKeys | Out-Null
    Get-UtcIso | Set-Content -Path $LastFatalLoopAlertFile -Encoding ASCII
  } catch {
    Write-Log 'ERROR' "Fix-DetectFatalLoop threw: $($_.Exception.Message)"
  }
}

function Tick-AutoFix {
  # Run all preventive fixers. Each is best-effort and isolated so one
  # failure doesn't poison the rest.
  try { Fix-EnvLocalMissingKeys | Out-Null } catch { Write-Log 'ERROR' "env-fixer: $($_.Exception.Message)" }
  try { Fix-MissingBuildId      | Out-Null } catch { Write-Log 'ERROR' "build-fixer: $($_.Exception.Message)" }
  try { Fix-DetectFatalLoop                 } catch { Write-Log 'ERROR' "fatal-loop-detector: $($_.Exception.Message)" }
}

function Tick-Component {
  param([string]$Name, [scriptblock]$Probe, [scriptblock]$Repair)
  $now = Get-Date
  if ($now -lt $cooldownUntil[$Name]) {
    # In cooldown — just skip. Don't log every tick; it's noisy.
    return
  }
  # During a legitimate build, the dashboard origin is offline by design —
  # the tunnel will 502 too because it has no upstream. Suppressing both
  # probes prevents the build-kill-rebuild loop. Reset failure counters
  # while we're suppressed so we don't trigger immediately when the build
  # finishes and the first post-build probe is still slow.
  if (($Name -eq 'dashboard' -or $Name -eq 'tunnel') -and (Test-BuildInProgress)) {
    if ($fails[$Name] -gt 0) { $fails[$Name] = 0 }
    return
  }
  $res = & $Probe
  if ($res.ok) {
    if ($fails[$Name] -gt 0) {
      Write-Log 'INFO' "$Name recovered (status=$($res.status), $($res.elapsedMs)ms)"
      $fails[$Name] = 0
    }
    return
  }
  $fails[$Name]++
  Write-Log 'WARN' "$Name unhealthy (status=$($res.status), $($res.elapsedMs)ms) — fail $($fails[$Name])/$FailureThreshold"
  if ($fails[$Name] -ge $FailureThreshold) {
    $cd = $cooldownSeconds[$Name]
    Write-Log 'ACT' "$Name repair triggered (cooldown=${cd}s)"
    & $Repair
    $fails[$Name] = 0
    $cooldownUntil[$Name] = (Get-Date).AddSeconds($cd)
    # Dashboard = the mother process. When we restart it, kokoro
    # (spawned by server.ts via startKokoro()) bounces with it. Apply
    # kokoro's cooldown too so we don't separately "repair" kokoro
    # while it's coming back up inside the mother. Tunnel is its own
    # independent cloudflared task, so leave it alone.
    if ($Name -eq 'dashboard') {
      $kokCd = $cooldownSeconds['kokoro']
      $cooldownUntil['kokoro'] = (Get-Date).AddSeconds($kokCd)
      $fails['kokoro'] = 0
      Write-Log 'INFO' "kokoro cooldown aligned with dashboard (${kokCd}s) — shares the mother process"
    }
  }
}

# ── Main loop ────────────────────────────────────────────────────────
Touch-Heartbeat
Write-Log 'BOOT' "watchdog starting — interval=${IntervalSeconds}s threshold=$FailureThreshold pid=$PID soft=$HttpSoftTimeoutSeconds hard=$HttpHardTimeoutSeconds"

$heartbeatEvery = [Math]::Max(1, [int](600 / [Math]::Max(1, $IntervalSeconds)))
$tickCount = 0

while ($true) {
  try {
    # Heartbeat is the FIRST thing each tick, before any probe. A hung
    # probe will never get here — the meta-watcher will notice and
    # recycle us.
    Touch-Heartbeat
    Rotate-LogIfNeeded
    $tickCount++
    if (($tickCount % $heartbeatEvery) -eq 0) {
      Write-Log 'TICK' "alive (tick #$tickCount, fails=dash:$($fails.dashboard) tun:$($fails.tunnel) kok:$($fails.kokoro))"
    }

    # Preventive fixers FIRST. Cheap idempotent state assertions (env
    # vars present, .next built) so we don't rely on the probe layer
    # spotting a crash that we could have prevented.
    Tick-AutoFix

    Tick-Component 'dashboard' `
      -Probe  { Probe-Http $DashboardUrl } `
      -Repair { Run-Repair $DashboardTask }

    Tick-Component 'tunnel' `
      -Probe  { Probe-Http $TunnelUrl } `
      -Repair { Run-Repair $TunnelTask }

    Tick-Component 'kokoro' `
      -Probe  { Probe-Http $KokoroUrl } `
      -Repair {
        $procs = Get-KokoroProcesses
        foreach ($p in $procs) {
          Write-Log 'ACT' "kokoro full-reset: killing pid=$($p.Pid)"
          Stop-Process -Id $p.Pid -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 800
        Start-Kokoro
      }

    Stop-KokoroDuplicates
  }
  catch {
    Write-Log 'ERROR' "tick threw: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds $IntervalSeconds
}

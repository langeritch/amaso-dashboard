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

# ── Periodic checks (cron-like, on top of the 30s probe layer) ──────
# The probe layer reacts in ~90s to a fully-down server. These run on a
# coarser schedule for things that don't need second-by-second attention:
#
#   • Every 5 minutes — explicit "is the dashboard alive?" check that
#     bypasses the FailureThreshold counter. If the local probe refuses
#     a connection on a 5-min boundary AND no build is in progress, we
#     force a restart immediately (vs waiting 90s for the probe layer).
#     This catches the case where a freeze just barely keeps producing
#     200s on some path but the operator-facing state is dead.
#
#   • Every 30 minutes — auto-rebuild if source code is newer than the
#     last build. The operator edits source frequently; without this
#     they have to remember to `npm run build` after every change. We
#     scan the watched source dirs, compare max mtime to .next/BUILD_ID,
#     and trigger a rebuild + task restart if anything is newer.
#
# Tick interval is 30s, so:
#   5 min  =  10 ticks  (FiveMinTickInterval)
#   30 min =  60 ticks  (RebuildTickInterval)
$FiveMinTickInterval = [int](300 / [Math]::Max(1, $IntervalSeconds))
$RebuildTickInterval = [int](1800 / [Math]::Max(1, $IntervalSeconds))
# Source roots we care about for rebuild-detection. Anything else (logs/,
# node_modules/, .next/ itself, .git/, the syncthing scratch dirs) is
# either generated or noise.
$SourceRoots = @('app','lib','components','public','scripts','types','server.ts','package.json','package-lock.json','next.config.ts','tsconfig.json')
$LastRebuildStampFile = Join-Path $LogDir 'last-rebuild.stamp'

# ── AI escalation ────────────────────────────────────────────────────
# When the rule-based layer can't fix a problem, we escalate to Claude
# via scripts/ai-heal.ps1. Triggers (any one fires the escalation):
#
#   • Thrash: dashboard repaired ≥3 times in the last 15 min. The probe
#     layer is doing its job (restart on fail) but the underlying cause
#     isn't going away — this is the pattern that means "human-level
#     reasoning required".
#   • Persistent FATAL: Fix-DetectFatalLoop already alerted >10 min ago
#     and the FATAL lines are still accumulating.
#   • Repeated build failure: Cron-RebuildIfStale failed twice in a row.
#
# Rate-limited inside ai-heal.ps1 to ≤1 invocation per hour. Each call
# costs API tokens and a flap-loop that keeps firing Claude is worse
# than the original outage.
$AiHealScript = Join-Path $PSScriptRoot 'ai-heal.ps1'
$RepairHistoryFile = Join-Path $LogDir 'repair-history.json'
# Sliding window: if dashboard has been repaired this many times in
# this many seconds, escalate.
$ThrashCount = 3
$ThrashWindowSeconds = 900

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

function Get-PortListenerPid {
  # Returns the PID currently LISTENING on $Port (IPv4 or IPv6 wildcard
  # bind), or $null if nothing is bound. Used by Run-Repair to detect
  # a wedged node that schtasks /End couldn't kill.
  param([int]$Port)
  try {
    $line = & netstat.exe -ano -p tcp 2>$null |
      Select-String -Pattern "(?:0\.0\.0\.0|\[::\]):${Port}\s+(?:0\.0\.0\.0|\[::\]):0\s+LISTENING\s+(\d+)" |
      Select-Object -First 1
    if (-not $line) { return $null }
    return [int]$line.Matches[0].Groups[1].Value
  } catch {
    return $null
  }
}

# Map task -> port the task's process owns. When schtasks /End fails to
# stop a wedged process, we look up the port and force-kill the PID
# that's still bound. cloudflared doesn't listen on a fixed local port
# so it's omitted (kill-by-name handles it cheaper anyway).
$TaskPorts = @{}
$TaskPorts[$DashboardTask] = 3737
$TaskPorts[$KokoroTask]    = 3939

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

  # Force-kill fallback. schtasks /End on a wedged Node — event loop
  # blocked, ignoring the equivalent of a graceful shutdown — exits 0
  # but leaves the process alive. The 2026-04-28 evening outage went
  # like this: pid 26324 wedged at ~20:10, watchdog logged 5 successive
  # /End;/Run cycles, each "exit=0", pid 26324 kept on running, all
  # probes timed out. Now: after /End, look up whoever is still
  # LISTENING on the task's port and kill by PID.
  if ($TaskPorts.ContainsKey($TaskName)) {
    $port = $TaskPorts[$TaskName]
    $still = Get-PortListenerPid -Port $port
    if ($still) {
      try {
        $proc = Get-Process -Id $still -ErrorAction Stop
        Write-Log 'ACT' "force-kill: pid=$still still on :$port after /End ($TaskName) — killing (name=$($proc.ProcessName) RSS=$([int]($proc.WorkingSet64/1MB))MB)"
        Stop-Process -Id $still -Force -ErrorAction Stop
        Start-Sleep -Milliseconds 800
      } catch {
        Write-Log 'ERROR' "force-kill failed for pid=$still : $($_.Exception.Message)"
      }
    }
  }

  try {
    & schtasks.exe /Run /TN $TaskName | Out-Null
    Write-Log 'INFO' "schtasks /End;/Run $TaskName → exit=$LASTEXITCODE"
  } catch {
    Write-Log 'ERROR' "schtasks /Run $TaskName failed: $($_.Exception.Message)"
  }
  # Record the repair so the thrash detector can spot a flap loop. We
  # store as ISO timestamps in a JSON array; entries older than the
  # window are pruned on each write so the file stays bounded.
  Record-Repair -TaskName $TaskName
}

function Record-Repair {
  param([string]$TaskName)
  $history = @()
  if (Test-Path $RepairHistoryFile) {
    try {
      $raw = Get-Content -Raw -Path $RepairHistoryFile -ErrorAction Stop
      if ($raw) { $history = ConvertFrom-Json $raw -ErrorAction Stop }
    } catch {
      # Corrupt history file (concurrent write, partial flush) — start
      # fresh. A stale empty history just delays escalation; that's
      # acceptable.
      Write-Log 'WARN' "repair-history.json unreadable; resetting"
      $history = @()
    }
  }
  $now = (Get-Date).ToUniversalTime()
  $cutoff = $now.AddSeconds(-$ThrashWindowSeconds)
  # Keep only entries inside the window, then append the new one.
  $kept = @($history | Where-Object {
    try { ([DateTime]::Parse($_.ts)) -ge $cutoff } catch { $false }
  })
  $kept += [pscustomobject]@{ ts = $now.ToString('s') + 'Z'; task = $TaskName }
  try {
    $kept | ConvertTo-Json -Compress | Set-Content -Path $RepairHistoryFile -Encoding ASCII
  } catch {
    Write-Log 'WARN' "could not persist repair history: $($_.Exception.Message)"
  }
}

function Try-AiHeal {
  param([string]$Reason)
  if (-not (Test-Path $AiHealScript)) {
    Write-Log 'WARN' "ai-heal script not found ($AiHealScript) — cannot escalate. Reason: $Reason"
    return
  }
  Write-Log 'ALERT' "ESCALATING to AI heal: $Reason"
  try {
    # Run synchronously in-process so we serialise on the watchdog tick.
    # ai-heal.ps1 has its own rate-limit (60 min) and will exit 2 if
    # called too soon — we don't double-gate here.
    # Use powershell.exe (5.1) — pwsh (7+) isn't installed on this box.
    # The script targets 5.1 syntax so it's compatible; if the operator
    # later installs pwsh we can switch here.
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $AiHealScript -Reason $Reason 2>&1 | ForEach-Object {
      Write-Log 'AI' $_
    }
  } catch {
    Write-Log 'ERROR' "ai-heal launch failed: $($_.Exception.Message)"
  }
}

function Detect-DashboardThrash {
  # Returns $true if dashboard has been repaired ≥$ThrashCount times
  # in the last $ThrashWindowSeconds. Uses the JSON history written by
  # Record-Repair.
  if (-not (Test-Path $RepairHistoryFile)) { return $false }
  try {
    $raw = Get-Content -Raw -Path $RepairHistoryFile -ErrorAction Stop
    if (-not $raw) { return $false }
    $history = ConvertFrom-Json $raw -ErrorAction Stop
    $cutoff = (Get-Date).ToUniversalTime().AddSeconds(-$ThrashWindowSeconds)
    $recent = @($history | Where-Object {
      $_.task -eq $DashboardTask -and (
        try { ([DateTime]::Parse($_.ts)) -ge $cutoff } catch { $false }
      )
    })
    return ($recent.Count -ge $ThrashCount)
  } catch {
    return $false
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
    # Persistent FATAL loops are a strong signal the rule-based fixer
    # isn't enough — escalate to AI. ai-heal.ps1 will rate-limit
    # internally if we already called it within the last hour.
    Try-AiHeal -Reason "persistent [env] FATAL loop ($fatalCount lines in app.log tail) — env-fixer ran but didn't resolve"
  } catch {
    Write-Log 'ERROR' "Fix-DetectFatalLoop threw: $($_.Exception.Message)"
  }
}

function Fix-ZombiePortHolder {
  # Detect the failure mode where a previous node process is bound to
  # 3737 but the run-loop is crash-looping because assertPortFree() is
  # rejecting every fresh start. Symptom in app.log:
  #   "[server] fatal: Error: port 3737 is already in use ..."
  # repeating every ~13 seconds. The dashboard probe still answers 200
  # from the zombie, so the rule-based probe layer never trips — but
  # the zombie's child processes (kokoro, telegram-voice, autopilot
  # cron) are dead, so the spar feature is broken.
  #
  # Hit on 2026-04-28: a node from 13:58:50 was holding the port and
  # the run-loop had logged ~25 fatal lines without recovery. A clean
  # 200 hid the breakage from every other layer.
  #
  # Fix: if the tail shows ≥3 of these fatal lines in the last 100,
  # find the actual port owner via netstat, kill it, and let the
  # run-loop bind on its next iteration. Idempotent because once the
  # zombie is gone the new server overwrites the log pattern within
  # one cycle.
  if (-not (Test-Path $AppLogFile)) { return }
  try {
    $tail = Get-Content -Path $AppLogFile -Tail 100 -ErrorAction Stop
    $hits = ($tail | Select-String -Pattern 'port 3737 is already in use' -SimpleMatch).Count
    if ($hits -lt 3) { return }
    Write-Log 'ALERT' "zombie-port pattern: $hits 'port already in use' lines in last 100 — locating PID"
    $owner = & netstat.exe -ano -p tcp 2>$null |
      Select-String -Pattern '\s+0\.0\.0\.0:3737\s+0\.0\.0\.0:0\s+LISTENING\s+(\d+)|\s+\[::\]:3737\s+\[::\]:0\s+LISTENING\s+(\d+)' |
      ForEach-Object {
        $m = $_.Matches[0]
        if ($m.Groups[1].Value) { $m.Groups[1].Value } else { $m.Groups[2].Value }
      } |
      Select-Object -First 1
    if (-not $owner) {
      Write-Log 'WARN' "no LISTENING owner on 3737 — pattern may be stale, leaving alone"
      return
    }
    try {
      $proc = Get-Process -Id $owner -ErrorAction Stop
      Write-Log 'ACT' "killing zombie holding 3737: pid=$owner name=$($proc.ProcessName) age=$([int](((Get-Date) - $proc.StartTime).TotalMinutes))m"
      Stop-Process -Id $owner -Force -ErrorAction Stop
      # Give the OS a moment to release the socket before the run-loop
      # tries again. TIME_WAIT can hold the bind for a few seconds; we
      # just need the LISTENING state cleared.
      Start-Sleep -Milliseconds 800
      # And kick the App task so a fresh run-loop is launched. The
      # watchdog cooldown protects us from repair-storming this.
      Run-Repair $DashboardTask
    } catch {
      Write-Log 'ERROR' "could not kill zombie pid=$owner : $($_.Exception.Message)"
    }
  } catch {
    Write-Log 'ERROR' "Fix-ZombiePortHolder threw: $($_.Exception.Message)"
  }
}

function Fix-StaleServerVsBundle {
  # Detect the failure mode where someone (operator, another tool, the
  # Cron-RebuildIfStale path that broke pre-restart) regenerated `.next`
  # AFTER the running server started. Next.js holds an in-memory
  # manifest of static assets that's only refreshed on process boot —
  # so the server's HTML output references the NEW asset hashes
  # (because Next reads the page manifest at request time), but its
  # static handler 404s those same files (because they were added to
  # disk after startup and aren't in the in-memory whitelist).
  #
  # Symptom: page loads, all CSS link tags 404, page renders unstyled.
  # Hit on 2026-04-29 morning: operator ran `npm run build` manually
  # while the server kept running. CSS file `0luqno3x-n6p2.css` was
  # 93163 bytes on disk but the server returned 404 for it.
  #
  # Fix: if BUILD_ID mtime > server StartTime + slack, the bundle was
  # regenerated under the running process. End + Run the App task so a
  # fresh node picks up a coherent manifest. 60-second slack absorbs
  # the legit case where the run-loop builds *during* boot.
  if (-not (Test-Path $BuildIdFile)) { return }
  if (Test-BuildInProgress) { return }
  $owner = Get-PortListenerPid -Port 3737
  if (-not $owner) { return }
  try {
    $proc = Get-Process -Id $owner -ErrorAction Stop
    $bundle = (Get-Item $BuildIdFile).LastWriteTime
    $serverStart = $proc.StartTime
    # Skip if bundle is older than the server (normal — server boots
    # against an existing build).
    if ($bundle -le $serverStart.AddSeconds(60)) { return }
    # Stamp file so we don't re-trigger every tick if the restart
    # somehow doesn't take. The 30-min cron handles persistent failure.
    if (Test-Path $LastRebuildStampFile) {
      $stampAge = ((Get-Date) - (Get-Item $LastRebuildStampFile).LastWriteTime).TotalSeconds
      if ($stampAge -lt 120) { return }
    }
    $skewSec = [int]($bundle - $serverStart).TotalSeconds
    Write-Log 'ALERT' "stale-server-vs-bundle: server pid=$owner started=$($serverStart.ToString('s')) but BUILD_ID is $($bundle.ToString('s')) (${skewSec}s newer) — restarting App to pick up new bundle"
    Get-UtcIso | Set-Content -Path $LastRebuildStampFile -Encoding ASCII
    Run-Repair $DashboardTask
    $cooldownUntil['dashboard'] = (Get-Date).AddSeconds(120)
    $cooldownUntil['kokoro']    = (Get-Date).AddSeconds(60)
  } catch {
    Write-Log 'ERROR' "Fix-StaleServerVsBundle threw: $($_.Exception.Message)"
  }
}

function Tick-AutoFix {
  # Run all preventive fixers. Each is best-effort and isolated so one
  # failure doesn't poison the rest.
  try { Fix-EnvLocalMissingKeys | Out-Null } catch { Write-Log 'ERROR' "env-fixer: $($_.Exception.Message)" }
  try { Fix-MissingBuildId      | Out-Null } catch { Write-Log 'ERROR' "build-fixer: $($_.Exception.Message)" }
  try { Fix-ZombiePortHolder                } catch { Write-Log 'ERROR' "zombie-port-fixer: $($_.Exception.Message)" }
  try { Fix-StaleServerVsBundle             } catch { Write-Log 'ERROR' "stale-bundle-fixer: $($_.Exception.Message)" }
  try { Fix-DetectFatalLoop                 } catch { Write-Log 'ERROR' "fatal-loop-detector: $($_.Exception.Message)" }
}

# ── Periodic cron-style checks ───────────────────────────────────────

function Cron-FiveMinHealthCheck {
  # Explicit deeper "is it really alive?" probe on a 5-min boundary.
  # Bypasses FailureThreshold: if the dashboard refuses connections
  # AND no build is in progress AND we're not in cooldown, force a
  # restart immediately. This is on top of (not instead of) the 30s
  # probe layer — it catches the "GC stutter caused 1-2 timeouts but
  # the threshold counter reset before the third" case.
  if (Test-BuildInProgress) {
    Write-Log 'CRON5' "skip — build in progress"
    return
  }
  if ((Get-Date) -lt $cooldownUntil['dashboard']) {
    Write-Log 'CRON5' "skip — dashboard in cooldown"
    return
  }
  $alive = $false
  try {
    $r = Invoke-WebRequest -Uri $DashboardUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $alive = $true }
  } catch {
    $alive = $false
  }
  if ($alive) {
    Write-Log 'CRON5' "dashboard healthy"
    return
  }
  Write-Log 'ALERT' "5-min check: dashboard NOT responding — forcing restart (bypassing failure threshold)"
  Run-Repair $DashboardTask
  $cooldownUntil['dashboard'] = (Get-Date).AddSeconds(120)
  $cooldownUntil['kokoro']    = (Get-Date).AddSeconds(60)
  $fails['dashboard'] = 0
}

function Get-MaxSourceMtime {
  # Returns the most recent LastWriteTime across all $SourceRoots. We
  # explicitly exclude generated/vendored dirs even when they live
  # inside a source root (e.g. app/.next-cache shouldn't trigger a
  # rebuild). Cheap enough to run every 30 min — typical scan is
  # <500ms because we skip node_modules/.next/.git up front.
  $excluded = @('node_modules','.next','.git','.gstack','.claude','dist','build','coverage','logs','.stfolder','.stversions','electron\dist-local')
  $latest = [DateTime]::MinValue
  foreach ($rel in $SourceRoots) {
    $p = Join-Path $RepoRoot $rel
    if (-not (Test-Path $p)) { continue }
    try {
      $item = Get-Item $p -ErrorAction Stop
      if ($item.PSIsContainer) {
        # Directory walk with prune. Get-ChildItem -Recurse can't
        # natively prune, so we filter the FullName for excluded
        # path segments. This is fast because the matching is on
        # already-enumerated entries; the alternative (a manual
        # recursive function) was 3x slower in measurement.
        $files = Get-ChildItem -Path $p -Recurse -File -Force -ErrorAction SilentlyContinue
        foreach ($f in $files) {
          $skip = $false
          foreach ($x in $excluded) {
            if ($f.FullName -match [regex]::Escape("\$x\")) { $skip = $true; break }
          }
          if ($skip) { continue }
          if ($f.LastWriteTime -gt $latest) { $latest = $f.LastWriteTime }
        }
      } else {
        if ($item.LastWriteTime -gt $latest) { $latest = $item.LastWriteTime }
      }
    } catch {
      Write-Log 'ERROR' "Get-MaxSourceMtime: $($_.Exception.Message) at $p"
    }
  }
  return $latest
}

function Cron-RebuildIfStale {
  # Auto-rebuild + restart task if any source file is newer than
  # `.next/BUILD_ID`. The operator edits source frequently — without
  # this they'd need to remember `npm run build` after every change.
  if (Test-BuildInProgress) {
    Write-Log 'CRON30' "skip rebuild — build already in progress"
    return
  }
  if (-not (Test-Path $BuildIdFile)) {
    # The auto-fixer (Fix-MissingBuildId) handles the no-build case;
    # don't double-fire from here.
    Write-Log 'CRON30' "skip rebuild — BUILD_ID missing (auto-fixer handles this)"
    return
  }
  $buildMtime = (Get-Item $BuildIdFile).LastWriteTime
  $sourceMtime = Get-MaxSourceMtime
  if ($sourceMtime -le $buildMtime) {
    Write-Log 'CRON30' "no rebuild needed (newest source $($sourceMtime.ToString('s')) <= BUILD_ID $($buildMtime.ToString('s')))"
    return
  }
  Write-Log 'ACT' "rebuild triggered — newest source $($sourceMtime.ToString('s')) > BUILD_ID $($buildMtime.ToString('s'))"
  # Drop build.lock FIRST so our own probe-suppression and the run-loop
  # both honour it. The lock is also what prevents Tick-Component from
  # killing the App task while we're mid-build.
  "watchdog cron rebuild $(Get-UtcIso)" | Set-Content -Path $BuildLockFile -Encoding ASCII
  $buildOk = $false
  try {
    Push-Location $RepoRoot
    # Don't pipe build stdout into app.log. The wedged-node failure
    # mode (2026-04-28 20:10) leaves the running server holding an
    # exclusive write handle on app.log, and `npm run build *>> app.log`
    # then throws "file is being used by another process" before the
    # build even starts. Pipe to a dedicated build-log file instead —
    # the operator can still tail it, and we never collide with the
    # running server.
    $buildLogFile = Join-Path $LogDir 'build.log'
    & npm.cmd run build *>> $buildLogFile
    $buildOk = ($LASTEXITCODE -eq 0) -and (Test-Path $BuildIdFile) -and ((Get-Item $BuildIdFile).LastWriteTime -gt $buildMtime)
  } catch {
    Write-Log 'ERROR' "rebuild threw: $($_.Exception.Message)"
  } finally {
    Pop-Location
    Remove-Item -Path $BuildLockFile -ErrorAction SilentlyContinue
  }
  if (-not $buildOk) {
    Write-Log 'ERROR' "rebuild FAILED — leaving previous bundle in place; will retry next 30-min tick"
    return
  }
  Write-Log 'INFO' "rebuild OK — restarting App task to pick up new bundle"
  # End + Run the App task so the running process drops the old bundle
  # and the run-loop respawns into the freshly-built `.next`.
  schtasks /End /TN $DashboardTask 2>&1 | Out-Null
  Start-Sleep -Milliseconds 800
  schtasks /Run /TN $DashboardTask 2>&1 | Out-Null
  $cooldownUntil['dashboard'] = (Get-Date).AddSeconds(120)
  $cooldownUntil['kokoro']    = (Get-Date).AddSeconds(60)
  Get-UtcIso | Set-Content -Path $LastRebuildStampFile -Encoding ASCII
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

    # Cron-style periodic checks layered on top of the 30s probes.
    # FiveMinTickInterval (10 ticks) — explicit health check that
    # bypasses FailureThreshold; restarts immediately if down.
    # RebuildTickInterval (60 ticks) — auto-rebuild + restart if any
    # source file is newer than .next/BUILD_ID.
    if (($tickCount % $FiveMinTickInterval) -eq 0) {
      try { Cron-FiveMinHealthCheck } catch { Write-Log 'ERROR' "cron-5min: $($_.Exception.Message)" }
    }
    if (($tickCount % $RebuildTickInterval) -eq 0) {
      try { Cron-RebuildIfStale } catch { Write-Log 'ERROR' "cron-30min: $($_.Exception.Message)" }
    }

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

    # Escalation: if rule-based repairs aren't sticking (dashboard has
    # been restarted ≥$ThrashCount times in the last $ThrashWindowSeconds),
    # call in the AI. ai-heal.ps1 self-rate-limits so this won't
    # double-fire.
    if (Detect-DashboardThrash) {
      Try-AiHeal -Reason "dashboard thrash: $ThrashCount+ repairs in last $($ThrashWindowSeconds)s — rule-based layer can't keep it up"
    }
  }
  catch {
    Write-Log 'ERROR' "tick threw: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds $IntervalSeconds
}

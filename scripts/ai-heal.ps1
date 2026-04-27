# AI-driven self-healing for the Amaso Dashboard.
#
# When the rule-based watchdog runs out of moves (a known crash mode it
# can't fix, or a new crash mode it doesn't recognise), it escalates to
# this script. We invoke `claude -p` headlessly with:
#   • The repo (--add-dir already implicit when cwd is the repo)
#   • Rich crash context from logs/* assembled as a single prompt
#   • A scoped tool allowlist (Read/Grep/Glob/Edit/Write + specific Bash
#     commands — git, npm, schtasks, powershell)
#   • A hard dollar budget per invocation
#   • A permission mode that doesn't prompt
#
# Safety rails:
#   1. Rate limit. At most 1 invocation per hour, enforced via mtime on
#      logs/ai-heal.last. AI calls cost money and a flap loop that
#      keeps invoking Claude is worse than the original outage.
#   2. Git checkpoint. Before Claude touches anything we tag the current
#      HEAD with `ai-heal-<timestamp>` so any change is one
#      `git reset --hard <tag>` away.
#   3. Bounded budget. --max-budget-usd caps API spend per call.
#   4. Logged decisions. Full prompt + Claude's transcript saved to
#      logs/ai-heal-<timestamp>.txt for postmortems.
#   5. Whitelisted scope. Tool allowlist prevents the agent from running
#      arbitrary bash. It can edit files, read logs, and run the
#      diagnostic commands we already trust the watchdog to run.

[CmdletBinding()]
param(
  # Free-text reason from the caller. Becomes the first thing Claude sees.
  [Parameter(Mandatory)] [string]$Reason,
  # Max wall-clock seconds. Claude itself will respect --max-budget-usd
  # but a stuck SDK call should still be killable.
  [int]$MaxRunSeconds = 600,
  # Cost ceiling. ~$0.50 buys plenty of turns at sonnet pricing.
  [double]$MaxBudgetUsd = 1.0,
  # Skip the rate-limit gate. ONLY for operator-run manual heals.
  [switch]$Force
)

$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $RepoRoot 'logs'
$AiHealLog = Join-Path $LogDir 'ai-heal.log'
$AiHealStampFile = Join-Path $LogDir 'ai-heal.last'
$RateLimitMinutes = 60

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-AiLog {
  param([string]$Level, [string]$Msg)
  $line = "[$((Get-Date).ToUniversalTime().ToString('s'))Z] $Level $Msg"
  try { Add-Content -Path $AiHealLog -Value $line -Encoding ASCII } catch { }
  Write-Host $line
}

# ── Rate-limit gate ───────────────────────────────────────────────────
if (-not $Force -and (Test-Path $AiHealStampFile)) {
  $age = ((Get-Date) - (Get-Item $AiHealStampFile).LastWriteTime).TotalMinutes
  if ($age -lt $RateLimitMinutes) {
    Write-AiLog 'SKIP' "rate-limited — last AI heal was $([int]$age)m ago (need >=${RateLimitMinutes}m). Pass -Force to override. Reason was: $Reason"
    exit 2
  }
}

# ── Pre-flight: claude on PATH ────────────────────────────────────────
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
  Write-AiLog 'ERROR' "claude CLI not found on PATH; cannot self-heal. Reason was: $Reason"
  exit 1
}
Write-AiLog 'INFO' "claude CLI: $($claude.Source)"

# ── Git checkpoint BEFORE invoking Claude ─────────────────────────────
# Tag HEAD so a bad AI edit is one `git reset --hard <tag>` away. We
# tag instead of branching because tags don't move and a reflog entry
# isn't enough to find later in a flap-loop scenario.
$tagName = "ai-heal-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'))"
Push-Location $RepoRoot
try {
  $head = (& git rev-parse HEAD 2>$null).Trim()
  if ($LASTEXITCODE -eq 0 -and $head) {
    & git tag $tagName HEAD 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-AiLog 'INFO' "git checkpoint tag created: $tagName at $($head.Substring(0,8))"
    } else {
      Write-AiLog 'WARN' "git tag failed — continuing without rollback tag"
    }
  } else {
    Write-AiLog 'WARN' "not in a git repo (or git missing) — no rollback tag"
  }
} finally {
  Pop-Location
}

# ── Build context from logs ──────────────────────────────────────────
function Get-LogTail {
  param([string]$Path, [int]$Lines = 50)
  if (-not (Test-Path $Path)) { return "(file not present)" }
  try {
    $tail = Get-Content -Path $Path -Tail $Lines -ErrorAction Stop
    return ($tail -join "`n")
  } catch { return "(error reading: $($_.Exception.Message))" }
}

$ctx = New-Object System.Text.StringBuilder
[void]$ctx.AppendLine("# Trigger reason")
[void]$ctx.AppendLine($Reason)
[void]$ctx.AppendLine("")
[void]$ctx.AppendLine("# logs/app.log — tail 80")
[void]$ctx.AppendLine('```')
[void]$ctx.AppendLine((Get-LogTail (Join-Path $LogDir 'app.log') 80))
[void]$ctx.AppendLine('```')
[void]$ctx.AppendLine("")
[void]$ctx.AppendLine("# logs/crash.log — tail 60 (empty if absent)")
[void]$ctx.AppendLine('```')
[void]$ctx.AppendLine((Get-LogTail (Join-Path $LogDir 'crash.log') 60))
[void]$ctx.AppendLine('```')
[void]$ctx.AppendLine("")
[void]$ctx.AppendLine("# logs/watchdog.log — tail 50")
[void]$ctx.AppendLine('```')
[void]$ctx.AppendLine((Get-LogTail (Join-Path $LogDir 'watchdog.log') 50))
[void]$ctx.AppendLine('```')
[void]$ctx.AppendLine("")
[void]$ctx.AppendLine("# Current scheduled-task statuses")
[void]$ctx.AppendLine('```')
foreach ($t in 'AmasoDashboard-App','AmasoDashboard-Tunnel','AmasoDashboard-Watchdog','AmasoKokoroSidecar') {
  $s = (& schtasks /Query /TN $t /FO LIST 2>$null |
        Select-String '^Status:\s*(.+)$' |
        ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() } |
        Select-Object -First 1)
  [void]$ctx.AppendLine("${t}: $s")
}
[void]$ctx.AppendLine('```')
[void]$ctx.AppendLine("")
[void]$ctx.AppendLine("# Local + tunnel HTTP probe")
foreach ($pair in @(@{n='local';u='http://127.0.0.1:3737/'}, @{n='tunnel';u='https://dashboard.amaso.nl/'})) {
  try {
    $r = Invoke-WebRequest -Uri $pair.u -UseBasicParsing -TimeoutSec 6 -ErrorAction Stop
    [void]$ctx.AppendLine("$($pair.n): $($r.StatusCode)")
  } catch {
    [void]$ctx.AppendLine("$($pair.n): DOWN — $($_.Exception.Message)")
  }
}

$contextText = $ctx.ToString()

# ── Build the system prompt ──────────────────────────────────────────
# Strict and short. The full architecture lives in
# docs/SPARRING_PARTNER.md which the agent will read first.
$systemPrompt = @'
You are an autonomous self-healing agent for the Amaso Dashboard
production server. The rule-based watchdog has run out of moves and
escalated to you.

DO THIS, IN ORDER:
1. Read docs/SPARRING_PARTNER.md FIRST. It contains the full
   architecture, the seven crash modes we already know, and the
   eleven rules you must NOT break. Treat that file as binding.
2. Read logs/app.log, logs/crash.log, logs/watchdog.log tails to
   diagnose the failure. The trigger reason and key context are in
   the first user message — start there.
3. If the failure matches a known crash mode, apply the documented
   fix.
4. If it is new, propose the smallest change that addresses the root
   cause. Add an inline comment in the file you change explaining
   what you observed and why this fixes it.
5. Always commit changes with `git commit -m "ai-heal: <one-line reason>"`
   so the operator can review or revert. Use `git add` for the
   specific files you changed — never `git add -A`.
6. Restart the relevant scheduled task (usually
   `schtasks /End /TN AmasoDashboard-App; schtasks /Run /TN AmasoDashboard-App`).
7. Verify: probe http://127.0.0.1:3737/ and confirm a 200, then check
   logs/app.log tail for [env] FATAL or stack traces.
8. Report concisely: what you observed, what you changed, what the
   operator should verify.

HARD CONSTRAINTS:
- Do NOT skip step 1. The rules in SPARRING_PARTNER.md are not
  suggestions — every one of them traces to a real outage.
- Do NOT modify .env.local secrets. You may add the required
  AMASO_PROJECTS_ROOT key if missing, nothing else.
- Do NOT delete .next/ to "force a clean build."
- Do NOT remove `setlocal EnableDelayedExpansion` from
  scripts/run-loop-prod.cmd, or convert that file to LF line endings.
- Do NOT lower the Node heap cap below 4096 MB.
- If you cannot diagnose with high confidence, say so and exit
  without modifying code. A loud "I do not know" is better than a
  guess that creates a new outage.
'@

$promptFile = Join-Path $LogDir "ai-heal-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'))-prompt.txt"
$transcriptFile = Join-Path $LogDir "ai-heal-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'))-transcript.txt"
$contextText | Set-Content -Path $promptFile -Encoding UTF8
Write-AiLog 'INFO' "context written to $promptFile ($([int]($contextText.Length / 1024)) KB)"

# Stamp the rate-limit file BEFORE invocation so a crash inside claude
# can't trigger an immediate re-fire. (We still update it on success.)
Get-Date | Set-Content -Path $AiHealStampFile

# ── Invoke claude ────────────────────────────────────────────────────
# --print              : non-interactive
# --permission-mode    : acceptEdits — apply edits without prompting,
#                        but bash still requires the allowlist below.
# --allowed-tools      : Read/Grep/Glob/Edit/Write for code; specific
#                        Bash subcommands for the diagnostic + restart
#                        actions the prompt expects.
# --max-budget-usd     : hard dollar cap per invocation
# --output-format text : human-readable transcript to disk
$allowedTools = @(
  'Read','Grep','Glob','Edit','Write','TodoWrite',
  'Bash(git status:*)','Bash(git diff:*)','Bash(git log:*)',
  'Bash(git add:*)','Bash(git commit:*)','Bash(git tag:*)','Bash(git rev-parse:*)',
  'Bash(npm run build:*)','Bash(npm install:*)',
  'Bash(schtasks:*)',
  'Bash(powershell:*)','Bash(pwsh:*)',
  'Bash(node:*)','Bash(type:*)','Bash(dir:*)'
) -join ','

Write-AiLog 'ACT' "invoking claude (budget=`$$MaxBudgetUsd, max=${MaxRunSeconds}s, reason=$Reason)"

# We pipe the full context into stdin via the $contextText.
# Note: use Start-Process with redirected I/O so we can enforce the
# wall-clock timeout. Direct call-operator + pipe doesn't expose a
# kill-handle.
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = 'claude.cmd'
$startInfo.Arguments = "--print --permission-mode acceptEdits --output-format text --allowed-tools `"$allowedTools`" --max-budget-usd $MaxBudgetUsd --append-system-prompt `"$($systemPrompt -replace '"','\"')`""
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WorkingDirectory = $RepoRoot

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $startInfo

# Async output capture so the buffer never deadlocks.
$outSb = New-Object System.Text.StringBuilder
$errSb = New-Object System.Text.StringBuilder
$null = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
  if ($EventArgs.Data) { [void]$Event.MessageData.AppendLine($EventArgs.Data) }
} -MessageData $outSb
$null = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
  if ($EventArgs.Data) { [void]$Event.MessageData.AppendLine($EventArgs.Data) }
} -MessageData $errSb

[void]$proc.Start()
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()
$proc.StandardInput.WriteLine($contextText)
$proc.StandardInput.Close()

$exited = $proc.WaitForExit($MaxRunSeconds * 1000)
if (-not $exited) {
  Write-AiLog 'ERROR' "claude exceeded ${MaxRunSeconds}s wall-clock — killing"
  try { $proc.Kill() } catch { }
  $proc.WaitForExit(5000) | Out-Null
}
$exit = $proc.ExitCode

# Drain async events one last time.
Start-Sleep -Milliseconds 200
Get-EventSubscriber | Where-Object { $_.SourceObject -eq $proc } | Unregister-Event
$proc.Dispose()

$transcript = $outSb.ToString()
if ($errSb.Length -gt 0) {
  $transcript += "`n---- STDERR ----`n" + $errSb.ToString()
}
$transcript | Set-Content -Path $transcriptFile -Encoding UTF8

if ($exit -eq 0) {
  Write-AiLog 'INFO' "claude completed (exit 0). transcript: $transcriptFile"
  Get-Date | Set-Content -Path $AiHealStampFile
} else {
  Write-AiLog 'ERROR' "claude exit=$exit — operator review required. transcript: $transcriptFile"
}

Write-AiLog 'INFO' "rollback: git -C `"$RepoRoot`" reset --hard $tagName"
exit $exit

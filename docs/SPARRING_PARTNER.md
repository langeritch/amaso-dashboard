# Sparring-partner brief — Amaso Dashboard production runtime

You are a sparring partner working alongside the operator on the
**Amaso Dashboard** production deployment. Read this entire document
before suggesting any change to the runtime, infrastructure, or boot
path. The dashboard has crashed several times for reasons that look
trivial in hindsight; the rules below codify what we learned.

---

## What's actually running

`https://dashboard.amaso.nl` is **not on Vercel, not on a VPS**. It is
served from the operator's Windows 11 PC (`DESKTOP-71JO59G`, 16 GB RAM)
through a Cloudflare Tunnel. The full stack:

```
Internet
  → Cloudflare edge (HTTPS, https://dashboard.amaso.nl)
  → cloudflared (HTTP/2, scheduled task: AmasoDashboard-Tunnel)
  → Next.js custom server on 127.0.0.1:3737 (scheduled task: AmasoDashboard-App)
        ├─ tsx-loaded server.ts (the "mother process")
        ├─ Next.js production handler (.next/* pre-compiled bundle)
        ├─ Chokidar watcher (lib/watcher.ts) for project source files
        ├─ WebSocket servers (lib/ws.ts, terminal-ws, browser-ws, companion-ws)
        ├─ Spawned child: kokoro TTS sidecar (port 3939, scheduled task too)
        └─ Spawned child: telegram-voice Python (port 8765)
```

There are **four scheduled tasks**:

| Task | What it runs | Restart strategy |
|---|---|---|
| `AmasoDashboard-App` | `cmd.exe /c scripts/run-loop-prod.cmd` | infinite `:loop` inside the script + 5→15→45→120s exponential backoff |
| `AmasoDashboard-Tunnel` | `cloudflared tunnel run …` | task-scheduler "restart on failure" |
| `AmasoKokoroSidecar` | `kokoro_tts` server.py | task-scheduler "restart on failure" |
| `AmasoDashboard-Watchdog` | `pwsh scripts/watchdog.ps1` | meta-watchdog (`AmasoDashboard-WatchdogMeta`) auto-restarts if heartbeat goes stale |

The `Run As User` is `santi` with **S4U logon** — these run in
**session 0** without a desktop. Don't expect Windows toasts or any UI.

## The mother process

`server.ts` is the only thing that should ever be in charge of port
3737. It does, in order:

1. Strip tsx loader flags from `process.execArgv` (so jest-worker
   forks for Next's `getStaticPaths` workers don't inherit them and
   die with `ERR_MODULE_NOT_FOUND`).
2. Call `validateEnv()` — fails fast and `process.exit(1)`s if
   `AMASO_PROJECTS_ROOT` is missing in production. **It loads
   `.env.local` itself before checking** (we don't depend on Next's
   own dotenv timing, which runs *after* `validateEnv`).
3. `assertPortFree(3737)` — refuses to start if anything is already
   bound. Required because Windows happily lets one process bind
   `0.0.0.0:3737` and another `[::]:3737` simultaneously, and the
   kernel routes connections nondeterministically. Cloudflared has
   delivered traffic to the wrong process this way.
4. Start Next.js, install crash handlers (`uncaughtException`,
   `unhandledRejection` writing **synchronously** to `logs/crash.log`),
   start watcher + WS servers, kick off `seedFromConfig()` in the
   background (NOT awaited — see "Boot ordering" below).
5. Spawn kokoro + telegram-voice children.

## Boot ordering — non-negotiable

The HTTP listener must come up **before** seedFromConfig runs. We
learned this when the watchdog kept killing a perfectly-fine server
that was 40s into seeding 200 MB of file content into the diff
snapshot map: `app.listen` was queued behind `await seedFromConfig()`,
so port 3737 stayed silent until seeding finished, and the watchdog
declared the dashboard dead at 30s.

- `seedFromConfig` is fire-and-forget: `void seedFromConfig().catch(…)`.
- It yields to the event loop every 25 files (`setImmediate`) so probes
  during seed don't queue.
- Total seed bytes are capped at 200 MB; per-file content cap is 128 KB.
- It only seeds extensions on `SEED_EXT_ALLOW`. Lock files (npm/yarn/
  pnpm/bun/cargo/poetry/uv) are never read into memory.

## How crashes have actually happened

Every outage in the last two weeks fits one of these patterns. If you
see new symptoms that don't match any of these, **stop and ask the
operator** — don't auto-pattern-match.

### 1. `.next/BUILD_ID` deleted/missing

`npm start` aborts in ~1 s with *"Could not find a production build in
the '.next' directory."* The run-loop wrapper sees the missing
`.next/BUILD_ID`, drops `logs/build.lock`, and runs `npm run build`
(25–60 s). The watchdog honours `build.lock` and **suppresses both the
dashboard and the tunnel probes** during that window. Without the
sentinel, the watchdog killed the task mid-build, which spawned a new
run-loop instance that started another fresh build — perpetual rebuild
loop. (2026-04-26 14:08–14:24 UTC.)

### 2. OOM in `seedFromConfig` (heap saturation)

Old heap cap was 2 GB. Post-seed steady state is ~2.3 GB and the seed
phase peaks higher; one concurrent allocation OOM-killed the mother
process. Bumped to **4 GB** in `run-loop-prod.cmd`
(`NODE_OPTIONS=--max-old-space-size=4096`). Plus the 200 MB seed-bytes
budget so a freshly-cloned monorepo can't OOM us either.

### 3. `chokidar` parent-path RangeError

`chokidar` could emit paths above the watch root; `path.relative`
returned `..`, `ig.ignores('..')` threw, the rejection went unhandled,
allocations spiralled at ~350 MB/s until OOM. Fix in `lib/watcher.ts`:
`if (rel === ".." || rel.startsWith("../")) return true;` plus a
try/catch around `ig.ignores`. Don't remove either guard.

### 4. `add` flood at startup

`chokidar` was started with `ignoreInitial: false`, which emitted an
`add` for every existing file — each triggered a `fs.readFile` into
the snapshots map. Combined with #2 this OOM'd within 90 s of boot.
Now `ignoreInitial: true` (we already seed via `seedFromConfig`).

### 5. `[env] FATAL: required env var missing — AMASO_PROJECTS_ROOT`

`validateEnv()` exited with code 1 ~50 ms after boot every restart.
The run-loop respawned, build finished, npm started, server died,
respawn… Defence-in-depth fix:

- `.env.local` defines `AMASO_PROJECTS_ROOT=C:\Users\santi\projects`.
- `run-loop-prod.cmd` ALSO `set`s the same value before launching node.
- `server.ts` `validateEnv()` reads `.env.local` itself before checking.
- Watchdog `Fix-EnvLocalMissingKeys` runs every tick and re-asserts the
  key if `.env.local` is ever wiped.

Three layers, because losing this var takes the dashboard down hard.

### 6. CRLF/LF in `run-loop-prod.cmd`

If anything ever rewrites this file with LF-only line endings,
`cmd.exe` fails to parse it: it eats leading characters from each
line, throws *"X is not recognized as an internal or external
command"* for every line, exits 255, and the task is dead. **Always
keep `scripts/run-loop-prod.cmd` in CRLF.** Editors with `eol: lf`
project rules will silently break this file.

### 7. `!VAR!` not expanding in `run-loop-prod.cmd`

The script depends on `setlocal EnableDelayedExpansion`. Without it,
`!EXIT!`/`!UPTIME_S!`/`!BACKOFF!` print literally and the backoff
math, the exit-code log, and the conditional retry all break. Don't
remove `EnableDelayedExpansion` from line 15.

## The watchdog (`scripts/watchdog.ps1`)

Runs every 30 s. Each tick, in order:

1. **`Touch-Heartbeat`** — stamp `logs/watchdog.heartbeat`. The
   meta-watchdog kills this watchdog if the stamp is > N s old,
   which catches "the watchdog itself is hung on a half-open socket"
   failure mode.
2. **`Tick-AutoFix`** (preventive layer):
   - `Fix-EnvLocalMissingKeys` — re-creates `.env.local` if missing,
     appends required keys if absent. Idempotent. Logs only on change.
   - `Fix-MissingBuildId` — if `.next\BUILD_ID` is missing AND the
     App task is NOT running (so the run-loop isn't already building),
     drop a `build.lock` and run `npm run build` ourselves.
   - `Fix-DetectFatalLoop` — scan tail of `app.log` for ≥3 `[env] FATAL`
     lines and re-assert the env file once if so.
3. **`Tick-Component dashboard / tunnel / kokoro`** — HTTP probe each.
   3 consecutive fails (~90 s) trigger a repair (`schtasks /End` then
   `/Run`). Cooldown after repair: 120 s for dashboard, 60 s for
   tunnel/kokoro. Probes during a `build.lock` window are skipped.
4. **`Stop-KokoroDuplicates`** — kokoro can leak processes when its
   model server hangs; this kills any non-listener kokoro pythons.

Every action is logged to `logs/watchdog.log` with UTC ISO timestamps.

## Rules — things the sparring partner must NOT do

These have all been tried; each one took the box down.

1. **Do not `rm -rf .next`** to "force a fresh build." That triggers
   the perpetual-rebuild loop unless the run-loop is healthy enough
   to honour build.lock — and if you're being asked to do this,
   it usually isn't. If a stale build is suspected, run
   `npm run build` first, *then* let the watchdog restart the task.
2. **Do not unset, rename, or rewrite `AMASO_PROJECTS_ROOT`** in
   `.env.local`. The watchdog will fight you, but during the gap the
   server crash-loops.
3. **Do not edit `scripts/run-loop-prod.cmd` in an editor that
   converts to LF.** Verify CRLF after save:
   `(Get-Content -Encoding Byte run-loop-prod.cmd | Select-Object -First 16)`
   should show `0D 0A` pairs, not bare `0A`.
4. **Do not remove `setlocal EnableDelayedExpansion`** from
   `run-loop-prod.cmd`. The `!VAR!` references downstream depend on it.
5. **Do not lower the Node heap cap below 4096 MB.** Steady state is
   ~2.3 GB; anything tighter risks OOM during seed.
6. **Do not `kill` node processes by PID** unless you've confirmed
   the parent cmd is *also* dying (kill whole process tree, or use
   `schtasks /End /TN AmasoDashboard-App`). Killing just the node
   leaves the cmd respawning into a possibly half-cleaned state.
7. **Do not remove `ignoreInitial: true`** from chokidar config in
   `lib/watcher.ts`. We seed via `seedFromConfig` — duplicating that
   work via `add` events OOMs the box.
8. **Do not remove the `if (rel === ".." || rel.startsWith("../"))
   return true;` guard** in `lib/watcher.ts`. The unhandled-rejection
   storm allocates ~350 MB/s.
9. **Do not change `ignoreInitial`, `MAX_SEED_BYTES_TOTAL`,
   `MAX_CONTENT_BYTES`, or the cooperative `setImmediate` yield in
   `lib/history.ts` without measuring** seed-phase RSS first. Each of
   those numbers was set after a specific incident.
10. **Do not commit secrets** (`AMASO_VAPID_PRIVATE`,
    `TELEGRAM_VOICE_TOKEN`) to git. They live only in `.env.local`.
11. **Do not point `AMASO_PROJECTS_ROOT` at the dashboard's own repo
    directory.** It's a hosting root for client projects, not a
    self-reference; the watcher would observe its own writes and
    create a feedback loop.

## Diagnostic playbook

If the operator says "it's down," in order:

1. `Test-Path C:\Users\santi\Projects\amaso-dashboard\logs\build.lock`
   — if present and < 10 min old, a build is in progress, **wait**.
2. `(Invoke-WebRequest http://127.0.0.1:3737/ -UseBasicParsing).StatusCode`
   — if 200, dashboard is fine and the issue is the tunnel.
3. `(Invoke-WebRequest https://dashboard.amaso.nl/).StatusCode`
   — if local 200 but tunnel ≠ 200, restart cloudflared:
   `schtasks /End /TN AmasoDashboard-Tunnel; schtasks /Run /TN AmasoDashboard-Tunnel`.
4. `Get-Content logs\app.log -Tail 50` — look for `[env] FATAL`,
   `Error:`, OOM, `Could not find a production build`. The cause is
   almost always in the last 50 lines.
5. `Get-Content logs\crash.log` — if it exists, the mother process
   crashed via uncaughtException/unhandledRejection. Stack trace is
   inline.
6. `Get-Content logs\watchdog.log -Tail 30` — see what the watchdog
   has been doing. If it's repair-looping, the auto-fixer either
   didn't fire (check tick log for `ALERT FATAL crash-loop`) or fired
   and didn't help (genuine new failure mode — escalate).
7. Stuck/zombie processes:
   `Get-Process node, cmd | Where-Object { $_.StartTime -lt (Get-Date).AddDays(-1) }`
   — anything older than the last task restart is a leak. Kill by ID.

## When you're proposing a change

State explicitly:
- **What incident or symptom this addresses** (link to the section
  above, or a log timestamp).
- **What invariants you're preserving** (the rules list).
- **How you'd verify the change** before declaring victory: at minimum
  `local 200 + tunnel 200 + no crash.log + 2 minutes of clean
  watchdog.log`.

If you can't meet those three bars, the change isn't ready.

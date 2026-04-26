@echo off
REM Self-healing wrapper for the Next.js PRODUCTION server.
REM Runs `npm start` (= NODE_ENV=production tsx server.ts), which serves
REM the pre-compiled .next output instead of dev-mode turbopack.
REM
REM Why prod mode: the dev server periodically wedged the box ? 2 GB RAM,
REM 25% sustained CPU, compile storms every few minutes that made the
REM dashboard + kokoro + tunnel all hard-timeout simultaneously (seen in
REM logs/watchdog.log around 2026-04-24 15:47-15:50Z). Prod mode uses
REM pre-compiled bundles: ~300 MB RAM, <2% idle CPU, no recompile wedges.
REM
REM If you change code: run `npm run build` manually, then the watchdog
REM will pick up the new bundle on the next task restart (or run
REM `schtasks /End /Run AmasoDashboard-App`).
setlocal EnableDelayedExpansion
cd /d "%~dp0\.."
REM 4096 MB heap cap. The previous 2048 MB cap was the actual ceiling that
REM OOM-killed the server during seedFromConfig: post-seed steady state is
REM ~2.3 GB and the seed phase pushes higher. Bumping to 4 GB gives ~70%
REM headroom over steady state and removes the cliff. The PC has 16 GB RAM
REM so even 4 GB is well below pressure thresholds.
set NODE_OPTIONS=--max-old-space-size=4096

REM AMASO_PROJECTS_ROOT is enforced as a hard requirement by validateEnv()
REM in server.ts when NODE_ENV=production. .env.local also defines it (for
REM Next routes), but we set it explicitly here so the prod-launcher works
REM even if Next's dotenv timing changes or .env.local goes missing. This
REM is the env var whose absence took us down on 2026-04-26: server.ts
REM exited 50ms after boot, run-loop respawned, fresh build, repeat.
set AMASO_PROJECTS_ROOT=C:\Users\santi\projects

if not exist logs mkdir logs

REM Exponential backoff state. A clean shutdown (uptime > 60s) resets the
REM counter; back-to-back fast crashes ramp the wait so we don't pin the
REM CPU at ~8s/cycle while the operator (or a fix) catches up. Saw an
REM OOM crash loop where the old constant 5s wait + ~3s npm-start startup
REM produced 450 retries/hour with zero progress.
set BACKOFF=5

:loop
REM Self-heal a missing/stale .next bundle. `npm start` aborts in ~1s with
REM "Could not find a production build in the '.next' directory" if the
REM build output is gone ? without this guard the loop spins forever
REM (~8s per cycle) consuming CPU and producing zero recovery. Saw this
REM after a manual `.next` cleanup left the dashboard down for hours.
if not exist ".next\BUILD_ID" (
  echo [%date% %time%] .next\BUILD_ID missing -- running npm run build first >> logs\app.log
  REM Drop a sentinel so the watchdog knows this isn't a sick server, it's
  REM a legitimate build in progress (~25-60s). Without this signal the
  REM watchdog probes localhost:3737, gets connection-refused, declares
  REM the dashboard unhealthy, kills run-loop-prod.cmd MID-BUILD, the new
  REM run-loop instance starts ANOTHER fresh build from scratch ? and so
  REM on. This is the loop the user kept hitting tonight.
  echo build started %date% %time% > logs\build.lock
  call npm run build >> logs\app.log 2>&1
  del logs\build.lock 2>nul
  if not exist ".next\BUILD_ID" (
    echo [%date% %time%] build FAILED -- waiting 30s before retry >> logs\app.log
    timeout /t 30 /nobreak > nul
    goto loop
  )
  echo [%date% %time%] build OK -- proceeding to npm start >> logs\app.log
)

echo [%date% %time%] starting npm start (production) >> logs\app.log
REM Capture wall-clock around npm start so we can decide whether to back off.
REM %time% is HH:MM:SS.cc ? strip non-digit chars and convert to centiseconds
REM (cs from midnight). Wraps at midnight; we compensate by adding 24h if the
REM end is < the start.
call :now START_CS
call npm start >> logs\app.log 2>&1
set EXIT=%errorlevel%
call :now END_CS
set /a UPTIME_CS=END_CS-START_CS
if !UPTIME_CS! LSS 0 set /a UPTIME_CS+=8640000
set /a UPTIME_S=UPTIME_CS/100

if !UPTIME_S! GEQ 60 (
  REM Ran for at least a minute -- treat as a clean lifecycle, reset backoff.
  set BACKOFF=5
) else (
  REM Crashed quickly -- ramp backoff: 5 -> 15 -> 45 -> 120 (capped).
  set /a BACKOFF=BACKOFF*3
  if !BACKOFF! GTR 120 set BACKOFF=120
)
echo [%date% %time%] exited with code !EXIT! after !UPTIME_S!s, restarting in !BACKOFF!s >> logs\app.log
timeout /t !BACKOFF! /nobreak > nul
goto loop

:now
REM Returns centiseconds-since-midnight in the variable named by %1.
set _t=%time: =0%
set _h=%_t:~0,2%
set _m=%_t:~3,2%
set _s=%_t:~6,2%
set _c=%_t:~9,2%
REM Strip leading zeros to avoid octal interpretation.
set /a _h=1%_h%-100
set /a _m=1%_m%-100
set /a _s=1%_s%-100
set /a _c=1%_c%-100
set /a %1=((_h*3600)+(_m*60)+_s)*100+_c
exit /b 0

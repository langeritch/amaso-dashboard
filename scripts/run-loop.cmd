@echo off
REM Self-healing wrapper for the Next.js dev server.
REM Restarts npm run dev whenever it exits, for any reason.
setlocal
cd /d "%~dp0\.."
set NODE_OPTIONS=--max-old-space-size=4096
if not exist logs mkdir logs

:loop
echo [%date% %time%] starting npm run dev >> logs\app.log
call npm run dev >> logs\app.log 2>&1
echo [%date% %time%] exited with code %errorlevel%, restarting in 5s >> logs\app.log
timeout /t 5 /nobreak > nul
goto loop

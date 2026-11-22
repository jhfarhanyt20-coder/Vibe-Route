@echo off
title Vibe Route (light)
cd /d "%~dp0"

rem Light mode: no Electron window. Starts the gateway and opens the dashboard
rem in your default browser. This is the fastest way to open Vibe Route.
set "PORT=8787"
for /f "delims=" %%p in ('node -e "try{process.stdout.write(String(require('./config.json').port||8787))}catch(e){process.stdout.write('8787')}"') do set "PORT=%%p"

start "" /b cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:%PORT%"
echo Starting Vibe Route on http://127.0.0.1:%PORT%
echo Close this window or press Ctrl+C to stop the gateway.
echo.
node proxy.cjs
echo.
echo Proxy stopped. Press any key to close.
pause >nul

@echo off
title Vibe Route
cd /d "%~dp0"
echo Starting Vibe Route...
echo.
node proxy.cjs
echo.
echo Proxy stopped. Press any key to close.
pause >nul

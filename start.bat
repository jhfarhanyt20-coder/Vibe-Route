@echo off
title BD Route
cd /d "%~dp0"
echo Starting BD Route...
echo.
node proxy.cjs
echo.
echo Proxy stopped. Press any key to close.
pause >nul

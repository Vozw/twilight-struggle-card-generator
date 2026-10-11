@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on your PATH.
  echo Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if "%TSCG_PORT%"=="" set TSCG_PORT=8731

start "" "http://127.0.0.1:%TSCG_PORT%/"
node server.js

pause

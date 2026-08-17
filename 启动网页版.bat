@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto :node_missing

if not exist node_modules (
    call npm install --no-audit --no-fund
    if errorlevel 1 goto :error
)

call npm run build
if errorlevel 1 goto :error

start "" "http://127.0.0.1:4174"
call npm start
if errorlevel 1 goto :error
goto :eof

:node_missing
echo Node.js was not found. Install Node.js 20 or newer, then run this file again.
pause
exit /b 1

:error
echo Startup failed. Read the error above.
pause
exit /b 1

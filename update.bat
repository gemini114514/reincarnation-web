@echo off
cd /d "%~dp0"
set LOG=%~dp0update.log
echo [%date% %time%] update started >>"%LOG%"

rem Kill the old server on port 4174 if still running (the auto-update path
rem already exits it; this covers manual double-click runs while a server is up).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":4174" ^| findstr "LISTENING"') do taskkill /f /pid %%a >>"%LOG%" 2>&1

echo [%date% %time%] git pull ... >>"%LOG%"
git pull >>"%LOG%" 2>&1
if errorlevel 1 goto :fail

echo [%date% %time%] npm install ... >>"%LOG%"
call npm install >>"%LOG%" 2>&1
if errorlevel 1 goto :fail

echo [%date% %time%] npm run build ... >>"%LOG%"
call npm run build >>"%LOG%" 2>&1
if errorlevel 1 goto :fail

echo [%date% %time%] starting new server ... >>"%LOG%"
start "" http://127.0.0.1:4174
start "ReincarnationServer" /min node server.js
echo [%date% %time%] update done >>"%LOG%"
exit /b 0

:fail
echo [%date% %time%] update failed, see update.log >>"%LOG%"
echo Update failed. See update.log
pause
exit /b 1

@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run build
if errorlevel 1 goto :error
start "" http://127.0.0.1:4174
call npm start
goto :eof
:error
echo 启动失败，请查看上方错误。
pause

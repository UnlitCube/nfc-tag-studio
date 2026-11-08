@echo off
rem NFC Tag Studio dev launcher - double-click to start (renderer hot reload).
rem Keep this file ASCII-only (cmd.exe on Japanese Windows uses CP932 - UTF-8
rem comments/echo would turn to mojibake).
cd /d "%~dp0"
rem The app and its logs write UTF-8; switch the console so they stay readable.
chcp 65001 >nul
rem ELECTRON_RUN_AS_NODE (sometimes set system-wide) would start Electron as plain
rem Node: no window, crash on first app/protocol call. Clear it for this launch.
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="
where npm >nul 2>nul
if errorlevel 1 ( echo [error] npm not found. Install Node.js first. & goto :error )
if not exist node_modules (
  echo [setup] first run: installing dependencies...
  call npm install
  if errorlevel 1 goto :error
)
echo [start] launching NFC Tag Studio (dev)...
call npm run dev
if errorlevel 1 goto :error
exit /b 0
:error
echo.
echo [error] Failed to start. Check the log above.
pause
exit /b 1

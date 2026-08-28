@echo off
cd /d "%~dp0"

:: Clean port 8790
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8790 ^| findstr LISTENING') do (
    echo [Clean] Killing PID=%%a on port 8790...
    taskkill /PID %%a /F >nul 2>&1
    timeout /t 1 /nobreak >nul
)

:: Open browser
start "" http://localhost:8790

:: Start service
node webapp.js

:: Cleanup on exit
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8790 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)
pause

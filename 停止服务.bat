@echo off
cd /d "%~dp0"
echo 正在停止监控服务并释放端口...
if exist "data\webhook.pid" (
    for /f %%p in (data\webhook.pid) do curl -s -m 3 "http://127.0.0.1:8787/__shutdown?pid=%%p" >nul 2>&1
)
if exist "data\webapp.pid" (
    for /f %%p in (data\webapp.pid) do curl -s -m 3 "http://127.0.0.1:8790/__shutdown?pid=%%p" >nul 2>&1
)
if exist "data\monitor.pid" (
    for /f %%p in (data\monitor.pid) do taskkill /F /PID %%p >nul 2>&1
)
taskkill /F /IM cloudflared.exe >nul 2>&1
timeout /t 2 /nobreak >nul
echo 完成。想重新启动就运行 一键启动全部.bat
pause

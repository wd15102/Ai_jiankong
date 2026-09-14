@echo off
title AI Monitor Service - 按 Q 键停止服务并退出
cd /d "%~dp0"

echo ==============================================
echo   AI Monitor Service
echo ==============================================
echo.

:: ---------- [1/4] 隧道 ----------
:: 读取 config.json 中 wxTest.publicBase (花生壳外网域名)
set "TUNNEL_URL="
for /f "delims=" %%u in ('node -e "var c=require('./config.json');console.log((c&&c.wxTest&&c.wxTest.publicBase)||'')"') do set "TUNNEL_URL=%%u"
:: 停掉可能残留的 cloudflared / tailscale 进程, 避免端口冲突
taskkill /F /IM cloudflared.exe >nul 2>&1
:: 花生壳客户端由用户手动开启并映射 127.0.0.1:8787, 本脚本不启动任何隧道
echo [1/4] 隧道模式: 花生壳内网穿透 (请确保花生壳客户端已运行)
if not defined TUNNEL_URL set "TUNNEL_URL=http://你的域名.vicp.fun"
:start_services
echo.
echo [2/4] 停止旧服务...
if exist "data\webhook.pid" (
    for /f %%p in (data\webhook.pid) do curl -s -m 3 "http://127.0.0.1:8787/__shutdown?pid=%%p" >nul 2>&1
)
if exist "data\webapp.pid" (
    for /f %%p in (data\webapp.pid) do curl -s -m 3 "http://127.0.0.1:8790/__shutdown?pid=%%p" >nul 2>&1
)
if exist "data\monitor.pid" (
    for /f %%p in (data\monitor.pid) do taskkill /F /PID %%p >nul 2>&1
)
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'webhook\.js|webapp\.js|monitor\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo [3/4] 启动服务...
start "AI-Monitor-Wx" /min cmd /c "node webhook.js >> data\webhook_run.log 2>&1"
start "AI-Monitor-Web" /min cmd /c "node webapp.js --cfg config.json >> data\webapp_run.log 2>&1"
start "AI-Monitor-Monitor" /min cmd /c "node monitor.js watch >> data\monitor_run.log 2>&1"
timeout /t 3 /nobreak >nul

echo [4/4] 健康检查...
curl -s -m 5 http://127.0.0.1:8790/health | findstr "ok" >nul && echo     WebApp OK || echo     WebApp [checking...]
curl -s -m 5 http://127.0.0.1:8787/health | findstr "ok" >nul && echo     Webhook OK || echo     Webhook [checking...]
timeout /t 1 /nobreak >nul
:: 自动打开 Web 看板
start "" http://localhost:8790

:: 更新 config.json (用 node, 避免 PS 的 GBK 读 UTF-8 中文乱码)
node -e "var fs=require('fs'),p='config.json',c=JSON.parse(fs.readFileSync(p,'utf8'));if(c.wxTest&&process.env.TUNNEL_URL){c.wxTest.publicBase=process.env.TUNNEL_URL;c.wxTest.lastUpdated=new Date().toISOString()}fs.writeFileSync(p,JSON.stringify(c,null,2),'utf8')"

echo.
echo ==============================================
echo   Service started!
echo   Web: http://localhost:8790
echo   Tunnel: %TUNNEL_URL%
echo ==============================================
echo.

:watchdog
echo.
echo   [服务运行中] 按 Q 停止所有服务并释放端口后退出 (直接关窗口, 服务仍在后台!)
choice /c QN /t 60 /d N /n >nul
if errorlevel 2 goto :keep_guard
:: ---- 用户按了 Q: 优雅停止并释放 ----
echo.
echo   [停止] 正在停止服务并释放端口...
if exist "data\webhook.pid" (
    for /f %%p in (data\webhook.pid) do curl -s -m 3 "http://127.0.0.1:8787/__shutdown?pid=%%p" >nul 2>&1
)
if exist "data\webapp.pid" (
    for /f %%p in (data\webapp.pid) do curl -s -m 3 "http://127.0.0.1:8790/__shutdown?pid=%%p" >nul 2>&1
)
taskkill /F /IM cloudflared.exe >nul 2>&1
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'webhook\.js|webapp\.js|monitor\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo   [完成] 服务已停止, 端口已释放, 可安全关闭窗口。
pause
exit /b 0
:keep_guard
:: 服务守护: 挂了自动重启
curl -s -m 3 http://127.0.0.1:8787/health >nul 2>&1
if errorlevel 1 (
    echo [%time%] Webhook died, restarting...
    start "AI-Monitor-Wx" /min cmd /c "node webhook.js >> data\webhook_run.log 2>&1"
    timeout /t 3 /nobreak >nul
)
curl -s -m 3 http://127.0.0.1:8790/health >nul 2>&1
if errorlevel 1 (
    echo [%time%] WebApp died, restarting...
    start "AI-Monitor-Web" /min cmd /c "node webapp.js --cfg config.json >> data\webapp_run.log 2>&1"
    timeout /t 3 /nobreak >nul
)
goto watchdog

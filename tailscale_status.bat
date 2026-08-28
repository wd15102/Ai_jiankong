@echo off
:: Tailscale / Funnel 健康自查
echo ==== 1. 节点连接状态 (direct=直连稳 / relay=中继慢) ====
set "TS=C:\Program Files\Tailscale\tailscale.exe"
%TS% status
echo.
echo ==== 2. Funnel 是否在线 ====
%TS% funnel status
echo.
echo ==== 3. 最近 DERP 节点延迟 (Funnel 走中继, 东京100ms上下属正常) ====
%TS% netcheck 2>nul | findstr /i "Nearest DERP DERP latency: tok sin hkg"
echo.
echo 说明: 只要第2步显示 Funnel on 且 URL 是 你的域名.ts.net 就正常。
pause

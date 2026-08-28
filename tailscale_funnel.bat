@echo off
:: 保持 Tailscale Funnel 开启，固定URL: https://你的域名.ts.net -> 8787
set TS="C:\Program Files\Tailscale\tailscale.exe"
%TS% funnel status | findstr "Funnel on" >nul 2>&1 || %TS% funnel --bg 8787

@echo off
:: 以管理员身份运行：清理已弃用的 cloudflared 残留进程
echo 正在清理 cloudflared.exe ...
taskkill /F /IM cloudflared.exe
echo.
echo 完成。如果上面显示"成功: 已终止"则已清理。
pause

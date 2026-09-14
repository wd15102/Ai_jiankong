@echo off
cd /d "%~dp0"
echo ==============================================
echo   公众号菜单追加「历史记录」按钮
echo ==============================================
echo.
node tools\update_menu.js
echo.
pause

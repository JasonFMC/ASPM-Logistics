@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-outlook-mail.ps1"
echo.
echo If the line above says Installed, this PC can open the original mail in Outlook.
pause

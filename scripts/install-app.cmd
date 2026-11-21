@echo off
setlocal DisableDelayedExpansion
if "%~1"=="" goto :usage
if not "%~2"=="" goto :usage

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "%~dp0check-installer.ps1" -Path "%~f1" -Launch
exit /b %ERRORLEVEL%

:usage
>&2 echo Usage: install-app.cmd "path\to\installer.exe"
>&2 echo Set BEWITHU_INSTALLER_SHA256 from a trusted release manifest or BEWITHU_PUBLISHER_CERT_SHA256 to a trusted publisher certificate pin.
exit /b 2

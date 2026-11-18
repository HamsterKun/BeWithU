@echo off
rem Launch the latest BeWithU installer after removing the "downloaded from internet"
rem mark (Zone.Identifier). Without that mark Windows SmartScreen usually shows
rem "Windows protected your PC" even for a per-user installer.
setlocal
cd /d "%~dp0.."

set "EXE=%~1"
if "%EXE%"=="" (
  for /f "delims=" %%f in ('dir /b /o-d "release\BeWithU-*-x64.exe" 2^>nul') do (
    set "EXE=release\%%f"
    goto :found
  )
)
:found
if "%EXE%"=="" (
  echo [x] No installer found in release\
  pause
  exit /b 1
)

if not exist "%EXE%" (
  echo [x] Not found: %EXE%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath '%EXE%' -ErrorAction SilentlyContinue"
echo [ok] Unblocked: %EXE%
start "" "%EXE%"

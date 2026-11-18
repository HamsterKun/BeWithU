@echo off
setlocal
cd /d "%~dp0.."

set "DSHROOT=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies"
if exist "%DSHROOT%\node\bin\node.exe" (
  set "NODE=%DSHROOT%\node\bin\node.exe"
  set "PNPM=%DSHROOT%\pnpm\bin\pnpm.mjs"
) else (
  set "NODE=node"
  set "PNPM="
)

set "ELECTRON_RUN_AS_NODE="
if "%ELECTRON_MIRROR%"=="" set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

if "%PNPM%"=="" (
  call npm install
) else (
  "%NODE%" "%PNPM%" install
)

if errorlevel 1 (
  echo.
  echo [x] install failed
  pause
  exit /b 1
)
echo.
echo [ok] dependencies installed
pause

@echo off
setlocal
cd /d "%~dp0.."

set "DSHROOT=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies"
if exist "%DSHROOT%\node\bin\node.exe" (
  set "NODE=%DSHROOT%\node\bin\node.exe"
) else (
  set "NODE=node"
)

set "ELECTRON_RUN_AS_NODE="
if "%ELECTRON_MIRROR%"=="" set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

"%NODE%" "node_modules\electron-vite\bin\electron-vite.js" dev

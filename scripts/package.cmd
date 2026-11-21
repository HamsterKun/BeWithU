@echo off
setlocal
cd /d "%~dp0.."

set "DSHROOT=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies"
if exist "%DSHROOT%\node\bin\node.exe" (
  set "NODE=%DSHROOT%\node\bin\node.exe"
) else (
  set "NODE=node"
)

rem Keep Electron from running as plain Node.
set "ELECTRON_RUN_AS_NODE="
if "%ELECTRON_MIRROR%"=="" set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

rem Builder binaries (nsis / winCodeSign) via a reachable mirror.
if "%ELECTRON_BUILDER_BINARIES_MIRROR%"=="" set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
rem Cache inside the workspace so repeat packaging does not download again.
if "%ELECTRON_BUILDER_CACHE%"=="" set "ELECTRON_BUILDER_CACHE=%CD%\.cache\electron-builder"

rem NSIS needs a writable TEMP; the system one may be locked down.
if not exist "%CD%\.cache\tmp" mkdir "%CD%\.cache\tmp"
set "TEMP=%CD%\.cache\tmp"
set "TMP=%CD%\.cache\tmp"

echo [1/2] build bundles...
"%NODE%" "node_modules\electron-vite\bin\electron-vite.js" build
if errorlevel 1 goto :fail

echo [2/2] package installer + portable...
rem Use the Electron runtime already installed under node_modules (no download).
"%NODE%" "node_modules\electron-builder\cli.js" --win --x64 --config.electronDist=%CD%\node_modules\electron\dist
if errorlevel 1 goto :fail

echo.
echo [ok] artifacts in release\
dir /b release\*.exe
echo.
echo GitHub Release update assets from this build:
dir /b release\*.exe.blockmap release\latest.yml
echo Upload these with the matching installer EXE.
pause
exit /b 0

:fail
echo.
echo [x] package failed
pause
exit /b 1

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

echo [1/3] typecheck main...
"%NODE%" "node_modules\typescript\bin\tsc" --noEmit -p tsconfig.node.json
if errorlevel 1 goto :fail

echo [2/3] typecheck renderer...
"%NODE%" "node_modules\typescript\bin\tsc" --noEmit -p tsconfig.web.json
if errorlevel 1 goto :fail

echo [3/3] build bundles...
"%NODE%" "node_modules\electron-vite\bin\electron-vite.js" build
if errorlevel 1 goto :fail

echo.
echo [ok] build finished, output in out\
pause
exit /b 0

:fail
echo.
echo [x] build failed
pause
exit /b 1

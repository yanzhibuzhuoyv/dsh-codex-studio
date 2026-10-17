@echo off
setlocal
pushd "%~dp0"
set "ELECTRON_EXE=%CD%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" (
  echo Electron is not installed yet.
  echo Run: npm install
  popd
  pause
  exit /b 1
)
start "DSH Codex Studio" "%ELECTRON_EXE%" .
popd

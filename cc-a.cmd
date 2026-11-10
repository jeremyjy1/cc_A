@echo off
setlocal
set "CC_A_START_DIR=%CD%"
pushd "%~dp0" || exit /b 1
bun --no-env-file run src\entrypoints\cli.tsx gateway %*
set "CC_A_EXIT=%ERRORLEVEL%"
popd
exit /b %CC_A_EXIT%

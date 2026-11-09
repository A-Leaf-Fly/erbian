@echo off
cd /d "%~dp0"
set LISTEN_OPEN=1
set "NODE_EXE="

where node >nul 2>nul && set "NODE_EXE=node"

if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\24.14.0\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\24.14.0\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org/
  pause
  exit /b 1
)

title Listen - local music server
"%NODE_EXE%" listen-server.js
echo.
echo Server exited. Press any key to close.
pause >nul

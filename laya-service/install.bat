@echo off
rem Install the Laya decision service on the WINDOWS laptop.
rem Run this from the laya-service folder (right-click -> "Open in Terminal", then ./install.bat, or just double-click).
setlocal EnableDelayedExpansion

echo ============================================================
echo   Laya decision service installer (Windows since 2026-09-22)
echo ============================================================

rem --- locate python -------------------------------------------------
set "PY=python"
python --version >nul 2>&1
if not %errorlevel%==0 (
  py -3 --version >nul 2>&1
  if not !errorlevel!==0 (
    echo ERROR: Python 3 not found on PATH. Install from https://www.python.org/downloads/
    echo (tick "Add python.exe to PATH" during install), then re-run this.
    pause
    exit /b 1
  )
  set "PY=py -3"
)

echo Using: %PY%
%PY% -c "import sys; raise SystemExit(0 if sys.version_info >= (3,9) else 1)" >nul 2>&1
if not %errorlevel%==0 (
  echo ERROR: need Python >= 3.9.
  pause
  exit /b 1
)

rem --- venv + deps ----------------------------------------------------
if exist ".venv\Scripts\python.exe" (
  echo Reusing existing .venv \(delete it for a clean install\)
) else (
  echo Creating virtual environment...
  %PY% -m venv .venv
)
set "VPY=.venv\Scripts\python.exe"
"%VPY%" -m pip install --upgrade pip >nul
echo Installing laya ^(+ torch/transformers, ~2GB^) - this takes several minutes...
"%VPY%" -m pip install laya
if not %errorlevel%==0 (
  echo ERROR: pip install laya failed. Check network / mirror, then re-run.
  pause
  exit /b 1
)

rem --- firewall: allow desktop to reach 8094 --------------------------
echo Allowing TCP 8094 in Windows Firewall...
netsh advfirewall firewall delete rule name="humanize-laya" >nul 2>&1
netsh advfirewall firewall add rule name="humanize-laya" dir=in action=allow protocol=TCP localport=8094 >nul 2>&1
if not %errorlevel%==0 echo  ^(firewall rule may need admin - ignore if you have a prompt or a group policy^)

rem --- run-server.bat (used by the scheduled task) --------------------
> run-server.bat (
  echo @echo off
  echo cd /d "%~dp0"
  echo ".venv\Scripts\python.exe" server.py ^>^> server.log 2^>^&1
)

rem --- start now + at every logon --------------------------------------
echo Starting service now...
rem Quiet launch (no console window), logs go to server.log
start "" /b ".venv\Scripts\pythonw.exe" server.py >> server.log 2>&1
timeout /t 2 >nul

echo Registering auto-start at logon (scheduled task HumanizeLaya)...
schtasks /create /tn "HumanizeLaya" /tr "%~dp0run-server.bat" /sc onlogon /rl limited /f >nul 2>&1
if not %errorlevel%==0 (
  echo  ^(scheduled task failed - you can instead double-click run-server.bat after each boot^)
)

echo ============================================================
echo   DONE.
echo   Laya service should be listening on 0.0.0.0:8094
echo   Desktop pool reaches it at: http://192.168.29.233:8094
echo   Health:  curl http://localhost:8094/health
echo   Logs:    server.log in this folder
echo ============================================================
echo NOTE: first launch downloads ~800MB model weights from HuggingFace.
pause
@echo off
setlocal

cd /d %~dp0

REM Prefer the Windows 'py' launcher when available (common on Python installs).
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 run_miraviewer.py
) else (
  python run_miraviewer.py
)

if errorlevel 1 (
  echo.
  echo MiraViewer failed to start.
  echo Python 3 is required. Install Python 3 from python.org and try again.
  echo.
  pause
)

endlocal

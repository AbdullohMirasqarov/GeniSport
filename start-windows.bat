@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv || goto :failed
)
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt || goto :failed
echo Open http://127.0.0.1:8000 in your browser.
".venv\Scripts\python.exe" main.py || goto :failed
exit /b 0
:failed
echo GeniSport could not start. Check Python 3.11+ and the error above.
pause
exit /b 1

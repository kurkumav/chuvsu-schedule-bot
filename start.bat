@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" goto ready
py -3 --version >nul 2>&1
if not errorlevel 1 (
    py -3 -m venv .venv
) else (
    python -m venv .venv
)
if errorlevel 1 goto fail
:ready
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto fail
".venv\Scripts\python.exe" setup.py
if errorlevel 1 goto fail
".venv\Scripts\python.exe" bot.py
pause
exit /b
:fail
echo Не удалось запустить бота. Нужен Python 3.11 или новее и интернет.
pause
exit /b 1

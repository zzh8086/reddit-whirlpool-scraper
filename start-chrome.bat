@echo off
echo === Whirlpool Scraper - Chrome Setup ===
echo.

echo Step 1: Closing any existing Chrome...
taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo Step 2: Starting Chrome with remote debugging...
start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\chrome-debug-profile"

echo Step 3: Waiting...
timeout /t 4 /nobreak >nul

echo Step 4: Verifying CDP...
curl -s http://localhost:9222/json/version | findstr "Browser" >nul
if %errorlevel% equ 0 (
    echo [OK] Chrome CDP ready!
    echo.
    echo Now:
    echo   1. In this Chrome window, visit https://forums.whirlpool.net.au
    echo   2. Complete any verification if needed
    echo   3. Keep Chrome open, run "node server.js" in terminal
) else (
    echo [FAIL] Port 9222 not responding. Try running this as Administrator.
)
echo.
pause

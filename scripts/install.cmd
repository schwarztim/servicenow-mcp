@echo off
REM ServiceNow MCP Installation Script for Windows

echo.
echo Installing ServiceNow MCP...
echo.

cd /d "%~dp0\.."

call npm install
if %ERRORLEVEL% NEQ 0 (
    echo Error: npm install failed
    exit /b 1
)

call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo Error: build failed
    exit /b 1
)

echo.
echo ✅ ServiceNow MCP installed successfully!
echo.
echo Next steps:
echo 1. Add to %USERPROFILE%\.claude\user-mcps.json (see README.md)
echo 2. Restart Claude
echo 3. Use auth_browser tool to authenticate via SSO
echo.

exit /b 0

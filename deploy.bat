@echo off
REM Fly.io Deployment Batch Script for Windows

echo ========================================
echo Fly.io Deployment Script
echo ========================================
echo.

REM Check if flyctl exists
where flyctl >nul 2>nul
if %errorlevel% neq 0 (
    echo Flyctl not found. Downloading...
    
    REM Create temp directory
    set TEMP_DIR=%TEMP%\flyctl_install
    if not exist %TEMP_DIR% mkdir %TEMP_DIR%
    
    REM Download and extract
    powershell -Command "iwr https://github.com/superfly/flyctl/releases/download/v0.2.32/flyctl_windows_amd64.zip -outfile '%TEMP_DIR%\flyctl.zip'; Expand-Archive -Path '%TEMP_DIR%\flyctl.zip' -DestinationPath '%TEMP_DIR%' -Force"
    
    REM Add to PATH (current session)
    set PATH=%TEMP_DIR%;%PATH%
    
    echo Flyctl downloaded to temp folder.
)

echo.
echo 1. Launching application on Fly.io...
call flyctl launch --name "access-api" --region "iad" --no-deploy

echo.
echo 2. Creating persistent storage...
call flyctl volumes create db_storage --size 10 --region iad -a access-api

echo.
echo 3. Setting API key...
set /p API_KEY="Enter your secret API key: "
call flyctl secrets set ACCESS_API_KEY=%API_KEY% -a access-api

echo.
echo 4. Deploying application...
call flyctl deploy

echo.
echo 5. Uploading database (this will take 5-10 minutes)...
echo.
echo Use this command to upload your database:
echo   flyctl sftp shell -a access-api
echo.
echo Inside the SFTP shell, run:
echo   mkdir /app/db
echo   put database.accdb /app/db/
echo   exit
echo.
pause

echo.
echo Deployment complete!
echo Your API will be live at: https://access-api.fly.dev
echo Monitor logs with: flyctl logs -a access-api -f
pause

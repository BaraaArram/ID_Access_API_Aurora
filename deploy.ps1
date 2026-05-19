#!/usr/bin/env pwsh
# Quick deployment script for Fly.io

$appName = Read-Host "Enter app name (default: access-api)"
if ([string]::IsNullOrWhiteSpace($appName)) { $appName = "access-api" }

$apiKey = Read-Host "Enter API key for ACCESS_API_KEY"
if ([string]::IsNullOrWhiteSpace($apiKey)) { $apiKey = "dev-secure-key" }

$region = Read-Host "Enter region (default: iad)"
if ([string]::IsNullOrWhiteSpace($region)) { $region = "iad" }

Write-Host "Starting Fly.io deployment..." -ForegroundColor Cyan

# Check if flyctl is installed
if (-not (Get-Command flyctl -ErrorAction SilentlyContinue)) {
    Write-Host "Flyctl not found. Install it first:" -ForegroundColor Yellow
    Write-Host "https://fly.io/docs/hands-on/install-flyctl/" -ForegroundColor Yellow
    exit 1
}

# Launch app
Write-Host "Launching app on Fly.io..." -ForegroundColor Cyan
flyctl launch --name $appName --region $region --no-deploy --copy-existing-config

# Create volume
Write-Host "Creating persistent storage volume..." -ForegroundColor Cyan
flyctl volumes create db_storage --size 10 --region $region -a $appName

# Set secrets
Write-Host "Setting API key..." -ForegroundColor Cyan
flyctl secrets set ACCESS_API_KEY=$apiKey -a $appName

# Deploy
Write-Host "Deploying to Fly.io..." -ForegroundColor Cyan
flyctl deploy

# Upload database via SSH
Write-Host "Uploading database file..." -ForegroundColor Yellow
Write-Host "This may take a few minutes due to file size (~1.2GB)..." -ForegroundColor Yellow

$dbPath = ".\database.accdb"
if (Test-Path $dbPath) {
    flyctl ssh console -a $appName -C "mkdir -p /app/db"
    Write-Host "Run this from your local machine to upload the database:" -ForegroundColor Cyan
    Write-Host "flyctl sftp shell -a $appName" -ForegroundColor Green
    Write-Host "put $dbPath /app/db/" -ForegroundColor Green
    Write-Host "exit" -ForegroundColor Green
} else {
    Write-Host "database.accdb not found in current directory" -ForegroundColor Red
}

Write-Host "Deployment complete!" -ForegroundColor Green
Write-Host "App URL: https://$appName.fly.dev" -ForegroundColor Green
Write-Host "Monitor logs: flyctl logs -a $appName" -ForegroundColor Green

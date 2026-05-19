#!/usr/bin/env pwsh
# Fly.io Deployment Only After Account Verification

Write-Host "⚠️  IMPORTANT: Before proceeding, verify your Fly.io account!" -ForegroundColor Yellow
Write-Host "   Go to: https://fly.io/high-risk-unlock" -ForegroundColor Yellow
Write-Host ""
Write-Host "Once verified, come back and run this:" -ForegroundColor Cyan
Write-Host ""

$flyctlPath = "C:\Projects\flyctl-0.4.33"
if (Test-Path "$flyctlPath\main.go") {
    Write-Host "Note: You have the flyctl SOURCE CODE, not the compiled binary."  -ForegroundColor Yellow
    Write-Host "You need the compiled flyctl.exe instead."
    Write-Host "Download from: https://github.com/superfly/flyctl/releases"
    Write-Host ""
}

Write-Host "== DEPLOYMENT STEPS FOR FLY.IO ==" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Install flyctl properly:" -ForegroundColor Green
Write-Host '   - Download: https://github.com/superfly/flyctl/releases/download/v0.2.61/flyctl_windows_amd64.zip' 
Write-Host '   - Extract to: C:\Program Files\flyctl\'
Write-Host '   - Add to PATH via System Environment Variables'
Write-Host ""

Write-Host "2. Verify account verification:" -ForegroundColor Green
Write-Host '   - Go to: https://fly.io/high-risk-unlock'
Write-Host '   - Complete the verification process'
Write-Host ""

Write-Host "3. Deploy from access-api folder:" -ForegroundColor Green
Write-Host ""
Write-Host '   # Login:' 
Write-Host '   flyctl auth logout'
Write-Host '   flyctl auth login'
Write-Host ""
Write-Host '   # Launch app without browser tweaking:'
Write-Host '   flyctl launch --name "access-api" --region "iad" --no-deploy --copy-existing-config'
Write-Host ""
Write-Host '   # Create storage:'
Write-Host '   flyctl volumes create db_storage --size 10 --region iad -a access-api'
Write-Host ""
Write-Host '   # Set API key:'
Write-Host '   flyctl secrets set ACCESS_API_KEY="dev-secure-key-xyz" -a access-api'
Write-Host ""
Write-Host '   # Deploy:'
Write-Host '   flyctl deploy'
Write-Host ""
Write-Host '   # Upload database (~5-10 min):'
Write-Host '   flyctl sftp shell -a access-api'
Write-Host '     # Inside SFTP:'
Write-Host '     mkdir /app/db'
Write-Host '     put database.accdb /app/db/'
Write-Host '     exit'
Write-Host ""

Write-Host "4. Your app will be live at:" -ForegroundColor Green
Write-Host "   https://access-api.fly.dev" -ForegroundColor Cyan
Write-Host ""

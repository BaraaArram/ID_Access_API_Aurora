# Fly.io Deployment Guide

## Prerequisites
1. Install Fly CLI: https://fly.io/docs/hands-on/install-flyctl/
2. Sign up for free: https://fly.io (no CC required for free tier)

## Login
```powershell
flyctl auth login
```

## Deploy
From the `access-api` folder:

```powershell
flyctl launch
```

When prompted:
- App name: `access-api` (or preferred name)
- Region: Choose closest to you (default IAD is fine)
- PostgreSQL: No (we're using file-based Access DB)
- Deploy: No (we'll upload database first)

## Create Persistent Storage Volume
```powershell
flyctl volumes create db_storage --size 10 --region iad
```

## Upload Database
```powershell
# Copy database to the mounted volume
flyctl ssh console
# Inside the SSH console:
cd /app/db
exit

# From local machine, copy the database:
flyctl sftp shell
put database.accdb /app/db/
exit
```

Or use scp:
```powershell
flyctl ssh console -C 'mkdir -p /app/db'
$appName = 'access-api'  # Use your app name
pscp -l root ".\database.accdb" "${appName}:/app/db/"
```

## Set Environment Variable
```powershell
flyctl secrets set ACCESS_API_KEY="your-secure-api-key"
```

## Deploy
```powershell
flyctl deploy
```

## Verify
```powershell
$appUrl = "https://access-api.fly.dev"  # Replace with your app name
Invoke-WebRequest -UseBasicParsing -Uri "$appUrl/health"
```

## Monitor Logs
```powershell
flyctl logs -a access-api
```

## Scale (Free Tier)
Free tier includes:
- 3 small shared-cpu VMs
- 3GB persistent storage
- 160GB outbound data/month

Sufficient for this API!

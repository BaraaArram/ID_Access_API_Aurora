# 🚀 Fly.io Deployment - Complete Guide

## Step 1: Install Fly CLI (One-Time Setup)

### Windows via Scoop (Recommended)
```powershell
# First install Scoop if needed:
iwr -useb get.scoop.sh | iex

# Then install flyctl:
scoop install flyctl
```

### Windows Direct Download
Download from: https://github.com/superfly/flyctl/releases/download/v0.2.32/flyctl_windows_amd64.zip

Extract to: `C:\Program Files\flyctl\`

Add to PATH and restart PowerShell.

### Verify Installation
```powershell
flyctl --version
```

---

## Step 2: Authenticate with Fly.io

```powershell
cd "c:\Projects\English ext\access-api"
flyctl auth login
```

This opens a browser for free signup (no credit card required).

---

## Step 3: Deploy the Application

```powershell
# From access-api folder:
flyctl launch --name "access-api" --region "iad" --no-deploy

# When asked about configuration, just press Enter to use defaults
```

---

## Step 4: Create Persistent Storage for Database

```powershell
flyctl volumes create db_storage --size 10 --region iad -a access-api
```

---

## Step 5: Set Secure API Key

```powershell
flyctl secrets set ACCESS_API_KEY="your-super-secret-key-here" -a access-api
```

---

## Step 6: Deploy the Container

```powershell
flyctl deploy
```

Watch the logs:
```powershell
flyctl logs -a access-api
```

---

## Step 7: Upload Your Database (~5-10 minutes)

### Option A: Using SFTP (Easiest)
```powershell
flyctl sftp shell -a access-api

# Inside SFTP shell:
mkdir /app/db
put database.accdb /app/db/
exit
```

### Option B: Using SCP
```powershell
$appName = "access-api"
flyctl ssh console -a $appName -C "mkdir -p /app/db"

# Then copy via SCP:
pscp -l $USER "database.accdb" "${appName}:/app/db/"
```

---

## Step 8: Verify Deployment

```powershell
# Test the health endpoint:
$headers = @{ 'X-Api-Key' = 'your-super-secret-key-here' }
Invoke-WebRequest -UseBasicParsing -Uri 'https://access-api.fly.dev/health' -Headers $headers

# Query a user:
Invoke-WebRequest -UseBasicParsing -Uri 'https://access-api.fly.dev/user?id=802373563&table=Sgaza&idColumn=الهوية' -Headers $headers
```

---

## Step 9: View Logs Anytime

```powershell
flyctl logs -a access-api

# Follow logs in real-time:
flyctl logs -a access-api -f
```

---

## Useful Commands

```powershell
# Check status
flyctl status -a access-api

# SSH into the app
flyctl ssh console -a access-api

# View environment variables
flyctl config show -a access-api

# Monitor resources
flyctl metrics -a access-api

# Scale (if needed)
flyctl scale vm shared-cpu-1x --count 1 -a access-api

# View persistent volume status
flyctl volumes list -a access-api
```

---

## Free Tier Limits

✅ Includes:
- 3 shared-cpu-1x VMs (always on)
- 10GB persistent storage
- 160GB data transfer/month
- Unlimited logs
- Automatic HTTPS

---

## Troubleshooting

### Database not found
```powershell
flyctl ssh console -a access-api
ls -la /app/db/
```

### Can't connect?
```powershell
# Check if app is running:
flyctl status -a access-api

# Restart if needed:
flyctl restart -a access-api
```

### Out of storage?
```powershell
# Increase volume size:
flyctl volumes extend db_storage --size 20 -a access-api
```

---

**That's it! Your API will be live at: `https://access-api.fly.dev`**

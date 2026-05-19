# 🚀 Complete Flyctl Fix Guide

## Problem
Flyctl executable not found despite multiple install attempts.

---

## Solution: Direct Binary Installation

### **Step 1: Manual Download & Extract**

Go to: https://github.com/superfly/flyctl/releases/download/v0.2.62/flyctl_windows_amd64.zip

1. Download the ZIP file
2. Extract to: **`C:\flyctl`** (create the folder first)
3. Inside should be: **`flyctl.exe`**

---

### **Step 2: Add to PATH Permanently**

**Windows 11/10:**

1. Press **Win + I** (Settings)
2. Search: **"environment"**
3. Click **"Edit environment variables for your account"**
4. Under "User variables", click **New**
5. Enter:
   - Variable name: `FLYCTL_HOME`
   - Variable value: `C:\flyctl`
6. Find **Path** in the list
7. Click **Edit**
8. Click **New**
9. Add: `C:\flyctl`
10. Click **OK** on all dialogs

**RESTART PowerShell completely**

---

### **Step 3: Verify Installation**

```powershell
flyctl --version
```

Should show: `flyctl v0.2.62`

---

## Step 4: Deploy

Once `flyctl --version` works, run:

```powershell
cd "c:\Projects\English ext\access-api"

# Verify account is verified first!
# Go to: https://fly.io/high-risk-unlock

# Login
flyctl auth login

# Deploy with correct config
flyctl launch --name "access-api" --region "iad" --no-deploy --copy-config

# Create storage
flyctl volumes create db_storage --size 10 --region iad -a access-api

# Set secret
flyctl secrets set ACCESS_API_KEY="your-secure-key-here" -a access-api

# Deploy
flyctl deploy

# Check logs
flyctl logs -a access-api
```

---

## Step 5: Upload Database

```powershell
flyctl sftp shell -a access-api

# Inside SFTP:
mkdir /app/db
put database.accdb /app/db/
exit
```

---

## Verification

```powershell
flyctl status -a access-api
flyctl ssh console -a access-api -C "ls -la /app/db/"
```

---

## If Still Not Working

Alternative deployment:

```powershell
# Test with local API running
npm start

# In new terminal:
ngrok http 5085
```

Then test: `https://YOUR-NGROK-URL/health`

---

**Follow these steps carefully and it will work!** 🎯

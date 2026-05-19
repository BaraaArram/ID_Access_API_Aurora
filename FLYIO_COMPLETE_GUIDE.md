# 🚀 Fly.io Deployment - Complete Manual

## ⚠️ FIRST: Verify Your Fly.io Account

Your account was marked as "high-risk" and needs verification:

1. **Go to:** https://fly.io/high-risk-unlock
2. **Complete the verification** (usually 2 minutes)
3. **Come back here when done**

---

## Step 1: Get Proper Flyctl Binary

You downloaded the **SOURCE CODE** instead of the compiled binary.

### **Download Correct Version:**
- Go to: https://github.com/superfly/flyctl/releases/download/v0.2.61/flyctl_windows_amd64.zip
- Extract to: `C:\Program Files\flyctl\`

### **Add to Windows PATH:**
1. Press **Win + X** → Select **System**
2. Click **Advanced system settings**
3. Click **Environment Variables**
4. Under "System variables", click **New**
5. Variable name: `PATH`
6. Variable value: `C:\Program Files\flyctl`
7. Click **OK** three times → **Restart PowerShell**

### **Verify Installation:**
```powershell
flyctl --version  # Should show version number
```

---

## Step 2: Deploy to Fly.io

### **Login (after account verification):**
```powershell
cd "c:\Projects\English ext\access-api"
flyctl auth logout
flyctl auth login
```

### **Launch App (without browser tweaking to avoid account issues):**
```powershell
flyctl launch --name "access-api" --region "iad" --no-deploy --copy-existing-config
```

### **Create Persistent Storage Volume:**
```powershell
flyctl volumes create db_storage --size 10 --region iad -a access-api
```

### **Set API Key Securely:**
```powershell
flyctl secrets set ACCESS_API_KEY="your-super-secret-key-change-this" -a access-api
```

### **Deploy the Application:**
```powershell
flyctl deploy
```

Watch the logs:
```powershell
flyctl logs -a access-api
```

---

## Step 3: Upload Your Database (Takes 5-10 minutes)

```powershell
# Open SFTP shell
flyctl sftp shell -a access-api

# Inside SFTP shell, run these commands:
# (Note: no $ or # prefix, just type them)
mkdir /app/db
put database.accdb /app/db/
exit
```

**This uploads your 1.2GB database file** to the persistent volume.

---

## Step 4: Test Your API

```powershell
# Test health endpoint
$headers = @{ 'X-Api-Key' = 'your-super-secret-key-change-this' }
Invoke-WebRequest -UseBasicParsing -Uri 'https://access-api.fly.dev/health' -Headers $headers

# Test user lookup
Invoke-WebRequest -UseBasicParsing -Uri 'https://access-api.fly.dev/user?id=802373563&table=Sgaza&idColumn=الهوية' -Headers $headers
```

---

## Common Commands

```powershell
# View logs in real-time
flyctl logs -a access-api -f

# SSH into the app
flyctl ssh console -a access-api

# Check database is there
flyctl ssh console -a access-api -C "ls -la /app/db/"

# Restart app
flyctl restart -a access-api

# View status
flyctl status -a access-api

# View volumes
flyctl volumes list -a access-api
```

---

## Troubleshooting

### **"Account has been marked as high risk"**
- Go to: https://fly.io/high-risk-unlock
- Complete verification
- Wait 5 minutes before retrying

### **"App not found"**
- Wait 30 seconds after `flyctl launch`
- Make sure app created successfully
- Check: `flyctl apps list`

### **Database not uploading**
- Check SFTP shell is connected properly
- Use absolute path: `/app/db/database.accdb`
- Check size: `flyctl ssh console -a access-api -C "du -sh /app/db/"`

### **Out of storage**
- Increase volume: `flyctl volumes extend db_storage --size 15 -a access-api`

---

## Free Tier Limits

✅ Includes:
- 3 shared-cpu machines (always on)
- 10GB persistent storage (we created)
- 160GB data transfer/month
- Automatic HTTPS
- Custom domains support

---

##Summary

1. ✅ Verify account at https://fly.io/high-risk-unlock
2. ✅ Download correct flyctl binary
3. ✅ Add to PATH
4. ✅ Run `flyctl deploy` commands above
5. ✅ Upload database via SFTP
6. ✅ Test your API

**Your live API:** https://access-api.fly.dev 🚀

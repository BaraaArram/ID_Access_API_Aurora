# 🚀 Deploy Using Fly.io Web Dashboard (Easiest!)

No command-line tools needed!

## Step 1: Verify Your Account
Go to: **https://fly.io/high-risk-unlock**
- Complete verification
- Wait 5 minutes

---

## Step 2: Go to Fly.io Dashboard
Visit: **https://fly.io/dashboard**

Click: **"Create an app"**

---

## Step 3: Deploy from Docker

1. Click **"Choose how to scale"** → Select **"Fly Launch"**
2. Choose deployment method: **"Existing Docker or Docker Compose"**
3. Upload your app:
   - Source: GitHub repository
   - Repo: `BaraaArram/idAPI`
   - Branch: `main`

---

## Step 4: Configure

1. **App name:** `access-api`
2. **Region:** Ashburn (iad)
3. **Environment Variables:**
   - `PORT=5085`
   - `ACCESS_API_KEY=your-secret-key`
   - `ACCESS_DB_PATH=./database.accdb`
   - `DEFAULT_TABLE=Sgaza`
   - `ALLOWED_TABLES=Sgaza,قائمة الموظفين`
   - `ALLOWED_ID_COLUMNS=الهوية,id,identity`

4. **Resources:**
   - CPU: Shared
   - Memory: 1GB
   - Count: 1

---

## Step 5: Deploy

Click **"Deploy"**

Wait 2-3 minutes...

---

## Step 6: Upload Database

1. In dashboard, go to your app
2. Click **"SSH Console"**
3. Run:
   ```
   mkdir -p /app/db
   ```
4. Close console

Then use web-based SFTP or command line:
```powershell
# From your local machine:
flyctl sftp shell -a access-api
mkdir /app/db
put database.accdb /app/db/
exit
```

---

## Step 7: Test

```powershell
$headers = @{ 'X-Api-Key' = 'your-secret-key' }
Invoke-WebRequest -Uri 'https://access-api.fly.dev/health' -Headers $headers
```

---

## Web Dashboard Benefits

✅ No command-line needed  
✅ Visual interface  
✅ Real-time logs  
✅ Easy restarts  
✅ Monitor resources  

---

## If Web Dashboard Doesn't Work

Use simpler alternative: **Deploy as Windows Service locally**

```powershell
# Create Windows Service wrapper script
# Run your app 24/7 without browser
# Accessible via ngrok tunnel for remote access
```

Let me know if you want that instead!

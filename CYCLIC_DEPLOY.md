# 🚀 Deploy to Cyclic.sh

Cyclic.sh is the easiest way to deploy Node.js apps without a credit card!

## Step 1: Push to GitHub ✅ (Done)
Your code is already at: https://github.com/BaraaArram/idAPI

## Step 2: Go to Cyclic
1. Visit: https://cyclic.sh
2. Click **"Deploy Now"** or **"Sign in with GitHub"**
3. Authorize Cyclic to access your GitHub account

## Step 3: Select Repository
1. Choose: **BaraaArram / idAPI**
2. Click **"Connect"**

## Step 4: Configure Environment Variables
Cyclic will show a form. Add these variables:

```
PORT=5085
ACCESS_API_KEY=your-super-secret-key-12345
ACCESS_DB_PATH=./database.accdb
DEFAULT_TABLE=Sgaza
ALLOWED_TABLES=Sgaza,قائمة الموظفين
ALLOWED_ID_COLUMNS=الهوية,id,identity
```

## Step 5: Deploy
Click **"Deploy"**

Cyclic will:
- Build your Node.js app
- Upload `package.json` dependencies
- Start the server

## Step 6: Upload Database
Cyclic has limited storage. For the 1.2GB database, you have options:

### Option A: Use Cloud Storage (Recommended)
Store database in:
- **AWS S3** (free tier: 5GB)
- **Azure Blob** (free: 1TB)
- **Google Cloud Storage** (free: 5GB)

Then update your API to fetch from there.

### Option B: Use Database Service
- **MongoDB Atlas** - Convert Access data to MongoDB (free tier)
- **PostgreSQL on Neon** - Migrate data (free tier)

### Option C: Keep Local Database
If you keep the database file locally, Cyclic will include it (~1.2GB).
This works but makes the app slower.

---

## Your Live App
Once deployed, your app will be at:
```
https://idAPI.cyclic.app
```

Test it:
```powershell
$headers = @{ 'X-Api-Key' = 'your-super-secret-key-12345' }
Invoke-WebRequest -UseBasicParsing -Uri 'https://idAPI.cyclic.app/health' -Headers $headers
```

---

## Important Notes
⚠️ **Cyclic Free Tier:**
- 5 hours uptime per day (development/testing)
- Paid tier for production use
- 24GB storage max

For production with 24/7 uptime, consider paid tier or alternative services.

---

## Troubleshooting

View logs in Cyclic dashboard:
- Go to: https://cyclic.sh/dashboard
- Click on your app
- View "Recent Logs"

If database not found:
- Ensure `ACCESS_DB_PATH=./database.accdb` in environment
- Database file must be committed to GitHub

If API key fails:
- Check environment variable is set exactly
- Restart the app in Cyclic dashboard

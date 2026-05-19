# 🚀 Deploy to Glitch

**Glitch** is the easiest way to deploy Node.js apps - no credit card needed!

## Super Simple Setup (2 minutes):

### **Step 1: Go to Glitch.com**
Visit: https://glitch.com

### **Step 2: Sign In with GitHub**
Click **"Sign In"** → Choose **GitHub**

### **Step 3: Import Your Repository**
1. Click **"New Project"** → **"Import from GitHub"**
2. Enter: `BaraaArram/idAPI`
3. Click **"Import"**

**That's it!** Glitch automatically:
- Clones your repo
- Installs dependencies (`npm install`)
- Starts your app (`npm start`)
- Gives you a live URL

---

## Step 4: Set Environment Variables

In your Glitch project:

1. Click **".env"** file in the sidebar (or create one)
2. Add these variables:

```
PORT=5085
ACCESS_API_KEY=your-super-secret-key-12345
ACCESS_DB_PATH=./database.accdb
DEFAULT_TABLE=Sgaza
ALLOWED_TABLES=Sgaza,قائمة الموظفين
ALLOWED_ID_COLUMNS=الهوية,id,identity
```

3. **Save** - Your app auto-restarts with the new variables

---

## Step 5: Your Live App

Glitch gives you a URL like:
```
https://PROJECT-NAME.glitch.me
```

You can also **customize the project name** to get a shorter URL.

**Test your API:**
```powershell
$headers = @{ 'X-Api-Key' = 'your-super-secret-key-12345' }
Invoke-WebRequest -Uri 'https://your-project-name.glitch.me/health' -Headers $headers
```

---

## Important Notes

### **Database (1.2GB)**
Glitch has a **file size limit** (~200MB projects). Your database is 1.2GB, so:

**Option A: Use External Database**
- Upload database to **AWS S3** (free 5GB)
- Update code to load from S3
- *(Recommended for production)*

**Option B: Test Without Full Database**
- Create a smaller test database
- Deploy to Glitch
- Use this for testing the API

**Option C: Paid Glitch**
- Glitch paid tier supports larger projects
- But free tier is still available

---

## Auto-Deploy from GitHub

After importing, Glitch automatically:
- Watches your GitHub repo
- **Auto-deploys** when you push changes
- No extra steps needed!

Just push to GitHub and Glitch updates instantly.

---

## Useful Glitch Features

### **View Logs**
Click **"Tools"** → **"Logs"** to see real-time errors

### **Terminal**
Click **"Tools"** → **"Terminal"** to run commands

### **Pause Project**
By default, Glitch projects sleep after inactivity (free plan).
Upgrade to keep running 24/7 or use **"Keep Awake"** extension.

---

## Next Steps

1. ✅ Go to **https://glitch.com**
2. ✅ Import **BaraaArram/idAPI**
3. ✅ Set environment variables in `.env`
4. ✅ Test your API at the Glitch URL

**That's all!** Your API is live on Glitch! 🎉

---

## Need the Database on Glitch?

Would you like me to:
1. **Create a smaller test database** for Glitch testing
2. **Set up AWS S3** to host the full database
3. **Migrate to MongoDB Atlas** (free, no size limits)

Let me know! 📝

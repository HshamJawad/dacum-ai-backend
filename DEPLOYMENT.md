# 🚀 Deploying DACUM AI Backend to Render.com

## Step-by-Step Deployment Guide

### STEP 1: Get Your Anthropic API Key

1. Go to https://console.anthropic.com/settings/keys
2. Sign in or create account
3. Click "Create Key"
4. Give it a name (e.g., "DACUM Backend")
5. **COPY THE KEY** - you won't see it again!
   - Format: `sk-ant-api03-xxxxxxxxxxxxx`

---

### STEP 2: Push Code to GitHub

1. **Create a new GitHub repository:**
   - Go to https://github.com/new
   - Repository name: `dacum-ai-backend`
   - Make it Public or Private
   - Click "Create repository"

2. **Upload your backend files:**
   
   **Option A: Using GitHub Web Interface (Easiest)**
   - Click "uploading an existing file"
   - Drag and drop these files:
     - server.js
     - package.json
     - .gitignore
     - .env.example
     - README.md
   - Click "Commit changes"

   **Option B: Using Git Command Line**
   ```bash
   cd /path/to/backend/folder
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR-USERNAME/dacum-ai-backend.git
   git push -u origin main
   ```

---

### STEP 3: Deploy on Render.com

1. **Go to Render Dashboard:**
   - Visit https://dashboard.render.com/
   - You should already be signed in

2. **Click "New +" button** (top right)
   - Select **"Web Service"**

3. **Connect GitHub Repository:**
   - Click "Configure account" to connect GitHub
   - Grant Render access to your repositories
   - Find and select `dacum-ai-backend`
   - Click "Connect"

4. **Configure Web Service:**
   
   Fill in these settings:
   
   | Setting | Value |
   |---------|-------|
   | **Name** | `dacum-ai-backend` (or any name you like) |
   | **Region** | Choose closest to you (e.g., Frankfurt, Singapore) |
   | **Branch** | `main` |
   | **Runtime** | `Node` |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance Type** | `Free` (or paid if you prefer) |

5. **Add Environment Variables:**
   
   Scroll down to **"Environment Variables"** section:
   
   - Click "Add Environment Variable"
   - **Key:** `ANTHROPIC_API_KEY`
   - **Value:** Paste your API key (sk-ant-api03-xxxxx...)
   - Click "Add"

6. **Deploy:**
   - Click **"Create Web Service"** button at bottom
   - Wait 2-5 minutes for deployment
   - Watch the logs - you should see:
     ```
     🚀 DACUM AI Backend Server running on port 10000
     ```

---

### STEP 4: Test Your Backend

Once deployed, Render will give you a URL like:
`https://dacum-ai-backend-xxxx.onrender.com`

**Test it:**

1. **Health Check:**
   - Visit: `https://your-backend-url.onrender.com/`
   - You should see:
     ```json
     {
       "status": "ok",
       "message": "DACUM AI Backend Server is running",
       "version": "1.0.0"
     }
     ```

2. **Test AI Endpoint:**
   Use this in your browser console or Postman:
   ```javascript
   fetch('https://your-backend-url.onrender.com/api/generate-dacum', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       prompt: 'Generate a simple DACUM for a Chef'
     })
   })
   .then(r => r.json())
   .then(d => console.log(d));
   ```

---

### STEP 5: Get Your Backend URL

1. In Render dashboard, click on your service
2. At the top, you'll see the URL:
   ```
   https://dacum-ai-backend-xxxx.onrender.com
   ```
3. **COPY THIS URL** - you'll need it for the frontend!

---

## ⚙️ Common Issues & Solutions

### Issue: "Build failed"
**Solution:** Check the logs. Usually missing dependencies or wrong Node version.

### Issue: "Application failed to respond"
**Solution:** Check Environment Variables - make sure ANTHROPIC_API_KEY is set.

### Issue: "API key not valid"
**Solution:** Double-check your API key in Environment Variables section.

### Issue: "Service sleeping" (Free tier)
**Solution:** Free tier sleeps after 15min of inactivity. First request may take 30-60 seconds to wake up.

---

## 🎯 Next Steps

After deployment succeeds:
1. ✅ Copy your backend URL
2. ✅ Update frontend HTML to use this URL
3. ✅ Test AI generation from frontend
4. ✅ Deploy frontend (GitHub Pages, Netlify, or Render Static Site)

---

## 📊 Monitoring

- **View Logs:** Render Dashboard → Your Service → Logs tab
- **View Metrics:** Render Dashboard → Your Service → Metrics tab
- **Restart Service:** Render Dashboard → Your Service → Manual Deploy → "Clear build cache & deploy"

---

## 💰 Pricing Notes

**Free Tier:**
- ✅ 750 hours/month free
- ✅ Auto-sleeps after 15min inactivity
- ✅ Perfect for testing and light use

**If you need 24/7 availability:**
- Upgrade to paid plan ($7/month)
- No sleeping
- Faster performance

---

## 🔒 Security Checklist

- ✅ Never commit .env file
- ✅ API key stored as environment variable (not in code)
- ✅ .gitignore includes .env
- ✅ GitHub repository can be private
- ✅ CORS configured (restrict to your domain in production)

---

**Questions? Issues? Check the logs first, then refer to Render docs: https://render.com/docs**

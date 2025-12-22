# Backend Update v2 - Files for GitHub

## What's Included

This package contains **4 files** to fix the taskKey validation issue:

1. **schema_v2.sql** - New database migration
2. **workshops.js** - Updated routes with taskKey generation
3. **votes.js** - Updated routes with database validation
4. **DEPLOYMENT_GUIDE.md** - Step-by-step instructions

## Quick Deploy

### 1. Copy Files to Your Repo

```bash
# In your local dacum-ai-backend folder

# Create new migration file
cp schema_v2.sql src/db/

# Replace existing route files
cp workshops.js src/routes/
cp votes.js src/routes/

# Add deployment guide
cp DEPLOYMENT_GUIDE.md ./
```

### 2. Commit and Push

```bash
git add .
git commit -m "Fix: Backend-owned taskKey validation"
git push origin main
```

Railway will auto-deploy.

### 3. Run Migration

```bash
railway login
railway link
railway run psql $DATABASE_URL < src/db/schema_v2.sql
```

### 4. Test

```bash
# Test snapshot upload - backend generates taskKey
curl -X POST https://your-app.railway.app/api/workshops/ABC123/snapshot \
  -H "X-Facilitator-Token: TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"duties":[{"dutyId":"duty_1","dutyTitle":"Test","tasks":[{"taskTitle":"Task 1"}]}]}'

# Response will include: "taskKey": "ABC123_duty_1_1"

# Test voting - uses backend taskKey
curl -X POST https://your-app.railway.app/api/votes/cast \
  -H "X-Participant-Token: TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskKey":"ABC123_duty_1_1","importanceRating":3}'

# Should return 200 OK
```

## What Changed

### Before (Broken):
- Frontend generated taskKey
- Backend trusted frontend
- Mismatch caused 400 errors

### After (Fixed):
- Backend generates taskKey during snapshot upload
- Database enforces uniqueness
- Vote validation checks database only
- **Result: No more "taskKey Invalid" errors**

## File Locations in Your Repo

```
dacum-ai-backend/
├── src/
│   ├── db/
│   │   ├── migrate.js
│   │   ├── migration.sql (old)
│   │   └── schema_v2.sql (NEW)
│   ├── routes/
│   │   ├── workshops.js (REPLACE)
│   │   ├── votes.js (REPLACE)
│   │   └── participants.js (no changes)
│   └── server.js (no changes)
├── DEPLOYMENT_GUIDE.md (NEW)
└── README.md
```

## Need Help?

See **DEPLOYMENT_GUIDE.md** for:
- Detailed deployment steps
- Testing procedures
- Rollback instructions
- Troubleshooting

## Technical Summary

**Database Changes:**
- New `duties` table
- New `tasks` table with `task_key` column (UNIQUE)
- Updated `task_votes` to reference `task_key`

**API Changes:**
- POST /snapshot: Backend generates taskKey
- GET /snapshot: Returns taskKey in response
- POST /votes/cast: Validates taskKey against database

**Result:**
taskKey is now backend-owned, immutable, and database-enforced.

---

**These files implement the LOCKED DB Schema v1 and API Contracts v1 exactly as specified.**

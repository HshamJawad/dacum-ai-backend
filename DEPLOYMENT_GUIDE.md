# Deployment Guide - Backend v2 with taskKey Fix

## Files to Update in GitHub

1. **src/db/schema_v2.sql** (NEW)
   - New migration file with separated tables
   - Backend-owned taskKey architecture

2. **src/routes/workshops.js** (REPLACE)
   - Updated snapshot upload with taskKey generation
   - GET snapshot returns tasks with taskKey

3. **src/routes/votes.js** (REPLACE)
   - Updated vote validation against database
   - Aggregation queries use new schema

## Step-by-Step Deployment

### 1. Push Files to GitHub

```bash
# In your local dacum-ai-backend folder

# Copy the new files
cp schema_v2.sql src/db/
cp workshops.js src/routes/
cp votes.js src/routes/

# Commit and push
git add .
git commit -m "Implement DB Schema v1 with backend-owned taskKey

- Add separated duties and tasks tables
- Backend generates taskKey during snapshot upload
- Vote validation checks database only
- Fixes taskKey Invalid errors permanently"

git push origin main
```

### 2. Backup Current Database

```bash
# Connect to Railway
railway login
railway link

# Backup current data
railway run pg_dump $DATABASE_URL > backup_before_v2.sql
```

### 3. Run Migration

**Option A: Railway CLI (Recommended)**
```bash
railway run psql $DATABASE_URL < src/db/schema_v2.sql
```

**Option B: Railway Dashboard**
1. Go to your PostgreSQL service
2. Click "Data" tab
3. Click "Query"
4. Copy contents of schema_v2.sql
5. Paste and execute

### 4. Verify Migration

```bash
# Check tables exist
railway run psql $DATABASE_URL -c "\dt"

# Should show:
# - workshops
# - duties (NEW)
# - tasks (NEW)
# - participants
# - task_votes (updated)

# Check taskKey column
railway run psql $DATABASE_URL -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks';"

# Should show task_key column
```

### 5. Test Complete Flow

```bash
BASE_URL="https://your-app.railway.app"

# 1. Create workshop
curl -X POST $BASE_URL/api/workshops \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test Workshop v2",
    "workflowType": "standard",
    "priorityFormula": "if"
  }'

# Save facilitatorToken and workshopCode from response

# 2. Upload snapshot (NO taskKey in request)
curl -X POST $BASE_URL/api/workshops/ABC123/snapshot \
  -H "Content-Type: application/json" \
  -H "X-Facilitator-Token: FTOKEN_..." \
  -d '{
    "duties": [{
      "dutyId": "duty_1",
      "dutyTitle": "Test Duty",
      "sortOrder": 1,
      "tasks": [{
        "taskTitle": "Test Task 1",
        "sortOrder": 1
      }, {
        "taskTitle": "Test Task 2",
        "sortOrder": 2
      }]
    }]
  }'

# Response should include generated taskKeys:
# - ABC123_duty_1_1
# - ABC123_duty_1_2

# 3. Get snapshot (should return taskKeys)
curl $BASE_URL/api/workshops/ABC123/snapshot

# 4. Join as participant
curl -X POST $BASE_URL/api/participants/join \
  -H "Content-Type: application/json" \
  -d '{
    "workshopCode": "ABC123",
    "displayName": "Test Participant"
  }'

# Save participantToken

# 5. Cast vote using exact taskKey from step 2
curl -X POST $BASE_URL/api/votes/cast \
  -H "Content-Type: application/json" \
  -H "X-Participant-Token: PTOKEN_..." \
  -d '{
    "taskKey": "ABC123_duty_1_1",
    "importanceRating": 3,
    "frequencyRating": 2,
    "difficultyRating": 1
  }'

# Should return 200 OK (not 400)

# 6. Get aggregated results
curl $BASE_URL/api/votes/aggregated \
  -H "X-Facilitator-Token: FTOKEN_..."

# Should show aggregated data with taskKey
```

## Expected Changes After Deployment

### ✅ What Works Now:

1. **Snapshot Upload:**
   - Frontend sends duties/tasks WITHOUT taskKey
   - Backend generates taskKey (format: `{code}_{dutyId}_{index}`)
   - Response includes generated taskKeys

2. **Vote Validation:**
   - Backend validates taskKey exists in `tasks` table
   - Invalid taskKeys rejected with 400 error
   - Valid taskKeys accepted with 200 OK

3. **Aggregated Results:**
   - Dashboard shows duties/tasks with vote counts
   - No more empty tables
   - Votes grouped by taskKey correctly

### ❌ What's Deprecated:

1. **Old dacum_snapshots table:**
   - No longer used for voting
   - Can be kept for historical reference
   - New snapshots stored in duties/tasks tables

2. **Frontend-generated taskKeys:**
   - Backend ignores any taskKey sent in snapshot upload
   - Frontend must use taskKey from GET /snapshot

## Rollback Plan (If Needed)

```bash
# Restore from backup
railway run psql $DATABASE_URL < backup_before_v2.sql

# Revert code changes
git revert HEAD
git push origin main
```

## Monitoring

### Check for Errors:

```bash
# Watch logs
railway logs --follow

# Look for:
# - "Snapshot upload error" → Check request format
# - "Vote cast error" → Check taskKey validation
# - "Aggregation error" → Check view exists
```

### Query Database:

```bash
# Count tasks with taskKey
railway run psql $DATABASE_URL -c "SELECT COUNT(*) FROM tasks;"

# Check recent votes
railway run psql $DATABASE_URL -c "SELECT * FROM task_votes ORDER BY voted_at DESC LIMIT 10;"

# View aggregations
railway run psql $DATABASE_URL -c "SELECT * FROM task_vote_aggregations LIMIT 10;"
```

## Success Criteria

- [ ] ✅ Migration completed without errors
- [ ] ✅ Tables created: duties, tasks
- [ ] ✅ POST /snapshot generates taskKey
- [ ] ✅ GET /snapshot returns taskKey
- [ ] ✅ POST /votes/cast accepts valid taskKey (200 OK)
- [ ] ✅ POST /votes/cast rejects invalid taskKey (400)
- [ ] ✅ GET /aggregated shows duties/tasks
- [ ] ✅ No "taskKey Invalid" errors in logs

## Support

If issues occur:

1. Check Railway logs: `railway logs`
2. Verify migration: `railway run psql $DATABASE_URL -c "\dt"`
3. Test manually with curl commands above
4. Restore from backup if needed

## Next Steps

After successful deployment:

1. ✅ Backend updated
2. 🔄 Update frontend HTML to use new API responses
3. 🔄 Test full workshop flow
4. 🔄 Update documentation

---

**This deployment fixes taskKey validation permanently by making backend the single source of truth.**

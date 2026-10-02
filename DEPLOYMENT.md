# 🚀 Deploying the DACUM AI Backend on Railway

This server is hosted on **Railway** and is used by two tools:

| Tool | Endpoint |
|---|---|
| DACUM Live Pro (all AI buttons) | `POST /api/generate-dacum` |
| Module Builder (Training Structure Mapping) | `POST /api/module-mapping` |

Live URL used by both front ends:
`https://dacum-ai-backend-production.up.railway.app`

> If the public URL ever changes, update it in **both** front ends:
> DACUM Live Pro (`BACKEND_URL` in the `*_ai.js` files) and Module Builder
> (`MB_AI_BACKEND_BASE` in `src/module-ai.js`).

---

## Updating the server (the usual case)

The Railway service is connected to this GitHub repository, so an update
is just a commit:

1. Replace the changed files in the repository (`server.js`,
   `package.json`, `README.md` …) — on GitHub: **Add file → Upload
   files**, then **Commit changes**.
2. Railway detects the commit and redeploys automatically (about 1–3
   minutes). Watch progress in the service's **Deployments** tab.
3. Check the health endpoint (see *Testing* below) — the `version` it
   reports should match `package.json`.

If a deploy does not start on its own, open the service in Railway and
trigger a redeploy of the latest commit from the **Deployments** tab.

---

## First-time setup (only if the service has to be recreated)

### 1. Anthropic API key
1. Go to https://console.anthropic.com/settings/keys
2. Create a key (e.g. "DACUM Backend") and **copy it** — it is shown once.

### 2. Repository
The repository must contain at least `server.js`, `package.json`,
`.gitignore` (with `.env` in it) and `README.md`. Never commit a `.env`
file or a key.

### 3. Railway service
1. In the Railway dashboard: **New Project → Deploy from GitHub repo**,
   and pick this repository.
2. Railway detects Node.js from `package.json` and runs `npm install`
   then `npm start` (= `node server.js`). No build or start command needs
   to be entered. Node 18 or newer is required (`engines` in
   `package.json`); the server uses the built-in `fetch`.
3. Railway sets `PORT` itself — the server reads it, so do not add it.
4. In the service **Settings → Networking**, generate a public domain.
   If it differs from the URL above, update both front ends (see note).

### 4. Variables
In the service's **Variables** tab:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | — | Key used for every AI call |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-4-20250514` | Model for both endpoints |
| `MODULE_MAPPING_MAX_TOKENS` | No | `8000` | Output budget for `/api/module-mapping` |

Saving a variable redeploys the service.

**Changing the model:** set `ANTHROPIC_MODEL` to another model id from
Anthropic's documentation (https://docs.claude.com) — no code change is
needed. If Anthropic retires the default model, the AI buttons start
failing with a model error in the logs; setting this variable is the fix.

---

## Testing

**Health check** — open in a browser:
`https://dacum-ai-backend-production.up.railway.app/`

```json
{ "status": "ok", "message": "DACUM AI Backend Server is running", "version": "1.1.0" }
```

**DACUM endpoint** — in the browser console:
```javascript
fetch('https://dacum-ai-backend-production.up.railway.app/api/generate-dacum', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'List three duties of a computer maintenance technician.' })
}).then(r => r.json()).then(console.log);
```

**Module Builder endpoint** — easiest from the tool itself: open a module
imported from DACUM Live Pro, go to Training Structure Mapping and run the
AI analysis. The proposal's items should show their sources (task items
or the occupational reference), not "not linked yet".

---

## ⚙️ Common issues

| Symptom | Likely cause / fix |
|---|---|
| Every AI button fails, logs show `API key not configured on server` | `ANTHROPIC_API_KEY` missing — add it in **Variables** |
| Logs show `401` / `invalid x-api-key` | Key revoked or mistyped — create a new one and replace the variable |
| Logs show a model `not_found` / deprecated error | Set `ANTHROPIC_MODEL` to a current model id |
| Front end reports rate limit (`429`) | Anthropic usage limit reached — wait, or raise the limit in the Anthropic console |
| Module Builder: "AI returned an invalid response" on large modules | Raise `MODULE_MAPPING_MAX_TOKENS` (e.g. `12000`) |
| Deploy fails | Open the failed deployment's **Build Logs**; usually a syntax error in an edited file or a Node version below 18 |
| Front end cannot reach the server | Check the public domain in **Settings → Networking** matches the URL in both front ends |

**Logs:** service → **Deployments** → select the active deployment →
**View Logs**. The server logs each call (`📤 Sending …`, `✅ Received …`,
`❌ …`).

---

## 🔒 Security checklist

- ✅ The API key lives only in Railway **Variables**, never in the code or the repository
- ✅ `.gitignore` contains `.env`
- ✅ Neither front end ever sees or sends the key
- ⚠️ CORS currently allows every origin (`app.use(cors())`). To restrict it
  to the two tools, replace that line with
  `app.use(cors({ origin: ['https://hshamjawad.github.io'] }))`
  (add any other domain the tools are served from).

---

## 💰 Cost notes

Railway bills the running service by usage according to your plan; check
current pricing in the Railway dashboard. Anthropic bills each AI call
separately by tokens — see https://docs.claude.com for model pricing.

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pkg = require('./package.json');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Configuration ───────────────────────────────────────────
// Everything below can be changed from the hosting dashboard
// (Railway → Variables) without a code change.
const intEnv = (name, fallback) => {
    const n = parseInt(process.env[name], 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// claude-sonnet-4-20250514, this server's old default, was retired by
// Anthropic on 2026-06-15; every call to it now fails. Set ANTHROPIC_MODEL
// only to pin a different model.
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
// Optional: low | medium | high. Left unset, Anthropic's own default applies.
const ANTHROPIC_EFFORT = process.env.ANTHROPIC_EFFORT || '';
// max_tokens covers the model's thinking AND its answer on current models,
// so these are higher than the old 4000 / 8000.
const DACUM_MAX_TOKENS = intEnv('DACUM_MAX_TOKENS', 8000) || 8000;
const MODULE_MAPPING_MAX_TOKENS = intEnv('MODULE_MAPPING_MAX_TOKENS', 16000) || 16000;
const UPSTREAM_TIMEOUT_MS = intEnv('UPSTREAM_TIMEOUT_MS', 150000) || 150000;
const UPSTREAM_RETRIES = intEnv('UPSTREAM_RETRIES', 1);
const RETRY_DELAY_MS = intEnv('RETRY_DELAY_MS', 1500);
const MAX_PROMPT_CHARS = intEnv('MAX_PROMPT_CHARS', 300000) || 300000;
// Per-IP limit on the two AI endpoints; RATE_LIMIT_MAX=0 turns it off.
const RATE_LIMIT_MAX = intEnv('RATE_LIMIT_MAX', 60);
const RATE_LIMIT_WINDOW_MS = intEnv('RATE_LIMIT_WINDOW_MS', 60000) || 60000;
// Optional comma-separated list of origins allowed to call the AI
// endpoints, e.g. https://hshamjawad.github.io. Unset = any origin (the
// behaviour this server has always had).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const DEBUG_ERRORS = process.env.DEBUG_ERRORS === '1';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Railway terminates TLS in front of the app: trust one proxy hop so
// req.ip is the visitor, not the proxy.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Middleware
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
app.use(ALLOWED_ORIGINS.length
    ? cors({ origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)) })
    : cors());   // Allow requests from any origin
app.use(express.json({ limit: '10mb' }));

// When an allow-list is set, a browser call from any other origin is refused
// outright (CORS alone only stops the browser from READING the reply).
function originGuard(req, res, next) {
    if (!ALLOWED_ORIGINS.length) return next();
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) return next();
    console.warn('⛔ Refused origin:', origin || '(none)');
    return res.status(403).json({ error: 'Origin not allowed' });
}

// Small in-memory sliding-window limiter — one process, no extra package.
function rateLimiter(max, windowMs) {
    const hits = new Map();
    const timer = setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [k, list] of hits) {
            const keep = list.filter(t => t > cutoff);
            if (keep.length) hits.set(k, keep); else hits.delete(k);
        }
    }, windowMs);
    if (timer.unref) timer.unref();
    return (req, res, next) => {
        if (!max) return next();
        const now = Date.now(), key = req.ip || 'unknown';
        const list = (hits.get(key) || []).filter(t => t > now - windowMs);
        if (list.length >= max) {
            res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
            return res.status(429).json({ error: 'Too many requests, please wait a moment and try again' });
        }
        list.push(now);
        hits.set(key, list);
        next();
    };
}
const aiLimiter = rateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

// ── Calling Anthropic ───────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One request to Anthropic with a timeout and a retry on overload /
 *  network trouble. Resolves { status, text }; rejects with an error that
 *  carries the HTTP status to answer the browser with. */
async function callAnthropic(payload) {
    const body = { model: ANTHROPIC_MODEL, ...payload };
    if (ANTHROPIC_EFFORT) body.output_config = { effort: ANTHROPIC_EFFORT };
    const attempts = 1 + UPSTREAM_RETRIES;
    let lastError;
    for (let i = 0; i < attempts; i++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
        try {
            const response = await fetch(ANTHROPIC_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': process.env.ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify(body),
                signal: ctl.signal
            });
            const text = await response.text();
            if ([502, 503, 504, 529].includes(response.status) && i < attempts - 1) {
                console.warn('⚠️ Anthropic answered ' + response.status + ' — retrying');
                lastError = null;
                await sleep(RETRY_DELAY_MS);
                continue;
            }
            return { status: response.status, text };
        } catch (e) {
            const timedOut = e && e.name === 'AbortError';
            lastError = Object.assign(new Error(timedOut ? 'The AI service took too long to answer' : 'Could not reach the AI service'),
                { httpStatus: timedOut ? 504 : 502 });
            if (!timedOut && i < attempts - 1) { await sleep(RETRY_DELAY_MS); continue; }
            throw lastError;
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastError || Object.assign(new Error('Could not reach the AI service'), { httpStatus: 502 });
}

/** Answer the browser for a failed Anthropic call: the useful detail goes
 *  to the log, a short generic message goes to the browser. */
function sendUpstreamFailure(res, status, text) {
    console.error('❌ Anthropic API Error (' + status + '):', String(text).slice(0, 2000));
    if (status === 429) return res.status(429).json({ error: 'Anthropic API rate limit reached' });
    const out = { error: status === 401 || status === 403 ? 'AI service is not configured correctly'
        : status === 404 ? 'The configured AI model is unavailable'
        : 'Anthropic API request failed' };
    if (DEBUG_ERRORS) out.details = String(text).slice(0, 2000);
    return res.status(502).json(out);
}

/** The text blocks of a reply. Current models can open a reply with a
 *  thinking block, so content[0] is not always the text. */
function textBlocks(data) {
    return (data && Array.isArray(data.content) ? data.content : []).filter(b => b && b.type === 'text');
}

function internalError(res, scope, error) {
    console.error('❌ Server Error (' + scope + '):', error);
    const out = { error: 'Internal server error' };
    if (DEBUG_ERRORS) out.message = error && error.message;
    return res.status(500).json(out);
}

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'DACUM AI Backend Server is running',
        version: pkg.version,
        model: ANTHROPIC_MODEL,
        aiConfigured: !!process.env.ANTHROPIC_API_KEY
    });
});

// AI Generation endpoint
app.post('/api/generate-dacum', originGuard, aiLimiter, async (req, res) => {
    try {
        const { prompt } = req.body || {};

        if (!prompt) {
            return res.status(400).json({ 
                error: 'Prompt is required' 
            });
        }
        if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_CHARS) {
            return res.status(400).json({ error: 'Prompt must be text of at most ' + MAX_PROMPT_CHARS + ' characters' });
        }

        // Check if API key is configured
        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(500).json({ 
                error: 'API key not configured on server' 
            });
        }

        console.log('📤 Sending request to Anthropic API...');

        const upstream = await callAnthropic({
            max_tokens: DACUM_MAX_TOKENS,
            messages: [{ role: 'user', content: prompt }]
        });
        if (upstream.status < 200 || upstream.status >= 300) return sendUpstreamFailure(res, upstream.status, upstream.text);

        let data;
        try { data = JSON.parse(upstream.text); }
        catch (_) { return res.status(502).json({ error: 'AI returned an invalid response' }); }
        console.log('✅ Received response from Anthropic API');

        // Same envelope the front ends have always read (content[0].text),
        // without any thinking blocks in front of the text.
        if (Array.isArray(data.content)) data.content = textBlocks(data);
        res.json(data);

    } catch (error) {
        if (error && error.httpStatus) return res.status(error.httpStatus).json({ error: error.message });
        internalError(res, 'generate-dacum', error);
    }
});

// ============================================================
// Module Builder — Training Structure Mapping
// ============================================================
// Called by Module Builder's src/module-ai.js. Unlike /api/generate-dacum
// above (a thin passthrough that hands the caller's own prompt straight
// to Anthropic and returns its raw envelope), this endpoint builds the
// prompt itself from structured data and returns a parsed, validated
// JSON object — the caller never sees a prompt string or Anthropic's
// response shape, only the mapping result.

const MODULE_MAPPING_FIELD_LABELS = {
    requiredKnowledge: 'Required Knowledge',
    requiredSkills: 'Required Skills',
    performanceSteps: 'Performance Steps',
    toolsEquipmentMaterials: 'Tools, Equipment & Materials',
    safetyOSH: 'Safety / OSH',
    conditionsWorkEnvironment: 'Conditions / Work Environment',
    decisionsCriticalPoints: 'Decisions / Critical Points',
    performanceCriteria: 'Performance Criteria (task-level)',
    performanceStandard: 'Performance Standard',
    commonErrorsTroubleshooting: 'Common Errors / Troubleshooting'
};

// ── Item lists, numbered exactly as Module Builder numbers them ──
// Module Builder (src/module-ai.js, _mbGetFieldItems) resolves a
// suggestion's source by { taskId, field, itemIndex }. The index is the
// item's position AFTER empty entries are dropped: an array keeps its
// non-blank entries, trimmed; a scalar field is one item. The prompt
// must number items by the SAME rule, or every citation lands one item
// off. This one function is used for both the prompt and validation.
function fieldItems(val) {
    if (Array.isArray(val)) return val.filter(v => v && String(v).trim()).map(v => String(v).trim());
    if (val && String(val).trim()) return [String(val).trim()];
    return [];
}

// Pseudo task id under which Module Builder offers the Verified
// Occupational Reference Data (DACUM Live Pro → Module Builder 3.8).
const OCC_REF_TASK = '__occref__';

function refCategories(input) {
    const ref = input && input.occupationalReference;
    return (ref && Array.isArray(ref.categories)) ? ref.categories : [];
}
function refItems(cat) {
    return fieldItems((cat && Array.isArray(cat.items) ? cat.items : []).map(i => (i && i.text) || ''));
}

// Renders exactly what was supplied and nothing else — an empty or
// missing field for a task is simply absent from the prompt, which is
// what stops the model treating silence as "nothing to report" and
// inventing something to fill the gap.
function buildModuleMappingPrompt(input) {
    const { module: mod, learningOutcomes, sourceTaskIds, taskAnalysis, language } = input;

    // The id Module Builder resolves (lo-3) AND the number people read
    // (LO3). The id used to be missing here, so the model could only
    // answer with "LO3", which matches nothing on the client: every
    // sheet then landed on the module's first outcome and every
    // assessment suggestion was skipped.
    const loBlock = (learningOutcomes || []).map(lo => {
        const pcBlock = (lo.performanceCriteria || [])
            .map(pc => `    - [pc id: ${pc.id}] ${pc.text}${pc.taskId ? ` [source task: ${pc.taskId}]` : ''}`)
            .join('\n') || '    (no performance criteria recorded)';
        return `- [lo id: ${lo.id}] ${lo.number || ''}: ${lo.statement || '(no statement recorded)'}\n${pcBlock}`;
    }).join('\n');

    const taBlock = (sourceTaskIds || []).map(taskId => {
        const ta = (taskAnalysis || {})[taskId];
        if (!ta) return `- [task id: ${taskId}] (no Task Analysis data available for this task)`;
        const fields = Object.keys(MODULE_MAPPING_FIELD_LABELS)
            .map(key => {
                const items = fieldItems(ta[key]);
                if (!items.length) return null;
                return `    - ${MODULE_MAPPING_FIELD_LABELS[key]} [field: ${key}]:\n` +
                    items.map((t, i) => `        [${i}] ${t}`).join('\n');
            })
            .filter(Boolean)
            .join('\n');
        return `- [task id: ${taskId}] ${ta.taskCode || ''}:\n${fields || '    (every Task Analysis field for this task is empty)'}`;
    }).join('\n');

    const refBlock = refCategories(input).map(cat => {
        const items = refItems(cat);
        if (!items.length) return null;
        const pct = i => {
            const raw = cat.items.filter(x => x && String(x.text || '').trim())[i];
            return raw && raw.percentage != null ? ` (verified importance ${raw.percentage}%)` : '';
        };
        return `- ${cat.name || cat.id} [field: ${cat.id}]:\n` +
            items.map((t, i) => `    [${i}] ${t}${pct(i)}`).join('\n');
    }).filter(Boolean).join('\n');

    const level = parseInt(mod && mod.level, 10);
    const levelLine = Number.isInteger(level) && level > 0
        ? `PROGRAMME LEVEL: ${level}${mod.track ? ` — SPECIALISATION: ${mod.track}` : ''}
Pitch the depth of every sheet to this level: lower levels emphasise guided, routine performance and safe basic practice; higher levels emphasise diagnosis, decision-making, independent work and responsibility. Do not add content that belongs to a different level.`
        : '';

    return `You are an instructional design assistant specializing in competency-based vocational education and training.

Analyze only the supplied module data below. Use professional judgment to suggest an efficient instructional structure. Do not fabricate missing occupational facts. Do not assume missing safety information, standards, procedures, tools, or technical requirements that were not supplied. You may transform existing source information into pedagogically useful sheet titles and structures (for example, a tool name like "Digital Caliper" may become an Information Sheet titled "Digital Caliper: Components and Basic Use" — that is instructional transformation of a real source item, not invention).

Prioritize, in this order of authority: Learning Outcomes, then Performance Criteria, then Tasks, then Task Analysis detail. Task Analysis information must never be mapped in isolation from the Learning Outcome and Performance Criteria it supports. Maintain full traceability in every item you propose.

Do not implement rigid one-to-one rules such as "Knowledge = Information Sheet" or "Steps = Activity Sheet". The mapping is contextual and may be many-to-many: a single source item (e.g. a tool) can support an Information Sheet, an Activity Sheet, and an Assessment criterion at once, or only one of them, depending on what the Learning Outcome and Performance Criteria actually call for. Group related information intelligently — do not create a separate Information Sheet for every individual item when one coherent sheet would serve the learner better.

The output is a PROPOSED STRUCTURE for a human curriculum developer to review, edit and approve — not final training content.

MODULE
${mod.moduleNumber || ''} ${mod.moduleTitle || '(untitled module)'}
${levelLine}

LEARNING OUTCOMES AND PERFORMANCE CRITERIA
${loBlock || '(none supplied)'}

TASK ANALYSIS (only fields actually filled in are listed; items are numbered [0], [1] … within each field; a task with none listed has no Task Analysis data yet)
${taBlock || '(no source tasks supplied)'}
${refBlock ? `
VERIFIED OCCUPATIONAL REFERENCE (task id: ${OCC_REF_TASK})
Occupation-level evidence ranked by the DACUM verification panel. It is REFERENCE ONLY: use it to enrich sheet content and resources (e.g. a verified tool as a resource or an information-sheet topic) where it supports a Learning Outcome above. NEVER create a learning outcome or a performance criterion from it, and never let it outweigh the Learning Outcomes and Performance Criteria.
${refBlock}
` : ''}
Respond in ${language === 'ar' ? 'Arabic' : language === 'fr' ? 'French' : 'English'}, matching the language the module content above is written in.

Respond with ONLY a single valid JSON object — no markdown code fences, no commentary before or after it — matching exactly this shape:

{
  "analysisSummary": "one or two sentences describing the proposed structure and why",
  "informationSheets": [
    { "tempId": "is-1", "title": "...", "rationale": "...",
      "learningOutcomeIds": ["<lo id, e.g. lo-1>"],
      "performanceCriteriaIds": ["<pc id, e.g. 1-1>"],
      "sourceSelections": [
        { "taskId": "<task id>", "field": "<field name, e.g. requiredKnowledge>", "itemIndex": 0, "itemText": "<the item's text exactly as listed>" }
      ],
      "mappingType": "direct" }
  ],
  "activitySheets": [ { "tempId": "as-1", "title": "...", "rationale": "...", "learningOutcomeIds": [], "performanceCriteriaIds": [], "sourceSelections": [], "mappingType": "direct" } ],
  "assessmentUnits": [ { "tempId": "au-1", "title": "...", "rationale": "...", "learningOutcomeIds": [], "performanceCriteriaIds": [], "sourceSelections": [], "mappingType": "direct" } ],
  "missingInformation": [ { "sourceTaskId": "...", "field": "safetyOSH", "message": "No safety information was provided for this task." } ]
}

sourceSelections cite individual numbered items: taskId is a [task id] above${refBlock ? ` (or "${OCC_REF_TASK}" for the occupational reference, with field = its [field] value)` : ''}, field is the [field] name, itemIndex is the [n] number within that field, and itemText repeats that item's text. Use "transformation" for mappingType only when you reworded/regrouped source material into a more pedagogically useful title; use "direct" when the sheet corresponds closely to the source as given. Every learningOutcomeIds value must be an [lo id] above and every performanceCriteriaIds value a [pc id] above — never invent an id. Every assessmentUnits item's learningOutcomeIds must contain exactly the one Learning Outcome its performance criteria belong to. If a field you would normally expect (safety, standards, tools) is genuinely absent from the supplied Task Analysis, note it in missingInformation instead of guessing a value. Omit any of the four arrays' entries entirely rather than padding them — an empty array is a valid and expected answer when the data does not support that category.`;
}

/**
 * Hold the model's answer to the data it was given, before it leaves the
 * server. Module Builder already discards what it cannot use; this makes
 * what it receives right in the first place:
 *   • learningOutcomeIds: an "LO3" number is turned into its id (lo-3);
 *     anything unknown is dropped;
 *   • performanceCriteriaIds: only ids that exist;
 *   • sourceSelections: only {taskId, field, itemIndex} that point at a
 *     real item — and itemText is replaced by that item's REAL text, so
 *     a misquoted index can never show the user words the source does
 *     not contain;
 *   • an assessment with no outcome but with criteria gets the outcome
 *     those criteria belong to (the client needs exactly one).
 */
function normalizeMappingResult(parsed, input) {
    const arr = v => Array.isArray(v) ? v : [];
    const los = arr(input.learningOutcomes);
    const loId = {};
    const pcToLo = {};
    los.forEach(lo => {
        if (!lo || !lo.id) return;
        loId[String(lo.id).toLowerCase()] = lo.id;
        if (lo.number) loId[String(lo.number).toLowerCase().replace(/\s+/g, '')] = lo.id;
        arr(lo.performanceCriteria).forEach(pc => { if (pc && pc.id) pcToLo[String(pc.id)] = lo.id; });
    });
    const tasks = new Set(arr(input.sourceTaskIds).map(String));
    const itemsFor = (taskId, field) => {
        if (taskId === OCC_REF_TASK) {
            const cat = refCategories(input).find(c => String(c.id) === String(field));
            return cat ? refItems(cat) : [];
        }
        if (!tasks.has(taskId) || !MODULE_MAPPING_FIELD_LABELS[field]) return [];
        return fieldItems(((input.taskAnalysis || {})[taskId] || {})[field]);
    };

    const fixItem = (it, isAssessment) => {
        if (!it || typeof it !== 'object') return null;
        const lo = [...new Set(arr(it.learningOutcomeIds)
            .map(v => loId[String(v).toLowerCase().replace(/\s+/g, '')])
            .filter(Boolean))];
        const pc = [...new Set(arr(it.performanceCriteriaIds).map(String).filter(id => pcToLo[id]))];
        const seen = new Set();
        const sel = arr(it.sourceSelections).map(s => {
            if (!s) return null;
            const taskId = String(s.taskId || ''), field = String(s.field || '');
            const idx = Number.isInteger(s.itemIndex) ? s.itemIndex : parseInt(s.itemIndex, 10);
            const items = itemsFor(taskId, field);
            if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) return null;
            const key = taskId + '|' + field + '|' + idx;
            if (seen.has(key)) return null;
            seen.add(key);
            return { taskId, field, itemIndex: idx, itemText: items[idx] };
        }).filter(Boolean);
        if (isAssessment && !lo.length && pc.length) lo.push(pcToLo[pc[0]]);
        return {
            ...it,
            learningOutcomeIds: isAssessment ? lo.slice(0, 1) : lo,
            performanceCriteriaIds: pc,
            sourceSelections: sel,
            mappingType: it.mappingType === 'transformation' ? 'transformation' : 'direct'
        };
    };

    return {
        analysisSummary: typeof parsed.analysisSummary === 'string' ? parsed.analysisSummary : '',
        informationSheets: arr(parsed.informationSheets).map(i => fixItem(i, false)).filter(Boolean),
        activitySheets:    arr(parsed.activitySheets).map(i => fixItem(i, false)).filter(Boolean),
        assessmentUnits:   arr(parsed.assessmentUnits).map(i => fixItem(i, true)).filter(Boolean),
        missingInformation: arr(parsed.missingInformation).filter(m => m && typeof m === 'object')
    };
}

/** Best-effort extraction of a JSON object from the model's text reply.
 *  Strips a code fence, or a sentence around the object, rather than
 *  failing a request that actually contains a good answer. */
function extractJsonObject(text) {
    const trimmed = String(text || '').trim();
    try { return JSON.parse(trimmed); } catch (_) { /* fall through */ }
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
        try { return JSON.parse(fenced[1].trim()); } catch (_) { /* fall through */ }
    }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)); } catch (_) { /* fall through */ }
    }
    return null;
}

app.post('/api/module-mapping', originGuard, aiLimiter, async (req, res) => {
    try {
        const input = req.body;

        if (!input || typeof input !== 'object' || !input.module) {
            return res.status(400).json({ error: 'module data is required' });
        }
        if (!Array.isArray(input.learningOutcomes) || input.learningOutcomes.length === 0) {
            return res.status(400).json({ error: 'At least one learning outcome is required' });
        }
        if (input.learningOutcomes.length > 100 || (Array.isArray(input.sourceTaskIds) && input.sourceTaskIds.length > 500)) {
            return res.status(400).json({ error: 'Too many learning outcomes or tasks in one request' });
        }

        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(500).json({ error: 'API key not configured on server' });
        }

        const prompt = buildModuleMappingPrompt(input);
        if (prompt.length > MAX_PROMPT_CHARS) {
            return res.status(400).json({ error: 'The module is too large to analyse in one request' });
        }

        console.log('📤 Sending module-mapping request to Anthropic API...');

        // No assistant "prefill": current models reject a conversation that
        // ends with an assistant turn. The prompt already asks for a single
        // JSON object, and extractJsonObject() copes with a fence or a stray
        // sentence around it.
        const upstream = await callAnthropic({
            // Raised from 4000: a module with several outcomes and a
            // full Task Analysis plus occupational reference could be
            // cut off mid-JSON, which surfaced as "invalid response".
            max_tokens: MODULE_MAPPING_MAX_TOKENS,
            messages: [{ role: 'user', content: prompt }]
        });
        if (upstream.status < 200 || upstream.status >= 300) return sendUpstreamFailure(res, upstream.status, upstream.text);

        let data;
        try { data = JSON.parse(upstream.text); }
        catch (_) { return res.status(502).json({ error: 'AI returned an invalid response' }); }

        const rawText = textBlocks(data).map(b => b.text || '').join('');
        const parsed = extractJsonObject(rawText);

        if (!parsed) {
            console.error('❌ Could not parse JSON from model response (stop_reason: ' + data.stop_reason + '):', rawText.slice(0, 500));
            return res.status(502).json({ error: 'AI returned an invalid response' });
        }

        console.log('✅ Module mapping proposal generated');
        res.json(normalizeMappingResult(parsed, input));

    } catch (error) {
        if (error && error.httpStatus) return res.status(error.httpStatus).json({ error: error.message });
        internalError(res, 'module-mapping', error);
    }
});

// Anything else: JSON, like the rest of the API.
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Bad JSON bodies and oversized bodies answer as JSON too.
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return res.status(400).json({ error: 'Invalid JSON' });
    return internalError(res, 'request', err);
});

// Start server — only when run directly (npm start / node server.js),
// so the prompt and validation functions can be loaded by a test.
if (require.main === module) {
    const server = app.listen(PORT, () => {
        console.log(`🚀 DACUM AI Backend Server ${pkg.version} running on port ${PORT}`);
        console.log(`📍 Health check: http://localhost:${PORT}/`);
        console.log(`🤖 AI endpoint: http://localhost:${PORT}/api/generate-dacum`);
        console.log(`🧩 Module mapping endpoint: http://localhost:${PORT}/api/module-mapping`);
        console.log(`🧠 Model: ${ANTHROPIC_MODEL}${process.env.ANTHROPIC_API_KEY ? '' : '  ⚠️ ANTHROPIC_API_KEY is not set'}`);
    });
    // Railway sends SIGTERM when it redeploys: finish the requests in flight.
    process.on('SIGTERM', () => {
        console.log('SIGTERM received — shutting down');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 10000).unref();
    });
    process.on('unhandledRejection', reason => console.error('❌ Unhandled rejection:', reason));
}

module.exports = { app, buildModuleMappingPrompt, normalizeMappingResult, fieldItems, extractJsonObject, textBlocks, DEFAULT_MODEL };

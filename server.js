const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Model and output budget can be changed from the hosting dashboard
// (Railway → Variables) without a code change. Defaults keep the exact
// behaviour this server has always had.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MODULE_MAPPING_MAX_TOKENS = parseInt(process.env.MODULE_MAPPING_MAX_TOKENS, 10) || 8000;

// Middleware
app.use(cors()); // Allow requests from any origin
app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'DACUM AI Backend Server is running',
        version: '1.1.0'
    });
});

// AI Generation endpoint
app.post('/api/generate-dacum', async (req, res) => {
    try {
        const { prompt } = req.body;

        if (!prompt) {
            return res.status(400).json({ 
                error: 'Prompt is required' 
            });
        }

        // Check if API key is configured
        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(500).json({ 
                error: 'API key not configured on server' 
            });
        }

        console.log('📤 Sending request to Anthropic API...');

        // Call Anthropic API
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: ANTHROPIC_MODEL,
                max_tokens: 4000,
                messages: [
                    { role: 'user', content: prompt }
                ]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Anthropic API Error:', errorText);
            return res.status(response.status).json({ 
                error: 'Anthropic API request failed',
                details: errorText
            });
        }

        const data = await response.json();
        console.log('✅ Received response from Anthropic API');

        // Return the response to frontend
        res.json(data);

    } catch (error) {
        console.error('❌ Server Error:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
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
 *  The assistant-prefill below makes a stray code fence unlikely, but
 *  this still strips one if the model adds it anyway, rather than
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

app.post('/api/module-mapping', async (req, res) => {
    try {
        const input = req.body;

        if (!input || typeof input !== 'object' || !input.module) {
            return res.status(400).json({ error: 'module data is required' });
        }
        if (!Array.isArray(input.learningOutcomes) || input.learningOutcomes.length === 0) {
            return res.status(400).json({ error: 'At least one learning outcome is required' });
        }

        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(500).json({ error: 'API key not configured on server' });
        }

        const prompt = buildModuleMappingPrompt(input);

        console.log('📤 Sending module-mapping request to Anthropic API...');

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: ANTHROPIC_MODEL,
                // Raised from 4000: a module with several outcomes and a
                // full Task Analysis plus occupational reference could be
                // cut off mid-JSON, which surfaced as "invalid response".
                max_tokens: MODULE_MAPPING_MAX_TOKENS,
                messages: [
                    { role: 'user', content: prompt },
                    // Prefilling the assistant turn with the opening brace is
                    // Anthropic's own documented technique for steering a
                    // reply straight into JSON, without needing tool-use for
                    // what is otherwise a plain text completion.
                    { role: 'assistant', content: '{' }
                ]
            })
        });

        if (response.status === 429) {
            return res.status(429).json({ error: 'Anthropic API rate limit reached' });
        }
        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Anthropic API Error:', errorText);
            return res.status(response.status >= 500 ? 502 : response.status).json({
                error: 'Anthropic API request failed',
                details: errorText
            });
        }

        const data = await response.json();
        const rawText = '{' + (data.content && data.content[0] && data.content[0].text || '');
        const parsed = extractJsonObject(rawText);

        if (!parsed) {
            console.error('❌ Could not parse JSON from model response:', rawText.slice(0, 500));
            return res.status(502).json({ error: 'AI returned an invalid response' });
        }

        console.log('✅ Module mapping proposal generated');
        res.json(normalizeMappingResult(parsed, input));

    } catch (error) {
        console.error('❌ Server Error (module-mapping):', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Start server — only when run directly (npm start / node server.js),
// so the prompt and validation functions can be loaded by a test.
if (require.main === module) app.listen(PORT, () => {
    console.log(`🚀 DACUM AI Backend Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/`);
    console.log(`🤖 AI endpoint: http://localhost:${PORT}/api/generate-dacum`);
    console.log(`🧩 Module mapping endpoint: http://localhost:${PORT}/api/module-mapping`);
});

module.exports = { app, buildModuleMappingPrompt, normalizeMappingResult, fieldItems };

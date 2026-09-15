const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Allow requests from any origin
app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'DACUM AI Backend Server is running',
        version: '1.0.0'
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
                model: 'claude-sonnet-4-20250514',
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

// Renders exactly what was supplied and nothing else — an empty or
// missing field for a task is simply absent from the prompt, which is
// what stops the model treating silence as "nothing to report" and
// inventing something to fill the gap.
function buildModuleMappingPrompt(input) {
    const { module: mod, learningOutcomes, sourceTaskIds, taskAnalysis, language } = input;

    const loBlock = (learningOutcomes || []).map(lo => {
        const pcBlock = (lo.performanceCriteria || [])
            .map(pc => `    - ${pc.id}: ${pc.text}${pc.taskId ? ` [source task: ${pc.taskId}]` : ''}`)
            .join('\n') || '    (no performance criteria recorded)';
        return `- ${lo.number || lo.id}: ${lo.statement || '(no statement recorded)'}\n${pcBlock}`;
    }).join('\n');

    const taBlock = (sourceTaskIds || []).map(taskId => {
        const ta = (taskAnalysis || {})[taskId];
        if (!ta) return `- ${taskId}: (no Task Analysis data available for this task)`;
        const fields = Object.keys(MODULE_MAPPING_FIELD_LABELS)
            .map(key => {
                const val = ta[key];
                const items = Array.isArray(val) ? val.filter(Boolean) : (val && String(val).trim() ? [String(val).trim()] : []);
                if (!items.length) return null;
                return `    - ${MODULE_MAPPING_FIELD_LABELS[key]} [field: ${key}]: ${items.join(' | ')}`;
            })
            .filter(Boolean)
            .join('\n');
        return `- ${ta.taskCode || taskId}:\n${fields || '    (every Task Analysis field for this task is empty)'}`;
    }).join('\n');

    return `You are an instructional design assistant specializing in competency-based vocational education and training.

Analyze only the supplied module data below. Use professional judgment to suggest an efficient instructional structure. Do not fabricate missing occupational facts. Do not assume missing safety information, standards, procedures, tools, or technical requirements that were not supplied. You may transform existing source information into pedagogically useful sheet titles and structures (for example, a tool name like "Digital Caliper" may become an Information Sheet titled "Digital Caliper: Components and Basic Use" — that is instructional transformation of a real source item, not invention).

Prioritize, in this order of authority: Learning Outcomes, then Performance Criteria, then Tasks, then Task Analysis detail. Task Analysis information must never be mapped in isolation from the Learning Outcome and Performance Criteria it supports. Maintain full traceability in every item you propose.

Do not implement rigid one-to-one rules such as "Knowledge = Information Sheet" or "Steps = Activity Sheet". The mapping is contextual and may be many-to-many: a single source item (e.g. a tool) can support an Information Sheet, an Activity Sheet, and an Assessment criterion at once, or only one of them, depending on what the Learning Outcome and Performance Criteria actually call for. Group related information intelligently — do not create a separate Information Sheet for every individual item when one coherent sheet would serve the learner better.

The output is a PROPOSED STRUCTURE for a human curriculum developer to review, edit and approve — not final training content.

MODULE
${mod.moduleNumber || ''} ${mod.moduleTitle || '(untitled module)'}

LEARNING OUTCOMES AND PERFORMANCE CRITERIA
${loBlock || '(none supplied)'}

TASK ANALYSIS (only fields actually filled in are listed; a task with none listed has no Task Analysis data yet)
${taBlock || '(no source tasks supplied)'}

Respond in ${language === 'ar' ? 'Arabic' : language === 'fr' ? 'French' : 'English'}, matching the language the module content above is written in.

Respond with ONLY a single valid JSON object — no markdown code fences, no commentary before or after it — matching exactly this shape:

{
  "analysisSummary": "one or two sentences describing the proposed structure and why",
  "informationSheets": [
    { "tempId": "is-1", "title": "...", "rationale": "...",
      "learningOutcomeIds": ["<LO id from the data above>"],
      "performanceCriteriaIds": ["<PC id, e.g. 1-1>"],
      "sourceTaskIds": ["<task id from the data above>"],
      "sourceFields": ["<field name from the Task Analysis field list, e.g. requiredKnowledge>"],
      "mappingType": "direct" }
  ],
  "activitySheets": [ { "tempId": "as-1", "title": "...", "rationale": "...", "learningOutcomeIds": [], "performanceCriteriaIds": [], "sourceTaskIds": [], "sourceFields": [], "mappingType": "direct" } ],
  "assessmentUnits": [ { "tempId": "au-1", "title": "...", "rationale": "...", "learningOutcomeIds": [], "performanceCriteriaIds": [], "sourceTaskIds": [], "sourceFields": [], "mappingType": "direct" } ],
  "missingInformation": [ { "sourceTaskId": "...", "field": "safetyOSH", "message": "No safety information was provided for this task." } ]
}

Use "transformation" for mappingType only when you reworded/regrouped source material into a more pedagogically useful title; use "direct" when the sheet corresponds closely to the source as given. Every learningOutcomeIds/performanceCriteriaIds/sourceTaskIds value must be one of the ids that actually appears in the data above — never invent an id. Every assessmentUnits item's learningOutcomeIds must contain exactly the one Learning Outcome its performance criteria belong to. If a field you would normally expect (safety, standards, tools) is genuinely absent from the supplied Task Analysis, note it in missingInformation instead of guessing a value. Omit any of the four arrays' entries entirely rather than padding them — an empty array is a valid and expected answer when the data does not support that category.`;
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
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4000,
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
        res.json(parsed);

    } catch (error) {
        console.error('❌ Server Error (module-mapping):', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 DACUM AI Backend Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/`);
    console.log(`🤖 AI endpoint: http://localhost:${PORT}/api/generate-dacum`);
    console.log(`🧩 Module mapping endpoint: http://localhost:${PORT}/api/module-mapping`);
});

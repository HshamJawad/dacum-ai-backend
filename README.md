# DACUM AI Backend Server

Backend server for the AI-powered DACUM Chart Generator tool. This server handles API requests to Anthropic's Claude AI.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ installed
- Anthropic API key ([Get one here](https://console.anthropic.com/settings/keys))

### Local Development

1. **Install dependencies:**
```bash
npm install
```

2. **Create .env file:**
```bash
cp .env.example .env
```

3. **Add your API key to .env:**
```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx
```

4. **Start the server:**
```bash
npm start
```

Server will run on http://localhost:3000

### Test the Server

**Health Check:**
```bash
curl http://localhost:3000/
```

**Test AI Generation:**
```bash
curl -X POST http://localhost:3000/api/generate-dacum \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Generate a DACUM for Automotive Technician"}'
```

## 📡 API Endpoints

### GET /
Health check endpoint
- Returns: `{ status: 'ok', message: '...', version, model, aiConfigured }`

### POST /api/generate-dacum
Generate DACUM structure using AI
- Body: `{ "prompt": "your prompt here" }`
- Returns: Anthropic API response with generated DACUM

### POST /api/module-mapping
Used by Module Builder's Training Structure Mapping feature. Unlike
`/api/generate-dacum`, this endpoint builds the prompt itself from
structured data and returns a parsed, **validated** JSON object — not
Anthropic's raw response envelope.
- Body:
```json
{
  "module": { "moduleId": "...", "moduleNumber": "M1", "moduleTitle": "...",
              "level": 1, "track": "CMCN" },
  "learningOutcomes": [
    { "id": "lo-1", "number": "LO1", "statement": "...",
      "performanceCriteria": [ { "id": "1-1", "text": "...", "taskId": "..." } ] }
  ],
  "sourceTaskIds": ["..."],
  "taskAnalysis": { "<taskId>": { "taskCode": "TASK B4", "requiredKnowledge": [...], "...": "..." } },
  "occupationalReference": { "categories": [ { "id": "toolsEquipment", "name": "...",
      "items": [ { "text": "Multimeter", "percentage": 93.3 } ] } ] },
  "language": "en"
}
```
  `level`, `track` and `occupationalReference` are optional (Module
  Builder 3.8+). The occupational reference is reference evidence only:
  it may inform sheet content and resources, never new learning outcomes.
- Returns:
```json
{
  "analysisSummary": "...",
  "informationSheets": [ { "tempId": "is-1", "title": "...", "rationale": "...",
      "learningOutcomeIds": ["lo-1"], "performanceCriteriaIds": ["1-1"],
      "sourceSelections": [ { "taskId": "<taskId | __occref__>", "field": "requiredKnowledge",
                              "itemIndex": 0, "itemText": "..." } ],
      "mappingType": "direct" } ],
  "activitySheets": [ ... ],
  "assessmentUnits": [ ... ],
  "missingInformation": [ { "sourceTaskId": "...", "field": "safetyOSH", "message": "..." } ]
}
```
  Before it is returned, the result is checked against the request
  (`normalizeMappingResult`): outcome numbers such as `LO3` become their
  ids, unknown outcome/criterion ids are dropped, each `sourceSelections`
  entry must point at a real item (`itemIndex` counts non-empty items in
  that field, the same way Module Builder counts them) and its `itemText`
  is replaced by that item's real text.
- Errors: `400` missing/empty module or learning outcomes, `429` Anthropic
  rate limit, `502` Anthropic server error or an unparseable AI reply,
  `500` missing API key or unexpected server error.

### Optional environment variables
| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | Model used by both endpoints |
| `MODULE_MAPPING_MAX_TOKENS` | `8000` | Output budget for `/api/module-mapping` |

## 🌐 Deploy to Render.com

See DEPLOYMENT.md for detailed instructions.

## 🔒 Security Notes

- Never commit .env file or API keys to Git
- Use environment variables for sensitive data
- CORS is enabled for all origins (restrict in production if needed)

## 📝 License

MIT License - Created by Husham Jawad Kadhim

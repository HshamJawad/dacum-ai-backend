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
- Returns: `{ status: 'ok', message: '...', version: '1.0.0' }`

### POST /api/generate-dacum
Generate DACUM structure using AI
- Body: `{ "prompt": "your prompt here" }`
- Returns: Anthropic API response with generated DACUM

### POST /api/module-mapping
Used by Module Builder's Training Structure Mapping feature. Unlike
`/api/generate-dacum`, this endpoint builds the prompt itself from
structured data and returns a parsed JSON object directly — not
Anthropic's raw response envelope.
- Body:
```json
{
  "module": { "moduleId": "...", "moduleNumber": "M1", "moduleTitle": "..." },
  "learningOutcomes": [
    { "id": "lo-1", "number": "LO1", "statement": "...",
      "performanceCriteria": [ { "id": "1-1", "text": "...", "taskId": "..." } ] }
  ],
  "sourceTaskIds": ["..."],
  "taskAnalysis": { "<taskId>": { "taskCode": "TASK B4", "requiredKnowledge": [...], "...": "..." } },
  "language": "en"
}
```
- Returns:
```json
{
  "analysisSummary": "...",
  "informationSheets": [ { "tempId": "is-1", "title": "...", "rationale": "...",
      "learningOutcomeIds": [...], "performanceCriteriaIds": [...],
      "sourceTaskIds": [...], "sourceFields": [...], "mappingType": "direct" } ],
  "activitySheets": [ ... ],
  "assessmentUnits": [ ... ],
  "missingInformation": [ { "sourceTaskId": "...", "field": "safetyOSH", "message": "..." } ]
}
```
- Errors: `400` missing/empty module or learning outcomes, `429` Anthropic
  rate limit, `502` Anthropic server error or an unparseable AI reply,
  `500` missing API key or unexpected server error.

## 🌐 Deploy to Render.com

See DEPLOYMENT.md for detailed instructions.

## 🔒 Security Notes

- Never commit .env file or API keys to Git
- Use environment variables for sensitive data
- CORS is enabled for all origins (restrict in production if needed)

## 📝 License

MIT License - Created by Husham Jawad Kadhim

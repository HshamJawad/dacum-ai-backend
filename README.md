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

## 🌐 Deploy to Render.com

See DEPLOYMENT.md for detailed instructions.

## 🔒 Security Notes

- Never commit .env file or API keys to Git
- Use environment variables for sensitive data
- CORS is enabled for all origins (restrict in production if needed)

## 📝 License

MIT License - Created by Husham Jawad Kadhim

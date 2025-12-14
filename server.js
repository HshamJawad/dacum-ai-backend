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

// Start server
app.listen(PORT, () => {
    console.log(`🚀 DACUM AI Backend Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/`);
    console.log(`🤖 AI endpoint: http://localhost:${PORT}/api/generate-dacum`);
});

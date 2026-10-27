// The per-IP limiter, with a small limit (its own process, so its own env).
process.env.ANTHROPIC_API_KEY = 'test-key';
for (const m of ['log', 'warn', 'error']) console[m] = () => {};   // the server logs every failure it handles
process.env.RATE_LIMIT_MAX = '3';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { app } = require('../server.js');

const realFetch = global.fetch;
global.fetch = async (url, opts) => String(url).startsWith('https://api.anthropic.com')
  ? { status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'x' }] }) }
  : realFetch(url, opts);

test('the fourth call in a minute gets 429 with Retry-After; the health check is never limited', async () => {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = () => realFetch(base + '/api/generate-dacum', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }) });
  for (let i = 0; i < 3; i++) assert.strictEqual((await call()).status, 200);
  const r = await call();
  assert.strictEqual(r.status, 429);
  assert.ok(r.headers.get('retry-after'));
  assert.match((await r.json()).error, /Too many requests/);
  for (let i = 0; i < 5; i++) assert.strictEqual((await realFetch(base + '/')).status, 200);
  server.close();
});

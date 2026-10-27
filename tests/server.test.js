// node --test tests/*.test.js — no network, no API key: Anthropic is stubbed.
process.env.ANTHROPIC_API_KEY = 'test-key';
for (const m of ['log', 'warn', 'error']) console[m] = () => {};   // the server logs every failure it handles
process.env.RETRY_DELAY_MS = '1';
process.env.RATE_LIMIT_MAX = '0';   // limiter is tested in ratelimit.test.js
process.env.RATE_LIMIT_WINDOW_MS = '60000';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { app, extractJsonObject, textBlocks, DEFAULT_MODEL } = require('../server.js');

const realFetch = global.fetch;
let upstream = [];            // queue of stub replies for Anthropic calls
let upstreamCalls = [];       // bodies sent to Anthropic
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.anthropic.com')) {
    upstreamCalls.push(JSON.parse(opts.body));
    const next = upstream.shift();
    if (next instanceof Error) throw next;
    return { status: next.status, text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)) };
  }
  return realFetch(url, opts);
};

let server, base;
test.before(async () => { server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => server.close());
test.beforeEach(() => { upstream = []; upstreamCalls = []; });

const post = (path, body, headers = {}) => realFetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ok = text => ({ status: 200, body: { id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] } });

const mappingInput = {
  module: { moduleNumber: 'M1', moduleTitle: 'Welding' },
  learningOutcomes: [{ id: 'lo-1', number: 'LO1', statement: 'Weld', performanceCriteria: [{ id: '1-1', text: 'Clean bead' }] }],
  sourceTaskIds: ['t1'], taskAnalysis: { t1: { taskCode: 'A1', requiredKnowledge: ['Arc basics', 'PPE'] } }, language: 'en'
};

test('health check reports version, model and whether the key is set', async () => {
  const j = await (await realFetch(base + '/')).json();
  assert.strictEqual(j.status, 'ok'); assert.strictEqual(j.model, DEFAULT_MODEL); assert.strictEqual(j.aiConfigured, true);
  assert.match(j.version, /^\d+\.\d+\.\d+$/);
});

test('the default model is not the retired claude-sonnet-4-20250514', () => {
  assert.strictEqual(DEFAULT_MODEL, 'claude-sonnet-5-5');
});

test('generate-dacum: keeps only text blocks, so content[0].text still works', async () => {
  upstream.push(ok('hello'));
  const r = await post('/api/generate-dacum', { prompt: 'hi' });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.content.length, 1); assert.strictEqual(j.content[0].text, 'hello');
  assert.strictEqual(upstreamCalls[0].model, DEFAULT_MODEL);
  assert.strictEqual(upstreamCalls[0].messages.length, 1);
});

test('generate-dacum: validates the prompt', async () => {
  assert.strictEqual((await post('/api/generate-dacum', {})).status, 400);
  assert.strictEqual((await post('/api/generate-dacum', { prompt: { a: 1 } })).status, 400);
  assert.strictEqual((await post('/api/generate-dacum', { prompt: 'x'.repeat(300001) })).status, 400);
  assert.strictEqual(upstreamCalls.length, 0);
});

test('a Anthropic error is answered generically, without its details', async () => {
  upstream.push({ status: 400, body: { error: { message: 'secret internal detail' } } });
  const r = await post('/api/generate-dacum', { prompt: 'hi' });
  assert.strictEqual(r.status, 502);
  const t = await r.text(); assert.ok(!t.includes('secret internal detail'), t);
});

test('a retired / unknown model is reported as such', async () => {
  upstream.push({ status: 404, body: { error: { message: 'model not found' } } });
  const r = await post('/api/generate-dacum', { prompt: 'hi' });
  assert.strictEqual(r.status, 502); assert.match((await r.json()).error, /model/i);
});

test('rate limit from Anthropic stays a 429', async () => {
  upstream.push({ status: 429, body: {} });
  assert.strictEqual((await post('/api/generate-dacum', { prompt: 'hi' })).status, 429);
});

test('an overloaded reply (529) is retried once', async () => {
  upstream.push({ status: 529, body: {} }, ok('second try'));
  const r = await post('/api/generate-dacum', { prompt: 'hi' });
  assert.strictEqual(r.status, 200); assert.strictEqual(upstreamCalls.length, 2);
});

test('a network failure reaching Anthropic answers 502', async () => {
  upstream.push(new Error('boom'), new Error('boom'));
  assert.strictEqual((await post('/api/generate-dacum', { prompt: 'hi' })).status, 502);
});

test('module-mapping: no assistant prefill, JSON read from the text block, ids validated', async () => {
  const reply = JSON.stringify({ analysisSummary: 's', informationSheets: [{ tempId: 'is-1', title: 'Arc', learningOutcomeIds: ['LO1', 'lo-99'],
    performanceCriteriaIds: ['1-1', '9-9'], sourceSelections: [{ taskId: 't1', field: 'requiredKnowledge', itemIndex: 1, itemText: 'wrong text' }, { taskId: 't1', field: 'requiredKnowledge', itemIndex: 7 }] }] });
  upstream.push(ok('```json\n' + reply + '\n```'));
  const r = await post('/api/module-mapping', mappingInput);
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.deepStrictEqual(j.informationSheets[0].learningOutcomeIds, ['lo-1']);
  assert.deepStrictEqual(j.informationSheets[0].performanceCriteriaIds, ['1-1']);
  assert.deepStrictEqual(j.informationSheets[0].sourceSelections, [{ taskId: 't1', field: 'requiredKnowledge', itemIndex: 1, itemText: 'PPE' }]);
  const last = upstreamCalls[0].messages[upstreamCalls[0].messages.length - 1];
  assert.strictEqual(last.role, 'user');
});

test('module-mapping: an unreadable answer is a 502, a bad request a 400', async () => {
  upstream.push(ok('I cannot do that'));
  assert.strictEqual((await post('/api/module-mapping', mappingInput)).status, 502);
  assert.strictEqual((await post('/api/module-mapping', { module: {} })).status, 400);
  assert.strictEqual((await post('/api/module-mapping', { ...mappingInput, learningOutcomes: new Array(101).fill(mappingInput.learningOutcomes[0]) })).status, 400);
});

test('bad JSON body and unknown paths answer as JSON', async () => {
  const bad = await post('/api/generate-dacum', '{not json');
  assert.strictEqual(bad.status, 400); assert.deepStrictEqual(await bad.json(), { error: 'Invalid JSON' });
  const nf = await realFetch(base + '/nope'); assert.strictEqual(nf.status, 404); assert.deepStrictEqual(await nf.json(), { error: 'Not found' });
});

test('extractJsonObject and textBlocks', () => {
  assert.deepStrictEqual(extractJsonObject('x {"a":1} y'), { a: 1 });
  assert.strictEqual(extractJsonObject('nothing'), null);
  assert.deepStrictEqual(textBlocks({ content: [{ type: 'thinking' }, { type: 'text', text: 'a' }] }), [{ type: 'text', text: 'a' }]);
  assert.deepStrictEqual(textBlocks({}), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { brotliCompressSync } from 'node:zlib';
import { createServer } from 'node:http';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
// Exercise the production TS/TSX entry points using the repo's TypeScript compiler.
function loadSource(relative, overrides = {}) {
  const filename = path.join(root, relative);
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const localRequire = name => {
    if (name in overrides) return overrides[name];
    if (name.startsWith('@/')) return loadSource(`${name.slice(2)}.ts`, overrides);
    return require(name);
  };
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  return module.exports;
}

const palaceCases = [
  ['命宫', 'overview'], ['兄弟', 'family'], ['夫妻', 'love'], ['子女', 'children'],
  ['财帛', 'wealth'], ['疾厄', 'health'], ['迁移', 'move'], ['仆役', 'friends'],
  ['官禄', 'career'], ['田宅', 'home'], ['福德', 'spirit'], ['父母', 'parents'],
];

test('palace selection sends an explicit local topic for all iztro names and long aliases', async () => {
  const savedFetch = globalThis.fetch;
  try {
    for (const [name, expected] of [...palaceCases, ...palaceCases.filter(([n]) => n !== '命宫').map(([n, t]) => [`${n}宫`, t]), ['交友', 'friends'], ['交友宫', 'friends']]) {
      const effects = [];
      const requests = [];
      globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response('data: [DONE]\n\n');
      };
      const hooks = {
        useState: initial => [initial, () => {}],
        useRef: initial => ({ current: initial }),
        useEffect: (callback, dependencies) => { effects.push({ callback, dependencies }); },
      };
      const Panel = loadSource('components/InsightPanel.tsx', { react: hooks }).default;
      const palace = { name, branch: 0, stars: [] };
      const birthInfo = { year: 2000, month: 2, day: 29, hour: 11, gender: 'female' };
      Panel({ chart: { birthInfo, palaces: [palace] }, selectedPalace: palace });
      // Run the real selected-palace effect; auto-overview is independently tested below.
      effects.find(e => e.dependencies?.length === 1 && e.dependencies[0] === palace).callback();
      assert.equal(requests.length, 1, name);
      assert.equal(requests[0].topic, expected, name);
      assert.deepEqual(requests[0].chart.birthInfo, birthInfo, name);
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { globalThis.fetch = savedFetch; }
});

test('interpret uses exact local data and handles unavailable free follow-ups without configuration leakage', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ziwei-route-'));
  const keys = ['ZIWEI_V4_DIR', 'MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_DEFAULT', 'AI_ENABLED', 'AI_DAILY_LIMIT', 'AI_QUOTA_FILE', 'AI_TIMEOUT_MS', 'AI_MAX_OUTPUT_TOKENS'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const topics = ['overview', 'personality', 'love', 'career', 'wealth', 'health', 'family', 'children', 'move', 'friends', 'home', 'spirit', 'parents'];
  const birth = { year: 2000, month: 2, day: 29, hour: 11, gender: 'female' };
  const rows = [birth, { ...birth, hour: 10 }].map(b => ({
    k: `2000-02-29-${b.hour}-female`, y: 2000, m: 2, d: 29, h: b.hour, g: b.gender,
    c: Object.fromEntries(topics.map(t => [t, `source-${b.hour}-${t}`])),
  }));
  const pack = brotliCompressSync(JSON.stringify(rows));
  writeFileSync(path.join(dir, '2000.pack'), pack);
  writeFileSync(path.join(dir, '2000.json'), JSON.stringify({ '2000-02-29': [0, pack.length] }));
  process.env.ZIWEI_V4_DIR = dir;
  delete process.env.MODEL_BASE_URL;
  delete process.env.MODEL_API_KEY;
  const { POST } = loadSource('app/api/interpret/route.ts');
  async function ask({ topic, mode, messages = [{ role: 'user', content: '请解读' }], b = birth } = {}) {
    const response = await POST(new Request('http://localhost/api/interpret', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chart: { birthInfo: b }, messages, ...(topic ? { topic } : {}), ...(mode ? { mode } : {}) }),
    }));
    const raw = await response.text();
    assert.match(raw, /data: \[DONE\]/);
    return raw.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)).delta.text).join('');
  }
  const followup = [{ role: 'user', content: '请解读' }, { role: 'assistant', content: '总览' }, { role: 'user', content: '明天穿什么颜色？' }];
  let server;
  try {
    for (const topic of topics) {
      assert.equal(await ask({ topic }), `source-11-${topic}`);
    }
    assert.match(await ask(), /^source-11-overview/);
    assert.match(await ask({ topic: 'wealth', b: { ...birth, hour: 10 } }), /^source-10-wealth/);
    assert.doesNotMatch(await ask({ b: { ...birth, hour: 9 } }), /source-|MODEL_/);
    const unsupported = await ask({ mode: 'ai', messages: followup });
    assert.match(unsupported, /主题/);
    assert.match(unsupported, /暂未开放/);
    assert.doesNotMatch(unsupported, /MODEL_|解读失败|source-|由模型|来自本地 v4 样本库/);
    process.env.MODEL_BASE_URL = 'http://127.0.0.1:1/v1';
    assert.equal(await ask({ mode: 'ai', messages: followup }), unsupported, 'base URL alone does not enable the model');
    delete process.env.MODEL_BASE_URL;
    process.env.MODEL_API_KEY = 'test-only';
    assert.equal(await ask({ mode: 'ai', messages: followup }), unsupported, 'API key alone does not enable the model');
    // A local HTTP model stub verifies the configured branch with no provider access.
    let modelRequest;
    let calls = 0;
    let providerError = false;
    server = createServer(async (req, res) => {
      calls++;
      let body = '';
      for await (const chunk of req) body += chunk;
      modelRequest = { url: req.url, body: JSON.parse(body) };
      if (providerError) { res.writeHead(500); res.end('secret-provider-detail'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"con');
      setTimeout(() => res.end('tent":"local-stub-answer"}}]}\n\ndata: [DONE]\n\n'), 5);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.MODEL_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
    process.env.MODEL_API_KEY = 'test-only';
    process.env.AI_ENABLED = 'true';
    process.env.AI_DAILY_LIMIT = '1';
    process.env.AI_QUOTA_FILE = path.join(dir, 'quota.json');
    process.env.MODEL_DEFAULT = 'gpt-6.1-terra';
    const oversized = await POST(new Request('http://localhost/api/interpret', { method: 'POST', body: 'x'.repeat(100001) }));
    assert.equal(oversized.status, 413);
    const unknown = await POST(new Request('http://localhost/api/interpret', { method: 'POST', body: JSON.stringify({ mode: 'unknown' }) }));
    assert.equal(unknown.status, 400);
    const longResponse = await POST(new Request('http://localhost/api/interpret', { method: 'POST', body: JSON.stringify({ mode: 'ai', chart: { birthInfo: birth }, messages: [...followup, { role: 'user', content: 'x'.repeat(4001) }] }) }));
    assert.equal(longResponse.status, 400);
    assert.equal(calls, 0);
    assert.equal(await ask({ topic: 'career' }), 'source-11-career');
    assert.equal(calls, 0);
    const answer = await ask({ mode: 'ai', messages: [...followup.slice(0, -1), { role: 'user', content: '我的事业如何？' }] });
    assert.match(answer, /^local-stub-answer/);
    assert.equal(modelRequest.body.model, 'gpt-6.1-terra');
    assert.equal(modelRequest.body.reasoning_effort, 'none');
    assert.equal(modelRequest.body.messages.at(-1).content, '我的事业如何？');
    assert.equal(modelRequest.body.messages.at(-2).content, '总览');
    assert.match(await ask({ mode: 'ai', messages: followup }), /额度已用完/);
    assert.equal(await ask({ topic: 'career' }), 'source-11-career');
    assert.equal(calls, 1);
    rmSync(process.env.AI_QUOTA_FILE);
    const concurrent = await Promise.all([ask({ mode: 'ai', messages: followup }), ask({ mode: 'ai', messages: followup })]);
    assert.equal(concurrent.filter(x => x.includes('local-stub-answer')).length, 1);
    assert.equal(concurrent.filter(x => x.includes('额度已用完')).length, 1);
    assert.equal(calls, 2);
    rmSync(process.env.AI_QUOTA_FILE);
    providerError = true;
    const failed = await ask({ mode: 'ai', messages: followup });
    assert.match(failed, /暂时不可用/);
    assert.doesNotMatch(failed, /secret-provider-detail|MODEL_|test-only/);
    assert.match(await ask({ mode: 'ai', messages: followup }), /额度已用完/);
    assert.equal(modelRequest.url, '/v1/chat/completions');
    assert.match(modelRequest.body.messages[1].content, /source-11-overview/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const source = fs.readFileSync(new URL('../docs/rpc.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function client() {
  const handlers = new Set(), timers = new Map(), frames = [], sent = [];
  let count = 0;
  const peer = { length: 0, postMessage: (...args) => sent.push(args) };
  const root = { length: 1, 0: peer };
  const window = { HF_CONNECTION: { gasUrl: 'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec' },
    addEventListener: (name, handler) => handlers.add(handler), removeEventListener: (name, handler) => handlers.delete(handler) };
  const context = vm.createContext({ window, crypto, URL, URLSearchParams, Uint8Array,
    location: { href: 'https://example.invalid/hf_test/exhibitor/', origin: 'https://example.invalid' },
    document: { body: { append: frame => frames.push(frame) }, createElement: () => ({ contentWindow: root, addEventListener() {}, remove() {} }) },
    setTimeout: (callback, ms) => { const id = ++count; timers.set(id, { callback, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context);
  const message = (data, origin = 'https://n-test-0lu-script.googleusercontent.com', sender = peer) => {
    for (const handler of handlers) handler({ data, origin, source: sender });
  };
  const ready = () => { const nonce = new URL(frames.at(-1).src).searchParams.get('nonce'); message({ channel: 'hf-rpc-v1', nonce, ready: true }); return nonce; };
  const tick = ms => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.callback(); } };
  return { window, frames, handlers, timers, sent, message, ready, tick, peer, root };
}
test('二重iframeのready・RPC応答を照合し、別窓・別origin・別nonce・未知の要求IDを拒否', async () => {
  const c = client(); let completed = false;
  const request = c.window.hfRpc('getMyProfile', 'private-token').then(result => { completed = true; return result; });
  const nonce = new URL(c.frames[0].src).searchParams.get('nonce');
  const hello = { channel: 'hf-rpc-v1', nonce, ready: true };
  c.message(hello, 'https://evil.invalid'); c.message(hello, undefined, { length: 0 }); c.message({ ...hello, nonce: 'bad' });
  await settle(); assert.equal(c.sent.length, 0);
  c.ready(); await settle(); assert.equal(c.sent.length, 1);
  const [message, origin] = c.sent[0]; assert.equal(origin, 'https://n-test-0lu-script.googleusercontent.com'); assert.equal(message.args[0], 'private-token');
  assert.doesNotMatch(c.frames[0].src, /private-token/);
  const response = { channel: 'hf-rpc-v1', nonce, id: message.id, result: { ok: true, data: { name: '本人' },
    performance: { totalMs: 50, stages: {}, cache: { jsonHit: 1, 'private-key': 2 } } } };
  c.message(response, 'https://evil.invalid'); c.message(response, undefined, c.root); c.message({ ...response, id: 'f'.repeat(32) });
  await settle(); assert.equal(completed, false);
  c.message(response); assert.equal((await request).data.name, '本人');
  c.message(response); assert.equal(c.timers.size, 0);
  const measurements = c.window.hfPerformance.snapshot();
  assert.deepEqual(Array.from(measurements, item => item.operation), ['bridge', 'getMyProfile']);
  assert.doesNotMatch(JSON.stringify(measurements), /private-token|本人|example|google/);
  assert.equal(measurements[1].cache.jsonHit, 1); assert.equal(measurements[1].cache['private-key'], undefined);
});
test('接続・応答のタイムアウトを成功扱いにせず、接続失敗後は新しいnonceで再試行', async () => {
  const c = client(); const first = c.window.hfRpc('getPublicCatalog'); const rejected = assert.rejects(first, error => error.network === true);
  const oldNonce = new URL(c.frames[0].src).searchParams.get('nonce'); c.tick(30000); await rejected; assert.equal(c.handlers.size, 0);
  const second = c.window.hfRpc('saveProfile', 'token', { requestId: 'fixed-request' }); const secondRejected = assert.rejects(second, error => error.network === true);
  const nonce = c.ready(); assert.notEqual(nonce, oldNonce); await settle();
  c.tick(60000); await secondRejected;
  assert.equal(c.sent.length, 1); assert.equal(c.sent[0][0].args[1].requestId, 'fixed-request');
});
test('未設定・別ホストの接続先を拒否してiframeを作らない', async () => {
  for (const url of ['', 'https://evil.invalid/macros/s/test/exec', 'https://script.google.com/macros/s/test/dev']) {
    const c = client(); c.window.HF_CONNECTION.gasUrl = url;
    await assert.rejects(c.window.hfRpc('getPublicCatalog'), error => error.network); assert.equal(c.frames.length, 0);
  }
});
test('GAS bridgeは許可したHPの最上位窓だけを受け付け、任意関数・重複実行を拒否', () => {
  const settings = { origin: 'https://example.invalid', nonce: 'a'.repeat(64) };
  const sent = [], calls = []; let listener, success;
  const top = { postMessage: (...args) => sent.push(args) };
  const runner = new Proxy({}, { get(_, method) {
    if (method === 'withSuccessHandler') return callback => { success = callback; return runner; };
    if (method === 'withFailureHandler') return () => runner;
    return (...args) => calls.push({ method, args });
  } });
  const html = fs.readFileSync(new URL('../gas/Bridge.html', import.meta.url), 'utf8');
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1].replace('<?!= settings ?>', JSON.stringify(settings)), {
    window: { top, addEventListener: (_, handler) => { listener = handler; } }, google: { script: { run: runner } }
  });
  assert.equal(sent[0][1], settings.origin);
  const data = { channel: 'hf-rpc-v1', nonce: settings.nonce, id: 'b'.repeat(32), method: 'saveProfile', args: ['token', {}] };
  const emit = (mutation = {}, origin = settings.origin, source = top) => listener({ data: { ...data, ...mutation }, origin, source });
  emit({}, 'https://evil.invalid'); emit({}, undefined, {}); emit({ nonce: 'bad' }); emit({ method: 'setupExperiment_' }); emit({ method: 'uploadPublicationImage' });
  assert.equal(calls.length, 0); emit(); emit(); assert.equal(calls.length, 1);
  success({ ok: true }); assert.equal(sent.length, 2); assert.equal(sent[1][0].id, data.id); assert.equal(sent[1][1], settings.origin);
});
test('GAS bridgeページはScript Propertiesのoriginとnonceを検証してから埋め込みを許可', () => {
  let allowed = false, template;
  const context = vm.createContext({ json_: JSON.parse,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => '["https://example.invalid"]' }) },
    HtmlService: { XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }, createHtmlOutput: text => ({ text }),
      createTemplateFromFile: () => { template = { evaluate: () => ({ setXFrameOptionsMode: () => { allowed = true; return {}; } }) }; return template; } } });
  vm.runInContext(fs.readFileSync(new URL('../gas/Transport.gs', import.meta.url), 'utf8'), context);
  context.bridgePage_({ origin: 'https://evil.invalid', nonce: 'a'.repeat(64) }); assert.equal(allowed, false);
  context.bridgePage_({ origin: 'https://example.invalid', nonce: '</script>' }); assert.equal(allowed, false);
  context.bridgePage_({ origin: 'https://example.invalid', nonce: 'a'.repeat(64) }); assert.equal(allowed, true);
  assert.equal(JSON.parse(template.settings).origin, 'https://example.invalid');
});

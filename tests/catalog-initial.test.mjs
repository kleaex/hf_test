import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { harness, saveRequest, book } from './gas-harness.mjs';
import { png, jpeg } from './image-fixtures.mjs';
import { validateCatalog } from '../docs/catalog-schema.mjs';

test('許可したカタログ接続だけに公開データを同梱し、scriptを終了させる文字をエスケープする', () => {
  const h = harness(); h.setup(); h.setupAdmin(); const a = h.login();
  const title = '</script><script>alert("x")</script>&\u2028\u2029end';
  assert.equal(h.call('saveProfile', a.token, saveRequest(a.data, { publications: [book({ title })] })).ok, true);
  const sheet = h.sheets.get('Exhibitors'); const state = JSON.parse(sheet.data[1][2]); state.internalMemo = 'PRIVATE_MEMO'; sheet.data[1][2] = JSON.stringify(state);
  let template, calls = 0;
  const context = vm.createContext({ json_: JSON.parse,
    api_: operation => { try { return { ok: true, ...operation() }; } catch (_) { return { ok: false }; } },
    timed_: (_, operation) => operation(),
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => '["https://example.invalid"]' }) },
    getPublicCatalog: () => { calls++; return h.call('getPublicCatalog'); },
    HtmlService: { XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }, createHtmlOutput: text => ({ text }),
      createTemplateFromFile: () => { template = { evaluate: () => ({ setXFrameOptionsMode: () => ({}) }) }; return template; } } });
  vm.runInContext(fs.readFileSync(new URL('../gas/Transport.gs', import.meta.url), 'utf8'), context);
  const parameters = { origin: 'https://example.invalid', nonce: 'a'.repeat(64) };
  context.bridgePage_({ ...parameters, origin: 'https://evil.invalid', initial: 'catalog' }); assert.equal(calls, 0);
  context.bridgePage_(parameters); assert.equal(calls, 0); assert.equal(JSON.parse(template.settings).initialCatalog, undefined);
  context.bridgePage_({ ...parameters, initial: 'catalog' }); assert.equal(calls, 1);
  const settings = JSON.parse(template.settings);
  assert.equal(settings.initialCatalog.data.exhibitors[0].publications[0].title, title);
  assert.doesNotMatch(template.settings, /<|>|&|\u2028|\u2029/);
  assert.doesNotMatch(template.settings, /PRIVATE_MEMO|authJson|token|fileId|receipts|userId|@example\.invalid/);
  const html = fs.readFileSync(new URL('../gas/Bridge.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace('<?!= settings ?>', template.settings);
  const sent = [];
  vm.runInNewContext(script, { window: { top: { postMessage: (...args) => sent.push(args) }, addEventListener() {} } });
  assert.equal(sent[0][0].initialCatalog.data.exhibitors[0].publications[0].title, title);
  assert.equal(sent[0][1], parameters.origin);
});

function imageFixture() {
  const h = harness(); h.setup(); h.setupAdmin(); const a = h.login();
  a.data = h.call('saveProfile', a.token, saveRequest(a.data, { publications: [book()] })).data;
  const staged = h.call('stagePublicationImage', a.token, { publicationId: a.data.publications[0].id,
    revision: a.data.revision, requestId: 'initial_preview_upload_12345', contentType: 'image/png', base64: png,
    thumbnail: { contentType: 'image/jpeg', base64: jpeg } });
  const id = staged.data.stagedImages[0].image.id;
  const request = saveRequest(staged.data); request.publications[0].imageIds = [id];
  h.call('saveProfile', a.token, request); h.properties.HF_PERFORMANCE = 'true';
  return { h, id };
}
test('初期応答に公開済みの小画像1点を同梱し、Drive内部情報を出さない', () => {
  const { h, id } = imageFixture(); const result = h.call('initialCatalog_');
  assert.equal(result.ok, true); assert.equal(result.initialImages.length, 1);
  assert.equal(result.initialImages[0].id, id); assert.equal(result.initialImages[0].base64, jpeg);
  assert.ok(result.initialImages[0].base64.length <= 40000);
  assert.equal(result.performance.stages.catalogPreview.count, 1);
  assert.doesNotMatch(JSON.stringify(result), /fileId|"hash"|authJson|token|receipts|private_image_folder/);
});
test('同梱画像の非公開状態を確認できない場合もカタログ本文を返す', () => {
  const { h } = imageFixture(); h.state.folderShared = true;
  const result = h.call('initialCatalog_'); assert.equal(result.ok, true);
  assert.equal(result.data.exhibitors.length, 1); assert.equal(result.initialImages.length, 0);
});
test('旧画像・大きな小画像を同梱せず、初期応答を重くしない', () => {
  for (const kind of ['legacy', 'large']) {
    const { h } = imageFixture(); const sheet = h.sheets.get('Exhibitors'); const state = JSON.parse(sheet.data[1][2]);
    if (kind === 'legacy') delete state.publications[0].images[0].thumbnail;
    else state.publications[0].images[0].thumbnail.bytes = 30001;
    sheet.data[1][2] = JSON.stringify(state); h.state.driveReadLocks = [];
    const result = h.call('initialCatalog_'); assert.equal(result.ok, true); assert.equal(result.initialImages.length, 0);
    assert.equal(h.state.driveReadLocks.length, 0);
  }
});

test('HPは同梱された本文と画像で表示し、追加のカタログ・小画像RPCを省く', async () => {
  for (const kind of ['valid', 'foreign', 'invalid']) {
    const { h, id } = imageFixture(); const response = h.call('initialCatalog_');
    if (kind === 'foreign') response.initialImages[0].id = 'img_' + 'f'.repeat(32);
    if (kind === 'invalid') response.initialImages[0].base64 = '<invalid>';
    class Element {
      constructor() { this.children = []; this.events = {}; this.value = ''; }
      append(...nodes) { this.children.push(...nodes); }
      replaceChildren(...nodes) { this.children = nodes; }
      addEventListener(name, handler) { this.events[name] = handler; }
      setAttribute(name, value) { this[name] = value; }
    }
    const elements = Object.fromEntries(['catalog', 'status', 'search', 'genre', 'publicationInfo', 'eventTitle', 'eventInfo', 'catalogNotice'].map(name => [name, new Element()]));
    const observed = new Set(), calls = []; let intersect, initialCalls = 0;
    class Observer {
      constructor(callback) { intersect = callback; }
      observe(node) { observed.add(node); }
      unobserve(node) { observed.delete(node); }
      disconnect() { observed.clear(); }
    }
    const script = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8').replace(/^import .*;$/m, '');
    vm.runInNewContext(script, { Blob, Uint8Array, atob, validateCatalog, IntersectionObserver: Observer,
      URL: { createObjectURL: () => 'blob:initial-preview', revokeObjectURL() {} },
      window: { HF_CONNECTION: { gasUrl: 'configured' }, addEventListener() {}, hfLoadCatalog: async () => { initialCalls++; return response; },
        hfRpc: async (name, ...args) => { calls.push(name); return h.call(name, ...args); } },
      document: { body: new Element(), getElementById: name => elements[name], createElement: () => new Element() }, console });
    const settle = () => new Promise(resolve => setImmediate(resolve)); await settle();
    assert.equal(initialCalls, 1); assert.equal(elements.catalog.children.length, 1); assert.equal(calls.length, 0);
    const button = [...observed][0]; intersect([{ target: button, isIntersecting: true }]); await settle();
    assert.equal(calls.includes('getPublicCatalog'), false);
    assert.deepEqual(calls, kind === 'valid' ? [] : ['getPublicImages']);
    assert.equal(button.children[0].src, 'blob:initial-preview'); assert.equal(response.data.exhibitors[0].publications[0].images[0].id, id);
  }
});

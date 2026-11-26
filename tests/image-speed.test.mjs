import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { harness, saveRequest, book } from './gas-harness.mjs';
import { png } from './image-fixtures.mjs';

test('公開画像3枚を1回のSheets一覧読取で選別し、Drive読取中は共通ロックを保持しない', () => {
  const h = harness(); h.setup(); const a = h.login();
  a.data = h.call('saveProfile', a.token, saveRequest(a.data, { publications: [book()] })).data;
  for (let i = 0; i < 3; i++) a.data = h.call('uploadPublicationImage', a.token, {
    publicationId: a.data.publications[0].id, revision: a.data.revision, requestId: crypto.randomUUID(), contentType: 'image/png', base64: png
  }).data;
  const ids = a.data.publications[0].images.map(image => image.id);
  h.state.sheetReads = {}; h.state.driveReadLocks = [];
  const result = h.call('getPublicImages', ids);
  assert.equal(result.ok, true); assert.equal(result.images.length, 3); assert.ok(result.images.every(image => image.ok));
  assert.equal(h.state.sheetReads.Exhibitors, 1); // ヘッダーと一覧を一括取得。
  assert.deepEqual(h.state.driveReadLocks, [false, false, false]);
  const mixed = h.call('getPublicImages', [ids[0], 'img_' + 'f'.repeat(32)]);
  assert.equal(mixed.images[0].ok, true); assert.equal(mixed.images[1].error.code, 'NOT_FOUND');
  assert.equal(h.call('getPublicImages', [...ids, 'img_' + 'f'.repeat(32)]).ok, false);
  assert.equal(h.call('getPublicImages', [ids[0], ids[0]]).ok, false);
  h.properties.HF_PUBLICATION_CONFIG_JSON = JSON.stringify({ title: 'hidden', exhibitors: [{ exhibitorId: 'exh_b', booth: '' }] });
  assert.equal(h.call('getPublicImages', [ids[0]]).images[0].error.code, 'NOT_FOUND');
});

const app = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8').replace(/^import .*;$/m, '').replace(/load\(\);\s*$/, '');
function imageClient(storage = new Map(), options = {}) {
  const calls = [];
  const caches = { open: async name => {
    if (options.blocked) throw Error('storage disabled');
    if (!storage.has(name)) storage.set(name, new Map()); const entries = storage.get(name);
    return { match: async key => entries.get(key)?.clone(), put: async (key, response) => entries.set(key, response.clone()),
      delete: async key => entries.delete(key), keys: async () => [...entries.keys()] };
  } };
  class ImageURL extends URL { static createObjectURL() { return 'blob:test-image'; } static revokeObjectURL() {} }
  const element = () => ({ append() {}, addEventListener() {}, removeAttribute() {} });
  const context = vm.createContext({ Blob, Uint8Array, atob, Response, URL: ImageURL,
    location: { href: 'https://example.invalid/hf_test/' },
    document: { getElementById: element, createElement: element, body: element() },
    window: { caches, HF_CONNECTION: { gasUrl: options.source || 'https://script.google.com/macros/s/source/exec' }, addEventListener() {},
      hfRpc: async (name, ...args) => {
        calls.push({ name, args });
        const image = { ok: true, contentType: 'image/png', base64: png };
        return name === 'getPublicImages' ? { images: args[0].map(id => ({ id, ...image })) } : image;
      } }
  });
  vm.runInContext(app, context);
  return { context, calls, data: (id, variant = 'thumbnail') => context.imageData(id, variant),
    written: () => vm.runInContext('cacheWrites', context) };
}
test('一覧画像3枚をまとめて取得し、同じ画像の重複取得を抑える', async () => {
  const client = imageClient(); const ids = ['a', 'b', 'c'].map(letter => 'img_' + letter.repeat(32));
  await Promise.all([...ids, ids[0]].map(id => client.data(id)));
  assert.equal(client.calls.length, 1); assert.equal(client.calls[0].name, 'getPublicImages');
  assert.deepEqual(Array.from(client.calls[0].args[0]), ids);
});
test('再読み込み後は保存画像を再利用し、保存不可・期限切れ・別接続先では通常取得する', async () => {
  const storage = new Map(), id = 'img_' + 'a'.repeat(32);
  const first = imageClient(storage); await first.data(id); await first.written();
  const reload = imageClient(storage); await reload.data(id); assert.equal(reload.calls.length, 0);
  const full = imageClient(storage); await full.data(id, 'full'); assert.equal(full.calls[0].name, 'getPublicImage');
  const other = imageClient(storage, { source: 'https://script.google.com/macros/s/another/exec' }); await other.data(id); assert.equal(other.calls.length, 1);
  const blocked = imageClient(new Map(), { blocked: true }); await blocked.data(id); assert.equal(blocked.calls.length, 1);
  await other.written(); await full.written();
  for (const entries of storage.values()) for (const [key, response] of entries) {
    entries.set(key, new Response(await response.blob(), { headers: { 'Content-Type': 'image/png', 'X-HF-Cached-At': '1' } }));
  }
  const expired = imageClient(storage); await expired.data(id); assert.equal(expired.calls.length, 1);
});
test('ブラウザー内の画像保存は小画像160点・拡大画像8点に制限する', async () => {
  const storage = new Map(), client = imageClient(storage);
  for (let i = 0; i < 9; i++) await client.data('img_' + i.toString(16).padStart(32, '0'), 'full');
  await client.written(); assert.equal(storage.get('hf-public-images-v1-full').size, 8);
});

test('最初の代表画像2枚は他画像と分け、クリックした拡大画像を待機中の一覧より優先する', async () => {
  const client = imageClient(); const id = letter => 'img_' + letter.repeat(32);
  await Promise.all([client.context.imageData(id('a'), 'thumbnail', true), client.context.imageData(id('b'), 'thumbnail', true), client.data(id('c'))]);
  assert.equal(client.calls.length, 3);
  for (const call of client.calls) assert.equal(call.args[0].length, 1);
  // 既に進行中の3要求は中断せず、次に空いた枠で拡大を先に送る。
  let active = 0; const finish = []; const calls = [];
  client.context.window.hfRpc = (name, ...args) => {
    calls.push({ name, args }); active++;
    return new Promise(resolve => finish.push(() => {
      active--; resolve(name === 'getPublicImages' ? { images: args[0].map(value => ({ id: value, ok: true, contentType: 'image/png', base64: png })) }
        : { ok: true, contentType: 'image/png', base64: png });
    }));
  };
  const pending = Array.from({ length: 12 }, (_, i) => client.data('img_' + i.toString(16).padStart(32, '0')));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(active, 3);
  const full = client.data(id('f'), 'full'); await new Promise(resolve => setImmediate(resolve));
  finish.shift()(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls[3].name, 'getPublicImage');
  while (finish.length) { finish.shift()(); await new Promise(resolve => setImmediate(resolve)); }
  await Promise.all([...pending, full]);
});

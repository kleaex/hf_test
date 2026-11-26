import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { harness, saveRequest, book } from './gas-harness.mjs';
import { png } from './image-fixtures.mjs';
import { validateCatalog } from '../docs/catalog-schema.mjs';
import { readRelease, installCatalog } from '../scripts/install-catalog.mjs';

function ready() {
  const h = harness(); h.setup(); const a = h.login();
  a.data = h.call('saveProfile', a.token, saveRequest(a.data, { publications: [book()] })).data;
  const input = { publicationId: a.data.publications[0].id, revision: a.data.revision,
    requestId: crypto.randomUUID(), contentType: 'image/png', base64: png };
  a.data = h.call('uploadPublicationImage', a.token, input).data;
  return { h, a };
}
const catalog = h => JSON.parse(h.state.zipEntries.find(entry => entry.name === 'catalog.json').bytes.toString('utf8'));
async function fixture(t) {
  const { h, a } = ready(); const result = h.call('exportCatalog_');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-catalog-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('hf-catalog-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const source = path.join(root, 'export'); await fs.mkdir(source);
  for (const entry of h.state.zipEntries) {
    await fs.mkdir(path.dirname(path.join(source, entry.name)), { recursive: true });
    await fs.writeFile(path.join(source, entry.name), entry.bytes);
  }
  const workspace = path.join(root, 'workspace'); await fs.mkdir(path.join(workspace, 'docs/data'), { recursive: true });
  for (const name of ['index.html', 'styles.css', 'app.js', 'catalog-schema.mjs', 'rpc.js', 'data/catalog.json']) await fs.copyFile(new URL('../docs/' + name, import.meta.url), path.join(workspace, 'docs', name));
  return { h, a, result, source, workspace, root };
}

test('明示した出店者と公開項目だけを画像付きで書き出し、非公開情報を混入させない', () => {
  const { h } = ready(); const state = JSON.parse(h.sheets.get('Exhibitors').data[1][2]);
  state.internalMemo = 'PRIVATE_MEMO'; state.profile.email = 'PRIVATE_EMAIL'; state.publications[0].payment = 'PRIVATE_PAYMENT';
  h.sheets.get('Exhibitors').data[1][2] = JSON.stringify(state);
  const result = h.call('exportCatalog_'); const data = catalog(h);
  assert.equal(result.exhibitorCount, 1); assert.equal(result.imageCount, 1); assert.equal(data.exhibitors[0].booth, 'A-01');
  assert.equal(data.exhibitors[0].id, 'exh_a'); assert.equal(data.sample, false);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_|exh_b|fileId|token|receipts|userId|imageBudget|"hash"/);
  validateCatalog(data, { releaseOnly: true });
  assert.equal(h.state.zipEntries.length, 3);
});

test('対象・設定・画像が不正ならZIPを作成せず、共有状態も変更しない', () => {
  const mutations = [
    h => { h.properties.HF_PUBLICATION_CONFIG_JSON = '{}'; },
    h => { h.properties.HF_PUBLICATION_CONFIG_JSON = JSON.stringify({ title: 'test', exhibitors: [{ exhibitorId: 'exh_missing', booth: '' }] }); },
    h => { h.properties.HF_PUBLICATION_CONFIG_JSON = JSON.stringify({ title: 'test', exhibitors: [{ exhibitorId: 'exh_a', booth: '1' }, { exhibitorId: 'exh_a', booth: '2' }] }); },
    h => { h.properties.HF_PUBLICATION_CONFIG_JSON = JSON.stringify({ title: 'test', exhibitors: [{ exhibitorId: 'exh_a', booth: '1' }, { exhibitorId: 'exh_b', booth: '1' }] }); },
    h => { h.state.exportFolderShared = true; },
    h => { h.properties.HF_EXPORT_FOLDER_ID = h.properties.HF_IMAGE_FOLDER_ID; },
    h => { [...h.files.values()][0].shared = true; },
    h => { [...h.files.values()][0].data = { getBytes: () => [0] }; }
  ];
  for (const mutate of mutations) {
    const { h } = ready(); const count = h.files.size; mutate(h);
    assert.throws(() => h.call('exportCatalog_')); assert.equal(h.files.size, count); assert.equal(h.state.zipEntries.length, 0);
  }
});

test('書出しは不変の別版になり、編集中・期限後とも明示操作で実行できる', () => {
  const { h } = ready(); const first = h.call('exportCatalog_'); const before = catalog(h);
  h.properties.HF_EDIT_DEADLINE = '';
  const next = h.call('exportCatalog_'); assert.notEqual(first.releaseId, next.releaseId);
  const after = JSON.parse(JSON.stringify(catalog(h).exhibitors).replaceAll(next.releaseId, first.releaseId));
  assert.deepEqual(before.exhibitors, after);
});

test('確認用取り込みでは公開対象を変更せず、適用時だけ現行カタログを切り替える', async t => {
  const f = await fixture(t); const active = path.join(f.workspace, 'docs/data/catalog.json');
  const original = await fs.readFile(active);
  const preview = await installCatalog(f.source, { workspace: f.workspace });
  assert.deepEqual(await fs.readFile(active), original);
  assert.match(preview.directory, /catalog-preview/);
  const previewData = JSON.parse(await fs.readFile(path.join(preview.directory, 'data/catalog.json'), 'utf8'));
  assert.equal(previewData.releaseId, f.result.releaseId);
  const result = await installCatalog(f.source, { mode: 'apply', workspace: f.workspace });
  assert.equal(JSON.parse(await fs.readFile(active, 'utf8')).releaseId, result.releaseId);
  await readRelease(path.join(f.workspace, 'docs/data/releases', result.releaseId));
});

test('画像欠落・改変・余分な私的ファイル・不正な参照は取り込まない', async t => {
  const f = await fixture(t); const image = f.h.state.zipEntries.find(entry => entry.name.startsWith('images/'));
  const imagePath = path.join(f.source, image.name);
  await fs.writeFile(imagePath, 'corrupt'); await assert.rejects(readRelease(f.source));
  await fs.writeFile(imagePath, image.bytes);
  await fs.writeFile(path.join(f.source, '.env'), 'private'); await assert.rejects(readRelease(f.source));
  await fs.unlink(path.join(f.source, '.env'));
  await fs.unlink(imagePath); await assert.rejects(readRelease(f.source));
});

test('反映先の書込不能・余分なファイルがあっても現行カタログを変更しない', async t => {
  const f = await fixture(t); const active = path.join(f.workspace, 'docs/data/catalog.json');
  const before = await fs.readFile(active);
  const target = path.join(f.workspace, 'docs/data/releases', f.result.releaseId);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'images'), 'blocked');
  await assert.rejects(installCatalog(f.source, { mode: 'apply', workspace: f.workspace }));
  assert.deepEqual(await fs.readFile(active), before);
  await fs.unlink(path.join(target, 'images'));
  await fs.writeFile(path.join(target, 'private.txt'), 'private');
  await assert.rejects(installCatalog(f.source, { mode: 'apply', workspace: f.workspace }), /余分なファイル/);
  assert.deepEqual(await fs.readFile(active), before);
});

test('外部URL・パストラバーサル・非公開フィールドを公開スキーマで拒否', () => {
  const { h } = ready(); h.call('exportCatalog_'); const data = catalog(h);
  for (const mutate of [
    copy => { copy.exhibitors[0].email = 'private'; },
    copy => { copy.exhibitors[0].publications[0].images[0].src = 'https://example.invalid/image.png'; },
    copy => { copy.exhibitors[0].publications[0].images[0].src = './data/releases/' + copy.releaseId + '/images/../secret.png'; },
    copy => { copy.exhibitors[0].publications[0].images[0].width = 0; },
    copy => { copy.exhibitors[0].publications[0].price = -1; }
  ]) { const copy = structuredClone(data); mutate(copy); assert.throws(() => validateCatalog(copy)); }
});

test('既存版の内容衝突で現行を変更せず、保存済み旧版へ戻せる', async t => {
  const f = await fixture(t); const active = path.join(f.workspace, 'docs/data/catalog.json');
  await installCatalog(f.source, { mode: 'apply', workspace: f.workspace }); const first = await fs.readFile(active);
  const record = JSON.parse(f.h.sheets.get('Exhibitors').data[1][2]); record.profile.name = '第二版';
  f.h.sheets.get('Exhibitors').data[1][2] = JSON.stringify(record); const second = f.h.call('exportCatalog_');
  for (const entry of f.h.state.zipEntries) await fs.writeFile(path.join(f.source, entry.name), entry.bytes);
  await installCatalog(f.source, { mode: 'apply', workspace: f.workspace });
  assert.equal(JSON.parse(await fs.readFile(active, 'utf8')).releaseId, second.releaseId);
  const previous = path.join(f.workspace, 'docs/data/releases', f.result.releaseId);
  await installCatalog(previous, { mode: 'apply', workspace: f.workspace }); assert.deepEqual(await fs.readFile(active), first);
  const manifest = JSON.parse(await fs.readFile(path.join(f.source, 'manifest.json'), 'utf8'));
  const data = JSON.parse(await fs.readFile(path.join(f.source, 'catalog.json'), 'utf8')); data.title = '改変';
  const bytes = Buffer.from(JSON.stringify(data)); await fs.writeFile(path.join(f.source, 'catalog.json'), bytes);
  const entry = manifest.files.find(item => item.path === 'catalog.json'); entry.bytes = bytes.length; entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(f.source, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(installCatalog(f.source, { mode: 'apply', workspace: f.workspace }), /同じ公開版ID/);
  assert.deepEqual(await fs.readFile(active), first);
});

function publicClient(data, failFetch = false) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.value = ''; this.events = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, handler) { this.events[name] = handler; }
  }
  const elements = Object.fromEntries(['catalog', 'status', 'search', 'genre', 'publicationInfo', 'eventTitle', 'eventInfo', 'catalogNotice'].map(id => [id, new Element('div')]));
  const document = { body: new Element('body'), getElementById: id => elements[id], createElement: tag => new Element(tag) };
  return { elements, document, context: vm.createContext({ document, window: { addEventListener() {} }, validateCatalog, console: { error() {} },
    fetch: async () => ({ ok: !failFetch, json: async () => data }) }) };
}

test('公開画面で画像と3点目までのリンク・タイトル・検索を扱い、HTMLを文字として表示', async () => {
  const { h } = ready(); h.call('exportCatalog_'); const data = catalog(h);
  data.exhibitors[0].description = '<script>private()</script>';
  // 追加画像は独立した安全な参照にする。
  const first = data.exhibitors[0].publications[0].images[0];
  data.exhibitors[0].publications[0].images.push({ ...first, src: first.src.replace(/img_[a-f0-9]{32}/, 'img_' + 'b'.repeat(32)) });
  data.exhibitors[0].publications[0].images.push({ ...first, src: first.src.replace(/img_[a-f0-9]{32}/, 'img_' + 'c'.repeat(32)) });
  const client = publicClient(data);
  const source = (await fs.readFile(new URL('../docs/app.js', import.meta.url), 'utf8')).replace(/^import .*;$/m, '');
  vm.runInContext(source, client.context); await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.elements.catalog.children.length, 1); assert.equal(client.elements.eventTitle.textContent, data.title);
  const all = node => [node, ...node.children.flatMap(all)]; const nodes = all(client.elements.catalog);
  assert.equal(nodes.filter(node => node.tag === 'img').length, 3);
  assert.ok(nodes.some(node => node.textContent === '<script>private()</script>'));
  client.elements.search.value = 'not found'; client.elements.search.events.input();
  assert.equal(client.elements.catalog.children.length, 0); assert.match(client.elements.status.textContent, /ありません/);
  const bad = publicClient(data, true); vm.runInContext(source, bad.context); await new Promise(resolve => setImmediate(resolve));
  assert.match(bad.elements.status.textContent, /読み込めません/);
});

test('既存サンプルの2組・4作品とジャンル絞り込みを維持する', async () => {
  const data = JSON.parse(await fs.readFile(new URL('../docs/data/catalog.json', import.meta.url), 'utf8'));
  const client = publicClient(data);
  const source = (await fs.readFile(new URL('../docs/app.js', import.meta.url), 'utf8')).replace(/^import .*;$/m, '');
  vm.runInContext(source, client.context); await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.elements.catalog.children.length, 2);
  const all = node => [node, ...node.children.flatMap(all)];
  assert.equal(all(client.elements.catalog).filter(node => node.className === 'book').length, 4);
  client.elements.genre.value = '短歌'; client.elements.genre.events.change();
  assert.equal(client.elements.catalog.children.length, 1);
});

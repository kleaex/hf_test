import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { harness, saveRequest, book } from './gas-harness.mjs';
import { clientHarness } from './client-harness.mjs';
import { png, jpeg } from './image-fixtures.mjs';
import { validateCatalog } from '../docs/catalog-schema.mjs';

function ready() {
  const h = harness(); h.setup(); h.setupAdmin(); const a = h.login();
  a.data = h.call('saveProfile', a.token, saveRequest(a.data, { publications: [book()] })).data;
  return { h, a };
}
function stage(h, a) {
  const request = { publicationId: a.data.publications[0].id, revision: a.data.revision,
    requestId: crypto.randomUUID(), contentType: 'image/png', base64: png,
    thumbnail: { contentType: 'image/jpeg', base64: jpeg } };
  const result = h.call('stagePublicationImage', a.token, request); assert.equal(result.ok, true, JSON.stringify(result));
  return { request, result, image: result.data.stagedImages.at(-1).image };
}
test('仮保存は公開されず、最終保存で作品と画像が一緒に公開される', () => {
  const { h, a } = ready(); const staged = stage(h, a);
  assert.equal(h.call('getPublicCatalog').data.exhibitors[0].publications[0].images.length, 0);
  assert.equal(h.call('getPublicImage', staged.image.id, 'full').error.code, 'NOT_FOUND');
  assert.equal(h.call('getPublicationImage', a.token, staged.image.id).ok, true);
  const input = saveRequest(staged.result.data); input.publications[0].imageIds = [staged.image.id]; input.publications[0].title = '保存して公開';
  const saved = h.call('saveProfile', a.token, input); assert.equal(saved.ok, true);
  const data = h.call('getPublicCatalog').data; validateCatalog(data, { allowLive: true });
  assert.equal(data.exhibitors[0].publications[0].title, '保存して公開');
  assert.equal(data.exhibitors[0].publications[0].images[0].id, staged.image.id);
  assert.equal(saved.data.stagedImages.length, 0);
  const full = h.call('getPublicImage', staged.image.id, 'full');
  const small = h.call('getPublicImage', staged.image.id, 'thumbnail');
  assert.equal(full.contentType, 'image/png'); assert.equal(small.contentType, 'image/jpeg');
  assert.notEqual(full.base64, small.base64);
  assert.doesNotMatch(JSON.stringify(data), /fileId|drive\.google|token|receipts|staged|authJson|email|"hash"/);
  assert.throws(() => validateCatalog(data, { releaseOnly: true }));
});
test('新規作品も画像を仮保存してから1回の最終保存で作成できる', () => {
  const { h, a } = ready(); const draftId = 'draft_' + 'd'.repeat(32);
  const request = { publicationId: draftId, revision: a.data.revision, requestId: crypto.randomUUID(),
    contentType: 'image/png', base64: png, thumbnail: { contentType: 'image/jpeg', base64: jpeg } };
  const staged = h.call('stagePublicationImage', a.token, request); assert.equal(staged.ok, true);
  const imageId = staged.data.stagedImages[0].image.id;
  assert.equal(h.call('getPublicCatalog').data.exhibitors[0].publications.length, 1);
  const input = saveRequest(staged.data); input.publications.push(book({ draftId, imageIds: [imageId] }));
  const duplicate = { ...input, requestId: crypto.randomUUID(), publications: [...input.publications, book({ draftId, imageIds: [imageId] })] };
  assert.equal(h.call('saveProfile', a.token, duplicate).error.code, 'VALIDATION');
  const saved = h.call('saveProfile', a.token, input); assert.equal(saved.ok, true);
  assert.match(saved.data.publications[1].id, /^pub_[a-f0-9]{32}$/);
  assert.equal(saved.data.publications[1].images[0].id, imageId);
  assert.equal(h.call('getPublicImage', imageId, 'thumbnail').ok, true);
  assert.doesNotMatch(JSON.stringify(h.call('getPublicCatalog')), /draft_/);
});
test('最終保存の失敗では公開状態を変えず、応答喪失の再送で二重登録しない', () => {
  const { h, a } = ready(); const staged = stage(h, a);
  const input = saveRequest(staged.result.data); input.publications[0].imageIds = [staged.image.id];
  h.state.failWrite = 'Exhibitors'; assert.equal(h.call('saveProfile', a.token, input).ok, false);
  assert.equal(h.call('getPublicImage', staged.image.id, 'full').ok, false);
  h.state.failAfterWrite = 'Exhibitors'; assert.equal(h.call('saveProfile', a.token, input).ok, false);
  assert.equal(h.call('saveProfile', a.token, input).replayed, true);
  assert.equal(h.call('getPublicCatalog').data.exhibitors[0].publications[0].images.length, 1);
});
test('仮保存のSheets失敗・応答喪失から同じ要求を再送しても2ファイルだけ', () => {
  for (const failure of ['failWrite', 'failAfterWrite']) {
    const { h, a } = ready();
    const request = { publicationId: a.data.publications[0].id, revision: a.data.revision, requestId: crypto.randomUUID(),
      contentType: 'image/png', base64: png, thumbnail: { contentType: 'image/jpeg', base64: jpeg } };
    h.state[failure] = 'Exhibitors'; assert.equal(h.call('stagePublicationImage', a.token, request).ok, false);
    assert.equal(h.files.size, 2);
    const result = h.call('stagePublicationImage', a.token, request); assert.equal(result.ok, true);
    assert.equal(h.files.size, 2); assert.equal(result.data.stagedImages.length, 1);
  }
});
test('仮保存の他者利用・別作品流用・期限後の確定・不正なサムネイルを拒否', () => {
  const { h, a } = ready(); const staged = stage(h, a); const b = h.login('b@example.invalid');
  assert.equal(h.call('getPublicationImage', b.token, staged.image.id).error.code, 'FORBIDDEN');
  b.data = h.call('saveProfile', b.token, saveRequest(b.data, { publications: [book()] })).data;
  const foreign = saveRequest(b.data); foreign.publications[0].imageIds = [staged.image.id];
  assert.equal(h.call('saveProfile', b.token, foreign).error.code, 'FORBIDDEN');
  const other = saveRequest(staged.result.data, { publications: [...staged.result.data.publications, book()] });
  const next = h.call('saveProfile', a.token, other).data;
  const swapped = saveRequest(next); swapped.publications[1].imageIds = [staged.image.id];
  assert.equal(h.call('saveProfile', a.token, swapped).error.code, 'FORBIDDEN');
  const invalid = { ...staged.request, requestId: crypto.randomUUID(), revision: next.revision, thumbnail: { contentType: 'image/svg+xml', base64: png } };
  assert.equal(h.call('stagePublicationImage', a.token, invalid).ok, false);
  h.tick(86400001); const fresh = h.login();
  const expired = saveRequest(fresh.data); expired.publications[0].imageIds = [staged.image.id];
  assert.equal(h.call('saveProfile', fresh.token, expired).error.code, 'FORBIDDEN');
});
test('非公開化・画像削除は次の公開取得から有効、編集終了後は仮保存も拒否', () => {
  const { h, a } = ready(); const staged = stage(h, a);
  const input = saveRequest(staged.result.data); input.publications[0].imageIds = [staged.image.id];
  const saved = h.call('saveProfile', a.token, input);
  const admin = h.loginAdmin(); const dashboard = h.call('getAdminDashboard', admin.token).data;
  const settings = { revision: dashboard.revision, requestId: crypto.randomUUID(), title: dashboard.title,
    eventDate: dashboard.eventDate, venue: dashboard.venue, editDeadline: dashboard.editDeadline,
    exhibitors: dashboard.exhibitors.map(item => ({ exhibitorId: item.exhibitorId, booth: item.booth, publish: false })) };
  assert.equal(h.call('saveAdminEvent', admin.token, settings).ok, true);
  const empty = h.call('getPublicCatalog').data; validateCatalog(empty, { allowLive: true }); assert.equal(empty.exhibitors.length, 0);
  assert.equal(h.call('getPublicImage', staged.image.id, 'full').error.code, 'NOT_FOUND');
  const remove = saveRequest(saved.data); remove.publications[0].imageIds = [];
  assert.equal(h.call('saveProfile', a.token, remove).ok, true);
  const latest = h.call('getMyProfile', a.token).data;
  // EventSettingsを直接終了扱いにするのはテスト内だけ。
  const sheet = h.sheets.get('EventSettings'); const state = JSON.parse(sheet.data[1][1]); state.editDeadline = ''; sheet.data[1][1] = JSON.stringify(state);
  assert.equal(h.call('stagePublicationImage', a.token, { ...staged.request, requestId: crypto.randomUUID(), revision: latest.revision }).error.code, 'EDIT_CLOSED');
});
test('HP編集画面は仮保存中の文章を保ち、最終保存で公開する', async () => {
  const { h, a } = ready(); let drop = true;
  const client = clientHarness((name, ...args) => {
    const result = h.call(name, ...args);
    if (name === 'stagePublicationImage' && drop) { drop = false; throw { network: true, message: 'lost' }; }
    return result;
  }, new Map([['hf_test.exhibitorSession.v1', a.token]]), { hpRole: 'exhibitor',
    createImageBitmap: async () => ({ width: 2, height: 2, close() {} }),
    canvas: () => ({ getContext: () => ({ drawImage() {}, fillRect() {} }), toBlob: (callback, type) => callback(new Blob([Buffer.from(type === 'image/jpeg' ? jpeg : png, 'base64')], { type })) }) });
  await client.settle(); client.elements.name.value = '未保存の紹介';
  await client.event('fields', 'input');
  const card = client.elements.books.children[0]; const upload = card.querySelectorAll('input').find(item => item.type === 'file');
  upload.files = [new Blob([Buffer.from(png, 'base64')], { type: 'image/png' })];
  await client.event(upload, 'change'); await client.settle();
  await client.event('uploadImage'); await client.event('uploadImage');
  assert.equal(client.elements.name.value, '未保存の紹介');
  const requests = client.calls.filter(item => item.name === 'stagePublicationImage'); assert.equal(requests.length, 2); assert.deepEqual(requests[0].args, requests[1].args);
  assert.equal(h.call('getPublicCatalog').data.exhibitors[0].name, '架空A');
  assert.equal(h.call('getPublicCatalog').data.exhibitors[0].publications[0].images.length, 0);
  await client.event('profileForm', 'submit');
  const data = h.call('getPublicCatalog').data; assert.equal(data.exhibitors[0].name, '未保存の紹介'); assert.equal(data.exhibitors[0].publications[0].images.length, 1);
  const all = node => [node, ...node.children.flatMap(all)];
  const previews = all(client.elements.books).filter(node => node.tagName === 'img');
  assert.equal(previews.length, 1); assert.equal(previews[0].hidden, false); assert.match(previews[0].src, /^data:image\/png;base64,/);
  assert.equal(client.calls.some(item => item.name === 'getPublicationImage'), false);
});
test('HP運営画面はZIP確認操作なしで保存し、公開対象の変更を反映', async () => {
  const { h } = ready(); const admin = h.loginAdmin();
  const client = clientHarness(h.call, new Map([['hf_test.adminSession.v1', admin.token]]), { hpRole: 'admin' }); await client.settle();
  assert.equal(client.elements.dashboard.hidden, false); client.elements.title.value = '新しい開催名';
  await client.event('eventForm', 'submit');
  assert.equal(h.call('getPublicCatalog').data.title, '新しい開催名');
  assert.equal(client.calls.some(item => /preview|export/.test(item.name)), false);
  const html = fs.readFileSync(new URL('../docs/admin/index.html', import.meta.url), 'utf8'); assert.doesNotMatch(html, /href="https:\/\/drive|id="export"|id="preview"/);
});
test('HP画面とbridgeのJavaScriptは構文が有効で接続情報に秘密値を持たない', () => {
  for (const name of ['exhibitor/index.html', 'admin/index.html']) {
    const html = fs.readFileSync(new URL('../docs/' + name, import.meta.url), 'utf8');
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(script[1]));
  }
  const config = fs.readFileSync(new URL('../docs/connection.js', import.meta.url), 'utf8'); assert.doesNotMatch(config, /HF_AUTH_SECRET|HF_SPREADSHEET_ID|HF_IMAGE_FOLDER_ID/);
});

test('公開HPは小画像を遅延取得し、クリック時だけ原寸画像をHP内に表示する', async () => {
  const { h, a } = ready(); const staged = stage(h, a); const input = saveRequest(staged.result.data);
  input.publications[0].imageIds = [staged.image.id]; h.call('saveProfile', a.token, input);
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.value = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    addEventListener(name, callback) { this.events[name] = callback; }
    showModal() { this.open = true; }
    close() { this.open = false; this.events.close(); }
  }
  const elements = Object.fromEntries(['catalog', 'status', 'search', 'genre', 'publicationInfo', 'eventTitle', 'eventInfo', 'catalogNotice'].map(id => [id, new Element('div')]));
  const body = new Element('body'), calls = [], observed = new Set(); let intersect;
  class Observer {
    constructor(callback) { intersect = callback; }
    observe(element) { observed.add(element); }
    unobserve(element) { observed.delete(element); }
    disconnect() { observed.clear(); }
  }
  const source = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8').replace(/^import .*;$/m, '');
  vm.runInNewContext(source, { validateCatalog, Blob, Uint8Array, atob, IntersectionObserver: Observer,
    URL: { createObjectURL: () => 'blob:local-image', revokeObjectURL() {} },
    window: { HF_CONNECTION: { gasUrl: 'configured' }, addEventListener() {}, hfRpc: async (name, ...args) => { calls.push({ name, args }); return h.call(name, ...args); } },
    document: { body, createElement: tag => new Element(tag), getElementById: id => elements[id] },
    fetch: () => { throw Error('static fallback must not run'); }, console });
  const settle = () => new Promise(resolve => setImmediate(resolve)); await settle();
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'getPublicCatalog'); assert.equal(observed.size, 1);
  const button = [...observed][0]; intersect([{ target: button, isIntersecting: true }]); await settle();
  assert.equal(calls[1].name, 'getPublicImages'); assert.deepEqual(Array.from(calls[1].args[0]), [staged.image.id]); assert.equal(button.children[0].src, 'blob:local-image');
  await button.events.click(); await settle(); assert.equal(calls[2].args[1], 'full');
  const dialog = body.children[0]; assert.equal(dialog.open, true); assert.equal(dialog.children[2].src, 'blob:local-image');
  assert.equal(button.href, undefined); dialog.children[0].events.click(); assert.equal(dialog.open, false);
});

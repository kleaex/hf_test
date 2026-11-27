import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { harness, saveRequest, book } from './gas-harness.mjs';
import { clientHarness } from './client-harness.mjs';
import { png, jpeg } from './image-fixtures.mjs';
import { validateCatalog } from '../docs/catalog-schema.mjs';

function ready() {
  const h = harness(); h.setup(); h.setupAdmin(); const a = h.login(), admin = h.loginAdmin();
  a.data = h.call('saveProfile', a.token, saveRequest(a.data, { publications: [book()] })).data;
  return { h, a, admin };
}
const activate = (h, admin) => assert.equal(h.call('rebuildPublicCatalog', admin.token).ok, true);
function adminRequest(data, overrides = {}) {
  return { revision: data.revision, requestId: crypto.randomUUID(), title: data.title, eventDate: data.eventDate,
    venue: data.venue, editDeadline: data.editDeadline, publicationMode: data.publicationMode,
    exhibitors: data.exhibitors.map(({ exhibitorId, booth, publish }) => ({ exhibitorId, booth, publish })), ...overrides };
}

test('永続版はキャッシュ消失・時間経過後も完成本文だけを1回で読み、正本を読み直さない', () => {
  const { h, admin } = ready(); const before = h.call('getPublicCatalog').data;
  activate(h, admin); h.properties.HF_PERFORMANCE = 'true';
  h.tick(60001); h.state.cacheEnabled = true; h.cache.clear(); h.state.sheetReads = {};
  const result = h.call('getPublicCatalog'); assert.equal(result.ok, true); validateCatalog(result.data, { allowLive: true });
  assert.deepEqual(result.data, before); assert.deepEqual(h.state.sheetReads, { PublicSnapshots: 1 });
  assert.equal(result.performance.stages.snapshotRead.count, 1); assert.equal(result.performance.stages.catalogBuild, undefined);
  h.state.sheetReads = {}; assert.equal(h.call('getPublicCatalog').ok, true); assert.deepEqual(h.state.sheetReads, {});
  assert.doesNotMatch(JSON.stringify(result.data), /authJson|email|token|receipts|fileId|test_image_folder/);
});

test('保存時に永続版を更新し、再送で作品を重複させず、仮保存だけでは公開版を変えない', () => {
  const { h, a, admin } = ready(); activate(h, admin);
  const key = Object.keys(h.properties).find(key => key.startsWith('HF_PUBLIC_SNAPSHOT_'));
  const original = h.properties[key];
  const staged = h.call('stagePublicationImage', a.token, { publicationId: a.data.publications[0].id,
    revision: a.data.revision, requestId: crypto.randomUUID(), contentType: 'image/png', base64: png,
    thumbnail: { contentType: 'image/jpeg', base64: jpeg } });
  assert.equal(staged.ok, true); assert.equal(h.properties[key], original);
  const request = saveRequest(staged.data, { profile: { name: '公開版を更新', genre: '', description: '' } });
  request.publications[0].imageIds = [staged.data.stagedImages[0].image.id];
  const saved = h.call('saveProfile', a.token, request); assert.equal(saved.ok, true);
  const data = h.call('getPublicCatalog').data; assert.equal(data.exhibitors[0].name, '公開版を更新');
  assert.equal(data.exhibitors[0].publications[0].images.length, 1);
  const manifest = h.properties[key]; const replay = h.call('saveProfile', a.token, request);
  assert.equal(replay.replayed, true); assert.equal(h.properties[key], manifest);
  h.state.sheetReads = {};
  const image = h.call('getPublicImage', request.publications[0].imageIds[0], 'thumbnail');
  assert.equal(image.ok, true); assert.equal(image.base64, jpeg);
  assert.deepEqual(h.state.sheetReads, { PublicSnapshots: 1 });
  assert.doesNotMatch(JSON.stringify(data), /fileId|hash|thumbnail|test_image_folder/);
});

test('公開版書込失敗では旧本文・旧画像を返さず、同じ保存の再送で公開まで復旧する', () => {
  for (const fail of ['failWrite', 'failAfterWrite', 'manifest']) {
    const { h, a, admin } = ready(); activate(h, admin); h.state.cacheEnabled = true;
    h.call('getPublicCatalog');
    const request = saveRequest(a.data, { publications: [], profile: { name: '保存は完了', genre: '', description: '' } });
    if (fail === 'manifest') h.state.failProperty = Object.keys(h.properties).find(key => key.startsWith('HF_PUBLIC_SNAPSHOT_'));
    else h.state[fail] = 'PublicSnapshots';
    const result = h.call('saveProfile', a.token, request); assert.equal(result.error.code, 'PUBLICATION_PENDING');
    assert.equal(h.call('getMyProfile', a.token).data.profile.name, '保存は完了');
    assert.equal(h.call('getPublicCatalog').error.code, 'PUBLICATION_PENDING');
    assert.equal(h.call('getPublicImage', 'img_' + 'a'.repeat(32), 'full').error.code, 'PUBLICATION_PENDING');
    h.state.failProperty = null;
    const retry = h.call('saveProfile', a.token, request); assert.equal(retry.ok, true); assert.equal(retry.replayed, true);
    assert.equal(retry.data.revision, a.data.revision + 1);
    assert.equal(h.call('getPublicCatalog').data.exhibitors[0].name, '保存は完了');
  }
});

test('非公開化の生成失敗で旧キャッシュを返さず、再試行後も画像を非公開にする', () => {
  const { h, a, admin } = ready();
  const image = h.call('uploadPublicationImage', a.token, { publicationId: a.data.publications[0].id,
    revision: a.data.revision, requestId: crypto.randomUUID(), contentType: 'image/png', base64: png }).data.publications[0].images[0].id;
  activate(h, admin); h.state.cacheEnabled = true; h.call('getPublicCatalog'); h.call('getPublicImage', image, 'full');
  const data = h.call('getAdminDashboard', admin.token).data;
  const request = adminRequest(data, { exhibitors: data.exhibitors.map(x => ({ exhibitorId: x.exhibitorId, booth: x.booth, publish: false })) });
  h.state.failWrite = 'PublicSnapshots'; assert.equal(h.call('saveAdminEvent', admin.token, request).error.code, 'PUBLICATION_PENDING');
  assert.equal(h.call('getPublicCatalog').error.code, 'PUBLICATION_PENDING');
  assert.equal(h.call('getPublicImage', image, 'full').error.code, 'PUBLICATION_PENDING');
  assert.equal(h.call('saveAdminEvent', admin.token, request).replayed, true);
  assert.equal(h.call('getPublicCatalog').data.exhibitors.length, 0);
  assert.equal(h.call('getPublicImage', image, 'full').error.code, 'NOT_FOUND');
});

test('自動公開の登録確定で公開版を更新し、未確認の登録は含めない', () => {
  const { h, admin } = ready();
  assert.equal(h.call('saveAdminEvent', admin.token, adminRequest(admin.data, { publicationMode: 'automatic' })).ok, true);
  activate(h, admin);
  assert.equal(h.call('requestRegistrationCode', '新しい出店', 'new@example.invalid').ok, true);
  assert.equal(h.call('getPublicCatalog').data.exhibitors.length, 2);
  const result = h.call('verifyRegistrationCode', '新しい出店', 'new@example.invalid', h.code('new@example.invalid'));
  assert.equal(result.ok, true); const data = h.call('getPublicCatalog').data;
  assert.ok(data.exhibitors.some(x => x.id === result.data.exhibitorId));
});

test('大きいUnicode本文は分割保存でき、破損時は正本への無断フォールバックをせず運営だけが復旧できる', () => {
  const { h, a, admin } = ready();
  const publications = Array.from({ length: 10 }, () => book({ description: '📚'.repeat(999) }));
  assert.equal(h.call('saveProfile', a.token, saveRequest(a.data, { publications })).ok, true);
  activate(h, admin); const first = h.call('getPublicCatalog').data;
  const sheet = h.sheets.get('PublicSnapshots'); assert.ok(sheet.data.length > 3);
  sheet.data[1][4] = 'json:PRIVATE_CORRUPTION';
  const broken = h.call('getPublicCatalog'); assert.equal(broken.error.code, 'PUBLICATION_PENDING'); assert.doesNotMatch(JSON.stringify(broken), /PRIVATE_CORRUPTION/);
  assert.equal(h.call('rebuildPublicCatalog', a.token).error.code, 'UNAUTHENTICATED');
  activate(h, admin); assert.deepEqual(h.call('getPublicCatalog').data, first);
  const length = sheet.data.length; activate(h, admin); assert.equal(sheet.data.length, length);
});

test('運営画面から有効化・再生成でき、公開反映待ちでも同じ設定保存を保持して再送する', async () => {
  const { h, admin } = ready();
  const client = clientHarness(h.call, new Map([['hf_test.adminSession.v1', admin.token]]), { hpRole: 'admin' });
  await client.settle(); await client.event('rebuildCatalog', 'click'); assert.ok(h.sheets.has('PublicSnapshots'));
  client.elements.title.value = '再試行する開催名'; await client.event('fields', 'input');
  h.state.failWrite = 'PublicSnapshots'; await client.event('eventForm', 'submit');
  assert.match(client.elements.result.textContent, /公開反映が完了していません/);
  assert.equal(client.elements.fields.disabled, true); assert.match(client.elements.save.textContent, /再試行/);
  await client.event('eventForm', 'submit'); assert.equal(client.elements.fields.disabled, false);
  assert.equal(h.call('getPublicCatalog').data.title, '再試行する開催名');
});

test('出店者画面でも公開反映待ちの保存要求を保持し、同じ要求で復旧する', async () => {
  const { h, a, admin } = ready(); activate(h, admin);
  for (const options of [{ hpRole: 'exhibitor' }, {}]) {
    const client = clientHarness(h.call, new Map([['hf_test.exhibitorSession.v1', a.token]]), options);
    await client.settle();
    client.elements.name.value = '出店者による再試行'; await client.event('fields', 'input');
    h.state.failWrite = 'PublicSnapshots'; await client.event('profileForm', 'submit');
    assert.equal(client.elements.fields.disabled, true); assert.match(client.elements.save.textContent, /再試行/);
    await client.event('profileForm', 'submit'); assert.equal(client.elements.fields.disabled, false);
    assert.equal(h.call('getPublicCatalog').data.exhibitors[0].name, '出店者による再試行');
  }
});

test('開催回別の公開版・更新世代を保持し、別開催回の再生成で以前の版を壊さない', () => {
  const { h, admin } = ready(); activate(h, admin); const first = h.call('getPublicCatalog').data;
  const event = JSON.parse(h.sheets.get('EventSettings').data[1][1]);
  event.title = '次回の開催'; event.exhibitors = [];
  h.sheets.get('EventSettings').data.push(['edition_two', JSON.stringify(event)]);
  const original = h.properties.HF_EVENT_ID; h.properties.HF_EVENT_ID = 'edition_two';
  h.tick(60001); const secondAdmin = h.loginAdmin(); activate(h, secondAdmin);
  assert.equal(h.call('getPublicCatalog').data.title, '次回の開催');
  activate(h, secondAdmin);
  h.properties.HF_EVENT_ID = original;
  assert.deepEqual(h.call('getPublicCatalog').data, first);
});

test('登録後の公開反映失敗でもログインでき、プロフィール保存で反映を復旧できる', () => {
  const { h, admin } = ready();
  assert.equal(h.call('saveAdminEvent', admin.token, adminRequest(admin.data, { publicationMode: 'automatic' })).ok, true);
  activate(h, admin);
  h.call('requestRegistrationCode', '登録する出店', 'new@example.invalid');
  h.state.failWrite = 'PublicSnapshots';
  const result = h.call('verifyRegistrationCode', '登録する出店', 'new@example.invalid', h.code('new@example.invalid'));
  assert.equal(result.error.code, 'PUBLICATION_PENDING');
  h.tick(60001); const user = h.login('new@example.invalid'); assert.equal(user.ok, true);
  assert.equal(h.call('getPublicCatalog').error.code, 'PUBLICATION_PENDING');
  assert.equal(h.call('saveProfile', user.token, saveRequest(user.data)).ok, true);
  assert.ok(h.call('getPublicCatalog').data.exhibitors.some(x => x.id === user.data.exhibitorId));
});

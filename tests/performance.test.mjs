import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { harness, saveRequest, book } from './gas-harness.mjs';
import { png, jpeg } from './image-fixtures.mjs';

function ready() {
  const h = harness(); h.setup(); h.setupAdmin(); const a = h.login();
  a.data = h.call('saveProfile', a.token, saveRequest(a.data, { publications: [book()] })).data;
  return { h, a };
}
const upload = a => ({ publicationId: a.data.publications[0].id, revision: a.data.revision, requestId: crypto.randomUUID(),
  contentType: 'image/png', base64: png, thumbnail: { contentType: 'image/jpeg', base64: jpeg } });
const readCount = h => Object.values(h.state.sheetReads).reduce((sum, count) => sum + count, 0);

test('カタログ10組でもSheets読取は2回、共有キャッシュ命中時は0回', () => {
  const { h } = ready(); const rows = h.sheets.get('Exhibitors').data;
  const eventSheet = h.sheets.get('EventSettings'); const state = JSON.parse(eventSheet.data[1][1]);
  for (let i = 0; i < 8; i++) rows.push(['exh_extra_' + i, h.properties.HF_EVENT_ID, JSON.stringify({ revision: 0,
    profile: { name: '架空追加', genre: '', description: '' }, publications: [], receipts: [] })]);
  state.exhibitors = rows.slice(1).map(row => ({ exhibitorId: row[0], booth: '', publish: true }));
  eventSheet.data[1][1] = JSON.stringify(state); h.state.cacheEnabled = true; h.state.sheetReads = {};
  assert.equal(h.call('getPublicCatalog').data.exhibitors.length, 10); assert.equal(readCount(h), 2);
  h.state.sheetReads = {}; assert.equal(h.call('getPublicCatalog').data.exhibitors.length, 10); assert.equal(readCount(h), 0);
});
test('保存失敗・応答喪失・キャッシュ障害時も古い公開内容を保存成功後に返さない', () => {
  const { h, a } = ready(); h.state.cacheEnabled = true;
  h.call('getPublicCatalog'); const input = saveRequest(a.data, { profile: { ...a.data.profile, name: '新しい保存' } });
  h.state.failWrite = 'Exhibitors'; assert.equal(h.call('saveProfile', a.token, input).ok, false);
  assert.equal(h.call('getPublicCatalog').data.exhibitors[0].name, a.data.profile.name);
  h.state.failAfterWrite = 'Exhibitors'; assert.equal(h.call('saveProfile', a.token, input).ok, false);
  assert.equal(h.call('getPublicCatalog').data.exhibitors[0].name, '新しい保存');
  assert.equal(h.call('saveProfile', a.token, input).replayed, true);
  h.state.cacheFails = true; assert.equal(h.call('getPublicCatalog').data.exhibitors[0].name, '新しい保存');
  h.state.cacheFails = false; h.state.failProperty = 'HF_PUBLIC_GENERATION';
  const current = h.call('getMyProfile', a.token).data;
  assert.equal(h.call('saveProfile', a.token, saveRequest(current, { profile: { ...current.profile, name: '失敗する保存' } })).ok, false);
  assert.equal(h.call('getPublicCatalog').data.exhibitors[0].name, '新しい保存');
});
test('共有キャッシュの一部消失・有効期限・Unicodeを扱い、必要なら正本から再構築', () => {
  const { h, a } = ready(); h.state.cacheEnabled = true;
  const publications = Array.from({ length: 10 }, () => book({ description: '📚'.repeat(999) }));
  assert.equal(h.call('saveProfile', a.token, saveRequest(a.data, { publications })).ok, true);
  const first = h.call('getPublicCatalog').data; const warm = h.call('getPublicCatalog').data; assert.deepEqual(warm, first);
  for (const [key, entry] of h.cache) {
    assert.ok(Buffer.byteLength(entry.value, 'utf8') < 100000);
    assert.equal(entry.value, Buffer.from(entry.value, 'utf8').toString('utf8'));
    if (key.includes(':')) { h.cache.delete(key); break; }
  }
  h.state.sheetReads = {}; assert.deepEqual(h.call('getPublicCatalog').data, first); assert.equal(readCount(h), 2);
  h.tick(60001); h.state.sheetReads = {}; assert.equal(h.call('getPublicCatalog').ok, true); assert.equal(readCount(h), 2);
});
test('画像の公開索引と小画像を共有し、非公開化・共有変更・Drive改変を拒否', () => {
  const { h, a } = ready(); const admin = h.loginAdmin();
  const staged = h.call('stagePublicationImage', a.token, upload(a));
  const id = staged.data.stagedImages[0].image.id; const input = saveRequest(staged.data); input.publications[0].imageIds = [id];
  h.call('saveProfile', a.token, input); h.state.cacheEnabled = true;
  const first = h.call('getPublicImages', [id]); assert.equal(first.images[0].ok, true);
  h.state.sheetReads = {}; h.state.driveReadLocks = [];
  assert.deepEqual(h.call('getPublicImages', [id]), first); assert.equal(readCount(h), 0); assert.equal(h.state.driveReadLocks.length, 0);
  h.state.folderShared = true; assert.equal(h.call('getPublicImages', [id]).images[0].error.code, 'IMAGE_CONFIG'); h.state.folderShared = false;
  const small = [...h.files.values()].find(file => file.name.endsWith('.thumbnail'));
  small.modifiedAt = 2; const data = small.data; small.data = { getBytes: () => [0] };
  assert.equal(h.call('getPublicImages', [id]).images[0].error.code, 'IMAGE_INVALID'); small.data = data;
  const event = h.call('getAdminDashboard', admin.token).data;
  assert.equal(h.call('saveAdminEvent', admin.token, { revision: event.revision, requestId: crypto.randomUUID(), title: event.title,
    eventDate: event.eventDate, venue: event.venue, editDeadline: event.editDeadline,
    exhibitors: event.exhibitors.map(item => ({ exhibitorId: item.exhibitorId, booth: item.booth, publish: false })) }).ok, true);
  assert.equal(h.call('getPublicImages', [id]).images[0].error.code, 'NOT_FOUND'); assert.equal(h.call('getPublicCatalog').data.exhibitors.length, 0);
});
test('画像変換・Drive保存中はロックせず、同じ出店者の二重アップロードだけを予約で防ぐ', () => {
  const { h, a } = ready(); const request = upload(a); let concurrent;
  h.state.beforeDecode = () => {
    assert.equal(h.state.locked, false); assert.equal(h.call('getPublicCatalog').ok, true);
    concurrent = h.call('stagePublicationImage', a.token, request);
  };
  h.state.decodeLocks = []; h.state.createLocks = [];
  const result = h.call('stagePublicationImage', a.token, request);
  assert.equal(result.ok, true); assert.equal(concurrent.error.code, 'BUSY'); assert.equal(h.files.size, 2);
  assert.deepEqual(h.state.decodeLocks, [false, false]); assert.deepEqual(h.state.createLocks, [false, false]);
  assert.equal(Object.keys(h.properties).some(key => key.startsWith('HF_UPLOAD_')), false);
  assert.equal(h.call('stagePublicationImage', a.token, request).replayed, true); assert.equal(h.files.size, 2);
});
test('変換中の他画面保存・ログアウト・停止・締切変更を確定時に再検証', () => {
  const scenarios = [
    ['CONFLICT', (h, a) => h.call('saveProfile', a.token, saveRequest(a.data))],
    ['UNAUTHENTICATED', (h, a) => h.call('logout', a.token)],
    ['UNAUTHENTICATED', h => { h.sheets.get('Users').data[1][2] = false; }],
    ['EDIT_CLOSED', h => { const sheet = h.sheets.get('EventSettings'); const state = JSON.parse(sheet.data[1][1]); state.editDeadline = ''; sheet.data[1][1] = JSON.stringify(state); }]
  ];
  for (const [code, change] of scenarios) {
    const { h, a } = ready(); h.state.beforeDecode = () => change(h, a);
    const result = h.call('stagePublicationImage', a.token, upload(a));
    assert.equal(result.error.code, code); assert.equal(JSON.parse(h.sheets.get('Exhibitors').data[1][2]).stagedImages?.length || 0, 0);
    assert.equal(Object.keys(h.properties).some(key => key.startsWith('HF_UPLOAD_')), false);
  }
});
test('計測は固定した処理名・時間・回数のみを返し、入力や接続先を含めない', () => {
  const { h, a } = ready(); h.properties.HF_PERFORMANCE = 'true';
  const result = h.call('stagePublicationImage', a.token, upload(a)); assert.equal(result.ok, true);
  assert.equal(result.performance.stages.imageValidate.count, 1); assert.equal(result.performance.stages.thumbnailValidate.count, 1);
  assert.equal(result.performance.stages.imageAuthorize.count, 1); assert.equal(result.performance.stages.imageCommit.count, 1);
  assert.doesNotMatch(JSON.stringify(result.performance), /file_|test_2026|example|base64|token|spreadsheet|lease/);
  delete h.properties.HF_PERFORMANCE; assert.equal(h.call('getPublicCatalog').performance, undefined);
});

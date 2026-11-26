import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { harness, saveRequest, book } from './gas-harness.mjs';
import { clientHarness } from './client-harness.mjs';
import { validateCatalog } from '../docs/catalog-schema.mjs';
import { png } from './image-fixtures.mjs';

function ready() { const h = harness(); h.setup(); h.setupAdmin(); return h; }
function settings(data, overrides = {}) {
  return { revision: data.revision, requestId: crypto.randomUUID(), title: data.title, eventDate: data.eventDate,
    venue: data.venue, editDeadline: data.editDeadline, publicationMode: data.publicationMode,
    exhibitors: data.exhibitors.map(({ exhibitorId, booth, publish }) => ({ exhibitorId, booth, publish })), ...overrides };
}
function setMode(h, admin, mode) {
  const data = h.call('getAdminDashboard', admin.token).data;
  const result = h.call('saveAdminEvent', admin.token, settings(data, { publicationMode: mode }));
  assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
}
function ids(h) { const result = h.call('getPublicCatalog'); assert.equal(result.ok, true); return result.data.exhibitors.map(x => x.id); }
function register(h, email = 'new@example.invalid') {
  h.call('requestRegistrationCode', '架空の新規出店', email);
  return h.call('verifyRegistrationCode', '架空の新規出店', email, h.code(email));
}

test('既存のモード未設定環境は運営承認となり、既存の公開対象を維持する', () => {
  const h = ready(); const sheet = h.sheets.get('EventSettings'); const state = JSON.parse(sheet.data[1][1]);
  delete state.publicationMode; sheet.data[1][1] = JSON.stringify(state);
  const admin = h.loginAdmin(); assert.equal(admin.data.publicationMode, 'approval');
  assert.deepEqual(ids(h), ['exh_a']);
  h.setupAdmin(); assert.deepEqual(ids(h), ['exh_a']);
});

test('自動公開の再構築は必要な4シートだけ読み、セッション一覧を読まない', () => {
  const h = ready(); const admin = h.loginAdmin(); setMode(h, admin, 'automatic');
  h.state.cacheEnabled = true; h.state.sheetReads = {};
  // セッション一覧がなくても、公開本文・画像索引の構築には不要。
  h.sheets.delete('Sessions');
  assert.deepEqual(ids(h), ['exh_a', 'exh_b']);
  assert.deepEqual(h.state.sheetReads, { EventSettings: 1, Users: 1, Memberships: 1, Exhibitors: 1 });
  h.state.sheetReads = {}; assert.deepEqual(ids(h), ['exh_a', 'exh_b']);
  assert.deepEqual(h.state.sheetReads, {});
});

test('自動公開は登録済み・新規OTP確認後の出店を掲載し、承認へ戻すと以前のチェックを使う', () => {
  const h = ready(); const admin = h.loginAdmin(); setMode(h, admin, 'automatic');
  assert.deepEqual(ids(h), ['exh_a', 'exh_b']);
  const newUser = register(h); assert.equal(newUser.ok, true); assert.equal(newUser.data.publicationMode, 'automatic');
  assert.ok(ids(h).includes(newUser.data.exhibitorId));
  setMode(h, admin, 'approval'); assert.deepEqual(ids(h), ['exh_a']);
  const data = h.call('getAdminDashboard', admin.token).data;
  data.exhibitors.find(x => x.exhibitorId === newUser.data.exhibitorId).publish = true;
  assert.equal(h.call('saveAdminEvent', admin.token, settings(data)).ok, true);
  const saved = h.call('saveProfile', newUser.token, saveRequest(newUser.data, { profile: { name: '承認後の変更', description: '', genre: '' } }));
  assert.equal(saved.ok, true);
  assert.equal(h.call('getPublicCatalog').data.exhibitors.find(x => x.id === newUser.data.exhibitorId).name, '承認後の変更');
});

test('自動公開でもOTP未確認・登録途中・利用停止・所属解除・別開催回は掲載しない', () => {
  const h = ready(); const admin = h.loginAdmin(); setMode(h, admin, 'automatic');
  h.call('requestRegistrationCode', '架空の新規出店', 'new@example.invalid');
  assert.deepEqual(ids(h), ['exh_a', 'exh_b']);
  h.state.failAfterWrite = 'Memberships';
  assert.equal(h.call('verifyRegistrationCode', '架空の新規出店', 'new@example.invalid', h.code('new@example.invalid')).ok, false);
  // 出店者・所属の書込後に失敗し、公開キャッシュが作られた場合でも、最終確定後には失効する。
  h.state.cacheEnabled = true;
  assert.deepEqual(ids(h), ['exh_a', 'exh_b']);
  const completed = h.call('verifyRegistrationCode', '架空の新規出店', 'new@example.invalid', h.code('new@example.invalid'));
  assert.equal(completed.ok, true); assert.ok(ids(h).includes(completed.data.exhibitorId));
  h.state.cacheEnabled = false;
  h.sheets.get('Users').data[1][2] = false;
  assert.ok(!ids(h).includes('exh_a'));
  h.sheets.get('Memberships').data[2][3] = false;
  assert.ok(!ids(h).includes('exh_b'));
  h.sheets.get('Exhibitors').data.at(-1)[1] = 'other_event';
  assert.deepEqual(ids(h), []);
});

test('モード変更は本文・画像のキャッシュを失効し、承認されていない出店の画像を非公開に戻す', () => {
  const h = ready(); const admin = h.loginAdmin(); const b = h.login('b@example.invalid');
  const saved = h.call('saveProfile', b.token, saveRequest(b.data, { publications: [book()] }));
  const uploaded = h.call('uploadPublicationImage', b.token, { publicationId: saved.data.publications[0].id,
    revision: saved.data.revision, requestId: crypto.randomUUID(), contentType: 'image/png', base64: png });
  const image = uploaded.data.publications[0].images[0].id;
  h.state.cacheEnabled = true; assert.deepEqual(ids(h), ['exh_a']);
  setMode(h, admin, 'automatic'); assert.ok(ids(h).includes('exh_b'));
  assert.equal(h.call('getPublicImage', image, 'full').ok, true);
  setMode(h, admin, 'approval'); assert.deepEqual(ids(h), ['exh_a']);
  assert.equal(h.call('getPublicImage', image, 'full').error.code, 'NOT_FOUND');
});

test('公開モードは運営だけが変更でき、不正値・競合・要求ID流用を拒否し再送は同じ結果', () => {
  const h = ready(); const admin = h.loginAdmin(); const user = h.login();
  const input = settings(admin.data, { publicationMode: 'automatic' });
  assert.equal(h.call('saveAdminEvent', user.token, input).error.code, 'UNAUTHENTICATED');
  assert.equal(h.call('saveAdminEvent', admin.token, { ...input, publicationMode: 'unknown' }).error.code, 'VALIDATION');
  const saved = h.call('saveAdminEvent', admin.token, input); assert.equal(saved.ok, true);
  assert.equal(h.call('saveAdminEvent', admin.token, input).replayed, true);
  assert.equal(h.call('saveAdminEvent', admin.token, { ...input, publicationMode: 'approval' }).error.code, 'REQUEST_REUSED');
  assert.equal(h.call('saveAdminEvent', admin.token, settings(admin.data)).error.code, 'CONFLICT');
  const legacy = settings(saved.data); delete legacy.publicationMode;
  assert.equal(h.call('saveAdminEvent', admin.token, legacy).data.publicationMode, 'automatic');
});

test('自動公開で出店が10組を超えてもライブカタログと運営設定を保存できる', () => {
  const h = ready(); const admin = h.loginAdmin(); setMode(h, admin, 'automatic');
  for (let i = 0; i < 9; i++) assert.equal(register(h, `new${i}@example.invalid`).ok, true);
  const catalog = h.call('getPublicCatalog'); assert.equal(catalog.ok, true); assert.equal(catalog.data.exhibitors.length, 11);
  validateCatalog(catalog.data, { allowLive: true });
  const data = h.call('getAdminDashboard', admin.token).data;
  assert.equal(h.call('saveAdminEvent', admin.token, settings(data)).ok, true);
});

test('HPと旧GASの運営画面でモード保存・承認欄切替・再読込を行える', async () => {
  for (const options of [{ hpRole: 'admin' }, { htmlFile: 'AdminIndex.html' }]) {
    const h = ready(); const admin = h.loginAdmin(); const storage = new Map([['hf_test.adminSession.v1', admin.token]]);
    const client = clientHarness(h.call, storage, options); await client.settle();
    assert.equal(client.elements.publicationMode.value, 'approval');
    const approved = client.elements.exhibitors.querySelectorAll('[data-key]').find(x => x.dataset.key === 'publish');
    assert.equal(approved.disabled, false);
    client.elements.publicationMode.value = 'automatic'; await client.event('publicationMode', 'change');
    assert.equal(approved.disabled, true); assert.deepEqual(ids(h), ['exh_a']);
    await client.event('eventForm', 'submit'); assert.deepEqual(ids(h), ['exh_a', 'exh_b']);
    const restored = clientHarness(h.call, storage, options); await restored.settle();
    assert.equal(restored.elements.publicationMode.value, 'automatic');
    restored.elements.publicationMode.value = 'approval'; await restored.event('publicationMode', 'change');
    await restored.event('eventForm', 'submit'); assert.deepEqual(ids(h), ['exh_a']);
  }
});

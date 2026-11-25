import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { harness, saveRequest, book } from './gas-harness.mjs';
import { clientHarness } from './client-harness.mjs';
import { png } from './image-fixtures.mjs';

function ready() { const h = harness(); h.setup(); h.setupAdmin(); return h; }
function error(result, code) { assert.equal(result.ok, false); assert.equal(result.error.code, code); }
function settings(data, overrides = {}) {
  return { revision: data.revision, requestId: crypto.randomUUID(), title: data.title, eventDate: data.eventDate,
    venue: data.venue, editDeadline: data.editDeadline,
    exhibitors: data.exhibitors.map(item => ({ exhibitorId: item.exhibitorId, booth: item.booth, publish: item.publish })), ...overrides };
}
function source(h) {
  const a = h.login();
  a.data = h.call('saveProfile', a.token, saveRequest(a.data, { publications: [book()] })).data;
  a.data = h.call('uploadPublicationImage', a.token, { publicationId: a.data.publications[0].id, revision: a.data.revision,
    requestId: crypto.randomUUID(), contentType: 'image/png', base64: png }).data;
  return a;
}

test('運営初期設定は既存の公開設定・編集期限を移行し、再実行で上書きしない', () => {
  const h = ready(); const admin = h.loginAdmin();
  assert.equal(admin.ok, true); assert.equal(admin.data.exhibitors[0].publish, true);
  assert.equal(admin.data.exhibitors[0].booth, 'A-01'); assert.equal(admin.data.exhibitors[1].publish, false);
  const saved = h.call('saveAdminEvent', admin.token, settings(admin.data, { title: '画面で設定', editDeadline: '' }));
  h.properties.HF_PUBLICATION_CONFIG_JSON = '{"title":"旧設定","exhibitors":[]}';
  h.properties.HF_EDIT_DEADLINE = '2099-01-01T00:00:00Z'; h.setupAdmin();
  assert.equal(h.call('getAdminDashboard', admin.token).data.title, saved.data.title);
  assert.equal(h.call('getSystemStatus').editable, false); assert.equal(h.sheets.get('Admins').data.length, 2);
});

test('出店者登録なしの運営が認証でき、出店者セッションで全運営APIを使えない', () => {
  const h = ready(); const a = h.login(); const admin = h.loginAdmin();
  assert.equal(admin.ok, true); assert.equal(h.sheets.get('Users').data.some(row => row[1] === 'ops@example.invalid'), false);
  for (const [method, payload] of [['getAdminDashboard'], ['saveAdminEvent', {}], ['previewAdminCatalog'],
    ['exportAdminCatalog', {}], ['getAdminImage', 'image'], ['logoutAdmin']]) error(h.call(method, a.token, payload), 'UNAUTHENTICATED');
  error(h.call('getMyProfile', admin.token), 'UNAUTHENTICATED');
  const response = h.call('requestAdminLoginCode', 'a@example.invalid'); assert.equal(response.ok, true);
  assert.equal(h.state.mail.filter(item => item.to === 'a@example.invalid').length, 1);
  assert.doesNotMatch(JSON.stringify(admin.data), /authJson|tokenHash|emailHash|receipts|adminId/);
});

test('運営のコードは一度限り・最大5回入力で、出店者用コードと混用しない', () => {
  const h = ready(); h.call('requestAdminLoginCode', 'ops@example.invalid'); const code = h.code('ops@example.invalid');
  const wrong = code === '000000' ? '111111' : '000000';
  for (let index = 0; index < 5; index++) error(h.call('verifyAdminLoginCode', 'ops@example.invalid', wrong), 'INVALID_CODE');
  error(h.call('verifyAdminLoginCode', 'ops@example.invalid', code), 'INVALID_CODE');
  h.tick(60001); const admin = h.loginAdmin(); assert.equal(admin.ok, true);
  error(h.call('verifyAdminLoginCode', 'ops@example.invalid', h.code('ops@example.invalid')), 'INVALID_CODE');
  h.properties.HF_TEST_EMAILS = '["ops@example.invalid", "a@example.invalid"]';
  error(h.call('verifyLoginCode', 'ops@example.invalid', h.code('ops@example.invalid')), 'INVALID_CODE');
});

test('運営セッションの期限・ログアウト・停止・宛先除外をすべての呼出しで確認', () => {
  for (const mutate of [
    (h, admin) => h.call('logoutAdmin', admin.token),
    h => { h.tick(3600000); }, h => { h.sheets.get('Admins').data[1][2] = false; },
    h => { h.properties.HF_ADMIN_EMAILS = '["other@example.invalid"]'; },
    h => { h.properties.HF_AUTH_SECRET = 'rotated-test-secret-for-admin-12345678901234567890'; }
  ]) {
    const h = ready(); const admin = h.loginAdmin(); mutate(h, admin);
    error(h.call('getAdminDashboard', admin.token), 'UNAUTHENTICATED');
    error(h.call('saveAdminEvent', admin.token, settings(admin.data)), 'UNAUTHENTICATED');
  }
});

test('運営設定の保存は更新番号・再送を扱い、重複ブース・他開催回・不正項目を拒否', () => {
  const h = ready(); const admin = h.loginAdmin(); const input = settings(admin.data, { title: '保存済み', eventDate: '2026-12-20', venue: '架空会場' });
  const first = h.call('saveAdminEvent', admin.token, input); assert.equal(first.ok, true); assert.equal(first.data.revision, 1);
  assert.equal(h.call('saveAdminEvent', admin.token, input).replayed, true);
  error(h.call('saveAdminEvent', admin.token, settings(admin.data)), 'CONFLICT');
  error(h.call('saveAdminEvent', admin.token, { ...input, title: '別内容' }), 'REQUEST_REUSED');
  const invalid = settings(first.data); invalid.exhibitors[1].booth = invalid.exhibitors[0].booth;
  error(h.call('saveAdminEvent', admin.token, invalid), 'VALIDATION');
  error(h.call('saveAdminEvent', admin.token, settings(first.data, { exhibitors: [{ exhibitorId: 'exh_unknown', booth: '', publish: true }] })), 'FORBIDDEN');
  error(h.call('saveAdminEvent', admin.token, settings(first.data, { role: 'owner' })), 'VALIDATION');
});

test('運営画面の期限設定が出店者の保存可否へ反映され、空欄なら停止する', () => {
  const h = ready(); const admin = h.loginAdmin(); const a = h.login();
  const stopped = h.call('saveAdminEvent', admin.token, settings(admin.data, { editDeadline: '' }));
  error(h.call('saveProfile', a.token, saveRequest(a.data)), 'EDIT_CLOSED');
  assert.equal(h.call('getMyProfile', a.token).data.editable, false);
  h.call('saveAdminEvent', admin.token, settings(stopped.data, { editDeadline: '2026-12-31T23:59:59+09:00' }));
  assert.equal(h.call('saveProfile', a.token, saveRequest(a.data)).ok, true);
});

test('運営のプレビューはZIPを作らず、対象の画像も認証付きで確認できる', () => {
  const h = ready(); const a = source(h); const admin = h.loginAdmin(); const count = h.files.size;
  const preview = h.call('previewAdminCatalog', admin.token); assert.equal(preview.ok, true);
  assert.equal(h.files.size, count); assert.equal(preview.catalog.exhibitors.length, 1);
  assert.doesNotMatch(JSON.stringify(preview.catalog), /fileId|hash|receipt|token/);
  assert.equal(h.call('getAdminImage', admin.token, a.data.publications[0].images[0].id).ok, true);
  error(h.call('getAdminImage', admin.token, 'img_unknown'), 'FORBIDDEN');
});

test('プレビュー後の作品更新・設定更新・10分経過で書き出しを拒否', () => {
  for (const mode of ['source', 'settings', 'expiry']) {
    const h = ready(); const a = source(h); const admin = h.loginAdmin(); const preview = h.call('previewAdminCatalog', admin.token);
    const count = h.files.size;
    if (mode === 'source') h.call('saveProfile', a.token, saveRequest(a.data, { profile: { ...a.data.profile, name: '変更後' } }));
    if (mode === 'settings') h.call('saveAdminEvent', admin.token, settings(admin.data, { title: '変更後' }));
    if (mode === 'expiry') h.tick(600000);
    error(h.call('exportAdminCatalog', admin.token, { previewId: preview.previewId, requestId: crypto.randomUUID() }), 'PREVIEW_STALE');
    assert.equal(h.files.size, count);
  }
});

test('未確認の書き出しを拒否し、確認済み内容を書き出して履歴に残す', () => {
  const h = ready(); const admin = h.loginAdmin();
  error(h.call('exportAdminCatalog', admin.token, { previewId: 'not-reviewed', requestId: crypto.randomUUID() }), 'PREVIEW_STALE');
  const preview = h.call('previewAdminCatalog', admin.token);
  const input = { previewId: preview.previewId, requestId: crypto.randomUUID() };
  const exported = h.call('exportAdminCatalog', admin.token, input); assert.equal(exported.ok, true);
  assert.match(exported.release.fileUrl, /^https:\/\/drive\.google\.com\/file\/d\//);
  assert.equal(h.call('getAdminDashboard', admin.token).data.releases.length, 1);
  assert.equal(h.call('exportAdminCatalog', admin.token, input).replayed, true); assert.equal(h.files.size, 1);
});

test('書き出し後のSheets失敗・応答喪失から再送してもZIPを重複作成しない', () => {
  for (const mode of ['failWrite', 'failAfterWrite']) {
    const h = ready(); const admin = h.loginAdmin(); const preview = h.call('previewAdminCatalog', admin.token);
    const input = { previewId: preview.previewId, requestId: crypto.randomUUID() }; h.state[mode] = 'EventSettings';
    error(h.call('exportAdminCatalog', admin.token, input), 'UNAVAILABLE'); assert.equal(h.files.size, 1);
    const result = h.call('exportAdminCatalog', admin.token, input); assert.equal(result.ok, true);
    assert.equal(h.files.size, 1); assert.equal(h.call('getAdminDashboard', admin.token).data.releases.length, 1);
  }
});

async function adminClient(h, backend = h.call, storage = new Map()) {
  const client = clientHarness(backend, storage, { htmlFile: 'AdminIndex.html' }); await client.settle();
  client.elements.email.value = 'ops@example.invalid'; await client.event('emailForm', 'submit');
  client.elements.code.value = h.code('ops@example.invalid'); await client.event('codeForm', 'submit');
  assert.equal(client.elements.dashboard.hidden, false); return client;
}

test('実運営画面の設定保存・確認チェック・書き出し・履歴表示までを実行', async () => {
  const h = ready(); const client = await adminClient(h);
  client.elements.title.value = '<script>実行しない</script>'; client.elements.eventDate.value = '2026-12-20';
  client.elements.deadline.value = '2026-12-21T12:30'; await client.event('fields', 'input');
  assert.equal(client.elements.preview.disabled, true);
  await client.event('eventForm', 'submit'); assert.match(client.elements.result.textContent, /保存しました/);
  assert.equal(client.elements.preview.disabled, false);
  await client.event('preview'); assert.equal(client.elements.previewPanel.hidden, false); assert.equal(client.elements.export.disabled, true);
  client.elements.confirmPreview.checked = true; await client.event('confirmPreview', 'change'); assert.equal(client.elements.export.disabled, false);
  await client.event('export'); assert.equal(h.files.size, 1); assert.equal(client.elements.previewPanel.hidden, true);
  assert.equal(client.elements.history.children.length, 1); assert.equal(client.storage.size, 1);
  assert.ok(client.storage.has('hf_test.adminSession.v1'));
  await client.event('logout'); assert.equal(client.elements.dashboard.hidden, true); assert.equal(client.storage.size, 0);
});

test('運営画面の保存応答喪失では内容・要求IDを固定して再試行する', async () => {
  const h = ready(); let drop = true;
  const client = await adminClient(h, (name, ...args) => {
    const result = h.call(name, ...args);
    if (name === 'saveAdminEvent' && drop) { drop = false; throw new Error('reply lost'); }
    return result;
  });
  client.elements.title.value = '再送'; await client.event('eventForm', 'submit'); assert.equal(client.elements.fields.disabled, true);
  await client.event('eventForm', 'submit');
  const requests = client.calls.filter(call => call.name === 'saveAdminEvent'); assert.deepEqual(requests[0].args, requests[1].args);
  assert.equal(client.elements.fields.disabled, false); assert.match(client.elements.revision.textContent, /設定更新番号 1/);
});

test('運営画面の復元はGASで確認し、出店者の保存トークンは読み書きしない', async () => {
  const h = ready(); const admin = h.loginAdmin(); const user = h.login();
  const storage = new Map([['hf_test.adminSession.v1', admin.token], ['hf_test.exhibitorSession.v1', user.token]]);
  const client = clientHarness(h.call, storage, { htmlFile: 'AdminIndex.html' }); await client.settle();
  assert.equal(client.elements.dashboard.hidden, false); assert.equal(storage.get('hf_test.exhibitorSession.v1'), user.token);
  h.tick(3600000);
  const expired = clientHarness(h.call, storage, { htmlFile: 'AdminIndex.html' }); await expired.settle();
  assert.equal(expired.elements.dashboard.hidden, true); assert.equal(storage.has('hf_test.adminSession.v1'), false);
  assert.equal(storage.get('hf_test.exhibitorSession.v1'), user.token);
});

test('運営画面のJavaScript構文を読み込める', () => {
  const html = fs.readFileSync(new URL('../gas/AdminIndex.html', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
});

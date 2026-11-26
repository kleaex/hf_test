import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { harness, saveRequest, book } from './gas-harness.mjs';

function ready() { const h = harness(); h.setup(); return h; }
function error(result, code) { assert.equal(result.ok, false); assert.equal(result.error.code, code); }

test('設定不足・異なる環境・Sheets障害は保存を拒否し、内部情報を返さない', () => {
  for (const [key, value] of [['HF_ENV', 'production'], ['HF_AUTH_SECRET', 'short'], ['HF_TEST_EMAILS', '[]'], ['HF_SPREADSHEET_ID', 'other_spreadsheet_id_123456']]) {
    const h = ready(); const a = h.login(); h.properties[key] = value;
    const result = h.call('saveProfile', a.token, saveRequest(a.data));
    error(result, key === 'HF_SPREADSHEET_ID' ? 'UNAVAILABLE' : 'NOT_CONFIGURED');
    assert.doesNotMatch(JSON.stringify(result), /private|not connected|spreadsheet_id/);
  }
});

test('初期設定の再実行は既存データを保持し、不整合なスキーマを上書きしない', () => {
  const h = ready(); const a = h.login();
  const result = h.call('saveProfile', a.token, saveRequest(a.data, { profile: { ...a.data.profile, name: '保存済み' } }));
  h.setup(); assert.deepEqual(h.call('getMyProfile', a.token).data, result.data);
  assert.equal(h.sheets.get('Users').data.length, 3);
  h.sheets.get('Users').data[0][0] = 'wrong';
  assert.throws(() => h.setup()); assert.equal(h.sheets.get('Users').data[0][0], 'wrong');
});

test('未登録・許可外・無効メールには送信せず登録有無を応答から示さない', () => {
  const h = ready(); const response = h.call('requestLoginCode', 'a@example.invalid');
  for (const input of ['unknown@example.invalid', 'broken', '=formula@example.invalid', null]) {
    assert.deepEqual(h.call('requestLoginCode', input), response);
    error(h.call('verifyLoginCode', input, '000000'), 'INVALID_CODE');
  }
  assert.equal(h.state.mail.length, 1);
});

test('コードとトークンは原文保存せず、コードは1回限り、閲覧応答から認証情報を除く', () => {
  const h = ready(); const a = h.login(); assert.equal(a.ok, true);
  const auth = JSON.parse(h.sheets.get('Users').data[1][3]);
  assert.notEqual(auth.challenge.hash, h.code('a@example.invalid'));
  assert.equal(auth.challenge.hash.length, 64);
  const raw = JSON.stringify([...h.sheets.values()].map(sheet => sheet.data));
  assert.equal(raw.includes(a.token), false);
  const result = h.call('getMyProfile', a.token); assert.deepEqual(result.data, a.data);
  assert.doesNotMatch(JSON.stringify(result), /token|email|receipts|authJson|userId/);
  error(h.call('verifyLoginCode', 'a@example.invalid', h.code('a@example.invalid')), 'INVALID_CODE');
});

test('誤入力5回で停止し、期限切れ・再送前のコードを拒否する', () => {
  const h = ready(); h.call('requestLoginCode', 'a@example.invalid');
  const code = h.code('a@example.invalid'); const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) error(h.call('verifyLoginCode', 'a@example.invalid', wrong), 'INVALID_CODE');
  error(h.call('verifyLoginCode', 'a@example.invalid', code), 'INVALID_CODE');
  h.tick(60001); h.call('requestLoginCode', 'a@example.invalid');
  const next = h.code('a@example.invalid');
  if (next !== code) error(h.call('verifyLoginCode', 'a@example.invalid', code), 'INVALID_CODE');
  h.tick(600000); error(h.call('verifyLoginCode', 'a@example.invalid', next), 'INVALID_CODE');
});

test('再送は60秒、宛先ごと1時間5通、全体1時間20通に制限', () => {
  const h = ready(); h.call('requestLoginCode', 'a@example.invalid'); h.call('requestLoginCode', 'a@example.invalid');
  assert.equal(h.state.mail.length, 1);
  for (let i = 0; i < 5; i++) { h.tick(60001); h.call('requestLoginCode', 'a@example.invalid'); }
  assert.equal(h.state.mail.length, 5);
  h.tick(3600000); h.call('requestLoginCode', 'a@example.invalid'); assert.equal(h.state.mail.length, 6);
  h.properties.HF_MAIL_BUDGET = JSON.stringify({ windowStart: Date.UTC(2026, 10, 24) + 3900005, count: 20 });
  h.call('requestLoginCode', 'b@example.invalid'); assert.equal(h.state.mail.length, 6);
});

test('送信失敗・quota不足でログインできず、保存済み情報を壊さない', () => {
  const h = ready(); const a = h.login(); const before = h.call('getMyProfile', a.token).data;
  h.tick(60001); h.state.mailFails = true; h.call('requestLoginCode', 'a@example.invalid');
  const auth = JSON.parse(h.sheets.get('Users').data[1][3]); assert.equal(auth.challenge.status, 'failed');
  error(h.call('verifyLoginCode', 'a@example.invalid', h.code('a@example.invalid')), 'INVALID_CODE');
  assert.deepEqual(h.call('getMyProfile', a.token).data, before);
  h.state.quota = 0; h.call('requestLoginCode', 'b@example.invalid'); assert.equal(h.state.mail.length, 1);
});

test('コード消費後にセッション保存が失敗しても、同じコードを再利用できない', () => {
  const h = ready(); h.call('requestLoginCode', 'a@example.invalid');
  const code = h.code('a@example.invalid'); h.state.failWrite = 'Sessions';
  error(h.call('verifyLoginCode', 'a@example.invalid', code), 'UNAVAILABLE');
  error(h.call('verifyLoginCode', 'a@example.invalid', code), 'INVALID_CODE');
  h.tick(60001); assert.equal(h.login().ok, true);
});

test('AとBのデータを分離し、なりすまし・頒布物IDの流用・削除を拒否', () => {
  const h = ready(); const a = h.login(); const b = h.login('b@example.invalid');
  const savedB = h.call('saveProfile', b.token, saveRequest(b.data, { publications: [book({ title: 'Bだけの作品' })] }));
  error(h.call('saveProfile', a.token, saveRequest(savedB.data, { publications: [] })), 'FORBIDDEN');
  error(h.call('saveProfile', a.token, saveRequest(a.data, { publications: savedB.data.publications })), 'FORBIDDEN');
  assert.deepEqual(h.call('getMyProfile', b.token).data, savedB.data);
  assert.equal(h.call('getMyProfile', a.token, 'exh_b').data.exhibitorId, 'exh_a');
  assert.doesNotMatch(JSON.stringify(h.call('getMyProfile', a.token)), /Bだけの作品/);
});

test('プロフィール・複数頒布物の保存・再取得・変更・削除を確認', () => {
  const h = ready(); const a = h.login();
  const first = h.call('saveProfile', a.token, saveRequest(a.data, {
    profile: { name: '=HYPERLINK("bad")', description: '<script>alert(1)</script>', genre: '詩' },
    publications: [book(), book({ title: '二冊目', price: 0, releaseType: '既刊' })] }));
  assert.equal(first.ok, true); assert.equal(first.data.revision, 1); assert.equal(first.data.publications.length, 2);
  assert.notEqual(first.data.publications[0].id, first.data.publications[1].id);
  assert.ok(h.sheets.get('Exhibitors').data[1][2].startsWith('{'));
  assert.deepEqual(h.call('getMyProfile', a.token).data, first.data);
  const next = saveRequest(first.data); next.publications = [{ ...next.publications[1], price: 700 }];
  const second = h.call('saveProfile', a.token, next); assert.equal(second.data.publications.length, 1);
  assert.equal(second.data.publications[0].price, 700); assert.equal(second.data.revision, 2);
});

test('不正・失効・期限切れ・再ログイン前のセッションを拒否', () => {
  const h = ready(); const a = h.login();
  for (const token of ['', null, 'a'.repeat(64), {}]) error(h.call('getMyProfile', token), 'UNAUTHENTICATED');
  h.tick(60001); const next = h.login(); error(h.call('getMyProfile', a.token), 'UNAUTHENTICATED');
  assert.equal(h.call('logout', next.token).ok, true);
  error(h.call('saveProfile', next.token, saveRequest(next.data)), 'UNAUTHENTICATED');
  h.tick(60001); const last = h.login(); h.tick(7200000);
  error(h.call('getMyProfile', last.token), 'UNAUTHENTICATED');
});

test('利用停止・所属解除・所属変更・許可宛先除外・秘密値変更が既存セッションに効く', () => {
  for (const mutate of [
    h => { h.sheets.get('Users').data[1][2] = false; },
    h => { h.sheets.get('Memberships').data[1][3] = false; },
    h => { h.sheets.get('Memberships').data[1][0] = 'mem_changed'; },
    h => { h.sheets.get('Memberships').data[1][2] = 'exh_b'; },
    h => { h.sheets.get('Users').data[1][1] = 'b@example.invalid'; },
    h => { h.properties.HF_TEST_EMAILS = '["b@example.invalid"]'; },
    h => { h.properties.HF_AUTH_SECRET = 'rotated-local-only-secret-value-12345678901234567890'; }
  ]) {
    const h = ready(); const a = h.login(); mutate(h);
    const result = h.call('saveProfile', a.token, saveRequest(a.data));
    assert.equal(result.ok, false); assert.ok(['UNAUTHENTICATED', 'FORBIDDEN'].includes(result.error.code));
  }
});

test('確認コード発行後に宛先が変更されると、旧コードで新宛先にログインできない', () => {
  const h = ready(); h.call('requestLoginCode', 'a@example.invalid');
  const code = h.code('a@example.invalid');
  h.sheets.get('Users').data[1][1] = 'changed@example.invalid';
  h.properties.HF_TEST_EMAILS = '["changed@example.invalid", "b@example.invalid"]';
  error(h.call('verifyLoginCode', 'changed@example.invalid', code), 'INVALID_CODE');
});

test('同じ更新番号の同時保存は一方のみ、同じ要求の再送で重複作成しない', () => {
  const h = ready(); const a = h.login(); const request = saveRequest(a.data, { publications: [book()] });
  const saved = h.call('saveProfile', a.token, request); assert.equal(saved.ok, true);
  const replayed = h.call('saveProfile', a.token, request); assert.equal(replayed.replayed, true); assert.deepEqual(replayed.data, saved.data);
  error(h.call('saveProfile', a.token, saveRequest(a.data)), 'CONFLICT');
  error(h.call('saveProfile', a.token, { ...request, profile: { ...request.profile, name: '別内容' } }), 'REQUEST_REUSED');
});

test('保存前の書込失敗・保存後の応答喪失から同じ要求で復旧', () => {
  for (const failMode of ['failWrite', 'failAfterWrite']) {
    const h = ready(); const a = h.login(); const request = saveRequest(a.data, { publications: [book()] });
    h.state[failMode] = 'Exhibitors';
    error(h.call('saveProfile', a.token, request), 'UNAVAILABLE');
    const result = h.call('saveProfile', a.token, request); assert.equal(result.ok, true);
    assert.equal(result.data.revision, 1); assert.equal(result.data.publications.length, 1);
    assert.equal(result.replayed, failMode === 'failAfterWrite');
  }
});

test('古い再送は最新データを返し、記録20件を越えても古い更新番号で上書きしない', () => {
  const h = ready(); const a = h.login(); const first = saveRequest(a.data);
  let data = h.call('saveProfile', a.token, first).data;
  for (let i = 0; i < 19; i++) data = h.call('saveProfile', a.token, saveRequest(data)).data;
  const replayed = h.call('saveProfile', a.token, first); assert.equal(replayed.data.revision, 20); assert.equal(replayed.savedRevision, 1);
  data = h.call('saveProfile', a.token, saveRequest(data)).data;
  error(h.call('saveProfile', a.token, first), 'CONFLICT'); assert.equal(data.revision, 21);
});

test('値・未知の項目・重複ID・過大データを検証し、失敗で既存内容を変えない', () => {
  const h = ready(); const a = h.login();
  const saved = h.call('saveProfile', a.token, saveRequest(a.data, { publications: [book()] }));
  const invalid = [
    { profile: { ...saved.data.profile, name: '' } }, { profile: { ...saved.data.profile, name: 'x'.repeat(81) } },
    { profile: { ...saved.data.profile, role: 'admin' } }, { profile: { ...saved.data.profile, description: '\u0000' } },
    { publications: [book({ price: -1 })] }, { publications: [book({ price: 1.5 })] },
    { publications: [book({ price: '500' })] }, { publications: [book({ releaseType: 'invalid' })] },
    { publications: [book({ id: 'foreign' })] }, { publications: Array.from({ length: 11 }, () => book()) },
    { publications: [saved.data.publications[0], saved.data.publications[0]] }, { revision: -1 },
    { requestId: 'small' }, { internalMemo: 'invalid' }
  ];
  for (const mutation of invalid) error(h.call('saveProfile', a.token, saveRequest(saved.data, mutation)), 'VALIDATION');
  error(h.call('saveProfile', a.token, saveRequest(saved.data, {
    profile: { name: '過大データ', description: '"'.repeat(2000), genre: '詩' },
    publications: Array.from({ length: 10 }, () => book({ title: '"'.repeat(120), author: '"'.repeat(120), description: '"'.repeat(2000) }))
  })), 'VALIDATION');
  assert.deepEqual(h.call('getMyProfile', a.token).data, saved.data);
});

test('ロック取得失敗では読取・書込を進めず、例外でもロックを解放', () => {
  const h = ready(); const a = h.login(); h.state.lockAvailable = false;
  error(h.call('saveProfile', a.token, saveRequest(a.data)), 'BUSY');
  h.state.lockAvailable = true; assert.equal(h.call('getMyProfile', a.token).ok, true); assert.equal(h.state.locked, false);
});

test('公開入口を限定し、内部・初期設定関数はすべて末尾 _', () => {
  const publicFunctions = [];
  for (const file of fs.readdirSync(new URL('../gas/', import.meta.url)).filter(name => name.endsWith('.gs'))) {
    const source = fs.readFileSync(new URL('../gas/' + file, import.meta.url), 'utf8');
    for (const match of source.matchAll(/^function (\w+)\(/gm)) if (!match[1].endsWith('_')) publicFunctions.push(match[1]);
  }
  assert.deepEqual(publicFunctions.sort(), ['doGet', 'getSystemStatus', 'requestLoginCode', 'verifyLoginCode', 'getMyProfile', 'saveProfile', 'logout', 'uploadPublicationImage', 'getPublicationImage',
    'requestAdminLoginCode', 'verifyAdminLoginCode', 'getAdminDashboard', 'saveAdminEvent', 'previewAdminCatalog', 'exportAdminCatalog', 'getAdminImage', 'logoutAdmin', 'getPublicCatalog', 'getPublicImage', 'getPublicImages', 'stagePublicationImage'].sort());
});

test('編集画面のJavaScript構文とGASマニフェストを読み込める', () => {
  const html = fs.readFileSync(new URL('../gas/Index.html', import.meta.url), 'utf8');
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(script[1]));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(new URL('../gas/appsscript.json', import.meta.url), 'utf8')));
});

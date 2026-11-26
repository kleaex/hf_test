import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, saveRequest } from './gas-harness.mjs';
import { clientHarness } from './client-harness.mjs';

const email = 'new@example.invalid';
const name = '架空の新規出店';
function ready() {
  const h = harness(); h.setup(); h.setupAdmin();
  h.properties.HF_TEST_EMAILS = JSON.stringify(['a@example.invalid', 'b@example.invalid', email]);
  return h;
}
function request(h) { return h.call('requestRegistrationCode', name, email); }
function verify(h, code = h.code(email)) { return h.call('verifyRegistrationCode', name, email, code); }

test('メール確認後に固定IDで登録・ログインし、保存しても運営選択までは非公開', () => {
  const h = ready(); request(h);
  assert.equal(h.sheets.get('Exhibitors').data.length, 3);
  assert.equal(h.sheets.get('Memberships').data.length, 3);
  assert.equal(h.sheets.get('Users').data.at(-1)[2], false);
  assert.equal(h.call('verifyLoginCode', email, h.code(email)).ok, false);
  const result = verify(h); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.profile.name, name); assert.equal(result.data.revision, 0);
  assert.match(result.data.exhibitorId, /^exh_[a-f0-9]{32}$/);
  assert.equal(h.call('getMyProfile', result.token).ok, true);
  const saved = h.call('saveProfile', result.token, saveRequest(result.data, { profile: { name: '改名後', description: '', genre: '' } }));
  assert.equal(saved.data.exhibitorId, result.data.exhibitorId);
  assert.equal(h.call('getPublicCatalog').data.exhibitors.some(x => x.id === result.data.exhibitorId), false);
  assert.equal(verify(h).ok, false);
  h.tick(60001);
  assert.equal(h.call('requestExhibitorLoginCode', name, email).ok, true);
  assert.equal(h.state.mail.length, 1);
  h.call('requestExhibitorLoginCode', '改名後', email);
  assert.equal(h.call('verifyExhibitorLoginCode', '改名後', email, h.code(email)).ok, true);
  assert.equal(h.call('verifyExhibitorLoginCode', name, email, h.code(email)).ok, false);
});

test('許可外・既存・停止済み宛先の新規登録では既存情報を書き換えない', () => {
  const h = ready();
  const before = structuredClone(h.sheets.get('Users').data);
  const response = request(h);
  for (const target of ['other@example.invalid', 'a@example.invalid', 'invalid']) {
    assert.deepEqual(h.call('requestRegistrationCode', name, target), response);
  }
  assert.deepEqual(h.sheets.get('Users').data.slice(0, 3), before);
  h.sheets.get('Users').data[1][2] = false;
  h.call('requestRegistrationCode', name, 'a@example.invalid');
  assert.equal(h.sheets.get('Users').data[1][2], false);
  assert.equal(h.state.mail.length, 1);
});

test('名前とメールのログイン照合結果を送信応答で区別しない', () => {
  const h = ready();
  const response = h.call('requestExhibitorLoginCode', '架空A', 'a@example.invalid');
  assert.deepEqual(h.call('requestExhibitorLoginCode', '別の名前', 'a@example.invalid'), response);
  assert.deepEqual(h.call('requestExhibitorLoginCode', name, email), response);
  assert.equal(h.state.mail.length, 1);
});

test('登録コードは名前・宛先・開催回・期限に結び付け、5回失敗で拒否', () => {
  for (const mutate of [
    h => h.call('verifyRegistrationCode', '別名', email, h.code(email)),
    h => h.call('verifyRegistrationCode', name, 'a@example.invalid', h.code(email)),
    h => { h.tick(600000); return verify(h); },
    h => { h.properties.HF_EVENT_ID = 'other_event'; return verify(h); },
    h => { for (let i = 0; i < 5; i++) verify(h, 'xxxxxx'); return verify(h); },
    h => { h.properties.HF_TEST_EMAILS = '["a@example.invalid"]'; return verify(h); }
  ]) {
    const h = ready(); request(h); assert.equal(mutate(h).ok, false);
    assert.equal(h.sheets.get('Exhibitors').data.length, 3);
  }
});

test('再送制限・メール障害・締切・入力検証を適用する', () => {
  const h = ready(); request(h); request(h); assert.equal(h.state.mail.length, 1);
  for (let i = 0; i < 5; i++) { h.tick(60001); request(h); }
  assert.equal(h.state.mail.length, 5);
  const failed = ready(); failed.state.mailFails = true; request(failed);
  assert.equal(verify(failed, '000000').ok, false);
  const closed = ready(); request(closed); closed.tick(50 * 86400000);
  assert.equal(request(closed).error.code, 'EDIT_CLOSED');
  assert.equal(verify(closed).error.code, 'EDIT_CLOSED');
  for (const invalid of ['', 'x'.repeat(81), null, '=\u0000']) {
    assert.equal(h.call('requestRegistrationCode', invalid, email).error.code, 'VALIDATION');
  }
});

test('途中の書込失敗・書込後の応答喪失は同じIDで復旧し、二重登録しない', () => {
  for (const sheet of ['Users', 'Exhibitors', 'Memberships']) for (const mode of ['failWrite', 'failAfterWrite']) {
    const h = ready(); request(h); h.state[mode] = sheet;
    assert.equal(verify(h).ok, false);
    const result = verify(h); assert.equal(result.ok, true, `${sheet}/${mode}: ${JSON.stringify(result)}`);
    assert.equal(h.sheets.get('Exhibitors').data.length, 4);
    assert.equal(h.sheets.get('Memberships').data.length, 4);
    assert.equal(h.sheets.get('Users').data.length, 4);
  }
});

test('登録確定後のセッション失敗は通常ログインで復旧する', () => {
  for (const mode of ['failWrite', 'failAfterWrite']) {
    const h = ready(); request(h); h.state[mode] = 'Sessions';
    assert.equal(verify(h).ok, false);
    assert.equal(verify(h).ok, false);
    h.tick(60001); h.call('requestExhibitorLoginCode', name, email);
    assert.equal(h.call('verifyExhibitorLoginCode', name, email, h.code(email)).ok, true);
    assert.equal(h.sheets.get('Exhibitors').data.length, 4);
  }
});

test('HPの登録フォームから確認・編集・保存・復元・再ログインまで進める', async () => {
  const h = ready(); const storage = new Map();
  const client = clientHarness(h.call, storage, { hpRole: 'exhibitor' }); await client.settle();
  client.elements.authMode.value = 'register'; client.elements.loginName.value = name; client.elements.email.value = email;
  await client.event('emailForm', 'submit'); client.elements.code.value = h.code(email);
  await client.event('codeForm', 'submit');
  assert.equal(client.elements.editor.hidden, false); assert.equal(client.elements.name.value, name);
  assert.match(client.elements.result.textContent, /非公開/);
  client.elements.description.value = '登録後の紹介'; await client.event('profileForm', 'submit');
  const restored = clientHarness(h.call, storage, { hpRole: 'exhibitor' }); await restored.settle();
  assert.equal(restored.elements.description.value, '登録後の紹介');
  await restored.event('logout'); h.tick(60001);
  restored.elements.authMode.value = 'login'; restored.elements.loginName.value = name; restored.elements.email.value = email;
  await restored.event('emailForm', 'submit'); restored.elements.code.value = h.code(email);
  await restored.event('codeForm', 'submit'); assert.equal(restored.elements.editor.hidden, false);
  assert.deepEqual(restored.calls.slice(-2).map(x => x.name), ['requestExhibitorLoginCode', 'verifyExhibitorLoginCode']);
});

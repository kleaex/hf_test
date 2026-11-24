import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './gas-harness.mjs';
import { clientHarness } from './client-harness.mjs';

const key = 'hf_test.exhibitorSession.v1';
function ready() { const h = harness(); h.setup(); return h; }
async function login(h, client) {
  await client.settle();
  client.elements.email.value = 'a@example.invalid';
  await client.event('emailForm', 'submit');
  client.elements.code.value = h.code('a@example.invalid');
  await client.event('codeForm', 'submit');
  assert.equal(client.elements.editor.hidden, false);
}

test('ログイン後はトークンだけを一時保存し、再読込でGAS検証して保存済み内容を復元', async () => {
  const h = ready(); const storage = new Map(); const client = clientHarness(h.call, storage);
  await login(h, client);
  assert.equal(storage.size, 1); assert.match(storage.get(key), /^[a-f0-9]{64}$/);
  client.elements.name.value = '再読込で復元する出店名';
  await client.event('profileForm', 'submit');
  client.elements.description.value = '未保存の入力';
  const restored = clientHarness(h.call, storage); await restored.settle();
  assert.equal(restored.elements.editor.hidden, false);
  assert.equal(restored.elements.name.value, '再読込で復元する出店名');
  assert.equal(restored.elements.description.value, '');
  assert.deepEqual(restored.calls.map(call => call.name), ['getMyProfile']);
  assert.equal(h.state.mail.length, 1);
});

test('保存トークンがあってもGASの検証完了まで編集画面を開かず、操作を無効にする', async () => {
  const h = ready(); const a = h.login(); let release;
  const client = clientHarness(() => new Promise(resolve => { release = resolve; }), new Map([[key, a.token]]));
  await client.settle();
  assert.equal(client.elements.editor.hidden, true); assert.equal(client.elements.email.disabled, true);
  release(h.call('getMyProfile', a.token)); await client.settle();
  assert.equal(client.elements.editor.hidden, false); assert.equal(client.elements.email.disabled, false);
});

test('再読込しても2時間の絶対期限は延長せず、期限切れで一時保存を削除', async () => {
  const h = ready(); const a = h.login(); const storage = new Map([[key, a.token]]);
  h.tick(7199000);
  const first = clientHarness(h.call, storage); await first.settle(); assert.equal(first.elements.editor.hidden, false);
  h.tick(1000);
  const expired = clientHarness(h.call, storage); await expired.settle();
  assert.equal(expired.elements.editor.hidden, true); assert.equal(storage.size, 0);
  assert.match(expired.elements.result.textContent, /再ログイン/);
});

test('失効・所属解除・再ログイン前のトークンは復元せず一時保存を削除', async () => {
  for (const mutate of [
    (h, a) => h.call('logout', a.token),
    h => { h.sheets.get('Memberships').data[1][3] = false; },
    h => { h.tick(60001); h.login(); }
  ]) {
    const h = ready(); const a = h.login(); mutate(h, a);
    const storage = new Map([[key, a.token]]); const client = clientHarness(h.call, storage); await client.settle();
    assert.equal(client.elements.editor.hidden, true); assert.equal(storage.size, 0);
  }
});

test('通信失敗・一時障害ではトークンを残し、復元ボタンで再試行する', async () => {
  for (const mode of ['network', 'backend']) {
    const h = ready(); const a = h.login(); const storage = new Map([[key, a.token]]); let failing = true;
    const client = clientHarness((name, ...args) => {
      if (failing) {
        if (mode === 'network') throw new Error('network');
        return { ok: false, error: { code: 'UNAVAILABLE', message: 'temporary' } };
      }
      return h.call(name, ...args);
    }, storage);
    await client.settle();
    assert.equal(client.elements.editor.hidden, true); assert.equal(storage.get(key), a.token);
    assert.equal(client.elements.restore.hidden, false);
    failing = false; await client.event('restore');
    assert.equal(client.elements.editor.hidden, false); assert.equal(client.elements.restore.hidden, true);
  }
});

test('ログアウト成功でGAS側と一時保存を失効し、再読込で自動ログインしない', async () => {
  const h = ready(); const storage = new Map(); const client = clientHarness(h.call, storage); await login(h, client);
  const token = storage.get(key); await client.event('logout');
  assert.equal(storage.size, 0); assert.equal(client.elements.editor.hidden, true);
  assert.equal(h.call('getMyProfile', token).ok, false);
  const reloaded = clientHarness(h.call, storage); await reloaded.settle();
  assert.equal(reloaded.calls.length, 0); assert.equal(reloaded.elements.editor.hidden, true);
});

test('ログアウトの通信失敗では失効済みと誤表示せず、再試行できる', async () => {
  const h = ready(); let failLogout = true;
  const client = clientHarness((name, ...args) => {
    if (name === 'logout' && failLogout) throw new Error('network');
    return h.call(name, ...args);
  });
  await login(h, client); const token = client.storage.get(key);
  await client.event('logout'); assert.equal(client.storage.get(key), token); assert.equal(client.elements.editor.hidden, false);
  failLogout = false; await client.event('logout'); assert.equal(client.storage.size, 0);
});

test('Storageが拒否されてもログイン・保存ができ、復元できない旨を表示', async () => {
  const h = ready(); const client = clientHarness(h.call, new Map(), { storageBlocked: true });
  await login(h, client); assert.equal(client.elements.sessionNotice.hidden, false);
  client.elements.name.value = '一時保存なしでも保存できる'; await client.event('profileForm', 'submit');
  assert.match(client.elements.result.textContent, /保存しました/);
  await client.event('logout'); assert.equal(client.elements.editor.hidden, true);
});

test('壊れた保存値はGASへ送らず削除し、別タブ相当の空のStorageでは復元しない', async () => {
  const h = ready(); const storage = new Map([[key, '<invalid>']]);
  const client = clientHarness(h.call, storage); await client.settle();
  assert.equal(storage.size, 0); assert.equal(client.calls.length, 0);
  h.login(); const otherTab = clientHarness(h.call); await otherTab.settle();
  assert.equal(otherTab.elements.editor.hidden, true); assert.equal(otherTab.calls.length, 0);
});

test('編集操作中に失効が判明したら保存トークンを削除し、未保存入力は控えられる', async () => {
  const h = ready(); const client = clientHarness(h.call); await login(h, client);
  client.elements.name.value = '手元に控える入力'; h.tick(7200000);
  await client.event('profileForm', 'submit');
  assert.equal(client.storage.size, 0); assert.equal(client.elements.name.value, '手元に控える入力');
  assert.match(client.elements.result.textContent, /ログイン/);
});

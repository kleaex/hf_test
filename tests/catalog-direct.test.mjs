import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { harness, saveRequest, book } from './gas-harness.mjs';

function endpoint() {
  const h = harness(); h.setup(); h.setupAdmin();
  let calls = 0;
  const context = vm.createContext({
    json_: JSON.parse, PropertiesService: { getScriptProperties: () => ({ getProperty: () => '["https://example.invalid"]' }) },
    ContentService: { MimeType: { JAVASCRIPT: 'javascript' }, createTextOutput: text => ({ text, setMimeType(type) { this.type = type; return this; } }) },
    getPublicCatalog: () => { calls++; return h.call('getPublicCatalog'); }
  });
  vm.runInContext(fs.readFileSync(new URL('../gas/Transport.gs', import.meta.url), 'utf8'), context);
  vm.runInContext(fs.readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8'), context);
  context.getPublicCatalog = () => { calls++; return h.call('getPublicCatalog'); };
  return { h, context, calls: () => calls };
}

test('公開GETは公開本文だけを返し、任意callbackや不許可originでは正本を読まない', () => {
  const { h, context, calls } = endpoint(); const login = h.login();
  const title = '</script><script>throw Error("injected")</script>&\u2028\u2029end';
  assert.equal(h.call('saveProfile', login.token, saveRequest(login.data, { publications: [book({ title })] })).ok, true);
  const callback = '__hf_catalog_' + 'a'.repeat(32);
  const parameters = { view: 'catalog', origin: 'https://example.invalid', callback };
  for (const invalid of ['alert', callback + '.constructor', callback + '();evil', '', null]) {
    const result = context.doGet({ parameter: { ...parameters, callback: invalid } });
    assert.equal(result.type, 'javascript'); assert.equal(calls(), 0); assert.doesNotMatch(result.text, /exhibitors|alert/);
  }
  context.doGet({ parameter: { ...parameters, origin: 'https://evil.invalid' } }); assert.equal(calls(), 0);
  const result = context.doGet({ parameter: { ...parameters, method: 'saveProfile', token: 'PRIVATE_TOKEN' } });
  assert.equal(calls(), 1); assert.equal(result.type, 'javascript');
  assert.doesNotMatch(result.text.slice(result.text.indexOf('({')), /<|>|&|\u2028|\u2029|PRIVATE_TOKEN|authJson|fileId|receipts|userId/);
  let received;
  vm.runInNewContext(result.text, { [callback]: data => { received = data; } });
  assert.equal(received.ok, true); assert.equal(received.data.exhibitors[0].publications[0].title, title);
  assert.equal(received.initialImages, undefined);
  // タイムアウト後に届いても、削除済みcallbackを呼ばない。
  assert.doesNotThrow(() => vm.runInNewContext(result.text, {}));
});

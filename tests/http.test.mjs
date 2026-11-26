import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('HPの公開・出店者・運営ルートと必要なJS/CSSをHTTPで配信できる', async t => {
  const child = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, HF_PREVIEW_PORT: '0' }, windowsHide: true });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('preview startup timeout')), 5000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', data => { const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.stderr.on('data', data => { clearTimeout(timer); reject(Error(data.toString())); });
  });
  for (const route of ['/', '/exhibitor/', '/admin/', '/connection.js', '/rpc.js', '/app.js', '/catalog-schema.mjs', '/styles.css', '/data/catalog.json']) {
    const result = await fetch(url + route); assert.equal(result.status, 200, route);
    if (route.endsWith('/') || route.endsWith('.html')) assert.match(result.headers.get('content-type'), /text\/html/);
    if (/\.m?js$/.test(route)) assert.match(result.headers.get('content-type'), /text\/javascript/);
    assert.ok((await result.text()).length > 0);
  }
  assert.equal((await fetch(url + '/gas/Code.gs')).status, 404);
  assert.equal((await fetch(url + '/%2e%2e%2fgas%2fCode.gs')).status, 403);
});

// ローカルのブラウザー検証専用。公開配信・GAS配置には含めない。
import http from 'node:http';
import fs from 'node:fs';
import { harness } from './gas-harness.mjs';

const h = harness(); h.setup(); h.setupAdmin();
h.properties.HF_TEST_EMAILS = JSON.stringify(['a@example.invalid', 'b@example.invalid', 'new@example.invalid']);
const allowed = new Set(['getSystemStatus', 'requestLoginCode', 'verifyLoginCode', 'getMyProfile', 'saveProfile', 'logout', 'uploadPublicationImage', 'getPublicationImage',
  'requestRegistrationCode', 'verifyRegistrationCode', 'requestExhibitorLoginCode', 'verifyExhibitorLoginCode',
  'requestAdminLoginCode', 'verifyAdminLoginCode', 'getAdminDashboard', 'saveAdminEvent', 'previewAdminCatalog', 'exportAdminCatalog', 'getAdminImage', 'logoutAdmin']);
const bridge = `<aside style="padding:1rem;background:#fff1cc">ローカル模擬環境（Google接続・実メール送信なし）<br>新規登録: new@example.invalid ／ 既存出店者: a@example.invalid / b@example.invalid ／ 運営: ops@example.invalid<br><a href="/exhibitor/">HPの登録・編集画面</a> ／ <a href="/">旧出店者画面</a> ／ <a href="/?view=admin">運営画面</a><br><span id="testCode">確認コードは送信操作後に表示します。</span><br><button type="button" id="dropReply">次の保存応答を失わせる</button></aside>
<script>
let dropReply = false;
document.getElementById('dropReply').onclick = () => { dropReply = true; document.getElementById('dropReply').textContent = '次の保存は応答喪失を再現します'; };
window.google = { script: { get run() {
  let success, failure;
  const runner = new Proxy({}, { get(_, name) {
    if (name === 'withSuccessHandler') return callback => { success = callback; return runner; };
    if (name === 'withFailureHandler') return callback => { failure = callback; return runner; };
    return async (...args) => {
      try {
        const result = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args }) }).then(r => r.json());
        if (['requestLoginCode', 'requestAdminLoginCode', 'requestRegistrationCode', 'requestExhibitorLoginCode'].includes(name)) document.getElementById('testCode').textContent = '模擬メールの確認コード: ' + result.testCode;
        delete result.testCode;
        if (['saveProfile', 'uploadPublicationImage', 'saveAdminEvent', 'exportAdminCatalog'].includes(name) && dropReply) { dropReply = false; document.getElementById('dropReply').textContent = '次の保存応答を失わせる'; failure(); return; }
        success(result);
      } catch (_) { failure(); }
    };
  } }); return runner;
} } };
window.hfRpc = (name, ...args) => new Promise((resolve, reject) => {
  google.script.run.withSuccessHandler(result => result.ok ? resolve(result) : reject(result.error))
    .withFailureHandler(() => reject(new Error('処理結果を確認できません。再試行してください。')))[name](...args);
});
</script>`;
const hpHtml = fs.readFileSync(new URL('../docs/exhibitor/index.html', import.meta.url), 'utf8')
  .replace('<script src="../connection.js"></script><script src="../rpc.js"></script>', '')
  .replace('<body>', '<body>' + bridge);
const html = fs.readFileSync(new URL('../gas/Index.html', import.meta.url), 'utf8').replace('<body>', '<body>' + bridge);
const adminHtml = fs.readFileSync(new URL('../gas/AdminIndex.html', import.meta.url), 'utf8').replace('<body>', '<body>' + bridge);
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/exhibitor/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(hpHtml); return;
  }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(url.searchParams.get('view') === 'admin' ? adminHtml : html); return;
  }
  const host = '127.0.0.1:' + server.address().port;
  if (req.method === 'POST' && req.url === '/rpc' && req.headers.host === host
      && req.headers.origin === 'http://' + host) {
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 2100000) throw new Error('size'); }
      const { name, args } = JSON.parse(body);
      if (!allowed.has(name) || !Array.isArray(args)) throw new Error('entry');
      const result = h.call(name, ...args);
      if (['requestLoginCode', 'requestAdminLoginCode'].includes(name)) result.testCode = h.code(args[0]) || '未送信';
      if (['requestRegistrationCode', 'requestExhibitorLoginCode'].includes(name)) result.testCode = h.code(args[1]) || '未送信';
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
    } catch { res.writeHead(400); res.end('Invalid request'); return; }
  }
  res.writeHead(404); res.end('Not found');
});
const port = process.env.HF_EXPERIMENT_PORT === undefined ? 8081 : Number(process.env.HF_EXPERIMENT_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('HF_EXPERIMENT_PORTが不正です。');
server.listen(port, '127.0.0.1', () => console.log('Local mock only: http://127.0.0.1:' + server.address().port + '/ (Ctrl+C to stop)'));

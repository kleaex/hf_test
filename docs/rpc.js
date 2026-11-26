'use strict';
// GASの二重iframeにも対応し、作成したiframeの子孫以外からの応答を受け付けない。
(() => {
  const measurements = [];
  const labels = new Set(['bridge', 'imagePrepare', 'imageCache', 'catalogPaint', 'getPublicCatalog', 'getPublicImage', 'getPublicImages',
    'getSystemStatus', 'requestLoginCode', 'verifyLoginCode', 'getMyProfile', 'saveProfile', 'stagePublicationImage', 'getPublicationImage', 'logout',
    'requestAdminLoginCode', 'verifyAdminLoginCode', 'getAdminDashboard', 'saveAdminEvent', 'getAdminImage', 'logoutAdmin']);
  const stages = new Set(['lockWait', 'lockHeld', 'sheetHeader', 'sheetRead', 'sheetWrite', 'catalogBuild', 'catalogCache',
    'imageValidate', 'thumbnailValidate', 'driveSave', 'driveRead', 'driveMetadata', 'imageAuthorize', 'imageCommit', 'sharedImageCache']);
  window.hfPerformance = Object.freeze({
    record(operation, elapsedMs, server) {
      if (!labels.has(operation) || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
      const item = { operation, elapsedMs };
      if (server && Number.isFinite(server.totalMs)) {
        item.serverMs = server.totalMs; item.stages = {};
        for (const [name, value] of Object.entries(server.stages || {})) {
          if (stages.has(name) && Number.isFinite(value.ms) && Number.isSafeInteger(value.count)) item.stages[name] = { ms: value.ms, count: value.count };
        }
      }
      measurements.push(item); if (measurements.length > 100) measurements.shift();
    },
    snapshot: () => JSON.parse(JSON.stringify(measurements)),
    clear: () => { measurements.length = 0; }
  });
  const random = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const belongs = (root, source, depth = 0) => {
    if (root === source) return true;
    if (!root || depth >= 4) return false;
    try { for (let i = 0; i < Math.min(root.length, 8); i++) if (belongs(root[i], source, depth + 1)) return true; } catch (_) { /* fail closed */ }
    return false;
  };
  const network = () => ({ network: true, message: 'GASとの接続結果を確認できませんでした。接続設定を確認し、再試行してください。' });
  let frame, nonce, peer, peerOrigin, ready;
  const pending = new Map();
  const googleOrigin = value => /^https:\/\/(?:script\.google\.com|(?:[a-z0-9-]+[.-])?script\.googleusercontent\.com)$/.test(value);
  function connect() {
    if (ready) return ready;
    const url = new URL(window.HF_CONNECTION?.gasUrl || '', location.href);
    if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) throw network();
    nonce = random(32); peer = null; peerOrigin = null;
    const connectionNonce = nonce;
    url.search = new URLSearchParams({ view: 'bridge', origin: location.origin, nonce });
    frame = document.createElement('iframe'); frame.hidden = true; frame.title = 'データ接続'; frame.referrerPolicy = 'no-referrer';
    const connectionFrame = frame;
    const started = Date.now();
    ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMessage); ready = null; connectionFrame.remove(); reject(network());
      }, 30000);
      const onMessage = event => {
        const message = event.data;
        if (!message || message.channel !== 'hf-rpc-v1' || message.nonce !== connectionNonce
            || !googleOrigin(event.origin) || !belongs(connectionFrame.contentWindow, event.source)) return;
        if (!peer && message.ready === true) {
          peer = event.source; peerOrigin = event.origin; clearTimeout(timeout);
          window.hfPerformance.record('bridge', Date.now() - started); resolve(); return;
        }
        if (event.source !== peer || event.origin !== peerOrigin || message.ready) return;
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timeout); entry.resolve(message.result);
      };
      window.addEventListener('message', onMessage);
      frame.addEventListener('load', () => { /* ready通知を待つ。loadだけで成功扱いにしない。 */ });
      frame.src = url.href; document.body.append(frame);
    });
    return ready;
  }
  window.hfRpc = async (method, ...args) => {
    await connect();
    const started = Date.now();
    if (pending.size >= 8) throw network();
    const id = random(16);
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(network()); }, 60000);
      pending.set(id, { resolve, timeout });
      peer.postMessage({ channel: 'hf-rpc-v1', nonce, id, method, args }, peerOrigin);
    });
    window.hfPerformance.record(method, Date.now() - started, result && result.performance);
    if (!result || typeof result.ok !== 'boolean') throw network();
    if (!result.ok) throw result.error || network();
    return result;
  };
})();

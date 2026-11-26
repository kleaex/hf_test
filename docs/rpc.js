'use strict';
// GASの二重iframeにも対応し、作成したiframeの子孫以外からの応答を受け付けない。
(() => {
  const measurements = [];
  const labels = new Set(['bridge', 'catalogDirect', 'catalogDirectFallback', 'catalogInitial', 'catalogFallback', 'catalogLoad', 'catalogTextReady', 'imagePrepare', 'imageUpload', 'imageProbe', 'imageLoad', 'imageQueue', 'imageUnpack', 'imageReady', 'imageCache', 'catalogPaint', 'getPublicCatalog', 'getPublicImage', 'getPublicImages',
    'getSystemStatus', 'requestLoginCode', 'verifyLoginCode', 'getMyProfile', 'saveProfile', 'stagePublicationImage', 'getPublicationImage', 'logout',
    'requestAdminLoginCode', 'verifyAdminLoginCode', 'getAdminDashboard', 'saveAdminEvent', 'getAdminImage', 'logoutAdmin']);
  const stages = new Set(['lockWait', 'lockHeld', 'sheetHeader', 'sheetRead', 'sheetWrite', 'catalogBuild', 'catalogCache',
    'imageValidate', 'thumbnailValidate', 'driveSave', 'driveRead', 'driveMetadata', 'driveMetadataApi', 'driveMetadataLegacy', 'imageIndexSeed', 'catalogPreview', 'imageAuthorize', 'imageCommit', 'sharedImageCache', 'cacheWrite']);
  const cacheStatuses = new Set(['jsonMiss', 'jsonHit', 'jsonInvalid', 'jsonPartial', 'jsonReadError', 'jsonStored',
    'jsonOversize', 'jsonWriteError', 'jsonWriteVerified', 'jsonWriteMissing', 'jsonReadbackError']);
  window.hfPerformance = Object.freeze({
    record(operation, elapsedMs, server, details) {
      if (!labels.has(operation) || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
      const item = { operation, elapsedMs };
      if (details) {
        item.details = {};
        if (['thumbnail', 'full'].includes(details.variant)) item.details.variant = details.variant;
        if (['memory', 'browser', 'gas', 'inflight'].includes(details.source)) item.details.source = details.source;
        for (const key of ['bytes', 'sourceBytes', 'thumbnailBytes', 'encodes', 'rpcMs', 'unpackMs', 'decodeMs', 'pass']) {
          const value = details[key];
          if (Number.isFinite(value) && value >= 0 && value <= 60000000) item.details[key] = value;
        }
      }
      if (server && Number.isFinite(server.totalMs)) {
        item.serverMs = server.totalMs; item.stages = {};
        for (const [name, value] of Object.entries(server.stages || {})) {
          if (stages.has(name) && Number.isFinite(value.ms) && Number.isSafeInteger(value.count)) item.stages[name] = { ms: value.ms, count: value.count };
        }
        item.cache = {};
        for (const [name, count] of Object.entries(server.cache || {})) {
          if (cacheStatuses.has(name) && Number.isSafeInteger(count) && count > 0) item.cache[name] = count;
        }
      }
      measurements.push(item); if (measurements.length > 100) measurements.shift();
    },
    snapshot: () => JSON.parse(JSON.stringify(measurements)),
    clear: () => { measurements.length = 0; },
    // 明示実行時だけ公開画像1点を各2回取得。共有・認証・保存・キャッシュ削除は行わない。
    async measureImages() {
      const catalog = await window.hfRpc('getPublicCatalog');
      let id;
      for (const exhibitor of catalog.data?.exhibitors || []) {
        for (const book of exhibitor.publications || []) {
          id = (book.images || []).find(image => typeof image.id === 'string' && /^img_[a-f0-9]{32}$/.test(image.id))?.id;
          if (id) break;
        }
        if (id) break;
      }
      if (!id) return { imagesFound: 0, measurements: [] };
      const report = [];
      for (const pass of [1, 2]) {
        for (const variant of ['thumbnail', 'full']) {
          const started = Date.now();
          const response = variant === 'thumbnail'
            ? await window.hfRpc('getPublicImages', [id]) : await window.hfRpc('getPublicImage', id, variant);
          const received = Date.now();
          const result = variant === 'thumbnail' ? response.images?.find(image => image.id === id) : response;
          if (!result || result.ok === false || !['image/png', 'image/jpeg'].includes(result.contentType)
              || typeof result.base64 !== 'string' || result.base64.length > 2000000
              || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.base64)) throw new Error('公開画像を取得できませんでした。');
          const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: result.contentType }));
          const image = document.createElement('img');
          const unpacked = Date.now();
          try {
            image.src = url;
            if (typeof image.decode !== 'function') throw new Error('このブラウザーでは画像の復号時間を計測できません。');
            await image.decode();
            const completed = Date.now();
            const details = { pass, variant, bytes: bytes.length, rpcMs: received - started,
              unpackMs: unpacked - received, decodeMs: completed - unpacked };
            window.hfPerformance.record('imageProbe', completed - started, response.performance, details);
            report.push(window.hfPerformance.snapshot().at(-1));
          } finally { image.removeAttribute('src'); URL.revokeObjectURL(url); }
        }
      }
      return { imagesFound: 1, measurements: report };
    }
  });
  const random = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const belongs = (root, source, depth = 0) => {
    if (root === source) return true;
    if (!root || depth >= 4) return false;
    try { for (let i = 0; i < Math.min(root.length, 8); i++) if (belongs(root[i], source, depth + 1)) return true; } catch (_) { /* fail closed */ }
    return false;
  };
  const network = () => ({ network: true, message: 'GASとの接続結果を確認できませんでした。接続設定を確認し、再試行してください。' });
  let frame, nonce, peer, peerOrigin, ready, initialCatalog;
  const pending = new Map();
  const googleOrigin = value => /^https:\/\/(?:script\.google\.com|(?:[a-z0-9-]+[.-])?script\.googleusercontent\.com)$/.test(value);
  function connect(withCatalog = false) {
    if (ready) return ready;
    const url = new URL(window.HF_CONNECTION?.gasUrl || '', location.href);
    if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) throw network();
    nonce = random(32); peer = null; peerOrigin = null;
    const connectionNonce = nonce;
    url.search = new URLSearchParams({ view: 'bridge', origin: location.origin, nonce });
    if (withCatalog) url.searchParams.set('initial', 'catalog');
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
          if (withCatalog && Object.prototype.hasOwnProperty.call(message, 'initialCatalog')) initialCatalog = message.initialCatalog;
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
  const loadCatalogBridge = async () => {
    const started = Date.now();
    await connect(true);
    if (initialCatalog !== undefined) {
      const result = initialCatalog; initialCatalog = undefined; // 1回だけ利用。以降は現在の情報を取得する。
      window.hfPerformance.record('catalogInitial', Date.now() - started, result && result.performance);
      if (!result || typeof result.ok !== 'boolean') throw network();
      if (!result.ok) throw result.error || network();
      return result;
    }
    // 旧GASとの段階更新・別画面から既に接続済みの場合も従来APIで動く。
    const result = await window.hfRpc('getPublicCatalog');
    window.hfPerformance.record('catalogFallback', Date.now() - started, result.performance);
    return result;
  };
  let directCatalog;
  function loadCatalogDirect() {
    const url = new URL(window.HF_CONNECTION?.gasUrl || '', location.href);
    if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) throw network();
    const callback = '__hf_catalog_' + random(16);
    url.search = new URLSearchParams({ view: 'catalog', origin: location.origin, callback });
    const script = document.createElement('script');
    script.async = true; script.referrerPolicy = 'no-referrer';
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); delete window[callback]; script.remove(); };
      const failed = () => { cleanup(); reject(network()); };
      const timeout = setTimeout(failed, 15000);
      window[callback] = result => {
        cleanup();
        if (!result || typeof result.ok !== 'boolean') { reject(network()); return; }
        window.hfPerformance.record('catalogDirect', Date.now() - started, result.performance);
        // 正本のエラーはそのまま伝える。失敗した公開APIを別経路で隠さない。
        resolve(result);
      };
      script.onerror = failed;
      script.onload = () => { if (Object.prototype.hasOwnProperty.call(window, callback)) failed(); };
      script.src = url.href; document.body.append(script);
    });
  }
  window.hfLoadCatalog = async () => {
    if (window.HF_CONNECTION?.catalogTransport === 'bridge') return loadCatalogBridge();
    // 同時呼出しだけを共有し、次回取得は新しい正本を読む。
    if (!directCatalog) {
      const started = Date.now();
      directCatalog = (async () => {
        let result;
        try { result = await loadCatalogDirect(); }
        catch (_) {
          window.hfPerformance.record('catalogDirectFallback', Date.now() - started);
          return loadCatalogBridge();
        }
        if (!result.ok) throw result.error || network();
        return result;
      })().finally(() => { directCatalog = null; });
    }
    return directCatalog;
  };
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

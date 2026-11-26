// キャッシュは消失・容量超過・障害時に正本へ戻す。公開内容の更新前に世代を変更する。
function publicCacheKey_(config, kind, version) {
  return 'hf_' + kind + '_' + digest_(config, 'public-cache', JSON.stringify([
    config.spreadsheetId, config.eventId, config.imageFolderId,
    config.properties.getProperty('HF_PUBLICATION_CONFIG_JSON') || '', version
  ]));
}

function cachedPublicJson_(key) {
  try {
    const cache = CacheService.getScriptCache();
    const raw = cache.get(key);
    if (raw === null) { cacheEvent_('jsonMiss'); return null; }
    let meta;
    try { meta = JSON.parse(raw); } catch (_) { cacheEvent_('jsonInvalid'); return null; }
    if (meta && Object.prototype.hasOwnProperty.call(meta, 'data')) { cacheEvent_('jsonHit'); return meta.data; }
    if (!meta || !Number.isInteger(meta.parts) || meta.parts < 1 || meta.parts > 60 || typeof meta.tag !== 'string') { cacheEvent_('jsonInvalid'); return null; }
    const keys = Array.from({ length: meta.parts }, function (_, index) { return key + ':' + meta.tag + ':' + index; });
    const chunks = cache.getAll(keys);
    if (keys.some(function (part) { return typeof chunks[part] !== 'string'; })) { cacheEvent_('jsonPartial'); return null; }
    let data;
    try { data = JSON.parse(keys.map(function (part) { return chunks[part]; }).join('')); }
    catch (_) { cacheEvent_('jsonInvalid'); return null; }
    cacheEvent_('jsonHit'); return data;
  } catch (_) { cacheEvent_('jsonReadError'); return null; }
}

function keepPublicJson_(key, value, seconds) {
  return timed_('cacheWrite', function () {
  try {
    const serialized = JSON.stringify(value);
    const cache = CacheService.getScriptCache();
    if (serialized.length <= 12000) {
      const payload = '{"data":' + serialized + '}';
      cache.put(key, payload, seconds); cacheEvent_('jsonStored');
      verifyCacheWrite_(cache, key, payload);
      return;
    }
    const pieces = [];
    for (let start = 0; start < serialized.length;) {
      let end = Math.min(start + 12000, serialized.length);
      const last = serialized.charCodeAt(end - 1);
      if (end < serialized.length && last >= 0xd800 && last <= 0xdbff) end--;
      pieces.push(serialized.slice(start, end)); start = end;
    }
    const parts = pieces.length;
    if (!parts || parts > 60) { cacheEvent_('jsonOversize'); return; }
    const tag = Utilities.getUuid();
    const chunks = {};
    for (let index = 0; index < parts; index++) chunks[key + ':' + tag + ':' + index] = pieces[index];
    cache.putAll(chunks, seconds);
    // 各項目100KB以下。全チャンク保存後にメタデータを置き、欠落時は再構築する。
    const payload = JSON.stringify({ tag: tag, parts: parts });
    cache.put(key, payload, seconds); cacheEvent_('jsonStored');
    verifyCacheWrite_(cache, key, payload);
  } catch (_) { cacheEvent_('jsonWriteError'); /* キャッシュの失敗は公開・保存を失敗させない。 */ }
  });
}

function verifyCacheWrite_(cache, key, payload) {
  // 計測時だけ、書込直後に読めるか確認する。内容やキーは診断へ出さない。
  if (!HF_REQUEST_ || !HF_REQUEST_.diagnostics) return;
  try { cacheEvent_(cache.get(key) === payload ? 'jsonWriteVerified' : 'jsonWriteMissing'); }
  catch (_) { cacheEvent_('jsonReadbackError'); }
}

function cachedSmallImage_(key) {
  try { return CacheService.getScriptCache().get(key); } catch (_) { return null; }
}

function keepSmallImage_(key, base64) {
  try {
    if (base64.length <= 80000) CacheService.getScriptCache().put(key, base64, 300);
  } catch (_) { /* 画像は検証済みの正本から返せる。 */ }
}

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
    const meta = JSON.parse(cache.get(key) || 'null');
    if (!meta || !Number.isInteger(meta.parts) || meta.parts < 1 || meta.parts > 60 || typeof meta.tag !== 'string') return null;
    const keys = Array.from({ length: meta.parts }, function (_, index) { return key + ':' + meta.tag + ':' + index; });
    const chunks = cache.getAll(keys);
    if (keys.some(function (part) { return typeof chunks[part] !== 'string'; })) return null;
    return JSON.parse(keys.map(function (part) { return chunks[part]; }).join(''));
  } catch (_) { return null; }
}

function keepPublicJson_(key, value, seconds) {
  try {
    const serialized = JSON.stringify(value);
    const pieces = [];
    for (let start = 0; start < serialized.length;) {
      let end = Math.min(start + 12000, serialized.length);
      const last = serialized.charCodeAt(end - 1);
      if (end < serialized.length && last >= 0xd800 && last <= 0xdbff) end--;
      pieces.push(serialized.slice(start, end)); start = end;
    }
    const parts = pieces.length;
    if (!parts || parts > 60) return;
    const cache = CacheService.getScriptCache(), tag = Utilities.getUuid();
    const chunks = {};
    for (let index = 0; index < parts; index++) chunks[key + ':' + tag + ':' + index] = pieces[index];
    cache.putAll(chunks, seconds);
    // 各項目100KB以下。全チャンク保存後にメタデータを置き、欠落時は再構築する。
    cache.put(key, JSON.stringify({ tag: tag, parts: parts }), seconds);
  } catch (_) { /* キャッシュの失敗は公開・保存を失敗させない。 */ }
}

function cachedSmallImage_(key) {
  try { return CacheService.getScriptCache().get(key); } catch (_) { return null; }
}

function keepSmallImage_(key, base64) {
  try {
    if (base64.length <= 80000) CacheService.getScriptCache().put(key, base64, 300);
  } catch (_) { /* 画像は検証済みの正本から返せる。 */ }
}

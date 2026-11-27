// 正本とは別の永続公開版。全関数は内部用。運営認証済みの再生成で初回有効化する。
const HF_SNAPSHOT_SCHEMA_ = ['scope', 'build', 'kind', 'part', 'payload'];

function snapshotProperty_(config) {
  return 'HF_PUBLIC_SNAPSHOT_' + digest_(config, 'snapshot-owner', JSON.stringify([config.spreadsheetId, config.eventId]));
}

function publicationGeneration_(config) {
  return config.properties.getProperty('HF_PUBLIC_GENERATION_' + config.eventId)
    || config.properties.getProperty('HF_PUBLIC_GENERATION') || 'initial';
}

function snapshotManifest_(config) {
  const raw = config.properties.getProperty(snapshotProperty_(config));
  if (!raw) return null; // 既存環境は初回有効化まで従来経路を維持する。
  try {
    const manifest = JSON.parse(raw);
    if (manifest.version !== 1 || manifest.scope !== publicCacheKey_(config, 'snapshot', 'v1')
        || typeof manifest.build !== 'string' || !/^[a-f0-9]{32}$/.test(manifest.build)
        || manifest.generation !== publicationGeneration_(config)) throw Error();
    ['catalog', 'imageIndex'].forEach(function (kind) {
      const part = manifest[kind];
      if (!part || !Number.isSafeInteger(part.row) || part.row < 2 || !Number.isSafeInteger(part.count)
          || part.count < 1 || part.count > 1000 || !/^[a-f0-9]{64}$/.test(part.hash)) throw Error();
    });
    return manifest;
  } catch (_) { fail_('PUBLICATION_PENDING', '公開データの更新が完了していません。時間をおいて再読み込みしてください。'); }
}

function readPublicSnapshot_(config, manifest, kind) {
  const key = publicCacheKey_(config, 'snapshot-' + kind, manifest.build);
  const cached = timed_('catalogCache', function () { return cachedPublicJson_(key); });
  if (cached) return cached;
  return timed_('snapshotRead', function () {
    try {
      const sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName('PublicSnapshots');
      const part = manifest[kind];
      if (!sheet) throw Error();
      const rows = sheet.getRange(part.row, 1, part.count, HF_SNAPSHOT_SCHEMA_.length).getValues();
      const serialized = rows.map(function (row, index) {
        if (row[0] !== manifest.scope || row[1] !== manifest.build || row[2] !== kind || row[3] !== index
            || typeof row[4] !== 'string' || row[4].slice(0, 5) !== 'json:') throw Error();
        return row[4].slice(5);
      }).join('');
      if (digest_(config, 'snapshot-' + kind, serialized) !== part.hash) throw Error();
      const value = JSON.parse(serialized);
      keepPublicJson_(key, value, 60);
      return value;
    } catch (_) { fail_('PUBLICATION_PENDING', '公開データを取得できませんでした。運営による再生成が必要です。'); }
  });
}

function invalidatePublication_(properties) {
  const generation = Utilities.getUuid();
  properties.setProperty('HF_PUBLIC_GENERATION', generation);
  properties.setProperty('HF_PUBLIC_GENERATION_' + properties.getProperty('HF_EVENT_ID'), generation);
  if (HF_REQUEST_) HF_REQUEST_.publicationChanged = true;
}

function writePublicSnapshot_(config) {
  return timed_('snapshotBuild', function () {
    const built = buildPublicCatalogData_(config);
    const values = { catalog: built.data, imageIndex: buildPublicImageIndex_(config, built.settings) };
    const spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
    let sheet = spreadsheet.getSheetByName('PublicSnapshots');
    if (!sheet) sheet = spreadsheet.insertSheet('PublicSnapshots');
    if (!sheet.getLastRow()) sheet.getRange(1, 1, 1, HF_SNAPSHOT_SCHEMA_.length).setValues([HF_SNAPSHOT_SCHEMA_]);
    if (JSON.stringify(sheet.getRange(1, 1, 1, HF_SNAPSHOT_SCHEMA_.length).getValues()[0]) !== JSON.stringify(HF_SNAPSHOT_SCHEMA_)) {
      fail_('SCHEMA', '公開版保存先の構造が一致しません。運営に確認してください。');
    }
    const manifest = { version: 1, scope: publicCacheKey_(config, 'snapshot', 'v1'),
      build: Utilities.getUuid().replace(/-/g, ''), generation: publicationGeneration_(config) };
    let previous;
    try { previous = JSON.parse(config.properties.getProperty(snapshotProperty_(config)) || 'null'); } catch (_) { /* 再生成で復旧する。 */ }
    ['catalog', 'imageIndex'].forEach(function (kind) {
      const serialized = JSON.stringify(values[kind]);
      const pieces = [];
      for (let start = 0; start < serialized.length;) {
        let end = Math.min(start + 12000, serialized.length);
        const last = serialized.charCodeAt(end - 1);
        if (end < serialized.length && last >= 0xd800 && last <= 0xdbff) end--;
        pieces.push(serialized.slice(start, end)); start = end;
      }
      if (!pieces.length || pieces.length > 1000) fail_('PUBLICATION_LIMIT', '公開データが大きすぎます。運営に確認してください。');
      // 同じ開催回の領域を再利用する。増量時だけ末尾に拡張し、他開催回を上書きしない。
      const old = previous && previous.scope === manifest.scope && previous[kind];
      const row = old && Number.isSafeInteger(old.row) && old.row >= 2 && old.count >= pieces.length
        ? old.row : sheet.getLastRow() + 1;
      const rows = pieces.map(function (piece, index) { return [manifest.scope, manifest.build, kind, index, 'json:' + piece]; });
      timed_('snapshotWrite', function () {
        const endRow = row + rows.length - 1;
        if (endRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), endRow - sheet.getMaxRows());
        sheet.getRange(row, 1, rows.length, HF_SNAPSHOT_SCHEMA_.length).setValues(rows);
        SpreadsheetApp.flush();
      });
      manifest[kind] = { row: row, count: rows.length, hash: digest_(config, 'snapshot-' + kind, serialized) };
    });
    // 書込・flush完了後に公開版を一度で切り替える。途中失敗では世代不一致のまま取得を停止する。
    config.properties.setProperty(snapshotProperty_(config), JSON.stringify(manifest));
    return manifest;
  });
}

function refreshPublicSnapshotAfterWrite_() {
  if (!HF_REQUEST_ || (!HF_REQUEST_.publicationChanged && !HF_REQUEST_.publicationRetry)) return;
  locked_(function () {
    freshRequestConfig_();
    const config = config_(true);
    if (!config.properties.getProperty(snapshotProperty_(config))) return;
    try { if (snapshotManifest_(config)) return; } catch (_) { /* 未完了版を現在の正本から修復する。 */ }
    try { writePublicSnapshot_(config); }
    catch (_) { fail_('PUBLICATION_PENDING', '内容は保存済みですが、公開反映が完了していません。同じ保存を再試行してください。登録後の場合はログインしてください。'); }
  });
}

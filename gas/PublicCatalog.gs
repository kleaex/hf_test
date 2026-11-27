// 正本から公開項目だけを構築し、保存前に世代を変える共有キャッシュで再利用する。承認・手動反映は不要。
function publicCatalog_() {
  const config = config_(true);
  const manifest = snapshotManifest_(config);
  if (manifest) return readPublicSnapshot_(config, manifest, 'catalog');
  const key = publicCacheKey_(config, 'catalog', publicationGeneration_(config));
  const cached = timed_('catalogCache', function () { return cachedPublicJson_(key); });
  if (cached) { cached.generatedAt = Date.now(); return cached; }
  const built = buildPublicCatalogData_(config), data = built.data;
  timed_('imageIndexSeed', function () { return publicImageIndex_(config, built.settings); });
  keepPublicJson_(key, data, 60);
  return data;
}

function buildPublicCatalogData_(config) {
  let settings;
  const data = timed_('catalogBuild', function () {
    settings = publicationSettings_(config);
    return buildCatalogRelease_(config, settings, 'rel_1000000000000_000000000000', Date.now(), false, true).catalog;
  });
  data.live = true;
  delete data.releaseId;
  data.exhibitors.forEach(function (exhibitor) {
    exhibitor.publications.forEach(function (book) {
      book.images = book.images.map(function (image) {
        return { id: image.src.match(/img_[a-f0-9]{32}/)[0], width: image.width, height: image.height };
      });
    });
  });
  return { data: data, settings: settings };
}

function publicImage_(imageId, variant) {
  const result = publicImages_([imageId], variant).images[0];
  if (!result.ok) fail_(result.error.code, result.error.message);
  return { contentType: result.contentType, base64: result.base64 };
}

function publicImageIndex_(config, settings) {
  const manifest = snapshotManifest_(config);
  if (manifest) return readPublicSnapshot_(config, manifest, 'imageIndex');
  const key = publicCacheKey_(config, 'imageIndex', publicationGeneration_(config));
  const cached = timed_('catalogCache', function () { return cachedPublicJson_(key); });
  if (cached) return cached;
  const images = buildPublicImageIndex_(config, settings);
  keepPublicJson_(key, images, 60);
  return images;
}

function buildPublicImageIndex_(config, settings) {
  const selections = (settings || publicationSettings_(config)).exhibitors;
  const records = HF_REQUEST_ && HF_REQUEST_.sheets.Exhibitors || rows_(database_(config, ['Exhibitors']).Exhibitors);
  const images = Object.create(null);
  selections.forEach(function (selection) {
    const matches = records.filter(function (record) { return record.values[0] === selection.exhibitorId; });
    if (matches.length > 1) fail_('SCHEMA', '保存先に重複があります。運営に確認してください。');
    const record = matches[0];
    if (!record || record.values[1] !== config.eventId) return;
    json_(record.values[2]).publications.forEach(function (book) {
      (book.images || []).forEach(function (image) { images[image.id] = image; });
    });
  });
  // Drive ID等を含む索引はGAS内だけに保存し、API応答へ返さない。
  return images;
}

function publicImages_(imageIds, variant) {
  if (!Array.isArray(imageIds) || imageIds.length < 1 || imageIds.length > 3
      || imageIds.some(function (id, index) { return typeof id !== 'string' || !/^img_[a-f0-9]{32}$/.test(id) || imageIds.indexOf(id) !== index; })
      || ['thumbnail', 'full'].indexOf(variant) < 0) fail_('NOT_FOUND', '公開画像が見つかりません。');
  // 変更と競合する公開対象の確認だけをロックする。遅いDrive読取で他の画像・保存を待たせない。
  const snapshot = locked_(function () {
    const config = config_(true);
    const images = publicImageIndex_(config);
    const selected = Object.create(null);
    imageIds.forEach(function (id) {
      const image = images[id];
      if (image) selected[id] = variant === 'thumbnail' && image.thumbnail ? image.thumbnail : image;
    });
    return { config: config, images: selected };
  });
  let folder;
  return { images: imageIds.map(function (id) {
    return Object.assign({ id: id }, api_(function () {
      const image = snapshot.images[id];
      if (!image) fail_('NOT_FOUND', '公開画像が見つかりません。');
      if (!folder) folder = imageFolder_(snapshot.config, true);
      return { contentType: image.contentType, base64: Utilities.base64Encode(storedImageBytes_(snapshot.config, image, folder, variant === 'thumbnail')) };
    }));
  }) };
}

// 正本の保存済み公開項目のみを都度読み出す。公開用コピーの更新・承認を必要としない。
function publicCatalog_() {
  const config = config_();
  const data = buildCatalogRelease_(config, publicationSettings_(config), 'rel_1000000000000_000000000000', Date.now(), false, true).catalog;
  data.live = true;
  delete data.releaseId;
  data.exhibitors.forEach(function (exhibitor) {
    exhibitor.publications.forEach(function (book) {
      book.images = book.images.map(function (image) {
        return { id: image.src.match(/img_[a-f0-9]{32}/)[0], width: image.width, height: image.height };
      });
    });
  });
  return data;
}

function publicImage_(imageId, variant) {
  const result = publicImages_([imageId], variant).images[0];
  if (!result.ok) fail_(result.error.code, result.error.message);
  return { contentType: result.contentType, base64: result.base64 };
}

function publicImages_(imageIds, variant) {
  if (!Array.isArray(imageIds) || imageIds.length < 1 || imageIds.length > 3
      || imageIds.some(function (id, index) { return typeof id !== 'string' || !/^img_[a-f0-9]{32}$/.test(id) || imageIds.indexOf(id) !== index; })
      || ['thumbnail', 'full'].indexOf(variant) < 0) fail_('NOT_FOUND', '公開画像が見つかりません。');
  // 変更と競合する公開対象の確認だけをロックする。遅いDrive読取で他の画像・保存を待たせない。
  const snapshot = locked_(function () {
    const config = config_();
    const selections = publicationSettings_(config).exhibitors;
    const records = rows_(database_(config).Exhibitors);
    const images = Object.create(null);
    selections.forEach(function (selection) {
      const matches = records.filter(function (record) { return record.values[0] === selection.exhibitorId; });
      if (matches.length > 1) fail_('SCHEMA', '保存先に重複があります。運営に確認してください。');
      const record = matches[0];
      if (!record || record.values[1] !== config.eventId) return;
      json_(record.values[2]).publications.forEach(function (book) {
        (book.images || []).forEach(function (image) {
          if (imageIds.indexOf(image.id) >= 0) images[image.id] = variant === 'thumbnail' && image.thumbnail ? image.thumbnail : image;
        });
      });
    });
    return { config: config, images: images };
  });
  let folder;
  return { images: imageIds.map(function (id) {
    return Object.assign({ id: id }, api_(function () {
      const image = snapshot.images[id];
      if (!image) fail_('NOT_FOUND', '公開画像が見つかりません。');
      if (!folder) folder = imageFolder_(snapshot.config);
      return { contentType: image.contentType, base64: Utilities.base64Encode(storedImageBytes_(snapshot.config, image, folder)) };
    }));
  }) };
}

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
  if (typeof imageId !== 'string' || !/^img_[a-f0-9]{32}$/.test(imageId)
      || ['thumbnail', 'full'].indexOf(variant) < 0) fail_('NOT_FOUND', '公開画像が見つかりません。');
  const config = config_();
  const selections = publicationSettings_(config).exhibitors;
  const db = database_(config);
  let image;
  selections.forEach(function (selection) {
    const record = one_(db.Exhibitors, 0, selection.exhibitorId);
    if (!record || record.values[1] !== config.eventId) return;
    json_(record.values[2]).publications.forEach(function (book) {
      (book.images || []).forEach(function (item) { if (item.id === imageId) image = item; });
    });
  });
  if (!image) fail_('NOT_FOUND', '公開画像が見つかりません。');
  // 旧画像にはサムネイルがない。次の差し替えまでは遅延取得する元画像で互換性を保つ。
  const selected = variant === 'thumbnail' && image.thumbnail ? image.thumbnail : image;
  return { contentType: selected.contentType, base64: Utilities.base64Encode(storedImageBytes_(config, selected)) };
}

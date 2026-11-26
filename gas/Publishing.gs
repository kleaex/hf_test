/** 旧来のエディタ実行入口。通常は運営画面からプレビュー後に書き出す。 */
function exportCatalog_() {
  return locked_(function () {
    const config = config_();
    const now = Date.now();
    const releaseId = 'rel_' + now + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    const bundle = buildCatalogRelease_(config, publicationSettings_(config), releaseId, now, true);
    const result = writeCatalogZip_(config, bundle);
    delete result.fileId;
    return result;
  });
}

function buildCatalogRelease_(config, settings, releaseId, generatedAt, includeFiles, live) {
    keys_(settings, ['title', 'exhibitors', 'eventDate', 'venue']);
    const title = text_(settings.title, 120, true);
    const eventDate = text_(settings.eventDate || '', 10, false);
    const venue = text_(settings.venue || '', 200, false);
    if (eventDate && (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !Number.isFinite(Date.parse(eventDate)))) fail_('PUBLICATION_CONFIG', '開催日が不正です。');
    if (!Array.isArray(settings.exhibitors) || (!live && settings.exhibitors.length < 1) || settings.exhibitors.length > 10) {
      fail_('PUBLICATION_CONFIG', '公開対象の出店者を1〜10組指定してください。');
    }
    const db = database_(config);
    const blobs = [], selected = [], booths = [], imageIds = [], publicationIds = [];
    let totalBytes = 0;
    const exhibitors = settings.exhibitors.map(function (selection) {
      keys_(selection, ['exhibitorId', 'booth']);
      if (typeof selection.exhibitorId !== 'string' || !/^exh_[A-Za-z0-9_-]{1,50}$/.test(selection.exhibitorId) || selected.indexOf(selection.exhibitorId) >= 0) {
        fail_('PUBLICATION_CONFIG', '公開対象の出店者IDが不正または重複しています。');
      }
      selected.push(selection.exhibitorId);
      const booth = text_(selection.booth, 40, false);
      if (booth && booths.indexOf(booth) >= 0) fail_('PUBLICATION_CONFIG', 'ブース番号が重複しています。');
      if (booth) booths.push(booth);
      const record = one_(db.Exhibitors, 0, selection.exhibitorId);
      if (!record || record.values[1] !== config.eventId) fail_('PUBLICATION_CONFIG', '対象開催回の出店者が見つかりません。');
      const state = json_(record.values[2]);
      if (!Array.isArray(state.publications) || state.publications.length > 10) fail_('PUBLICATION_CONFIG', '作品一覧が不正です。');
      // フィールドを1つずつ選ぶ。認証・入金・内部メモ等は含めない。
      return { id: selection.exhibitorId, name: text_(state.profile.name, 80, true),
        genre: text_(state.profile.genre, 40, false), description: text_(state.profile.description, 2000, false),
        booth: booth, publications: state.publications.map(function (book) {
          if (typeof book.id !== 'string' || !/^pub_[a-f0-9]{32}$/.test(book.id) || publicationIds.indexOf(book.id) >= 0
              || !Number.isSafeInteger(book.price) || book.price < 0 || book.price > 1000000
              || ['新刊', '既刊', 'その他'].indexOf(book.releaseType) < 0) fail_('PUBLICATION_CONFIG', '作品情報が不正です。');
          publicationIds.push(book.id);
          const images = book.images || [];
          if (!Array.isArray(images) || images.length > 3) fail_('PUBLICATION_CONFIG', '画像一覧が不正です。');
          return { id: book.id, title: text_(book.title, 120, true), author: text_(book.author, 120, false),
            description: text_(book.description, 2000, false), price: book.price, releaseType: book.releaseType,
            images: images.map(function (image) {
              if (typeof image.id !== 'string' || !/^img_[a-f0-9]{32}$/.test(image.id) || imageIds.indexOf(image.id) >= 0
                  || ['image/jpeg', 'image/png'].indexOf(image.contentType) < 0) fail_('PUBLICATION_CONFIG', '画像情報が不正です。');
              imageIds.push(image.id);
              if (!Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > HF_IMAGE_MAX_
                  || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1
                  || image.width > 2400 || image.height > 2400) {
                fail_('IMAGE_INVALID', '公開画像の寸法・容量が一致しません。');
              }
              totalBytes += image.bytes;
              if (!live && totalBytes > 20000000) fail_('PUBLICATION_LIMIT', '書出しは画像合計20MBまでです。公開対象を見直してください。');
              const path = 'images/' + image.id + (image.contentType === 'image/png' ? '.png' : '.jpg');
              if (includeFiles) {
                const bytes = storedImageBytes_(config, image);
                const inspected = inspectImage_(bytes, image.contentType);
                if (inspected.width !== image.width || inspected.height !== image.height) fail_('IMAGE_INVALID', '公開画像の寸法が一致しません。');
                blobs.push(Utilities.newBlob(bytes, image.contentType, path));
              }
              return { src: './data/releases/' + releaseId + '/' + path, width: image.width, height: image.height };
            }) };
        }) };
    });
    const catalog = { schemaVersion: 1, sample: false, eventId: config.eventId, title: title,
      eventDate: eventDate, venue: venue, releaseId: releaseId, generatedAt: generatedAt, exhibitors: exhibitors };
    if (!includeFiles) return { catalog: catalog };
    blobs.unshift(Utilities.newBlob(JSON.stringify(catalog, null, 2) + '\n', 'application/json', 'catalog.json'));
    const manifest = { schemaVersion: 1, releaseId: releaseId, files: blobs.map(function (blob) {
      const bytes = blob.getBytes();
      return { path: blob.getName(), bytes: bytes.length, sha256: publicSha256_(bytes) };
    }) };
    blobs.push(Utilities.newBlob(JSON.stringify(manifest, null, 2) + '\n', 'application/json', 'manifest.json'));
    return { catalog: catalog, blobs: blobs, exhibitorCount: exhibitors.length, imageCount: imageIds.length };
}

function writeCatalogZip_(config, bundle) {
    const folderId = config.properties.getProperty('HF_EXPORT_FOLDER_ID') || '';
    if (!/^[A-Za-z0-9_-]{10,}$/.test(folderId) || folderId === config.imageFolderId) {
      fail_('PUBLICATION_CONFIG', '画像保存先とは別の非公開の書出し先フォルダを設定してください。');
    }
    const folder = DriveApp.getFolderById(folderId);
    privateDriveItem_(folder);
    const fileName = bundle.catalog.releaseId + '.zip';
    const existing = folder.getFilesByName(fileName);
    let file;
    if (existing.hasNext()) {
      file = existing.next(); privateDriveItem_(file);
      if (existing.hasNext()) fail_('PUBLICATION_CONFIG', '同じ公開版のファイルが重複しています。');
      const previous = Utilities.unzip(file.getBlob());
      const names = previous.map(function (blob) { return blob.getName(); });
      if (previous.length !== bundle.blobs.length || names.some(function (name, index) { return names.indexOf(name) !== index; }) || previous.some(function (blob) {
        const expected = bundle.blobs.find(function (item) { return item.getName() === blob.getName(); });
        return !expected || publicSha256_(expected.getBytes()) !== publicSha256_(blob.getBytes());
      })) fail_('PUBLICATION_CONFIG', '同じ公開版のファイル内容が一致しません。');
    } else file = folder.createFile(Utilities.zip(bundle.blobs, fileName));
    privateDriveItem_(file);
    return { releaseId: bundle.catalog.releaseId, fileName: fileName, fileId: file.getId(),
      exhibitorCount: bundle.exhibitorCount, imageCount: bundle.imageCount };
}

function publicSha256_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(function (byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
}

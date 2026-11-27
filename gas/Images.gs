// ブラウザーで調整したJPEG/PNGだけを受信。GIF/BMPは選択時に静止画へ変換する。
const HF_IMAGE_MAX_ = 1500000;

function imageFolder_(config, forRead) {
  return timed_('driveMetadata', function () {
    if (!/^[A-Za-z0-9_-]{10,}$/.test(config.imageFolderId)) fail_('IMAGE_CONFIG', '画像保存先が未設定です。運営に確認してください。');
    if (forRead && driveMetadataApiAvailable_()) {
      const metadata = privateReadMetadata_(config.imageFolderId);
      if (metadata.mimeType !== 'application/vnd.google-apps.folder') fail_('IMAGE_CONFIG', '画像保存先がフォルダではありません。');
      return { getId: function () { return config.imageFolderId; } };
    }
    const folder = DriveApp.getFolderById(config.imageFolderId);
    privateDriveItem_(folder);
    return folder;
  });
}

function privateDriveItem_(item) {
  return timed_('driveMetadataLegacy', function () {
    if (item.isTrashed() || !item.getOwner() || item.getSharingAccess() !== DriveApp.Access.PRIVATE
        || item.getEditors().length || item.getViewers().length) {
      fail_('IMAGE_CONFIG', '画像保存先または画像が共有されています。運営に確認してください。');
    }
    return null;
  });
}

function imageBytes_(request) {
  if (['image/jpeg', 'image/png'].indexOf(request.contentType) < 0 || typeof request.base64 !== 'string'
      || !request.base64.length || request.base64.length > 2000000
      || request.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.base64)) {
    fail_('IMAGE_INVALID', '調整後のJPEG/PNG画像を1.5MB以内で送信してください。');
  }
  const bytes = Utilities.base64Decode(request.base64);
  if (!bytes.length || bytes.length > HF_IMAGE_MAX_ || Utilities.base64Encode(bytes) !== request.base64) fail_('IMAGE_INVALID', '画像の容量・符号化を確認してください。');
  return bytes;
}

function inspectImage_(signed, type) {
  const bytes = signed.map(function (byte) { return (byte + 256) % 256; });
  const bad = function () { fail_('IMAGE_INVALID', '画像ファイルの内容を確認できません。別の画像を選択してください。'); };
  const u16 = function (at) { return bytes[at] * 256 + bytes[at + 1]; };
  const u32 = function (at) { return bytes[at] * 16777216 + bytes[at + 1] * 65536 + bytes[at + 2] * 256 + bytes[at + 3]; };
  let width, height;
  const clean = [];
  if (type === 'image/png') {
    if (bytes.slice(0, 8).join(',') !== '137,80,78,71,13,10,26,10') return bad();
    let at = 8, idat = false, end = false;
    bytes.slice(0, 8).forEach(function (byte) { clean.push(byte); });
    while (at + 12 <= bytes.length) {
      const length = u32(at);
      const name = String.fromCharCode.apply(null, bytes.slice(at + 4, at + 8));
      if (!Number.isSafeInteger(length) || at + length + 12 > bytes.length || end) return bad();
      if (at === 8) {
        if (name !== 'IHDR' || length !== 13) return bad();
        width = u32(at + 8); height = u32(at + 12);
      } else if (name === 'IHDR') return bad();
      if (name === 'acTL' || name === 'fcTL' || name === 'fdAT') return bad();
      if (name === 'IDAT') idat = true;
      if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].indexOf(name) >= 0) {
        for (let index = at; index < at + length + 12; index++) clean.push(bytes[index]);
      } else if (name[0] === name[0].toUpperCase()) return bad();
      at += length + 12;
      if (name === 'IEND') { if (length !== 0) return bad(); end = true; break; }
    }
    if (!idat || !end || at !== bytes.length) return bad();
  } else if (type === 'image/jpeg') {
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) return bad();
    clean.push(255, 216);
    let at = 2, scan = false;
    while (at + 4 <= bytes.length) {
      const start = at;
      if (bytes[at++] !== 255) return bad();
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      const length = u16(at);
      if (length < 2 || at + length > bytes.length) return bad();
      if (marker === 193 || marker === 194) return bad();
      if (marker === 192) {
        if (width || length < 8) return bad();
        height = u16(at + 3); width = u16(at + 5);
      }
      // EXIF・ICC・コメント等を保存しない。Canvas出力の画素を前提にする。
      if (!((marker >= 225 && marker <= 237) || marker === 239 || marker === 254)) {
        for (let index = start; index < at + length; index++) clean.push(bytes[index]);
      }
      at += length;
      if (marker === 218) {
        // 単一走査のJPEGに限定し、走査後へ隠されたメタデータや別形式を拒否する。
        let cursor = at, ended = false;
        while (cursor < bytes.length) {
          if (bytes[cursor++] !== 255) continue;
          while (bytes[cursor] === 255) cursor++;
          const code = bytes[cursor++];
          if (code === 0 || (code >= 208 && code <= 215)) continue;
          if (code === 217 && cursor === bytes.length) { ended = true; break; }
          return bad();
        }
        if (!ended) return bad();
        for (let index = at; index < bytes.length; index++) clean.push(bytes[index]);
        scan = true; break;
      }
    }
    if (!scan) return bad();
  } else return bad();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2400 || height > 2400) return bad();
  return { width: width, height: height, bytes: clean.map(function (byte) { return byte > 127 ? byte - 256 : byte; }) };
}

function validateImage_(request) {
  const inspected = inspectImage_(imageBytes_(request), request.contentType);
  try {
    // 宣言・ヘッダーだけで判断しない。異なる形式への実変換でGoogleのデコーダーを通す。
    const opposite = request.contentType === 'image/png' ? 'image/jpeg' : 'image/png';
    const converted = Utilities.newBlob(inspected.bytes, request.contentType).getAs(opposite);
    const decoded = inspectImage_(converted.getBytes(), opposite);
    if (decoded.width !== inspected.width || decoded.height !== inspected.height) throw new Error('dimensions');
  } catch (_) { fail_('IMAGE_INVALID', '画像を読み込めませんでした。別の画像で再試行してください。'); }
  return inspected;
}

function checkImageUpload_(token, request, staged) {
  const context = authenticate_(token);
  keys_(request, staged ? ['publicationId', 'revision', 'requestId', 'contentType', 'base64', 'thumbnail'] : ['publicationId', 'revision', 'requestId', 'contentType', 'base64']);
  if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(request.requestId)
      || !Number.isSafeInteger(request.revision) || request.revision < 0) fail_('VALIDATION', '画像の保存要求が正しくありません。');
  const state = json_(context.record.values[2]);
  const book = state.publications.find(function (item) { return item.id === request.publicationId; })
    || (staged && /^draft_[a-f0-9]{32}$/.test(request.publicationId || '') ? { id: request.publicationId, images: [] } : null);
  if (!book) fail_('FORBIDDEN', 'この出店者に属さない作品へ画像を登録できません。');
  const bytes = imageBytes_(request);
  const fingerprintInput = { publicationId: request.publicationId,
    revision: request.revision, contentType: request.contentType, base64: request.base64 };
  if (staged) { fingerprintInput.staged = true; fingerprintInput.thumbnail = request.thumbnail || null; }
  const fingerprint = digest_(context.config, 'image-request', JSON.stringify(fingerprintInput));
  const receipt = state.receipts.find(function (item) { return item.id === request.requestId; });
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) fail_('REQUEST_REUSED', '同じ保存要求IDを別の画像には使用できません。');
    return { replay: { data: view_(context.record), replayed: true, savedRevision: receipt.revision } };
  }
  requireEditing_(context.config);
  if (state.revision !== request.revision) fail_('CONFLICT', '別の画面で更新されています。保存済みの内容を読み直してください。');
  const draft = (state.stagedImages || []).filter(function (item) { return item.expiresAt > Date.now(); });
  if (staged && draft.length >= 10) fail_('IMAGE_LIMIT', '仮保存画像は10点までです。保存するか、有効期限後に再試行してください。');
  if (!staged && (book.images || []).length >= 3) fail_('IMAGE_LIMIT', '1作品に登録できる画像は3点までです。');
  const budget = state.imageBudget || {};
  const day = Math.floor(Date.now() / 86400000);
  if (budget.day === day && (budget.count >= 30 || budget.bytes + bytes.length > 30000000)) fail_('IMAGE_LIMIT', '本日の画像登録上限に達しました。運営に確認してください。');
  let uploadedBytes = bytes.length;
  if (staged) {
    keys_(request.thumbnail, ['contentType', 'base64']);
    const smallBytes = imageBytes_(request.thumbnail);
    if (smallBytes.length > 120000) fail_('IMAGE_INVALID', 'サムネイルは120KB以内にしてください。');
    uploadedBytes += smallBytes.length;
  }
  if (budget.day === day && budget.bytes + uploadedBytes > 30000000) fail_('IMAGE_LIMIT', '本日の画像登録上限に達しました。運営に確認してください。');
  return { context: context, state: state, book: book, draft: draft, budget: budget, day: day,
    fingerprint: fingerprint, uploadedBytes: uploadedBytes };
}

function prepareImageUpload_(context, request, staged) {
  const folder = imageFolder_(context.config);
  const validated = timed_('imageValidate', function () { return validateImage_(request); });
  let thumbnail;
  if (staged) {
    keys_(request.thumbnail, ['contentType', 'base64']);
    const small = timed_('thumbnailValidate', function () { return validateImage_(request.thumbnail); });
    if (small.width > 400 || small.height > 400 || small.bytes.length > 120000) fail_('IMAGE_INVALID', 'サムネイルは長辺400px・120KB以内にしてください。');
    thumbnail = { bytes: small.bytes, contentType: request.thumbnail.contentType, width: small.width, height: small.height };
  }
  return timed_('driveSave', function () {
    const hash = digest_(context.config, 'image-bytes', Utilities.base64Encode(validated.bytes));
    const fileName = 'hf_' + digest_(context.config, 'image-file', context.config.eventId + ':' + context.record.values[0] + ':' + request.requestId)
      + (request.contentType === 'image/png' ? '.png' : '.jpg');
    const files = folder.getFilesByName(fileName);
    let file;
    if (files.hasNext()) {
      file = files.next();
      if (files.hasNext()) fail_('IMAGE_CONFIG', '画像保存先に重複があります。運営に確認してください。');
      if (digest_(context.config, 'image-bytes', Utilities.base64Encode(file.getBlob().getBytes())) !== hash) {
        fail_('REQUEST_REUSED', '同じ保存要求IDを別の画像には使用できません。');
      }
    } else file = folder.createFile(Utilities.newBlob(validated.bytes, request.contentType, fileName));
    privateDriveItem_(file);
    const image = { id: 'img_' + random_(context.config, 'image-id').slice(0, 32), fileId: file.getId(),
      contentType: request.contentType, width: validated.width, height: validated.height,
      bytes: validated.bytes.length, hash: hash };
    if (thumbnail) {
      const name = fileName + '.thumbnail';
      const matches = folder.getFilesByName(name);
      const existed = matches.hasNext();
      const smallFile = existed ? matches.next() : folder.createFile(Utilities.newBlob(thumbnail.bytes, thumbnail.contentType, name));
      privateDriveItem_(smallFile);
      const smallHash = digest_(context.config, 'image-bytes', Utilities.base64Encode(thumbnail.bytes));
      if (matches.hasNext() || (existed && digest_(context.config, 'image-bytes', Utilities.base64Encode(smallFile.getBlob().getBytes())) !== smallHash)) fail_('REQUEST_REUSED', '画像の再送内容が一致しません。');
      image.thumbnail = { fileId: smallFile.getId(), contentType: thumbnail.contentType, width: thumbnail.width,
        height: thumbnail.height, bytes: thumbnail.bytes.length, hash: smallHash };
    }
    return image;
  });
}

function commitImageUpload_(checked, request, image, staged) {
  const context = checked.context, state = checked.state, book = checked.book, draft = checked.draft;
  const budget = checked.budget, day = checked.day;
  if (staged) state.stagedImages = draft.concat([{ publicationId: book.id, expiresAt: Date.now() + 86400000, image: image }]);
  else book.images = (book.images || []).concat([image]);
  state.revision++;
  state.updatedAt = Date.now();
  state.imageBudget = { day: day, count: (budget.day === day ? budget.count : 0) + 1,
    bytes: (budget.day === day ? budget.bytes : 0) + checked.uploadedBytes };
  state.receipts = state.receipts.concat([{ id: request.requestId, fingerprint: checked.fingerprint, revision: state.revision,
    userId: context.user.values[0], savedAt: Date.now() }]).slice(-20);
  const serialized = JSON.stringify(state);
  if (serialized.length > 45000) fail_('VALIDATION', '保存データが大きすぎます。紹介文を短くしてください。');
  // ファイル作成後のSheets失敗でも、同じ要求の再送でファイルを再利用する。
  writeRow_(context.db.Exhibitors, context.record.row, [context.record.values[0], context.config.eventId, serialized], !staged);
  return { data: view_({ values: [context.record.values[0], context.config.eventId, serialized] }), replayed: false, savedRevision: state.revision };
}

function uploadImage_(token, request, staged) {
  const checked = checkImageUpload_(token, request, staged);
  if (checked.replay) return checked.replay;
  return commitImageUpload_(checked, request, prepareImageUpload_(checked.context, request, staged), staged);
}

function stageImage_(token, request) {
  // 同じ出店者の処理を1件予約し、重い画像変換・Drive作成は共通ロックの外で行う。
  const reservation = locked_(function () {
    const checked = timed_('imageAuthorize', function () { return checkImageUpload_(token, request, true); });
    if (checked.replay) return checked;
    const config = checked.context.config;
    const key = 'HF_UPLOAD_' + digest_(config, 'upload-reservation', config.eventId + ':' + checked.context.record.values[0]).slice(0, 32);
    const previous = json_(config.properties.getProperty(key) || 'null');
    if (previous && previous.until > Date.now()) fail_('BUSY', '画像を登録中です。少し待って同じ操作を再試行してください。');
    const lease = random_(config, 'upload-lease');
    config.properties.setProperty(key, JSON.stringify({ lease: lease, until: Date.now() + 10 * 60000 }));
    return { checked: checked, key: key, lease: lease };
  });
  if (reservation.replay) return reservation.replay;
  try {
    const image = prepareImageUpload_(reservation.checked.context, request, true);
    return locked_(function () {
      freshRequestConfig_();
      return timed_('imageCommit', function () {
        // 変換中のログアウト・停止・締切・他画面保存を反映して再検証する。
        const checked = checkImageUpload_(token, request, true);
        if (checked.replay) return checked.replay;
        const current = json_(checked.context.config.properties.getProperty(reservation.key) || 'null');
        if (!current || current.lease !== reservation.lease || current.until <= Date.now()) fail_('CONFLICT', '画像の登録予約が失効しました。保存済みの内容を確認してください。');
        return commitImageUpload_(checked, request, image, true);
      });
    });
  } finally {
    try { locked_(function () {
      const properties = reservation.checked.context.config.properties;
      const current = json_(properties.getProperty(reservation.key) || 'null');
      if (current && current.lease === reservation.lease) properties.deleteProperty(reservation.key);
    }); } catch (_) { /* 強制終了等の予約は10分で失効。同じ要求の結果確認は可能。 */ }
  }
}

function readImage_(token, imageId, variant) {
  const snapshot = locked_(function () {
    const context = authenticate_(token);
    if (variant !== undefined && ['thumbnail', 'full'].indexOf(variant) < 0) fail_('VALIDATION', '画像の種類が正しくありません。');
    const state = json_(context.record.values[2]);
    let image;
    state.publications.forEach(function (book) {
      (book.images || []).forEach(function (item) { if (item.id === imageId) image = item; });
  });
  (state.stagedImages || []).forEach(function (item) { if (item.expiresAt > Date.now() && item.image.id === imageId) image = item.image; });
  if (!image) fail_('FORBIDDEN', 'この出店者に属さない画像は取得できません。');
  return { config: context.config, image: variant === 'thumbnail' && image.thumbnail ? image.thumbnail : image };
  });
  return { contentType: snapshot.image.contentType, base64: Utilities.base64Encode(storedImageBytes_(snapshot.config, snapshot.image)) };
}

function storedImageBytes_(config, image, checkedFolder, sharedCache) {
  const folder = checkedFolder || imageFolder_(config, true);
  const metadata = timed_('driveMetadata', function () {
    if (driveMetadataApiAvailable_()) {
      const details = privateReadMetadata_(image.fileId);
      if (!Array.isArray(details.parents) || details.parents.length !== 1 || details.parents[0] !== folder.getId()) fail_('IMAGE_CONFIG', '画像の保存先が一致しません。');
      if (details.mimeType !== image.contentType) fail_('IMAGE_INVALID', '保存画像の種類が一致しません。');
      return { file: null, modified: sharedCache && image.bytes <= 60000 ? Date.parse(details.modifiedTime) : null };
    }
    const file = DriveApp.getFileById(image.fileId);
    privateDriveItem_(file);
    const parents = file.getParents();
    if (!parents.hasNext() || parents.next().getId() !== folder.getId() || parents.hasNext()) fail_('IMAGE_CONFIG', '画像の保存先が一致しません。');
    return { file: file, modified: sharedCache && image.bytes <= 60000 ? file.getLastUpdated().getTime() : null };
  });
  const file = metadata.file;
  let key;
  // フォルダ・ファイルの非公開状態と所属を確認した後にのみ共有キャッシュを使う。
  // Driveの更新日時も鍵に含め、外部からのファイル変更を古い内容で覆い隠さない。
  if (sharedCache && image.bytes <= 60000) {
    key = publicCacheKey_(config, 'image', [image.fileId, image.hash, metadata.modified].join(':'));
    const cached = timed_('sharedImageCache', function () { return cachedSmallImage_(key); });
    if (typeof cached === 'string') {
      try {
        const stored = Utilities.base64Decode(cached);
        if (stored.length === image.bytes && digest_(config, 'image-bytes', cached) === image.hash) return stored;
      } catch (_) { /* キャッシュ破損時は正本を検証し直す。 */ }
    }
  }
  const bytes = timed_('driveRead', function () { return (file || DriveApp.getFileById(image.fileId)).getBlob().getBytes(); });
  if (bytes.length !== image.bytes || digest_(config, 'image-bytes', Utilities.base64Encode(bytes)) !== image.hash) fail_('IMAGE_INVALID', '保存画像の内容が一致しません。');
  if (key) keepSmallImage_(key, Utilities.base64Encode(bytes));
  return bytes;
}

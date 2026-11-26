const HF_ADMIN_SCHEMA_ = Object.freeze({
  Admins: ['adminId', 'email', 'enabled', 'authJson'],
  AdminSessions: ['adminId', 'tokenHash', 'issuedAt', 'expiresAt', 'revokedAt', 'emailHash', 'eventId'],
  EventSettings: ['eventId', 'stateJson']
});

function adminEmails_(config) {
  const values = json_(config.properties.getProperty('HF_ADMIN_EMAILS') || 'null');
  if (!Array.isArray(values) || !values.length || values.length > 5 || values.some(function (value) { return !email_(value); })
      || values.map(email_).some(function (value, index, all) { return all.indexOf(value) !== index; })) {
    fail_('ADMIN_CONFIG', '運営アカウントの初期設定が完了していません。');
  }
  return values.map(email_);
}

function checkAdminSheet_(sheet, name) {
  if (HF_REQUEST_) {
    sheetSnapshot_(sheet, name, HF_ADMIN_SCHEMA_[name], 'ADMIN_CONFIG', '運営画面用シートの初期設定が必要です。');
    return sheet;
  }
  if (!sheet || !sheet.getLastRow() || JSON.stringify(timed_('sheetHeader', function () { return sheet.getRange(1, 1, 1, HF_ADMIN_SCHEMA_[name].length).getValues()[0]; })) !== JSON.stringify(HF_ADMIN_SCHEMA_[name])) {
    fail_('ADMIN_CONFIG', '運営画面用シートの初期設定が必要です。');
  }
  return sheet;
}

function eventRecord_(config, required) {
  if (Object.prototype.hasOwnProperty.call(config, 'eventRecord')) {
    if (required && !config.eventRecord) fail_('ADMIN_CONFIG', '開催設定がありません。');
    return config.eventRecord;
  }
  const sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName('EventSettings');
  if (!sheet) { if (required) fail_('ADMIN_CONFIG', '運営画面の初期設定が必要です。'); config.eventRecord = null; return null; }
  checkAdminSheet_(sheet, 'EventSettings');
  const record = one_(sheet, 0, config.eventId);
  if (!record) { if (required) fail_('ADMIN_CONFIG', '開催設定がありません。'); config.eventRecord = null; return null; }
  config.eventRecord = { sheet: sheet, row: record.row, state: json_(record.values[1]) };
  return config.eventRecord;
}

function adminDatabase_(config) {
  const spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
  const result = {};
  Object.keys(HF_ADMIN_SCHEMA_).forEach(function (name) { result[name] = checkAdminSheet_(spreadsheet.getSheetByName(name), name); });
  return result;
}

/** 運営の初回登録・既存設定の移行。一時関数からエディタでのみ実行する。 */
function setupAdminConsole_() {
  return locked_(function () {
    const config = config_(); const emails = adminEmails_(config);
    const spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
    Object.keys(HF_ADMIN_SCHEMA_).forEach(function (name) {
      const existing = spreadsheet.getSheetByName(name);
      if (existing && existing.getLastRow()) checkAdminSheet_(existing, name);
    });
    Object.keys(HF_ADMIN_SCHEMA_).forEach(function (name) {
      const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
      if (!sheet.getLastRow()) writeRow_(sheet, 1, HF_ADMIN_SCHEMA_[name]);
    });
    const db = adminDatabase_(config);
    emails.forEach(function (email) {
      const existing = one_(db.Admins, 1, email);
      if (!existing) writeRow_(db.Admins, db.Admins.getLastRow() + 1, ['adm_' + Utilities.getUuid().replace(/-/g, ''), email, true, '{}']);
    });
    if (!eventRecord_(config, false)) {
      const legacy = json_(config.properties.getProperty('HF_PUBLICATION_CONFIG_JSON') || '{}');
      const current = rows_(database_(config).Exhibitors).filter(function (record) { return record.values[1] === config.eventId; });
      const selections = Array.isArray(legacy.exhibitors) ? legacy.exhibitors : [];
      const state = { revision: 0, title: typeof legacy.title === 'string' ? text_(legacy.title, 120, true) : '文芸の小さな市（実験）',
        eventDate: '', venue: '', editDeadline: config.editDeadline,
        exhibitors: current.map(function (record) {
          const chosen = selections.find(function (item) { return item.exhibitorId === record.values[0]; });
          return { exhibitorId: record.values[0], booth: chosen ? text_(chosen.booth, 40, false) : '', publish: !!chosen };
        }), receipts: [], releases: [], preview: null, updatedAt: null };
      writeRow_(db.EventSettings, db.EventSettings.getLastRow() + 1, [config.eventId, JSON.stringify(state)]);
    }
    return { ok: true, adminCount: emails.length };
  });
}

function requestAdminCode_(input) {
  const config = config_(); const emails = adminEmails_(config); const db = adminDatabase_(config);
  const email = email_(input);
  const response = { message: '登録済みのテスト宛先には確認コードを送信します。届かない場合は、時間をおいて運営に確認してください。' };
  if (!email || emails.indexOf(email) < 0) return response;
  const admin = one_(db.Admins, 1, email);
  if (!admin || !active_(admin.values[2])) return response;
  return sendChallenge_(config, db.Admins, admin, email, 'admin-code:' + admin.values[0] + ':' + email);
}

function verifyAdminCode_(input, code) {
  const config = config_(); const emails = adminEmails_(config); const db = adminDatabase_(config); const email = email_(input);
  const reject = function () { fail_('INVALID_CODE', '運営用コードを確認できません。有効期限・入力内容を確認してください。'); };
  if (!email || emails.indexOf(email) < 0) return reject();
  const admin = one_(db.Admins, 1, email);
  if (!admin || !active_(admin.values[2])) return reject();
  const auth = json_(admin.values[3]); const challenge = auth.challenge; const now = Date.now();
  if (!challenge || challenge.status !== 'ready' || challenge.used || challenge.expiresAt <= now || challenge.attempts >= 5) return reject();
  challenge.attempts++;
  const valid = typeof code === 'string' && /^\d{6}$/.test(code)
    && equal_(challenge.hash, digest_(config, 'admin-code:' + admin.values[0] + ':' + email, code));
  if (valid) challenge.used = true;
  const values = admin.values.slice(); values[3] = JSON.stringify(auth); writeRow_(db.Admins, admin.row, values);
  if (!valid) return reject();
  const token = random_(config, 'admin-session'); const previous = one_(db.AdminSessions, 0, admin.values[0]);
  writeRow_(db.AdminSessions, previous ? previous.row : db.AdminSessions.getLastRow() + 1,
    [admin.values[0], digest_(config, 'admin-session', token), now, now + 3600000, '', digest_(config, 'admin-email', email), config.eventId]);
  return { token: token, expiresAt: now + 3600000, data: adminDashboard_(authenticateAdmin_(token)) };
}

function authenticateAdmin_(token) {
  const config = config_(); const emails = adminEmails_(config); const adminDb = adminDatabase_(config);
  const reject = function () { fail_('UNAUTHENTICATED', '運営ログインが期限切れ、または利用停止されています。再ログインしてください。'); };
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return reject();
  const hash = digest_(config, 'admin-session', token);
  const session = one_(adminDb.AdminSessions, 1, hash);
  if (!session || session.values[4] || !Number.isFinite(session.values[3]) || session.values[3] <= Date.now() || session.values[6] !== config.eventId) return reject();
  const admin = one_(adminDb.Admins, 0, session.values[0]);
  if (!admin || !active_(admin.values[2]) || emails.indexOf(admin.values[1]) < 0
      || !equal_(session.values[5], digest_(config, 'admin-email', admin.values[1]))) return reject();
  return { config: config, adminDb: adminDb, admin: admin, session: session, db: database_(config) };
}

function releaseView_(release) {
  return { releaseId: release.releaseId, fileName: release.fileName, createdAt: release.createdAt,
    exhibitorCount: release.exhibitorCount, imageCount: release.imageCount,
    fileUrl: 'https://drive.google.com/file/d/' + encodeURIComponent(release.fileId) + '/view' };
}

function adminDashboard_(context) {
  const state = eventRecord_(context.config, true).state;
  const exhibitors = rows_(context.db.Exhibitors).filter(function (record) { return record.values[1] === context.config.eventId; });
  return { eventId: context.config.eventId, revision: state.revision, title: state.title, eventDate: state.eventDate,
    venue: state.venue, editDeadline: state.editDeadline, updatedAt: state.updatedAt,
    exhibitors: exhibitors.map(function (record) {
      const profile = json_(record.values[2]); const selection = state.exhibitors.find(function (item) { return item.exhibitorId === record.values[0]; });
      return { exhibitorId: record.values[0], name: profile.profile.name, publicationCount: profile.publications.length,
        imageCount: profile.publications.reduce(function (count, book) { return count + (book.images || []).length; }, 0),
        booth: selection ? selection.booth : '', publish: selection ? selection.publish : false };
    }), releases: (state.releases || []).slice().reverse().map(releaseView_) };
}

function saveEventRecord_(config, record) {
  const serialized = JSON.stringify(record.state);
  if (serialized.length > 45000) fail_('VALIDATION', '運営データが大きすぎます。');
  writeRow_(record.sheet, record.row, [config.eventId, serialized]);
}

function saveAdminEvent_(token, request) {
  const context = authenticateAdmin_(token);
  keys_(request, ['revision', 'requestId', 'title', 'eventDate', 'venue', 'editDeadline', 'exhibitors']);
  if (!Number.isSafeInteger(request.revision) || request.revision < 0 || typeof request.requestId !== 'string'
      || !/^[A-Za-z0-9_-]{16,80}$/.test(request.requestId)) fail_('VALIDATION', '設定の保存要求が不正です。');
  const next = { title: text_(request.title, 120, true), eventDate: text_(request.eventDate, 10, false),
    venue: text_(request.venue, 200, false), editDeadline: text_(request.editDeadline, 32, false), exhibitors: [] };
  if (next.eventDate && (!/^\d{4}-\d{2}-\d{2}$/.test(next.eventDate) || !Number.isFinite(Date.parse(next.eventDate))
      || new Date(next.eventDate + 'T00:00:00Z').toISOString().slice(0, 10) !== next.eventDate)) fail_('VALIDATION', '開催日を確認してください。');
  if (next.editDeadline && !editing_({ editDeadline: next.editDeadline }).deadline) fail_('VALIDATION', '編集期限はタイムゾーン付きの日時で指定してください。');
  if (!Array.isArray(request.exhibitors) || request.exhibitors.length > 10) fail_('VALIDATION', '出店者は10組までです。');
  const ids = [], booths = [];
  next.exhibitors = request.exhibitors.map(function (selection) {
    keys_(selection, ['exhibitorId', 'booth', 'publish']);
    if (typeof selection.exhibitorId !== 'string' || ids.indexOf(selection.exhibitorId) >= 0 || typeof selection.publish !== 'boolean') fail_('VALIDATION', '公開対象が不正です。');
    const record = one_(context.db.Exhibitors, 0, selection.exhibitorId);
    if (!record || record.values[1] !== context.config.eventId) fail_('FORBIDDEN', 'この開催回の出店者ではありません。');
    ids.push(selection.exhibitorId); const booth = text_(selection.booth, 40, false);
    if (booth && booths.indexOf(booth) >= 0) fail_('VALIDATION', 'ブース番号が重複しています。');
    if (booth) booths.push(booth);
    return { exhibitorId: selection.exhibitorId, booth: booth, publish: selection.publish };
  });
  const record = eventRecord_(context.config, true);
  const fingerprint = digest_(context.config, 'admin-save', JSON.stringify({ revision: request.revision, data: next }));
  const receipt = record.state.receipts.find(function (item) { return item.id === request.requestId; });
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) fail_('REQUEST_REUSED', '同じ保存要求IDを別内容には使用できません。');
    return { data: adminDashboard_(context), replayed: true };
  }
  if (record.state.revision !== request.revision) fail_('CONFLICT', '別の画面で設定が変更されています。入力を控えてから読み直してください。');
  Object.assign(record.state, next); record.state.revision++; record.state.updatedAt = Date.now(); record.state.preview = null;
  record.state.receipts = record.state.receipts.concat([{ id: request.requestId, fingerprint: fingerprint,
    revision: record.state.revision, adminId: context.admin.values[0], savedAt: Date.now() }]).slice(-20);
  saveEventRecord_(context.config, record);
  return { data: adminDashboard_(context), replayed: false };
}

function publicationSettings_(config) {
  const event = eventRecord_(config, false);
  if (event) return { title: event.state.title, eventDate: event.state.eventDate, venue: event.state.venue,
    exhibitors: event.state.exhibitors.filter(function (item) { return item.publish; }).map(function (item) { return { exhibitorId: item.exhibitorId, booth: item.booth }; }) };
  return json_(config.properties.getProperty('HF_PUBLICATION_CONFIG_JSON') || 'null');
}

function previewFingerprint_(context, settings) {
  return publicSha256_(Utilities.newBlob(JSON.stringify({ settings: settings,
    sources: settings.exhibitors.map(function (item) {
      const record = one_(context.db.Exhibitors, 0, item.exhibitorId);
      if (!record || record.values[1] !== context.config.eventId) fail_('FORBIDDEN', '公開対象が見つかりません。');
      return [item.exhibitorId, record.values[2]];
    }) })).getBytes());
}

function previewAdminCatalog_(token) {
  const context = authenticateAdmin_(token); const record = eventRecord_(context.config, true);
  const settings = publicationSettings_(context.config); const now = Date.now();
  const preview = { id: random_(context.config, 'admin-preview'), adminId: context.admin.values[0], createdAt: now,
    expiresAt: now + 600000, fingerprint: previewFingerprint_(context, settings),
    releaseId: 'rel_' + now + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12) };
  const bundle = buildCatalogRelease_(context.config, settings, preview.releaseId, now, false);
  record.state.preview = preview; saveEventRecord_(context.config, record);
  return { previewId: preview.id, expiresAt: preview.expiresAt, catalog: bundle.catalog };
}

function exportAdminCatalog_(token, request) {
  const context = authenticateAdmin_(token);
  keys_(request, ['previewId', 'requestId']);
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(request.requestId) || typeof request.previewId !== 'string') fail_('VALIDATION', '書き出し要求が不正です。');
  const record = eventRecord_(context.config, true);
  const existing = record.state.releases.find(function (item) { return item.requestId === request.requestId || item.previewId === request.previewId; });
  if (existing) {
    if (existing.previewId !== request.previewId) fail_('REQUEST_REUSED', '同じ要求IDを別の公開確認には使用できません。');
    return { release: releaseView_(existing), replayed: true };
  }
  const preview = record.state.preview; const settings = publicationSettings_(context.config);
  if (!preview || preview.id !== request.previewId || preview.adminId !== context.admin.values[0] || preview.expiresAt <= Date.now()
      || preview.fingerprint !== previewFingerprint_(context, settings)) fail_('PREVIEW_STALE', '公開内容が更新されたか、確認期限が切れています。もう一度公開プレビューを確認してください。');
  const bundle = buildCatalogRelease_(context.config, settings, preview.releaseId, preview.createdAt, true);
  const exported = writeCatalogZip_(context.config, bundle);
  const release = Object.assign({}, exported, { requestId: request.requestId, previewId: preview.id,
    adminId: context.admin.values[0], createdAt: Date.now() });
  record.state.releases = record.state.releases.concat([release]).slice(-20);
  saveEventRecord_(context.config, record);
  return { release: releaseView_(release), replayed: false };
}

function readAdminImage_(token, imageId) {
  const context = authenticateAdmin_(token); let image;
  rows_(context.db.Exhibitors).filter(function (record) { return record.values[1] === context.config.eventId; }).forEach(function (record) {
    json_(record.values[2]).publications.forEach(function (book) { (book.images || []).forEach(function (item) { if (item.id === imageId) image = item; }); });
  });
  if (!image) fail_('FORBIDDEN', 'この開催回の画像ではありません。');
  return { contentType: image.contentType, base64: Utilities.base64Encode(storedImageBytes_(context.config, image)) };
}

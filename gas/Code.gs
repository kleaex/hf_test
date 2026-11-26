/** 実験用Webアプリ。公開入口はこのファイルだけ。 */
function doGet(event) {
  if (event && event.parameter && event.parameter.view === 'bridge') return bridgePage_(event.parameter);
  const admin = event && event.parameter && event.parameter.view === 'admin';
  return HtmlService.createHtmlOutputFromFile(admin ? 'AdminIndex' : 'Index').setTitle(admin ? '運営画面（実験用）' : '出店者編集（実験用）');
}

function getPublicCatalog() {
  return api_(function () { return locked_(function () { return { data: publicCatalog_() }; }); });
}

function getPublicImage(imageId, variant) {
  return api_(function () { return locked_(function () { return publicImage_(imageId, variant); }); });
}

function stagePublicationImage(token, request) {
  return api_(function () { return locked_(function () { return uploadImage_(token, request, true); }); });
}

function getSystemStatus() {
  return api_(function () {
    return locked_(function () {
      const config = config_();
      database_(config);
      if (config.imageFolderId) imageFolder_(config);
      return { environment: 'experiment', storageConnected: true, authenticationImplemented: true,
        imagesConfigured: !!config.imageFolderId, editable: editing_(config).editable };
    });
  });
}

function requestLoginCode(email) {
  return api_(function () { return locked_(function () { return requestCode_(email); }); });
}

function verifyLoginCode(email, code) {
  return api_(function () { return locked_(function () { return verifyCode_(email, code); }); });
}

function getMyProfile(token) {
  return api_(function () {
    return locked_(function () { return { data: view_(authenticate_(token).record) }; });
  });
}

function saveProfile(token, request) {
  return api_(function () { return locked_(function () { return saveProfile_(token, request); }); });
}

function uploadPublicationImage(token, request) {
  return api_(function () { return locked_(function () { return uploadImage_(token, request); }); });
}

function getPublicationImage(token, imageId) {
  return api_(function () { return locked_(function () { return readImage_(token, imageId); }); });
}

function logout(token) {
  return api_(function () {
    return locked_(function () {
      const context = authenticate_(token);
      const row = context.session.values.slice();
      row[5] = Date.now();
      writeRow_(context.db.Sessions, context.session.row, row);
      return {};
    });
  });
}

function requestAdminLoginCode(email) {
  return api_(function () { return locked_(function () { return requestAdminCode_(email); }); });
}

function verifyAdminLoginCode(email, code) {
  return api_(function () { return locked_(function () { return verifyAdminCode_(email, code); }); });
}

function getAdminDashboard(token) {
  return api_(function () { return locked_(function () { return { data: adminDashboard_(authenticateAdmin_(token)) }; }); });
}

function saveAdminEvent(token, request) {
  return api_(function () { return locked_(function () { return saveAdminEvent_(token, request); }); });
}

function previewAdminCatalog(token) {
  return api_(function () { return locked_(function () { return previewAdminCatalog_(token); }); });
}

function exportAdminCatalog(token, request) {
  return api_(function () { return locked_(function () { return exportAdminCatalog_(token, request); }); });
}

function getAdminImage(token, imageId) {
  return api_(function () { return locked_(function () { return readAdminImage_(token, imageId); }); });
}

function logoutAdmin(token) {
  return api_(function () { return locked_(function () {
    const context = authenticateAdmin_(token);
    const values = context.session.values.slice(); values[4] = Date.now();
    writeRow_(context.adminDb.AdminSessions, context.session.row, values);
    return {};
  }); });
}

function api_(operation) {
  try { return Object.assign({ ok: true }, operation()); }
  catch (error) {
    // 生の例外・接続先・入力・トークンはクライアントやログへ出さない。
    return { ok: false, error: error && error.hfCode
      ? { code: error.hfCode, message: error.message }
      : { code: 'UNAVAILABLE', message: '処理を完了できませんでした。時間をおいて再試行してください。' } };
  }
}

function fail_(code, message) {
  const error = new Error(message);
  error.hfCode = code;
  throw error;
}

function locked_(operation) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) fail_('BUSY', '処理が混み合っています。同じ操作を再試行してください。');
  try { return operation(); } finally { lock.releaseLock(); }
}

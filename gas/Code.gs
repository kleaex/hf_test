/** 実験用Webアプリ。公開入口はこのファイルだけ。 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('出店者編集（実験用）');
}

function getSystemStatus() {
  return api_(function () {
    return locked_(function () {
      database_(config_());
      return { environment: 'experiment', storageConnected: true, authenticationImplemented: true };
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

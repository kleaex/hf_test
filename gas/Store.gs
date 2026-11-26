const HF_SCHEMA_ = Object.freeze({
  Users: ['userId', 'email', 'enabled', 'authJson'],
  Memberships: ['membershipId', 'userId', 'exhibitorId', 'enabled'],
  Exhibitors: ['exhibitorId', 'eventId', 'stateJson'],
  Sessions: ['userId', 'tokenHash', 'membershipId', 'issuedAt', 'expiresAt', 'revokedAt', 'exhibitorId', 'emailHash', 'eventId']
});

function email_(value) {
  if (typeof value !== 'string' || value.length > 254) return '';
  const result = value.trim().toLowerCase();
  // 実験では先頭を英数字に限定し、Sheetsの数式として扱われる値を拒否する。
  return /^[a-z0-9][a-z0-9.!#$%&'*+/=?^_`{|}~-]*@[a-z0-9.-]+\.[a-z]{2,}$/.test(result) ? result : '';
}

function config_(deferEvent) {
  if (HF_REQUEST_ && HF_REQUEST_.config) {
    const cached = HF_REQUEST_.config;
    if (!deferEvent) {
      const event = eventRecord_(cached, false);
      if (event) cached.editDeadline = event.state.editDeadline;
    }
    return cached;
  }
  const properties = PropertiesService.getScriptProperties();
  const values = properties.getProperties();
  let emails;
  try { emails = JSON.parse(values.HF_TEST_EMAILS || 'null'); } catch (_) { emails = null; }
  if (values.HF_ENV !== 'experiment' || !/^[A-Za-z0-9_-]{20,}$/.test(values.HF_SPREADSHEET_ID || '')
      || !/^[A-Za-z0-9_-]{1,64}$/.test(values.HF_EVENT_ID || '')
      || !/^[A-Za-z0-9+/=_-]{43,}$/.test(values.HF_AUTH_SECRET || '')
      || !Array.isArray(emails) || emails.length < 1 || emails.length > 10
      || emails.some(function (email) { return !email_(email); })) {
    fail_('NOT_CONFIGURED', '実験環境の設定が完了していません。運営に確認してください。');
  }
  const config = { properties: properties, spreadsheetId: values.HF_SPREADSHEET_ID,
    eventId: values.HF_EVENT_ID, secret: values.HF_AUTH_SECRET, emails: emails.map(email_),
    imageFolderId: values.HF_IMAGE_FOLDER_ID || '', editDeadline: values.HF_EDIT_DEADLINE || '' };
  if (HF_REQUEST_) HF_REQUEST_.config = config;
  if (!deferEvent) {
    const settings = eventRecord_(config, false);
    if (settings) config.editDeadline = settings.state.editDeadline;
  }
  return config;
}

function editing_(config) {
  const configured = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(config.editDeadline);
  const deadline = configured ? Date.parse(config.editDeadline) : NaN;
  return { editable: Number.isFinite(deadline) && Date.now() < deadline,
    deadline: Number.isFinite(deadline) ? deadline : null };
}

function requireEditing_(config) {
  if (!editing_(config).editable) fail_('EDIT_CLOSED', 'カタログの編集期間外です。変更・削除はできません。');
}

function database_(config, names) {
  const spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
  const db = {};
  (names || Object.keys(HF_SCHEMA_)).forEach(function (name) {
    const sheet = spreadsheet.getSheetByName(name);
    const columns = HF_SCHEMA_[name];
    if (HF_REQUEST_) {
      sheetSnapshot_(sheet, name, columns, 'SCHEMA', '保存先の構造が一致しません。運営に確認してください。');
      db[name] = sheet; return;
    }
    if (!sheet || sheet.getLastRow() < 1
        || JSON.stringify(timed_('sheetHeader', function () { return sheet.getRange(1, 1, 1, columns.length).getValues()[0]; })) !== JSON.stringify(columns)) {
      fail_('SCHEMA', '保存先の構造が一致しません。運営に確認してください。');
    }
    db[name] = sheet;
  });
  return db;
}

function rows_(sheet) {
  if (HF_REQUEST_ && HF_REQUEST_.sheets[sheet.getName()]) return HF_REQUEST_.sheets[sheet.getName()];
  const count = sheet.getLastRow() - 1;
  if (!count) return [];
  return timed_('sheetRead', function () { return sheet.getRange(2, 1, count, (HF_SCHEMA_[sheet.getName()] || HF_ADMIN_SCHEMA_[sheet.getName()]).length).getValues(); })
    .map(function (values, index) { return { row: index + 2, values: values }; });
}

function sheetSnapshot_(sheet, name, columns, code, message) {
  if (!sheet || !sheet.getLastRow()) fail_(code, message);
  if (HF_REQUEST_ && HF_REQUEST_.sheets[name]) return HF_REQUEST_.sheets[name];
  const values = timed_('sheetRead', function () { return sheet.getRange(1, 1, sheet.getLastRow(), columns.length).getValues(); });
  if (JSON.stringify(values[0]) !== JSON.stringify(columns)) fail_(code, message);
  const records = values.slice(1).map(function (row, index) { return { row: index + 2, values: row }; });
  if (HF_REQUEST_) HF_REQUEST_.sheets[name] = records;
  return records;
}

function one_(sheet, column, value) {
  const matches = rows_(sheet).filter(function (entry) { return entry.values[column] === value; });
  if (matches.length > 1) fail_('SCHEMA', '保存先に重複があります。運営に確認してください。');
  return matches[0] || null;
}

function writeRow_(sheet, row, values) {
  if (HF_REQUEST_) delete HF_REQUEST_.sheets[sheet.getName()];
  if (['Exhibitors', 'EventSettings'].indexOf(sheet.getName()) >= 0) {
    // 世代変更に失敗した場合は書込前に停止し、保存成功後に旧公開版が残ることを防ぐ。
    PropertiesService.getScriptProperties().setProperty('HF_PUBLIC_GENERATION', Utilities.getUuid());
  }
  // 自由入力はJSONセルにのみ格納する。先頭が { のため数式にはならない。
  timed_('sheetWrite', function () {
    sheet.getRange(row, 1, 1, values.length).setValues([values]);
    SpreadsheetApp.flush();
  });
  if (sheet.getName() === 'EventSettings') freshRequestConfig_();
}

function json_(value) {
  try { return JSON.parse(value); } catch (_) { fail_('SCHEMA', '保存データを読み込めません。運営に確認してください。'); }
}

function digest_(config, purpose, value) {
  return Utilities.computeHmacSha256Signature(purpose + ':' + value, config.secret, Utilities.Charset.UTF_8)
    .map(function (byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
}

function random_(config, purpose) {
  return digest_(config, purpose, Utilities.getUuid() + ':' + Utilities.getUuid() + ':' + Date.now());
}

function equal_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

function active_(value) { return value === true || value === 'TRUE'; }

function membership_(db, userId) {
  const matches = rows_(db.Memberships).filter(function (entry) {
    return entry.values[1] === userId && active_(entry.values[3]);
  });
  if (matches.length !== 1) fail_('FORBIDDEN', '編集できる出店者の登録を確認できません。');
  return matches[0];
}

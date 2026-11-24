/** 運営が配置前に一時関数から実行する。手順はdesign/SETUP.md。末尾 _ は実行一覧にも出ない。 */
function setupExperiment_() {
  return locked_(function () {
    const config = config_();
    const accounts = json_(config.properties.getProperty('HF_BOOTSTRAP_JSON') || 'null');
    if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 10) throw new Error('HF_BOOTSTRAP_JSONを設定してください。');
    const emails = [], userIds = [], exhibitorIds = [];
    accounts.forEach(function (account) {
      keys_(account, ['userId', 'exhibitorId', 'email', 'name']);
      if (!/^usr_[a-zA-Z0-9_-]{1,50}$/.test(account.userId || '')
          || !/^exh_[a-zA-Z0-9_-]{1,50}$/.test(account.exhibitorId || '')
          || !email_(account.email) || config.emails.indexOf(email_(account.email)) < 0
          || emails.indexOf(email_(account.email)) >= 0 || userIds.indexOf(account.userId) >= 0
          || exhibitorIds.indexOf(account.exhibitorId) >= 0) throw new Error('初期アカウントのID・宛先・重複を確認してください。');
      text_(account.name, 80, true);
      emails.push(email_(account.email)); userIds.push(account.userId); exhibitorIds.push(account.exhibitorId);
    });
    const spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
    Object.keys(HF_SCHEMA_).forEach(function (name) {
      const existing = spreadsheet.getSheetByName(name);
      if (existing && existing.getLastRow() > 0
          && JSON.stringify(existing.getRange(1, 1, 1, HF_SCHEMA_[name].length).getValues()[0]) !== JSON.stringify(HF_SCHEMA_[name])) {
        throw new Error('同名シートの形式が異なります。実験専用の空のSpreadsheetを指定してください。');
      }
    });
    Object.keys(HF_SCHEMA_).forEach(function (name) {
      const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
      if (!sheet.getLastRow()) writeRow_(sheet, 1, HF_SCHEMA_[name]);
    });
    const db = database_(config);
    accounts.forEach(function (account) {
      const email = email_(account.email);
      const user = one_(db.Users, 0, account.userId);
      const sameEmail = one_(db.Users, 1, email);
      const record = one_(db.Exhibitors, 0, account.exhibitorId);
      const membershipId = 'mem_' + account.userId.slice(4);
      const membership = one_(db.Memberships, 0, membershipId);
      if ((user && user.values[1] !== email) || (sameEmail && sameEmail.values[0] !== account.userId)
          || (record && record.values[1] !== config.eventId)
          || (membership && (membership.values[1] !== account.userId || membership.values[2] !== account.exhibitorId))
          || rows_(db.Memberships).some(function (entry) {
            return entry.values[0] !== membershipId && (entry.values[1] === account.userId || entry.values[2] === account.exhibitorId);
          })) throw new Error('既存のID・メール・所属と初期設定が一致しません。');
      if (!record) writeRow_(db.Exhibitors, db.Exhibitors.getLastRow() + 1,
        [account.exhibitorId, config.eventId, JSON.stringify({ revision: 0,
          profile: { name: account.name.trim(), description: '', genre: '' }, publications: [], updatedAt: null, receipts: [] })]);
      if (!user) writeRow_(db.Users, db.Users.getLastRow() + 1, [account.userId, email, true, '{}']);
      if (!membership) writeRow_(db.Memberships, db.Memberships.getLastRow() + 1,
        [membershipId, account.userId, account.exhibitorId, true]);
    });
    return { ok: true, accountCount: accounts.length };
  });
}

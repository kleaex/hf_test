// 登録待ちは無効なUsers行だけ。メール確認後に固定IDで所属・出店情報を作る。
function codeResponse_() {
  return { message: '入力内容を確認できた場合は、確認コードを送信します。届かない場合は、入力内容・登録済みかどうかを確認し、時間をおいて再試行してください。' };
}

function matchesExhibitor_(name, input) {
  const config = config_();
  const email = email_(input);
  const normalized = text_(name, 80, true);
  if (!email) return false;
  const db = database_(config);
  const user = one_(db.Users, 1, email);
  if (!user || !active_(user.values[2])) return false;
  const membership = membership_(db, user.values[0]);
  const record = one_(db.Exhibitors, 0, membership.values[2]);
  return !!record && record.values[1] === config.eventId && json_(record.values[2]).profile.name === normalized;
}

function registrationPurpose_(registration, email) {
  return 'registration:' + JSON.stringify([registration.eventId, registration.name, email]);
}

function requestRegistration_(name, input) {
  const config = config_();
  requireEditing_(config);
  const normalized = text_(name, 80, true);
  const email = email_(input);
  const response = codeResponse_();
  if (!email) return response;
  const db = database_(config);
  let user = one_(db.Users, 1, email);
  if (user && active_(user.values[2])) return response;
  let auth = user ? json_(user.values[3]) : {};
  // 利用停止された既存アカウントは新規登録で復活させない。
  if (user && (!auth.registration || auth.registration.eventId !== config.eventId)) return response;
  if (auth.lastSentAt && Date.now() - auth.lastSentAt < 60000) return response;
  // 宛先数に上限を設けないため、全体の送信枠がなければ登録待ち行も増やさない。
  const budget = json_(config.properties.getProperty('HF_MAIL_BUDGET') || '{}');
  if ((budget.windowStart && Date.now() - budget.windowStart < 3600000 && budget.count >= 20)
      || MailApp.getRemainingDailyQuota() < 1) return response;
  const registration = auth.registration || {
    eventId: config.eventId,
    exhibitorId: 'exh_' + random_(config, 'exhibitor').slice(0, 32),
    membershipId: 'mem_' + random_(config, 'membership').slice(0, 32)
  };
  // 作成途中の再送は同じID・名前で復旧。登録後の名前変更は編集画面で行う。
  if (one_(db.Exhibitors, 0, registration.exhibitorId) && registration.name !== normalized) return response;
  registration.name = normalized;
  auth.registration = registration;
  const values = [user ? user.values[0] : 'usr_' + random_(config, 'user').slice(0, 32), email, false, JSON.stringify(auth)];
  const row = user ? user.row : db.Users.getLastRow() + 1;
  writeRow_(db.Users, row, values);
  user = { row: row, values: values };
  sendChallenge_(config, db.Users, user, email, registrationPurpose_(registration, email));
  return response;
}

function verifyRegistration_(name, input, code) {
  const config = config_();
  requireEditing_(config);
  const normalized = text_(name, 80, true);
  const email = email_(input);
  const reject = function () { fail_('INVALID_CODE', '出店名・メールアドレス・コード・有効期限を確認してください。登録済みの場合はログインしてください。'); };
  if (!email) return reject();
  const db = database_(config);
  const user = one_(db.Users, 1, email);
  if (!user || active_(user.values[2])) return reject();
  const auth = json_(user.values[3]);
  const registration = auth.registration;
  const challenge = auth.challenge;
  if (!registration || registration.eventId !== config.eventId || !challenge || challenge.status !== 'ready'
      || challenge.used || challenge.expiresAt <= Date.now() || challenge.attempts >= 5) return reject();
  challenge.attempts++;
  const valid = registration.name === normalized && typeof code === 'string' && /^\d{6}$/.test(code)
    && equal_(challenge.hash, digest_(config, registrationPurpose_(registration, email), code));
  user.values[3] = JSON.stringify(auth);
  writeRow_(db.Users, user.row, user.values);
  if (!valid) return reject();

  // ScriptLock内で同じIDを再利用。途中の書込失敗・応答喪失でも重複作成しない。
  let record = one_(db.Exhibitors, 0, registration.exhibitorId);
  if (!record) {
    const values = [registration.exhibitorId, config.eventId, JSON.stringify({ revision: 0,
      profile: { name: normalized, description: '', genre: '' }, publications: [], updatedAt: null, receipts: [] })];
    const row = db.Exhibitors.getLastRow() + 1;
    writeRow_(db.Exhibitors, row, values);
    record = { row: row, values: values };
  }
  let membership = one_(db.Memberships, 0, registration.membershipId);
  if (!membership) {
    const values = [registration.membershipId, user.values[0], registration.exhibitorId, true];
    const row = db.Memberships.getLastRow() + 1;
    writeRow_(db.Memberships, row, values);
    membership = { row: row, values: values };
  }
  if (record.values[1] !== config.eventId || membership.values[1] !== user.values[0]
      || membership.values[2] !== registration.exhibitorId || !active_(membership.values[3])) {
    fail_('FORBIDDEN', '登録情報が一致しません。運営に確認してください。');
  }
  challenge.used = true;
  delete auth.registration;
  user.values[2] = true;
  user.values[3] = JSON.stringify(auth);
  // 自動公開は有効化済みUsersも参照するため、その確定前に公開キャッシュを失効させる。
  config.properties.setProperty('HF_PUBLIC_GENERATION', Utilities.getUuid());
  writeRow_(db.Users, user.row, user.values);
  // 承認一覧は変更しない。自動公開モードでは有効化後の次回取得から掲載する。
  return issueSession_(config, db, user, membership, record);
}

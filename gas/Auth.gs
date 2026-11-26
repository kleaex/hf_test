function requestCode_(input) {
  const config = config_();
  const db = database_(config);
  const email = email_(input);
  const response = { message: '登録済みのテスト宛先には確認コードを送信します。届かない場合は、時間をおいて運営に確認してください。' };
  if (!email || config.emails.indexOf(email) < 0) return response;
  const user = one_(db.Users, 1, email);
  if (!user || !active_(user.values[2])) return response;
  membership_(db, user.values[0]);
  return sendChallenge_(config, db.Users, user, email);
}

function sendChallenge_(config, sheet, user, email, codePurpose) {
  const response = { message: '登録済みのテスト宛先には確認コードを送信します。届かない場合は、時間をおいて運営に確認してください。' };
  const now = Date.now();
  const auth = json_(user.values[3]);
  if (auth.lastSentAt && now - auth.lastSentAt < 60000) return response;
  if (!auth.windowStart || now - auth.windowStart >= 3600000) {
    auth.windowStart = now;
    auth.sendCount = 0;
  }
  const budget = json_(config.properties.getProperty('HF_MAIL_BUDGET') || '{}');
  if (!budget.windowStart || now - budget.windowStart >= 3600000) {
    budget.windowStart = now;
    budget.count = 0;
  }
  if (auth.sendCount >= 5 || budget.count >= 20 || MailApp.getRemainingDailyQuota() < 1) return response;
  const code = ('000000' + (parseInt(random_(config, 'code').slice(0, 12), 16) % 1000000)).slice(-6);
  auth.lastSentAt = now;
  auth.sendCount = (auth.sendCount || 0) + 1;
  auth.challenge = { hash: digest_(config, codePurpose || 'code:' + user.values[0] + ':' + email, code),
    expiresAt: now + 600000, attempts: 0, used: false, status: 'pending' };
  budget.count = (budget.count || 0) + 1;
  config.properties.setProperty('HF_MAIL_BUDGET', JSON.stringify(budget));
  const values = user.values.slice();
  values[3] = JSON.stringify(auth);
  writeRow_(sheet, user.row, values);
  try {
    MailApp.sendEmail({ to: email, subject: codePurpose && codePurpose.indexOf('registration:') === 0
      ? '【実験用】出店者登録の確認コード' : codePurpose ? '【実験用】運営画面の確認コード' : '【実験用】出店者編集の確認コード',
      body: '確認コード: ' + code + '\n有効期限は10分、入力は5回までです。\n心当たりがなければ、このメールを破棄してください。' });
  } catch (_) {
    auth.challenge.status = 'failed';
    values[3] = JSON.stringify(auth);
    writeRow_(sheet, user.row, values);
    return response;
  }
  auth.challenge.status = 'ready';
  values[3] = JSON.stringify(auth);
  writeRow_(sheet, user.row, values);
  return response;
}

function verifyCode_(input, code) {
  const config = config_();
  const db = database_(config);
  const email = email_(input);
  const reject = function () { fail_('INVALID_CODE', 'コードを確認できません。有効期限・入力内容を確認し、必要なら再送してください。'); };
  if (!email || config.emails.indexOf(email) < 0) return reject();
  const user = one_(db.Users, 1, email);
  if (!user || !active_(user.values[2])) return reject();
  const auth = json_(user.values[3]);
  const challenge = auth.challenge;
  const now = Date.now();
  if (!challenge || challenge.status !== 'ready' || challenge.used
      || challenge.expiresAt <= now || challenge.attempts >= 5) return reject();
  challenge.attempts++;
  const valid = typeof code === 'string' && /^\d{6}$/.test(code)
    && equal_(challenge.hash, digest_(config, 'code:' + user.values[0] + ':' + email, code));
  if (valid) challenge.used = true;
  const values = user.values.slice();
  values[3] = JSON.stringify(auth);
  writeRow_(db.Users, user.row, values);
  if (!valid) return reject();
  const membership = membership_(db, user.values[0]);
  const record = one_(db.Exhibitors, 0, membership.values[2]);
  if (!record || record.values[1] !== config.eventId) fail_('FORBIDDEN', '対象の開催回に出店者登録がありません。');
  return issueSession_(config, db, user, membership, record);
}

function issueSession_(config, db, user, membership, record) {
  const now = Date.now();
  const email = user.values[1];
  const token = random_(config, 'session');
  const previous = one_(db.Sessions, 0, user.values[0]);
  const expiresAt = now + 7200000;
  writeRow_(db.Sessions, previous ? previous.row : db.Sessions.getLastRow() + 1,
    [user.values[0], digest_(config, 'session', token), membership.values[0], now, expiresAt, '',
      membership.values[2], digest_(config, 'email', email), config.eventId]);
  return { token: token, expiresAt: expiresAt, data: view_(record) };
}

function authenticate_(token) {
  const config = config_();
  const db = database_(config);
  const reject = function () { fail_('UNAUTHENTICATED', 'ログインの有効期限が切れたか、利用が停止されています。もう一度ログインしてください。'); };
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return reject();
  const hash = digest_(config, 'session', token);
  const sessions = rows_(db.Sessions).filter(function (entry) { return equal_(entry.values[1], hash); });
  if (sessions.length !== 1) return reject();
  const session = sessions[0];
  if (session.values[5] || !Number.isFinite(session.values[4]) || session.values[4] <= Date.now()) return reject();
  const user = one_(db.Users, 0, session.values[0]);
  if (!user || !active_(user.values[2]) || config.emails.indexOf(user.values[1]) < 0) return reject();
  if (!equal_(session.values[7], digest_(config, 'email', user.values[1])) || session.values[8] !== config.eventId) return reject();
  const membership = membership_(db, user.values[0]);
  if (membership.values[0] !== session.values[2] || membership.values[2] !== session.values[6]) return reject();
  const record = one_(db.Exhibitors, 0, membership.values[2]);
  if (!record || record.values[1] !== config.eventId) fail_('FORBIDDEN', '対象の開催回に出店者登録がありません。');
  return { config: config, db: db, user: user, membership: membership, record: record, session: session };
}

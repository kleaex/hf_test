function view_(record) {
  const state = json_(record.values[2]);
  return { exhibitorId: record.values[0], eventId: record.values[1], revision: state.revision,
    profile: state.profile, publications: state.publications, updatedAt: state.updatedAt };
}

function text_(value, max, required) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail_('VALIDATION', '入力の文字数・必須項目・使用できない文字を確認してください。');
  }
  return value.trim();
}

function keys_(object, allowed) {
  if (!object || typeof object !== 'object' || Array.isArray(object)
      || Object.keys(object).some(function (key) { return allowed.indexOf(key) < 0; })) {
    fail_('VALIDATION', '保存する項目が正しくありません。');
  }
}

function saveProfile_(token, request) {
  const context = authenticate_(token);
  keys_(request, ['exhibitorId', 'revision', 'requestId', 'profile', 'publications']);
  if (request.exhibitorId !== context.record.values[0]) fail_('FORBIDDEN', '他の出店者の情報は保存できません。');
  if (!Number.isSafeInteger(request.revision) || request.revision < 0
      || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(request.requestId)) {
    fail_('VALIDATION', '保存要求が正しくありません。');
  }
  keys_(request.profile, ['name', 'description', 'genre']);
  const profile = { name: text_(request.profile.name, 80, true),
    description: text_(request.profile.description, 2000, false), genre: text_(request.profile.genre, 40, false) };
  if (!Array.isArray(request.publications) || request.publications.length > 10) fail_('VALIDATION', '頒布物は10点まで登録できます。');
  const ids = [];
  const publications = request.publications.map(function (book) {
    keys_(book, ['id', 'title', 'author', 'description', 'price', 'releaseType']);
    if (book.id !== null && (typeof book.id !== 'string' || !/^pub_[a-f0-9]{32}$/.test(book.id))) fail_('VALIDATION', '頒布物IDが正しくありません。');
    if (book.id !== null && ids.indexOf(book.id) >= 0) fail_('VALIDATION', '同じ頒布物が重複しています。');
    if (book.id !== null) ids.push(book.id);
    if (!Number.isSafeInteger(book.price) || book.price < 0 || book.price > 1000000) fail_('VALIDATION', '価格は0〜1,000,000円の整数で入力してください。');
    if (['新刊', '既刊', 'その他'].indexOf(book.releaseType) < 0) fail_('VALIDATION', '刊行区分を選択してください。');
    return { id: book.id, title: text_(book.title, 120, true), author: text_(book.author, 120, false),
      description: text_(book.description, 2000, false), price: book.price, releaseType: book.releaseType };
  });
  const state = json_(context.record.values[2]);
  const fingerprint = digest_(context.config, 'save', JSON.stringify({ exhibitorId: request.exhibitorId,
    revision: request.revision, profile: profile, publications: publications }));
  const receipt = state.receipts.find(function (entry) { return entry.id === request.requestId; });
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) fail_('REQUEST_REUSED', '同じ保存要求IDを別の内容には使用できません。');
    return { data: view_(context.record), replayed: true, savedRevision: receipt.revision };
  }
  if (state.revision !== request.revision) fail_('CONFLICT', '別の画面で更新されています。入力内容を控えてから保存済みの内容を読み直してください。');
  publications.forEach(function (book) {
    if (book.id === null) book.id = 'pub_' + random_(context.config, 'publication').slice(0, 32);
    else if (!state.publications.some(function (saved) { return saved.id === book.id; })) {
      fail_('FORBIDDEN', 'この出店者に属さない頒布物は保存できません。');
    }
  });
  const revision = state.revision + 1;
  const next = { revision: revision, profile: profile, publications: publications, updatedAt: Date.now(),
    receipts: state.receipts.concat([{ id: request.requestId, fingerprint: fingerprint,
      revision: revision, userId: context.user.values[0], savedAt: Date.now() }]).slice(-20) };
  const serialized = JSON.stringify(next);
  if (serialized.length > 45000) fail_('VALIDATION', '保存データが大きすぎます。紹介文を短くしてください。');
  // 更新・削除（配列から除外）・再送記録を同じセルで確定する。
  writeRow_(context.db.Exhibitors, context.record.row, [request.exhibitorId, context.config.eventId, serialized]);
  return { data: view_({ values: [request.exhibitorId, context.config.eventId, serialized] }),
    replayed: false, savedRevision: revision };
}

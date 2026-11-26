// HTML Service内からのみgoogle.script.runを使う。HPへは固定したoriginへ応答する。
function bridgePage_(parameters) {
  const origins = json_(PropertiesService.getScriptProperties().getProperty('HF_FRONTEND_ORIGINS') || '[]');
  const origin = parameters.origin;
  if (!Array.isArray(origins) || origins.indexOf(origin) < 0
      || typeof origin !== 'string' || !/^https?:\/\/[A-Za-z0-9.:-]+$/.test(origin)
      || !/^[a-f0-9]{64}$/.test(parameters.nonce || '')) {
    return HtmlService.createHtmlOutput('接続元が設定されていません。');
  }
  const template = HtmlService.createTemplateFromFile('Bridge');
  const settings = { origin: origin, nonce: parameters.nonce };
  // 公開カタログを要求した初回接続だけ同梱する。本人・運営の非公開情報は取得しない。
  if (parameters.initial === 'catalog') settings.initialCatalog = initialCatalog_();
  template.settings = bridgeJson_(settings);
  return template.evaluate().setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function initialCatalog_() {
  // 画像のDrive確認・読取で本文を待たせない。画像はHPの表示後に通常経路で取得する。
  return getPublicCatalog();
}

function bridgeJson_(value) {
  // 紹介文等に </script> があってもHTMLのscript要素を終了させない。
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, function (character) {
    return '\\u' + ('0000' + character.charCodeAt(0).toString(16)).slice(-4);
  });
}

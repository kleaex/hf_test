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
  template.settings = JSON.stringify({ origin: origin, nonce: parameters.nonce });
  return template.evaluate().setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 実験用の疎通確認のみ。保存・本人確認・画像処理は未実装。
 * 本番KHBのコード・設定値をコピーしない。
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('即売会システム 接続確認');
}

function getSystemStatus() {
  return { ok: true, environment: 'experiment', storageConnected: false, authenticationImplemented: false };
}

function saveProfile() {
  throw new Error('未実装：本人確認と所有権検証ができるまで保存は利用できません。');
}

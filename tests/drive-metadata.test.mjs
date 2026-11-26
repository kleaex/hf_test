import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, saveRequest, book } from './gas-harness.mjs';
import { png, jpeg } from './image-fixtures.mjs';

function ready() {
  const h = harness(); h.setup(); h.setupAdmin(); const a = h.login();
  a.data = h.call('saveProfile', a.token, saveRequest(a.data, { publications: [book()] })).data;
  const staged = h.call('stagePublicationImage', a.token, { publicationId: a.data.publications[0].id,
    revision: a.data.revision, requestId: 'metadata_upload_123456', contentType: 'image/png', base64: png,
    thumbnail: { contentType: 'image/jpeg', base64: jpeg } });
  const id = staged.data.stagedImages[0].image.id;
  const request = saveRequest(staged.data); request.publications[0].imageIds = [id]; h.call('saveProfile', a.token, request);
  h.properties.HF_PERFORMANCE = 'true'; h.state.driveApiEnabled = true;
  return { h, a, id };
}
test('読取の非公開確認をフォルダ・画像それぞれ1回のメタデータAPI取得へまとめる', () => {
  const { h, id } = ready(); const result = h.call('getPublicImages', [id]);
  assert.equal(result.images[0].ok, true); assert.equal(h.state.driveApiCalls.length, 2);
  assert.equal(result.performance.stages.driveMetadataApi.count, 2); assert.equal(result.performance.stages.driveMetadataLegacy, undefined);
  assert.ok(h.state.driveApiCalls.every(call => call.options.fields.includes('permissions') && call.options.supportsAllDrives === false));
  assert.doesNotMatch(JSON.stringify(result), /owner_only|permissionId|file_|mimeType|modifiedTime|parents/);
});
test('カタログの正本読取から画像索引も用意し、最初の画像要求でSheetsを読み直さない', () => {
  const { h, id } = ready(); h.state.cacheEnabled = true; h.state.sheetReads = {};
  const catalog = h.call('getPublicCatalog'); assert.equal(catalog.ok, true);
  assert.equal(Object.values(h.state.sheetReads).reduce((sum, count) => sum + count, 0), 2);
  h.state.sheetReads = {};
  assert.equal(h.call('getPublicImages', [id]).images[0].ok, true);
  assert.equal(Object.values(h.state.sheetReads).reduce((sum, count) => sum + count, 0), 0);
  assert.doesNotMatch(JSON.stringify(catalog.data), /file_|parents|permissions|owner_only|hash/);
});
test('共有・権限欠落・別所有者・ゴミ箱・ショートカット・別保存先を拒否', () => {
  const mutations = [
    meta => { meta.shared = true; }, meta => { meta.ownedByMe = false; }, meta => { meta.trashed = true; },
    meta => { delete meta.permissions; }, meta => { meta.permissions = []; }, meta => { meta.permissions = [null]; },
    meta => { meta.permissions.push({ id: 'reader', type: 'user', role: 'reader' }); },
    meta => { meta.permissions.push({ id: 'domain', type: 'domain', role: 'reader' }); },
    meta => { meta.owners[0].me = false; }, meta => { meta.permissions[0].id = 'wrong-owner'; },
    meta => { meta.mimeType = 'application/vnd.google-apps.shortcut'; }, meta => { meta.driveId = 'shared_drive'; },
    meta => { meta.modifiedTime = ''; }, meta => { meta.mimeType !== 'application/vnd.google-apps.folder' && (meta.parents = ['other_folder']); }
  ];
  for (const mutate of mutations) {
    const { h, id } = ready(); h.state.metadataTransform = meta => { mutate(meta); return meta; };
    assert.equal(h.call('getPublicImages', [id]).images[0].ok, false);
  }
});
test('小画像キャッシュ命中後も共有・保存先・更新日時を再確認する', () => {
  const { h, id } = ready(); h.state.cacheEnabled = true;
  h.call('getPublicImages', [id]); h.state.driveReadLocks = []; h.state.driveApiCalls = [];
  h.state.fileHandleReads = 0; h.state.folderHandleReads = 0;
  assert.equal(h.call('getPublicImages', [id]).images[0].ok, true);
  assert.equal(h.state.driveApiCalls.length, 2); assert.equal(h.state.driveReadLocks.length, 0);
  assert.equal(h.state.fileHandleReads, 0); assert.equal(h.state.folderHandleReads, 0);
  h.state.folderShared = true; assert.equal(h.call('getPublicImages', [id]).images[0].ok, false); h.state.folderShared = false;
  const file = [...h.files.values()].find(value => value.name.endsWith('.thumbnail'));
  file.modifiedAt = 2; file.data = { getContentType: () => 'image/jpeg', getBytes: () => [0] };
  assert.equal(h.call('getPublicImages', [id]).images[0].error.code, 'IMAGE_INVALID');
});
test('API未有効なら従来の読取で動き、有効なAPIのエラーは安全性確認を省略しない', () => {
  const { h, a, id } = ready(); h.state.driveApiEnabled = false;
  const legacy = h.call('getPublicationImage', a.token, id, 'thumbnail');
  assert.equal(legacy.ok, true); assert.equal(legacy.performance.stages.driveMetadataLegacy.count, 2);
  h.state.driveApiEnabled = true; h.state.driveApiFails = true;
  assert.equal(h.call('getPublicImages', [id]).images[0].ok, false);
  assert.equal(h.call('getPublicationImage', a.token, id, 'thumbnail').ok, false);
});

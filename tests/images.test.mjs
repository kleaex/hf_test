import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { harness, saveRequest, book } from './gas-harness.mjs';
import { clientHarness } from './client-harness.mjs';
import { png, jpeg, gif, bmp } from './image-fixtures.mjs';

function ready() {
  const h = harness(); h.setup(); const a = h.login();
  a.data = h.call('saveProfile', a.token, saveRequest(a.data, { publications: [book(), book({ title: '別作品' })] })).data;
  return { h, a };
}
function request(data, overrides = {}) { return { publicationId: data.publications[0].id,
  revision: data.revision, requestId: crypto.randomUUID(), contentType: 'image/png', base64: png, ...overrides }; }
function error(result, code) { assert.equal(result.ok, false); assert.equal(result.error.code, code); }

test('画像を非公開保存し、本人だけが取得でき、Drive IDや内部ハッシュを画面へ返さない', () => {
  const { h, a } = ready(); const result = h.call('uploadPublicationImage', a.token, request(a.data));
  assert.equal(result.ok, true); assert.equal(result.data.publications[0].images.length, 1);
  assert.equal(h.files.size, 1); assert.equal(h.state.conversions, 1);
  assert.doesNotMatch(JSON.stringify(result), /fileId|file_|"hash"|test_image_folder/);
  const imageId = result.data.publications[0].images[0].id;
  const read = h.call('getPublicationImage', a.token, imageId); assert.equal(read.ok, true);
  assert.equal(read.contentType, 'image/png'); assert.ok(read.base64.length > 0);
  const b = h.login('b@example.invalid');
  error(h.call('getPublicationImage', b.token, imageId), 'FORBIDDEN');
  error(h.call('uploadPublicationImage', b.token, request(a.data)), 'FORBIDDEN');
  error(h.call('getPublicationImage', 'f'.repeat(64), imageId), 'UNAUTHENTICATED');
});

test('JPEGも受信でき、EXIF等のメタデータを除いて保存する', () => {
  const { h, a } = ready();
  const original = Buffer.from(jpeg, 'base64');
  const metadata = Buffer.from([255, 225, 0, 8, 69, 120, 105, 102, 0, 0]);
  const input = Buffer.concat([original.subarray(0, 2), metadata, original.subarray(2)]).toString('base64');
  const result = h.call('uploadPublicationImage', a.token, request(a.data, { contentType: 'image/jpeg', base64: input }));
  assert.equal(result.ok, true);
  const read = h.call('getPublicationImage', a.token, result.data.publications[0].images[0].id);
  assert.equal(Buffer.from(read.base64, 'base64').includes(Buffer.from('Exif')), false);
});

test('偽装・不正ファイル・容量超過・過大寸法・デコーダー拒否を保存前に拒否', () => {
  const { h, a } = ready();
  const oversized = Buffer.from(png, 'base64'); oversized.writeUInt32BE(2401, 16);
  const malformed = [
    { contentType: 'image/svg+xml', base64: Buffer.from('<svg/>').toString('base64') },
    { contentType: 'image/jpeg', base64: png }, { base64: 'bad' }, { base64: 'a'.repeat(2000004) },
    { base64: oversized.toString('base64') }, { base64: Buffer.from('not an image').toString('base64') },
    { base64: Buffer.from(png, 'base64').subarray(0, 32).toString('base64') }
  ];
  for (const item of malformed) error(h.call('uploadPublicationImage', a.token, request(a.data, item)), 'IMAGE_INVALID');
  h.state.decodeFails = true;
  error(h.call('uploadPublicationImage', a.token, request(a.data)), 'IMAGE_INVALID');
  assert.equal(h.files.size, 0);
});

test('1作品3点制限、順序変更と削除の永続化、他作品の画像流用拒否', () => {
  const { h, a } = ready(); let data = a.data;
  for (let index = 0; index < 3; index++) data = h.call('uploadPublicationImage', a.token, request(data)).data;
  error(h.call('uploadPublicationImage', a.token, request(data)), 'IMAGE_LIMIT');
  const ids = data.publications[0].images.map(image => image.id);
  const injection = saveRequest(data); injection.publications[1].imageIds = [ids[0]];
  error(h.call('saveProfile', a.token, injection), 'FORBIDDEN');
  const reorder = saveRequest(data); reorder.publications[0].imageIds = [ids[2], ids[0]];
  const saved = h.call('saveProfile', a.token, reorder); assert.equal(saved.ok, true);
  assert.deepEqual(saved.data.publications[0].images.map(image => image.id), [ids[2], ids[0]]);
  error(h.call('getPublicationImage', a.token, ids[1]), 'FORBIDDEN');
  // ファイルの自動物理削除はしない。過去の公開版を将来参照できるよう保持する。
  assert.equal(h.files.size, 3);
});

test('画像登録前後のSheets失敗から再送しても、同じDriveファイルを重複作成しない', () => {
  for (const mode of ['failWrite', 'failAfterWrite']) {
    const { h, a } = ready(); const input = request(a.data); h.state[mode] = 'Exhibitors';
    error(h.call('uploadPublicationImage', a.token, input), 'UNAVAILABLE');
    assert.equal(h.files.size, 1);
    const result = h.call('uploadPublicationImage', a.token, input); assert.equal(result.ok, true);
    assert.equal(result.data.publications[0].images.length, 1); assert.equal(h.files.size, 1);
    assert.equal(result.replayed, mode === 'failAfterWrite');
    assert.equal(h.call('uploadPublicationImage', a.token, input).replayed, true);
    error(h.call('uploadPublicationImage', a.token, { ...input, base64: jpeg, contentType: 'image/jpeg' }), 'REQUEST_REUSED');
  }
});

test('共有されたフォルダ・ファイル、保存先未設定、Drive失敗、改変された画像を拒否', () => {
  for (const mutate of [h => { h.state.folderShared = true; }, h => { h.state.folderViewers = [{}]; },
    h => { h.state.folderEditors = [{}]; }, h => { delete h.properties.HF_IMAGE_FOLDER_ID; }]) {
    const { h, a } = ready(); mutate(h);
    error(h.call('uploadPublicationImage', a.token, request(a.data)), 'IMAGE_CONFIG'); assert.equal(h.files.size, 0);
  }
  const { h, a } = ready(); h.state.driveFails = true;
  error(h.call('uploadPublicationImage', a.token, request(a.data)), 'UNAVAILABLE');
  h.state.driveFails = false;
  const saved = h.call('uploadPublicationImage', a.token, request(a.data)); const id = saved.data.publications[0].images[0].id;
  const file = [...h.files.values()][0]; file.shared = true;
  error(h.call('getPublicationImage', a.token, id), 'IMAGE_CONFIG');
  file.shared = false; file.data = { getBytes: () => [1, 2, 3] };
  error(h.call('getPublicationImage', a.token, id), 'IMAGE_INVALID');
});

test('編集期限終了・未設定では変更と削除を拒否し、閲覧と確定済み要求の結果確認を許可', () => {
  for (const deadline of ['', 'bad', '2026-11-24T00:00:00Z']) {
    const { h, a } = ready(); const input = request(a.data);
    const saved = h.call('uploadPublicationImage', a.token, input); h.properties.HF_EDIT_DEADLINE = deadline;
    assert.equal(h.call('getMyProfile', a.token).data.editable, false);
    error(h.call('saveProfile', a.token, saveRequest(saved.data, { publications: [] })), 'EDIT_CLOSED');
    error(h.call('uploadPublicationImage', a.token, request(saved.data)), 'EDIT_CLOSED');
    assert.equal(h.call('getPublicationImage', a.token, saved.data.publications[0].images[0].id).ok, true);
    assert.equal(h.call('uploadPublicationImage', a.token, input).replayed, true);
  }
});

test('画像登録上限はプロフィール保存や削除でリセットされない', () => {
  const { h, a } = ready();
  const state = JSON.parse(h.sheets.get('Exhibitors').data[1][2]);
  state.imageBudget = { day: Math.floor(Date.UTC(2026, 10, 24) / 86400000), count: 30, bytes: 1000 };
  h.sheets.get('Exhibitors').data[1][2] = JSON.stringify(state);
  a.data = h.call('saveProfile', a.token, saveRequest(a.data)).data;
  error(h.call('uploadPublicationImage', a.token, request(a.data)), 'IMAGE_LIMIT');
});

test('ブラウザー受付は拡張子に依存せず4形式の寸法を読み、容量・画素数で事前拒否', async () => {
  const client = clientHarness(() => ({})); await client.settle();
  for (const input of [png, jpeg, gif, bmp]) {
    const size = client.invoke('sourceImageSize', new Uint8Array(Buffer.from(input, 'base64')));
    assert.equal(size.width, 2); assert.equal(size.height, 2);
  }
  assert.throws(() => client.invoke('sourceImageSize', new Uint8Array(Buffer.from('<svg/>'))));
  await assert.rejects(client.invoke('prepareImage', { size: 20000001 }), /20MB/);
  const huge = Buffer.from(png, 'base64'); huge.writeUInt32BE(10000, 16); huge.writeUInt32BE(10000, 20);
  await assert.rejects(client.invoke('prepareImage', { size: huge.length, arrayBuffer: async () => huge }), /6,000/);
});

test('実クライアントの画像プレビュー・登録・応答喪失後の同一要求再送を確認', async () => {
  const { h, a } = ready(); let drop = true;
  const storage = new Map([['hf_test.exhibitorSession.v1', a.token]]);
  const client = clientHarness((name, ...args) => {
    const result = h.call(name, ...args);
    if (name === 'uploadPublicationImage' && drop) { drop = false; throw new Error('reply lost'); }
    return result;
  }, storage, {
    createImageBitmap: async () => ({ width: 2, height: 2, close() {} }),
    canvas: () => ({ getContext: () => ({ drawImage() {}, fillRect() {} }),
      toBlob: (callback, type) => callback(new Blob([Buffer.from(png, 'base64')], { type })) })
  });
  await client.settle();
  const upload = client.elements.books.children[0].querySelectorAll('input').find(node => node.type === 'file');
  upload.files = [new File([Buffer.from(png, 'base64')], 'test.png', { type: 'image/png' })];
  // 実ブラウザーではfile inputのinputイベントも親へ届く。未保存の本文扱いにしない。
  client.elements.fields.events.input({ target: upload });
  await client.event(upload, 'change'); await client.settle();
  assert.equal(client.elements.imageConfirm.hidden, false); assert.equal(client.elements.save.disabled, true);
  assert.equal(h.files.size, 0);
  await client.event('uploadImage');
  assert.equal(h.files.size, 1); assert.equal(client.elements.imageConfirm.hidden, false);
  assert.equal(client.elements.cancelImage.disabled, true);
  await client.event('uploadImage');
  assert.equal(client.elements.imageConfirm.hidden, true); assert.equal(h.files.size, 1);
  const requests = client.calls.filter(call => call.name === 'uploadPublicationImage');
  assert.deepEqual(requests[0].args, requests[1].args);
  assert.equal(h.call('getMyProfile', a.token).data.publications[0].images.length, 1);
});

test('編集期間外の画面では変更を無効化し、保存要求を送らない', async () => {
  const { h, a } = ready(); h.properties.HF_EDIT_DEADLINE = '';
  const client = clientHarness(h.call, new Map([['hf_test.exhibitorSession.v1', a.token]])); await client.settle();
  assert.equal(client.elements.save.disabled, true); assert.equal(client.elements.name.disabled, true);
  await client.event('profileForm', 'submit');
  assert.equal(client.calls.some(call => call.name === 'saveProfile'), false);
});

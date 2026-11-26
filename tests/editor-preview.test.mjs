import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, saveRequest, book } from './gas-harness.mjs';
import { clientHarness } from './client-harness.mjs';
import { png, jpeg } from './image-fixtures.mjs';

test('編集画面を再表示すると本人用の小画像を自動取得し、再描画でもプレビューを保持', async () => {
  const h = harness(); h.setup(); const a = h.login();
  a.data = h.call('saveProfile', a.token, saveRequest(a.data, { publications: [book()] })).data;
  const staged = h.call('stagePublicationImage', a.token, { publicationId: a.data.publications[0].id,
    revision: a.data.revision, requestId: 'preview_upload_123456789', contentType: 'image/png', base64: png,
    thumbnail: { contentType: 'image/jpeg', base64: jpeg } });
  const request = saveRequest(staged.data); request.publications[0].imageIds = [staged.data.stagedImages[0].image.id];
  a.data = h.call('saveProfile', a.token, request).data;
  const client = clientHarness(h.call, new Map([['hf_test.exhibitorSession.v1', a.token]]), { hpRole: 'exhibitor' });
  await client.settle(); await client.settle();
  const all = node => [node, ...node.children.flatMap(all)];
  const image = all(client.elements.books).find(node => node.tagName === 'img');
  assert.equal(image.hidden, false); assert.match(image.src, /^data:image\/jpeg;base64,/);
  const before = client.calls.filter(item => item.name === 'getPublicationImage'); assert.equal(before.length, 1); assert.equal(before[0].args[2], 'thumbnail');
  await client.event('profileForm', 'submit');
  assert.equal(all(client.elements.books).find(node => node.tagName === 'img').hidden, false);
  assert.equal(client.calls.filter(item => item.name === 'getPublicationImage').length, 1);
});

test('JPEG入力ではPNG圧縮を試さず、小画像のCanvasを長辺240pxにする', async () => {
  const encodes = [], sizes = [];
  const client = clientHarness(() => ({ ok: true }), new Map(), { hpRole: 'exhibitor',
    createImageBitmap: async () => ({ width: 1200, height: 800, close() {} }),
    canvas: () => {
      const canvas = { getContext: () => ({ drawImage() {}, fillRect() {} }), toBlob: (callback, type) => {
        encodes.push(type); sizes.push([canvas.width, canvas.height]);
        callback(new Blob([Buffer.from(type === 'image/jpeg' ? jpeg : png, 'base64')], { type }));
      } }; return canvas;
    } });
  const result = await client.invoke('prepareImage', new Blob([Buffer.from(jpeg, 'base64')], { type: 'image/jpeg' }));
  assert.deepEqual(encodes, ['image/jpeg', 'image/jpeg']); assert.deepEqual(sizes, [[1200, 800], [240, 160]]);
  assert.ok(result.thumbnail.base64.length < 40000);
});

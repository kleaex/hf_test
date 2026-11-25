import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateCatalog } from '../docs/catalog-schema.mjs';

const defaultWorkspace = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function regularFile(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink()) throw new Error('リンク経由のファイルは使用できません。');
  }
  if (!(await fs.stat(current)).isFile()) throw new Error('通常のファイルではありません。');
  return current;
}

async function entries(root, prefix = '') {
  const list = [];
  for (const item of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error('リンクを含む書出しデータは使用できません。');
    if (item.isDirectory() && relative === 'images') list.push(...await entries(root, 'images/'));
    else if (item.isFile()) list.push(relative);
    else throw new Error('書出しデータに許可されていない項目があります。');
    if (list.length > 302) throw new Error('書出しファイルが多すぎます。');
  }
  return list;
}

export async function readRelease(source) {
  const root = await fs.realpath(source);
  const actual = await entries(root);
  if (actual.some(name => !/^(catalog\.json|manifest\.json|images\/img_[a-f0-9]{32}\.(png|jpg))$/.test(name))) throw new Error('公開対象以外のファイルがあります。');
  const buffers = new Map();
  let total = 0;
  for (const name of actual) {
    const file = await regularFile(root, name);
    const size = (await fs.stat(file)).size;
    if (size > (name.endsWith('.json') ? 1000000 : 1500000) || total + size > 22000000) throw new Error('書出しデータが上限を超えています。');
    const bytes = await fs.readFile(file); total += bytes.length; buffers.set(name, bytes);
  }
  const manifest = JSON.parse(buffers.get('manifest.json')?.toString('utf8') || 'null');
  if (!manifest || Object.keys(manifest).some(key => !['schemaVersion', 'releaseId', 'files'].includes(key))
      || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 301) throw new Error('公開版の一覧が不正です。');
  const listed = new Set(['manifest.json']);
  for (const entry of manifest.files) {
    if (!entry || Object.keys(entry).some(key => !['path', 'bytes', 'sha256'].includes(key))
        || typeof entry.path !== 'string' || listed.has(entry.path) || !buffers.has(entry.path)
        || buffers.get(entry.path).length !== entry.bytes || sha256(buffers.get(entry.path)) !== entry.sha256) throw new Error('公開版のファイル検証に失敗しました。');
    listed.add(entry.path);
  }
  if (listed.size !== buffers.size || !listed.has('catalog.json')) throw new Error('公開版に欠落・余分なファイルがあります。');
  const data = validateCatalog(JSON.parse(buffers.get('catalog.json').toString('utf8')), { releaseOnly: true });
  if (data.releaseId !== manifest.releaseId) throw new Error('公開版IDが一致しません。');
  const images = data.exhibitors.flatMap(exhibitor => exhibitor.publications.flatMap(book => book.images));
  if (images.length + 2 !== buffers.size) throw new Error('画像の参照とファイル数が一致しません。');
  for (const image of images) {
    const name = image.src.slice(('./data/releases/' + data.releaseId + '/').length);
    const bytes = buffers.get(name);
    if (!bytes || (name.endsWith('.png') ? !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)) throw new Error('画像ファイルの形式が一致しません。');
  }
  return { data, buffers };
}

async function safeDirectory(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    await fs.mkdir(current, { recursive: true });
    if ((await fs.lstat(current)).isSymbolicLink() || !(await fs.stat(current)).isDirectory()) throw new Error('反映先のディレクトリが不正です。');
  }
  return current;
}

async function atomicFile(target, bytes) {
  try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('反映先がリンクになっています。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = target + '.tmp-' + crypto.randomUUID();
  try { await fs.writeFile(temporary, bytes, { flag: 'wx' }); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
}

export async function installCatalog(source, { mode = 'preview', workspace = defaultWorkspace } = {}) {
  if (!['preview', 'apply'].includes(mode)) throw new Error('反映モードが不正です。');
  const { data, buffers } = await readRelease(source);
  const root = await fs.realpath(workspace);
  const publicRoot = mode === 'apply' ? await safeDirectory(root, 'docs') : await safeDirectory(root, 'tmp/catalog-preview/' + data.releaseId);
  if (mode === 'preview') {
    for (const name of ['index.html', 'styles.css', 'app.js', 'catalog-schema.mjs']) {
      await atomicFile(path.join(publicRoot, name), await fs.readFile(await regularFile(root, 'docs/' + name)));
    }
  }
  const releaseRoot = await safeDirectory(publicRoot, 'data/releases/' + data.releaseId);
  if ((await entries(releaseRoot)).some(name => !buffers.has(name))) throw new Error('反映先の公開版に余分なファイルがあります。');
  // 同じIDの内容は不変。既存版が異なる内容なら、現行カタログを切り替えない。
  for (const [name, bytes] of buffers) {
    const target = path.join(releaseRoot, name);
    if (name.startsWith('images/')) await safeDirectory(releaseRoot, 'images');
    try {
      const existing = await fs.readFile(await regularFile(releaseRoot, name));
      if (!existing.equals(bytes)) throw new Error('同じ公開版IDの内容を変更することはできません。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const [name, bytes] of buffers) await atomicFile(path.join(releaseRoot, name), bytes);
  // すべての画像・版データの配置成功後に、現行データを最後に切り替える。
  await atomicFile(path.join(publicRoot, 'data/catalog.json'), buffers.get('catalog.json'));
  return { mode, releaseId: data.releaseId, directory: publicRoot, exhibitorCount: data.exhibitors.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--apply')) throw new Error('使い方: node scripts/install-catalog.mjs <展開先フォルダ> [--apply]');
    const result = await installCatalog(args[0], { mode: args[1] ? 'apply' : 'preview' });
    console.log(result.mode === 'preview' ? '確認用カタログを作成しました。' : 'ローカルの公開対象データを更新しました。GitHub Pagesへの反映はまだです。');
    console.log('公開版: ' + result.releaseId + '\n出店者: ' + result.exhibitorCount + '組\n配置先: ' + result.directory);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

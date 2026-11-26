'use strict';
import { validateCatalog } from './catalog-schema.mjs';

const catalog = document.getElementById('catalog');
const status = document.getElementById('status');
const search = document.getElementById('search');
const genre = document.getElementById('genre');
let exhibitors = [];
const imageCache = new Map();
const readyImages = new Set();
const imageQueue = [];
let activeImages = 0;
let initialPreviews = 0;
const lightbox = document.createElement('dialog');
lightbox.className = 'image-dialog';
lightbox.setAttribute('aria-label', '画像の拡大表示');
const fullImage = document.createElement('img');
const imageMessage = document.createElement('p');
const closeImage = document.createElement('button'); closeImage.type = 'button'; closeImage.textContent = '×';
closeImage.className = 'image-dialog-close'; closeImage.setAttribute('aria-label', '画像を閉じる');
closeImage.addEventListener('click', () => lightbox.close());
lightbox.addEventListener('click', event => {
  if (event.target !== lightbox) return;
  const bounds = lightbox.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) lightbox.close();
});
lightbox.append(closeImage, imageMessage, fullImage); document.body.append(lightbox);
let openedImage = 0;
lightbox.addEventListener('close', () => { openedImage++; fullImage.removeAttribute('src'); });

function imageData(id, variant, representative = false) {
  const key = id + ':' + variant;
  const started = Date.now();
  if (imageCache.has(key)) {
    const source = readyImages.has(key) ? 'memory' : 'inflight';
    return imageCache.get(key).then(url => {
      window.hfPerformance?.record('imageLoad', Date.now() - started, null, { variant, source }); return url;
    });
  }
  const details = { variant, source: 'gas' };
  const promise = (async () => {
    const cached = await cachedImage(id, variant);
    if (cached) { details.source = 'browser'; details.bytes = cached.size; return URL.createObjectURL(cached); }
    return new Promise((resolve, reject) => {
      imageQueue.push({ id, variant, resolve, reject, details, queuedAt: Date.now(), priority: representative && initialPreviews++ < 2 });
      Promise.resolve().then(drainImages);
    });
  })().then(url => {
    readyImages.add(key); window.hfPerformance?.record('imageLoad', Date.now() - started, null, details); return url;
  });
  imageCache.set(key, promise);
  promise.catch(() => imageCache.delete(key));
  return promise;
}
// カタログは毎回新規取得する。そこに含まれる不変の画像IDだけをブラウザー内で再利用する。
async function imageStorage(id, variant) {
  if (!window.caches) return null;
  const cache = await window.caches.open('hf-public-images-v1-' + variant);
  const url = new URL('./__image_cache__/' + id + '/' + variant, location.href);
  url.searchParams.set('source', window.HF_CONNECTION.gasUrl);
  return { cache, key: url.href };
}
async function cachedImage(id, variant) {
  try {
    const storage = await imageStorage(id, variant); if (!storage) return null;
    const response = await storage.cache.match(storage.key); if (!response) return null;
    const age = Date.now() - Number(response.headers.get('X-HF-Cached-At'));
    if (!Number.isFinite(age) || age < 0 || age > 7 * 86400000) { await storage.cache.delete(storage.key); return null; }
    const blob = await response.blob();
    if (['image/jpeg', 'image/png'].includes(blob.type) && blob.size > 0 && blob.size <= (variant === 'thumbnail' ? 120000 : 1500000)) return blob;
  } catch (_) { /* Storage制限時も通常の画像取得を続ける。 */ }
  return null;
}
let cacheWrites = Promise.resolve();
function keepImage(id, variant, blob) {
  if (blob.size > (variant === 'thumbnail' ? 120000 : 1500000)) return;
  cacheWrites = cacheWrites.then(async () => {
    const storage = await imageStorage(id, variant); if (!storage) return;
    await storage.cache.put(storage.key, new Response(blob, { headers: { 'Content-Type': blob.type, 'X-HF-Cached-At': String(Date.now()) } }));
    const keys = await storage.cache.keys();
    const limit = variant === 'thumbnail' ? 160 : 8;
    for (const key of keys.slice(0, Math.max(0, keys.length - limit))) await storage.cache.delete(key);
  }).catch(() => {});
}
function decodedImage(result, task) {
  const started = Date.now();
  if (!result || result.ok === false) throw result?.error || new Error('画像を取得できません。');
  if (!['image/jpeg', 'image/png'].includes(result.contentType) || typeof result.base64 !== 'string'
      || result.base64.length > 2000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.base64)) throw new Error('画像の形式が不正です。');
  const binary = atob(result.base64);
  const blob = new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: result.contentType });
  task.details.bytes = blob.size;
  window.hfPerformance?.record('imageUnpack', Date.now() - started, null, { variant: task.variant, bytes: blob.size });
  keepImage(task.id, task.variant, blob);
  return URL.createObjectURL(blob);
}
function drainImages() {
  while (activeImages < 3 && imageQueue.length) {
    // クリックした拡大画像を、未取得の一覧画像より先に処理する。
    const full = imageQueue.findIndex(task => task.variant === 'full');
    const priority = imageQueue.findIndex(task => task.priority);
    const tasks = full >= 0 ? imageQueue.splice(full, 1) : priority >= 0 ? imageQueue.splice(priority, 1) : imageQueue.splice(0, 3);
    for (const task of tasks) window.hfPerformance?.record('imageQueue', Date.now() - task.queuedAt, null, { variant: task.variant });
    activeImages++;
    (async () => {
      const result = tasks[0].variant === 'full'
        ? { images: [Object.assign({ id: tasks[0].id }, await window.hfRpc('getPublicImage', tasks[0].id, 'full'))] }
        : await window.hfRpc('getPublicImages', tasks.map(task => task.id));
      for (const task of tasks) {
        try {
          const entry = result.images?.find(image => image.id === task.id);
          task.resolve(decodedImage(entry, task));
        } catch (error) { task.reject(error); }
      }
    })().catch(error => tasks.forEach(task => task.reject(error))).finally(() => { activeImages--; drainImages(); });
  }
}
const imageObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) { imageObserver.unobserve(entry.target); entry.target.loadPreview(); }
}, { rootMargin: '160px' }) : null;
window.addEventListener('pagehide', () => {
  for (const promise of imageCache.values()) promise.then(url => URL.revokeObjectURL(url), () => {});
  imageCache.clear();
  readyImages.clear();
});

function recordImageReady(img, src, started, variant, current) {
  if (typeof img.decode !== 'function') return;
  img.decode().then(() => {
    if (current() && img.src === src) window.hfPerformance?.record('imageReady', Date.now() - started, null, { variant });
  }).catch(() => {}); // 画面切替・閉じる・読込失敗は表示完了として記録しない。
}

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function imageLink(image, title, index) {
  if (image.id) {
    const link = element('button', undefined, 'cover image-link'); link.type = 'button';
    link.setAttribute('aria-label', title + 'の画像' + (index + 1) + 'を拡大');
    const img = element('img'); img.alt = title + 'の画像' + (index + 1); img.width = image.width; img.height = image.height; img.decoding = 'async';
    link.append(img);
    link.loadPreview = async () => {
      const started = Date.now();
      try {
        const src = await imageData(image.id, 'thumbnail', index === 0); img.src = src;
        recordImageReady(img, src, started, 'thumbnail', () => img.isConnected !== false);
      }
      catch (_) { link.replaceChildren(element('span', '画像の取得を再試行')); }
    };
    link.addEventListener('click', async () => {
      const started = Date.now();
      const request = ++openedImage; imageMessage.textContent = '画像を読み込んでいます。'; fullImage.removeAttribute('src'); fullImage.alt = img.alt;
      if (img.src) { fullImage.src = img.src; imageMessage.textContent = '高画質の画像を読み込んでいます。'; }
      if (!lightbox.open) lightbox.showModal();
      try { const url = await imageData(image.id, 'full'); if (request === openedImage) {
        fullImage.src = url; imageMessage.textContent = '';
        recordImageReady(fullImage, url, started, 'full', () => request === openedImage && lightbox.open);
      } }
      catch (_) { if (request === openedImage) imageMessage.textContent = '画像を読み込めませんでした。閉じて再試行してください。'; }
    });
    if (imageObserver) imageObserver.observe(link); else link.loadPreview();
    return link;
  }
  const link = element('a', undefined, 'cover image-link');
  link.href = image.src; link.target = '_blank'; link.rel = 'noopener noreferrer';
  const img = element('img');
  img.src = image.src; img.alt = title + 'の画像' + (index + 1);
  img.width = image.width; img.height = image.height; img.loading = 'lazy'; img.decoding = 'async';
  img.addEventListener('error', () => { link.replaceChildren(element('span', '画像を読み込めませんでした。')); });
  link.append(img); return link;
}

function render() {
  if (imageObserver) imageObserver.disconnect();
  const query = search.value.trim().normalize('NFKC').toLocaleLowerCase('ja');
  const selected = exhibitors.filter(exhibitor => {
    const text = [exhibitor.name, exhibitor.description,
      ...exhibitor.publications.flatMap(book => [book.title, book.author, book.description])].join(' ');
    return (!genre.value || exhibitor.genre === genre.value)
      && text.normalize('NFKC').toLocaleLowerCase('ja').includes(query);
  });
  catalog.replaceChildren();
  for (const exhibitor of selected) {
    const card = element('article', undefined, 'exhibitor');
    card.append(element('p', exhibitor.booth ? 'ブース ' + exhibitor.booth : '配置未定', 'booth'),
      element('h3', exhibitor.name), element('p', exhibitor.description),
      element('p', exhibitor.genre, 'meta'));
    const books = element('div', undefined, 'books');
    for (const book of exhibitor.publications) {
      const item = element('article', undefined, 'book');
      const content = element('div');
      content.append(element('h4', book.title), element('p', book.author, 'meta'),
        element('p', book.description),
        element('p', new Intl.NumberFormat('ja-JP').format(book.price) + '円 / ' + book.releaseType, 'meta'));
      const images = book.images || [];
      item.append(images.length ? imageLink(images[0], book.title, 0) : element('div', '書影未登録', 'cover'), content);
      if (images.length > 1) {
        const details = element('details', undefined, 'book-images');
        details.append(element('summary', '補足・試し読み画像（' + (images.length - 1) + '点）'));
        const gallery = element('div', undefined, 'image-gallery');
        images.slice(1).forEach((image, index) => gallery.append(imageLink(image, book.title, index + 1)));
        details.append(gallery); content.append(details);
      }
      books.append(item);
    }
    card.append(books);
    catalog.append(card);
  }
  status.textContent = selected.length ? selected.length + '組の出店者を表示しています。'
    : '条件に合う出店者がありません。検索条件を変えてください。';
}

async function load() {
  const loadStarted = Date.now();
  try {
    let raw, initialImages = [];
    if (window.HF_CONNECTION?.gasUrl) {
      const result = await (window.hfLoadCatalog ? window.hfLoadCatalog() : window.hfRpc('getPublicCatalog'));
      raw = result.data;
      if (Array.isArray(result.initialImages)) initialImages = result.initialImages.slice(0, 1);
    }
    else {
      const response = await fetch('./data/catalog.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Catalog unavailable');
      raw = await response.json();
    }
    const data = validateCatalog(raw, { allowLive: true });
    const publicIds = new Set(data.exhibitors.flatMap(exhibitor => exhibitor.publications.flatMap(book => (book.images || []).map(image => image.id))));
    for (const image of initialImages) {
      if (!image || !publicIds.has(image.id) || typeof image.base64 !== 'string' || image.base64.length > 40000) continue;
      const key = image.id + ':thumbnail';
      try {
        const url = decodedImage(image, { id: image.id, variant: 'thumbnail', details: {} });
        imageCache.set(key, Promise.resolve(url)); readyImages.add(key);
      } catch (_) { /* 同梱画像の問題で本文の表示を止めない。通常の画像要求で再試行する。 */ }
    }
    const publicationInfo = document.getElementById('publicationInfo');
    publicationInfo.textContent = data.sample ? 'サンプルカタログを表示しています。'
      : data.live ? '保存済みの公開情報 ／ 取得日時 ' + new Date(data.generatedAt).toLocaleString('ja-JP')
      : '公開版 ' + data.releaseId + ' ／ 書出し日時 ' + new Date(data.generatedAt).toLocaleString('ja-JP');
    if (!data.sample) {
      document.getElementById('eventTitle').textContent = data.title;
      document.title = data.title + '｜実験カタログ';
      document.getElementById('catalogNotice').textContent = '実験用：運営が選択した登録情報の公開版です。開催・出店募集は行っていません。';
      document.getElementById('eventInfo').textContent = [data.eventDate, data.venue].filter(Boolean).join(' ／ ');
    }
    exhibitors = data.exhibitors;
    for (const value of new Set(exhibitors.map(item => item.genre))) {
      const option = element('option', value);
      option.value = value;
      genre.append(option);
    }
    search.addEventListener('input', render);
    genre.addEventListener('change', render);
    const started = Date.now(); render(); window.hfPerformance?.record('catalogPaint', Date.now() - started);
    window.hfPerformance?.record('catalogLoad', Date.now() - loadStarted);
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      window.hfPerformance?.record('catalogTextReady', performance.now());
    }
  } catch (error) {
    catalog.replaceChildren();
    status.textContent = 'カタログを読み込めませんでした。時間をおいて再読み込みしてください。';
    console.error(error);
  }
}
load();

'use strict';
import { validateCatalog } from './catalog-schema.mjs';

const catalog = document.getElementById('catalog');
const status = document.getElementById('status');
const search = document.getElementById('search');
const genre = document.getElementById('genre');
let exhibitors = [];
const imageCache = new Map();
const imageQueue = [];
let activeImages = 0;
const lightbox = document.createElement('dialog');
lightbox.className = 'image-dialog';
const fullImage = document.createElement('img');
const imageMessage = document.createElement('p');
const closeImage = document.createElement('button'); closeImage.type = 'button'; closeImage.textContent = '閉じる';
closeImage.addEventListener('click', () => lightbox.close());
lightbox.append(closeImage, imageMessage, fullImage); document.body.append(lightbox);
let openedImage = 0;
lightbox.addEventListener('close', () => { openedImage++; fullImage.removeAttribute('src'); });

function imageData(id, variant) {
  const key = id + ':' + variant;
  if (imageCache.has(key)) return imageCache.get(key);
  const promise = new Promise((resolve, reject) => { imageQueue.push({ id, variant, resolve, reject }); drainImages(); });
  imageCache.set(key, promise);
  promise.catch(() => imageCache.delete(key));
  return promise;
}
function drainImages() {
  while (activeImages < 3 && imageQueue.length) {
    const task = imageQueue.shift(); activeImages++;
    (async () => {
      const result = await window.hfRpc('getPublicImage', task.id, task.variant);
      if (!['image/jpeg', 'image/png'].includes(result.contentType) || typeof result.base64 !== 'string'
          || result.base64.length > 2000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.base64)) throw new Error('画像の形式が不正です。');
      const binary = atob(result.base64);
      return URL.createObjectURL(new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: result.contentType }));
    })().then(task.resolve, task.reject).finally(() => { activeImages--; drainImages(); });
  }
}
const imageObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) { imageObserver.unobserve(entry.target); entry.target.loadPreview(); }
}, { rootMargin: '160px' }) : null;
window.addEventListener('pagehide', () => {
  for (const promise of imageCache.values()) promise.then(url => URL.revokeObjectURL(url), () => {});
  imageCache.clear();
});

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
      try { img.src = await imageData(image.id, 'thumbnail'); }
      catch (_) { link.replaceChildren(element('span', '画像の取得を再試行')); }
    };
    link.addEventListener('click', async () => {
      const request = ++openedImage; imageMessage.textContent = '画像を読み込んでいます。'; fullImage.removeAttribute('src'); fullImage.alt = img.alt;
      if (!lightbox.open) lightbox.showModal();
      try { const url = await imageData(image.id, 'full'); if (request === openedImage) { fullImage.src = url; imageMessage.textContent = ''; } }
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
  try {
    let raw;
    if (window.HF_CONNECTION?.gasUrl) raw = (await window.hfRpc('getPublicCatalog')).data;
    else {
      const response = await fetch('./data/catalog.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Catalog unavailable');
      raw = await response.json();
    }
    const data = validateCatalog(raw, { allowLive: true });
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
    render();
  } catch (error) {
    catalog.replaceChildren();
    status.textContent = 'カタログを読み込めませんでした。時間をおいて再読み込みしてください。';
    console.error(error);
  }
}
load();

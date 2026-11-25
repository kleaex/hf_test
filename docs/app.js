'use strict';
import { validateCatalog } from './catalog-schema.mjs';

const catalog = document.getElementById('catalog');
const status = document.getElementById('status');
const search = document.getElementById('search');
const genre = document.getElementById('genre');
let exhibitors = [];

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function imageLink(image, title, index) {
  const link = element('a', undefined, 'cover image-link');
  link.href = image.src; link.target = '_blank'; link.rel = 'noopener noreferrer';
  const img = element('img');
  img.src = image.src; img.alt = title + 'の画像' + (index + 1);
  img.width = image.width; img.height = image.height; img.loading = 'lazy'; img.decoding = 'async';
  img.addEventListener('error', () => { link.replaceChildren(element('span', '画像を読み込めませんでした。')); });
  link.append(img); return link;
}

function render() {
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
    const response = await fetch('./data/catalog.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Catalog unavailable');
    const data = validateCatalog(await response.json());
    const publicationInfo = document.getElementById('publicationInfo');
    publicationInfo.textContent = data.sample ? 'サンプルカタログを表示しています。'
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

'use strict';

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
    card.append(element('p', 'ブース ' + exhibitor.booth, 'booth'),
      element('h3', exhibitor.name), element('p', exhibitor.description),
      element('p', exhibitor.genre, 'meta'));
    const books = element('div', undefined, 'books');
    for (const book of exhibitor.publications) {
      const item = element('article', undefined, 'book');
      const content = element('div');
      content.append(element('h4', book.title), element('p', book.author, 'meta'),
        element('p', book.description),
        element('p', new Intl.NumberFormat('ja-JP').format(book.price) + '円 / ' + book.releaseType, 'meta'));
      item.append(element('div', '書影未登録', 'cover'), content);
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
    const response = await fetch('./data/catalog.json');
    if (!response.ok) throw new Error('Catalog unavailable');
    const data = await response.json();
    if (data.schemaVersion !== 1 || !Array.isArray(data.exhibitors)) throw new Error('Invalid catalog');
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

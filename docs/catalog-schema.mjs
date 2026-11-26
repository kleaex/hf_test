// 公開項目・ローカル画像参照だけを許可する。GASの業務データは受け取らない。
export function validateCatalog(data, { releaseOnly = false, allowLive = false } = {}) {
  const fail = () => { throw new Error('公開カタログの形式が正しくありません。'); };
  const keys = (value, allowed) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail();
  };
  const string = (value, max, required = false) => {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail();
  };
  keys(data, ['schemaVersion', 'sample', 'eventId', 'title', 'eventDate', 'venue', 'releaseId', 'generatedAt', 'exhibitors', 'live']);
  const live = data.live === true && allowLive && !releaseOnly && data.sample === false;
  if (data.live !== undefined && !live) fail();
  if (data.schemaVersion !== 1 || typeof data.sample !== 'boolean' || (releaseOnly && data.sample)) fail();
  if (!data.sample) {
    if ((!live && !/^rel_[0-9]{13}_[a-f0-9]{12}$/.test(data.releaseId || '')) || (live && data.releaseId !== undefined) || !/^[A-Za-z0-9_-]{1,64}$/.test(data.eventId || '')
        || !Number.isSafeInteger(data.generatedAt) || data.generatedAt < 1) fail();
    string(data.title, 120, true);
    if (data.eventDate !== undefined) { string(data.eventDate, 10); if (data.eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(data.eventDate)) fail(); }
    if (data.venue !== undefined) string(data.venue, 200);
  }
  if (!Array.isArray(data.exhibitors) || (!live && data.exhibitors.length > 10) || (!live && !data.sample && !data.exhibitors.length)) fail();
  const ids = new Set(), booths = new Set(), paths = new Set();
  const id = (value, pattern) => { if (typeof value !== 'string' || !pattern.test(value) || ids.has(value)) fail(); ids.add(value); };
  for (const exhibitor of data.exhibitors) {
    keys(exhibitor, ['id', 'name', 'genre', 'description', 'booth', 'publications']);
    id(exhibitor.id, data.sample ? /^[A-Za-z0-9_-]{1,128}$/ : /^exh_[A-Za-z0-9_-]{1,50}$/);
    string(exhibitor.name, 80, true); string(exhibitor.genre, 40); string(exhibitor.description, 2000); string(exhibitor.booth, 40);
    if (exhibitor.booth) { if (booths.has(exhibitor.booth)) fail(); booths.add(exhibitor.booth); }
    if (!Array.isArray(exhibitor.publications) || exhibitor.publications.length > 10) fail();
    for (const book of exhibitor.publications) {
      keys(book, ['id', 'title', 'author', 'description', 'price', 'releaseType', 'images']);
      id(book.id, data.sample ? /^[A-Za-z0-9_-]{1,128}$/ : /^pub_[a-f0-9]{32}$/);
      string(book.title, 120, true); string(book.author, 120); string(book.description, 2000);
      if (!Number.isSafeInteger(book.price) || book.price < 0 || book.price > 1000000 || !['新刊', '既刊', 'その他'].includes(book.releaseType)) fail();
      const images = data.sample && book.images === undefined ? [] : book.images;
      if (!Array.isArray(images) || images.length > 3) fail();
      for (const image of images) {
        if (live) {
          keys(image, ['id', 'width', 'height']);
          id(image.id, /^img_[a-f0-9]{32}$/);
          if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1
              || image.width > 2400 || image.height > 2400) fail();
          continue;
        }
        keys(image, ['src', 'width', 'height']);
        const prefix = './data/releases/' + data.releaseId + '/images/';
        if (data.sample || typeof image.src !== 'string' || !image.src.startsWith(prefix)
            || !/^img_[a-f0-9]{32}\.(png|jpg)$/.test(image.src.slice(prefix.length)) || paths.has(image.src)
            || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1
            || image.width > 2400 || image.height > 2400) fail();
        paths.add(image.src);
      }
    }
  }
  return data;
}

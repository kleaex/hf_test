import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';

// 実際のIndex.html内スクリプトを動かす最小DOM。描画やブラウザーのStorage挙動は検証しない。
export function clientHarness(backend, storage = new Map(), options = {}) {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.events = {}; this.hidden = false; this.value = ''; this.textContent = ''; this.disabled = false; }
    addEventListener(name, handler) { this.events[name] = handler; }
    append(...nodes) { this.children.push(...nodes); for (const node of nodes) node.parent = this; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
    removeAttribute(name) { delete this[name]; }
    setAttribute(name, value) { this[name] = value; }
    prepend(node) { node.remove(); this.children.unshift(node); node.parent = this; }
    querySelectorAll(selector) {
      const all = this.children.flatMap(node => [node, ...node.querySelectorAll(selector)]);
      if (selector === '[data-key]') return all.filter(node => node.dataset.key);
      const tags = selector.split(',').map(tag => tag.trim());
      return all.filter(node => tags.includes(node.tagName));
    }
    reportValidity() { return true; }
    reset() { for (const id of options.htmlFile ? ['title', 'eventDate', 'venue', 'deadline'] : ['name', 'description', 'genre']) elements[id].value = ''; }
  }
  const html = fs.readFileSync(new URL('../gas/' + (options.htmlFile || 'Index.html'), import.meta.url), 'utf8');
  const elements = {};
  for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"/g)) {
    elements[match[2]] = new Element(); elements[match[2]].tagName = match[1];
  }
  if (options.htmlFile) elements.fields.append(elements.title, elements.eventDate, elements.venue, elements.deadline, elements.exhibitors);
  else elements.fields.append(elements.name, elements.description, elements.genre, elements.books, elements.addBook);
  for (const id of options.htmlFile ? ['dashboard', 'storageNotice', 'restore', 'previewPanel'] : ['editor', 'sessionNotice', 'restore', 'imageConfirm']) elements[id].hidden = true;
  const calls = [];
  const google = { script: { get run() {
    let success, failure;
    const runner = new Proxy({}, { get(_, name) {
      if (name === 'withSuccessHandler') return callback => { success = callback; return runner; };
      if (name === 'withFailureHandler') return callback => { failure = callback; return runner; };
      return (...args) => {
        calls.push({ name, args });
        Promise.resolve().then(() => backend(name, ...args)).then(success, failure);
      };
    } }); return runner;
  } } };
  const window = { google, addEventListener() {} };
  Object.defineProperty(window, 'sessionStorage', { get() {
    if (options.storageBlocked) throw new Error('SecurityError');
    return { getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  } });
  const document = { getElementById: id => elements[id], createElement: tag => {
    if (tag === 'canvas' && options.canvas) return options.canvas();
    const node = new Element(); node.tagName = tag; return node;
  },
    querySelectorAll: () => [elements.email, elements.code, ...(elements.sendCode ? [elements.sendCode] : [])] };
  const context = vm.createContext({ window, document, google, crypto, btoa, confirm: () => true,
    ...(options.createImageBitmap ? { createImageBitmap: options.createImageBitmap } : {}) });
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(source, context, { filename: 'Index.html' });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const event = async (id, name = 'click') => {
    const target = typeof id === 'string' ? elements[id] : id;
    target.events[name]({ preventDefault() {}, target }); await settle();
  };
  return { elements, storage, calls, settle, event, invoke: (name, ...args) => context[name](...args) };
}

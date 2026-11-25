import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { png, jpeg } from './image-fixtures.mjs';

// Apps Script境界の代替。実Google接続・送信を行わず、同じ.gsを実行する。
export function harness() {
  const sheets = new Map();
  const properties = {
    HF_ENV: 'experiment', HF_SPREADSHEET_ID: 'test_spreadsheet_not_a_real_id', HF_EVENT_ID: 'test_2026',
    HF_EDIT_DEADLINE: '2026-12-31T23:59:59+09:00', HF_IMAGE_FOLDER_ID: 'test_image_folder_only',
    HF_EXPORT_FOLDER_ID: 'test_export_folder_only',
    HF_ADMIN_EMAILS: JSON.stringify(['ops@example.invalid']),
    HF_PUBLICATION_CONFIG_JSON: JSON.stringify({ title: '架空の文芸市', exhibitors: [{ exhibitorId: 'exh_a', booth: 'A-01' }] }),
    HF_AUTH_SECRET: 'local-test-only-secret-value-not-for-any-deployment-123456',
    HF_TEST_EMAILS: JSON.stringify(['a@example.invalid', 'b@example.invalid']),
    HF_BOOTSTRAP_JSON: JSON.stringify([
      { userId: 'usr_a', exhibitorId: 'exh_a', email: 'a@example.invalid', name: '架空A' },
      { userId: 'usr_b', exhibitorId: 'exh_b', email: 'b@example.invalid', name: '架空B' }
    ])
  };
  let now = Date.UTC(2026, 10, 24);
  const state = { mail: [], quota: 100, mailFails: false, lockAvailable: true, locked: false,
    failWrite: null, failAfterWrite: null, decodeFails: false, conversions: 0,
    folderShared: false, folderViewers: [], folderEditors: [], driveFails: false, exportFolderShared: false, zipEntries: [] };
  const files = new Map();
  const iterator = items => { let at = 0; return { hasNext: () => at < items.length, next: () => items[at++] }; };
  function blob(bytes, type, name) {
    if (typeof bytes === 'string') bytes = [...Buffer.from(bytes, 'utf8')];
    return { getBytes: () => [...bytes], getContentType: () => type, getName: () => name,
      getAs: output => {
        state.conversions++;
        if (state.decodeFails) throw new Error('decode failed');
        // Googleの実デコーダーは代替しない。テスト用2x2の変換結果だけを返す。
        return blob([...Buffer.from(output === 'image/png' ? png : jpeg, 'base64')], output, name);
      } };
  }
  const folder = {
    getId: () => 'test_image_folder_only', isTrashed: () => false, getOwner: () => ({}),
    getSharingAccess: () => state.folderShared ? 'ANYONE' : 'PRIVATE',
    getViewers: () => state.folderViewers, getEditors: () => state.folderEditors,
    getFilesByName: name => iterator([...files.values()].filter(file => file.name === name && !file.trashed)),
    createFile: data => {
      if (state.driveFails) throw new Error('private Drive failure');
      const id = 'file_' + crypto.randomUUID();
      const file = { id, name: data.getName(), data, shared: false, trashed: false,
        getId: () => id, getBlob: () => file.data, getOwner: () => ({}), isTrashed: () => file.trashed,
        getSharingAccess: () => file.shared ? 'ANYONE' : 'PRIVATE', getEditors: () => [], getViewers: () => [],
        getParents: () => iterator([folder]) };
      files.set(id, file); return file;
    }
  };
  const exportFolder = { ...folder, getId: () => 'test_export_folder_only',
    getSharingAccess: () => state.exportFolderShared ? 'ANYONE' : 'PRIVATE',
    createFile: data => { const file = folder.createFile(data); file.getParents = () => iterator([exportFolder]); return file; } };
  class Sheet {
    constructor(name) { this.name = name; this.data = []; }
    getName() { return this.name; }
    getLastRow() { return this.data.length; }
    getRange(row, column, height, width) {
      return {
        getValues: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => this.data[row - 1 + r]?.[column - 1 + c] ?? '')),
        setValues: values => {
          if (state.failWrite === this.name) { state.failWrite = null; throw new Error('private backend details'); }
          values.forEach((cells, r) => {
            this.data[row - 1 + r] ||= [];
            cells.forEach((value, c) => { this.data[row - 1 + r][column - 1 + c] = value; });
          });
          if (state.failAfterWrite === this.name) { state.failAfterWrite = null; throw new Error('reply lost after commit'); }
        }
      };
    }
  }
  const spreadsheet = { getSheetByName: name => sheets.get(name) || null,
    insertSheet: name => { const sheet = new Sheet(name); sheets.set(name, sheet); return sheet; } };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    Date: Clock,
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...properties }),
      getProperty: key => properties[key] ?? null, setProperty: (key, value) => { properties[key] = value; } }) },
    SpreadsheetApp: { openById: id => {
      if (id !== 'test_spreadsheet_not_a_real_id') throw new Error('not connected');
      return spreadsheet;
    }, flush: () => {} },
    LockService: { getScriptLock: () => ({ tryLock: () => {
      if (!state.lockAvailable || state.locked) return false;
      state.locked = true; return true;
    }, releaseLock: () => { state.locked = false; } }) },
    MailApp: { getRemainingDailyQuota: () => state.quota, sendEmail: mail => {
      if (state.mailFails) throw new Error('private mail error');
      state.mail.push(mail); state.quota--;
    } },
    DriveApp: { Access: { PRIVATE: 'PRIVATE' }, getFolderById: id => {
      if (id === 'test_export_folder_only') return exportFolder;
      if (id !== 'test_image_folder_only') throw new Error('folder missing'); return folder;
    }, getFileById: id => { if (!files.has(id)) throw new Error('file missing'); return files.get(id); } },
    Utilities: { Charset: { UTF_8: 'UTF_8' }, getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, computeDigest: (_, bytes) => [...crypto.createHash('sha256').update(Buffer.from(bytes.map(byte => (byte + 256) % 256))).digest()].map(byte => byte > 127 ? byte - 256 : byte),
      zip: (blobs, name) => {
        state.zipEntries = blobs.map(data => ({ name: data.getName(), bytes: Buffer.from(data.getBytes().map(byte => (byte + 256) % 256)) }));
        const value = blob('test zip placeholder', 'application/zip', name); value.entries = blobs; return value;
      },
      unzip: value => { if (!value.entries) throw new Error('not a zip'); return value.entries; },
      base64Decode: value => [...Buffer.from(value, 'base64')].map(byte => byte > 127 ? byte - 256 : byte),
      base64Encode: bytes => Buffer.from(bytes.map(byte => (byte + 256) % 256)).toString('base64'), newBlob: blob,
      computeHmacSha256Signature: (value, key) => [...crypto.createHmac('sha256', key).update(value).digest()].map(byte => byte > 127 ? byte - 256 : byte) }
  });
  for (const name of ['Code', 'Store', 'Auth', 'Profile', 'Admin', 'Images', 'Publishing', 'AdminConsole']) vm.runInContext(fs.readFileSync(new URL('../gas/' + name + '.gs', import.meta.url), 'utf8'), context, { filename: name + '.gs' });
  const call = (name, ...args) => JSON.parse(JSON.stringify(context[name](...JSON.parse(JSON.stringify(args)))));
  const setup = () => call('setupExperiment_');
  const code = email => state.mail.findLast(mail => mail.to === email)?.body.match(/確認コード: (\d{6})/)[1];
  const login = (email = 'a@example.invalid') => {
    call('requestLoginCode', email);
    return call('verifyLoginCode', email, code(email));
  };
  const setupAdmin = () => call('setupAdminConsole_');
  const loginAdmin = (email = 'ops@example.invalid') => { call('requestAdminLoginCode', email); return call('verifyAdminLoginCode', email, code(email)); };
  return { call, setup, login, code, setupAdmin, loginAdmin, sheets, properties, state, files, tick: ms => { now += ms; } };
}

export function saveRequest(data, overrides = {}) {
  const request = { exhibitorId: data.exhibitorId, revision: data.revision, requestId: crypto.randomUUID(),
    profile: structuredClone(data.profile), publications: structuredClone(data.publications), ...overrides };
  if (Array.isArray(request.publications)) request.publications = request.publications.map(item => {
    const result = { ...item };
    if (result.images) { result.imageIds = result.images.map(image => image.id); delete result.images; }
    return result;
  });
  return request;
}

export function book(overrides = {}) {
  return { id: null, title: '架空の詩集', author: 'テスト著者', description: '架空の紹介', price: 500, releaseType: '新刊', ...overrides };
}

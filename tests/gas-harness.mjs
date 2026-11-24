import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Apps Script境界の代替。実Google接続・送信を行わず、同じ.gsを実行する。
export function harness() {
  const sheets = new Map();
  const properties = {
    HF_ENV: 'experiment', HF_SPREADSHEET_ID: 'test_spreadsheet_not_a_real_id', HF_EVENT_ID: 'test_2026',
    HF_AUTH_SECRET: 'local-test-only-secret-value-not-for-any-deployment-123456',
    HF_TEST_EMAILS: JSON.stringify(['a@example.invalid', 'b@example.invalid']),
    HF_BOOTSTRAP_JSON: JSON.stringify([
      { userId: 'usr_a', exhibitorId: 'exh_a', email: 'a@example.invalid', name: '架空A' },
      { userId: 'usr_b', exhibitorId: 'exh_b', email: 'b@example.invalid', name: '架空B' }
    ])
  };
  let now = Date.UTC(2026, 10, 24);
  const state = { mail: [], quota: 100, mailFails: false, lockAvailable: true, locked: false,
    failWrite: null, failAfterWrite: null };
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
    Utilities: { Charset: { UTF_8: 'UTF_8' }, getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (value, key) => [...crypto.createHmac('sha256', key).update(value).digest()].map(byte => byte > 127 ? byte - 256 : byte) }
  });
  for (const name of ['Code', 'Store', 'Auth', 'Profile', 'Admin']) vm.runInContext(fs.readFileSync(new URL('../gas/' + name + '.gs', import.meta.url), 'utf8'), context, { filename: name + '.gs' });
  const call = (name, ...args) => JSON.parse(JSON.stringify(context[name](...JSON.parse(JSON.stringify(args)))));
  const setup = () => call('setupExperiment_');
  const code = email => state.mail.findLast(mail => mail.to === email)?.body.match(/確認コード: (\d{6})/)[1];
  const login = (email = 'a@example.invalid') => {
    call('requestLoginCode', email);
    return call('verifyLoginCode', email, code(email));
  };
  return { call, setup, login, code, sheets, properties, state, tick: ms => { now += ms; } };
}

export function saveRequest(data, overrides = {}) {
  return { exhibitorId: data.exhibitorId, revision: data.revision, requestId: crypto.randomUUID(),
    profile: structuredClone(data.profile), publications: structuredClone(data.publications), ...overrides };
}

export function book(overrides = {}) {
  return { id: null, title: '架空の詩集', author: 'テスト著者', description: '架空の紹介', price: 500, releaseType: '新刊', ...overrides };
}

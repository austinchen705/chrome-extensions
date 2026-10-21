// 共用資料的 background 行為測試：在記憶體裡實際執行 background.js，假的 chrome（storage.local）與 fetch，
// 檢查發了幾次請求、查詢回覆有沒有套上共用路線、快取存了什麼。
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const extensionDir = path.join(__dirname, '..', 'catworld-auto-command');
const SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=0&single=true&output=csv';
const OTHER_SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-other/pub?gid=0&single=true&output=csv';
const HEADER = '怪物名稱,指令,備註,更新者,更新時間';
const HOUR = 60 * 60 * 1000;

const mobs = [{ name: '白猿(white ape)', id: 'white ape', exp: 250000, location: '古墓', note: '', source: 'zap' }];
const store = {};
const listeners = [];
const csvCalls = [];
const DEFAULT_CSV = `${HEADER}\n白猿(white ape),run e;push stone,先買貂皮衣,小明,2026-10-21 14:30\n`;
let csvBody = DEFAULT_CSV;
let csvFailure = null;
let clock = Date.parse('2026-10-21T12:00:00Z');
Date.now = () => clock;

globalThis.importScripts = (...names) => names.forEach(name => require(path.join(extensionDir, name)));
globalThis.fetch = async (url, options) => {
  if (url === 'zap-data.json') return { ok: true, json: async () => ({ mobs, items: [], riddles: [], pages: {}, routes: [], routeAliases: {} }) };
  csvCalls.push({ url, signal: options?.signal });
  if (csvFailure === 'hang') {
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  }
  if (csvFailure === 'network') throw new Error('network down');
  if (csvFailure === 'http') return { ok: false, status: 403, text: async () => 'denied' };
  return { ok: true, status: 200, text: async () => csvBody };
};
const noop = { addListener() {} };
globalThis.chrome = {
  runtime: { id: 'me', onMessage: { addListener: fn => listeners.push(fn) }, getURL: file => `chrome-extension://me/${file === 'zap-data.json' ? file : file}` },
  tabs: { onRemoved: noop },
  notifications: { onButtonClicked: noop, onClicked: noop },
  storage: {
    session: {},
    local: {
      get: async keys => Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, structuredClone(store[key])])),
      set: async values => { Object.assign(store, structuredClone(values)); },
    },
  },
};
// background 用 chrome.runtime.getURL('zap-data.json') 取資料：假的 fetch 認得結尾
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => realFetch(String(url).endsWith('zap-data.json') ? 'zap-data.json' : url, options);
require(path.join(extensionDir, 'background.js'));

const settingsPage = { id: 'me', url: 'chrome-extension://me/popup.html?tab=1' };
const gamePage = { tab: { id: 1 }, id: 'me', url: 'https://catworld.muds.tw/web' };
const ask = (message, sender = gamePage) => new Promise(resolve => {
  const handled = listeners.map(listener => listener(message, sender, resolve)).some(result => result === true);
  assert.equal(handled, true, 'a listener must return true to answer asynchronously');
});
const lookup = () => ask({ type: 'ZAP_LOOKUP', exp: 414748, names: [{ name: '白猿(white ape)', count: 1 }] });
const routeOf = reply => reply.items[0].candidates[0].route;
const reset = (sources = { mob: SHEET }, features = { mobs: true }) => {
  Object.keys(store).forEach(key => delete store[key]);
  Object.assign(store, { sharedSources: sources, zapFeatures: features });
  csvCalls.length = 0;
  csvFailure = null;
  csvBody = DEFAULT_CSV;
  clock = Date.parse('2026-10-21T12:00:00Z');
};

test('the first lookup fetches the sheet and puts the shared route on the reply', async () => {
  reset();
  const route = routeOf(await lookup());
  assert.equal(csvCalls.length, 1);
  assert.equal(csvCalls[0].url, SHEET);
  assert.deepEqual([route.route.command, route.shared, route.exact], ['run e;push stone', { by: '小明', note: '先買貂皮衣' }, true]);
  assert.equal(store.sharedCache.mob.url, SHEET);
  assert.equal(store.sharedCache.mob.at, clock);
  assert.deepEqual([store.sharedCache.mob.report.rows, store.sharedCache.mob.report.used], [1, 1]);
});

test('lookups within an hour use the cache; after an hour the sheet is fetched again', async () => {
  reset();
  await lookup();
  clock += HOUR - 1000;
  await lookup();
  assert.equal(csvCalls.length, 1);
  csvBody = `${HEADER}\n白猿(white ape),run changed,,小華,2026-10-21 15:00\n`;
  clock += 2000;
  const route = routeOf(await lookup());
  assert.equal(csvCalls.length, 2);
  assert.equal(route.route.command, 'run changed');
});

test('"update now" from the settings page always fetches, even when the cache is fresh', async () => {
  reset();
  await lookup();
  const reply = await ask({ type: 'SHARED_REFRESH' }, settingsPage);
  assert.equal(reply.ok, true);
  assert.equal(csvCalls.length, 2);
  assert.equal(reply.cache.mob.report.used, 1);
});

test('only the extension\'s own pages may ask for an update', () => {
  reset();
  const answered = listeners.some(listener => listener({ type: 'SHARED_REFRESH' }, gamePage, () => {}) === true);
  assert.equal(answered, false, 'a game page (content script) is ignored');
  assert.equal(csvCalls.length, 0);
});

test('changing the link drops the old cache and fetches the new sheet', async () => {
  reset();
  await lookup();
  store.sharedSources = { mob: OTHER_SHEET };
  await lookup();
  assert.deepEqual(csvCalls.map(call => call.url), [SHEET, OTHER_SHEET]);
  assert.equal(store.sharedCache.mob.url, OTHER_SHEET);
});

test('clearing the link empties the shared layer and fetches nothing', async () => {
  reset();
  await lookup();
  store.sharedSources = { mob: '' };
  csvCalls.length = 0;
  const route = routeOf(await lookup());
  assert.equal(csvCalls.length, 0);
  assert.equal(route, null, 'the built-in data has no route for this mob');
  assert.equal(store.sharedCache.mob, undefined);
});

test('a failed fetch keeps the old shared layer, records why, and does not retry on every lookup', async () => {
  reset();
  await lookup();
  clock += HOUR + 1000;
  csvFailure = 'network';
  const route = routeOf(await lookup());
  assert.equal(route.route.command, 'run e;push stone', 'the old cache still works');
  assert.match(store.sharedCache.mob.error.reason, /network down/);
  assert.equal(store.sharedCache.mob.error.at, clock);
  assert.ok(store.sharedCache.mob.at < clock, 'the last successful time is kept');
  const callsAfterFailure = csvCalls.length;
  clock += 60 * 1000;
  await lookup();
  assert.equal(csvCalls.length, callsAfterFailure, 'backs off for a few minutes');
  clock += 5 * 60 * 1000;
  csvFailure = null;
  await lookup();
  assert.equal(csvCalls.length, callsAfterFailure + 1);
  assert.equal(store.sharedCache.mob.error, undefined, 'a success clears the error');
});

test('an HTTP error is reported with its status and a sheet that is not CSV is an error too', async () => {
  reset();
  csvFailure = 'http';
  await lookup();
  assert.match(store.sharedCache.mob.error.reason, /403/);
  reset();
  csvBody = `怪物名稱,備註\n白猿(white ape),x\n`;
  await lookup();
  assert.match(store.sharedCache.mob.error.reason, /指令/);
  assert.equal(Object.keys(store.sharedCache.mob.routes).length, 0);
});

test('with the mob and riddle features both off the sheet is not fetched', async () => {
  reset({ mob: SHEET }, { mobs: false, items: true, riddles: false });
  await lookup();
  assert.equal(csvCalls.length, 0);
});

test('a link that is not a published Google sheet is never requested', async () => {
  reset({ mob: 'https://evil.example.com/steal?output=csv' });
  await lookup();
  assert.equal(csvCalls.length, 0);
  assert.match(store.sharedCache.mob.error.reason, /發布到網路/);
});

test('the request has a timeout signal, and a broken storage never breaks the built-in lookup', async () => {
  reset();
  await lookup();
  assert.ok(csvCalls[0].signal, 'the fetch gets an abort signal');
  const saved = chrome.storage.local.get;
  chrome.storage.local.get = async () => { throw new Error('storage broke'); };
  const reply = await lookup();
  chrome.storage.local.get = saved;
  assert.equal(reply.ok, true);
  assert.equal(reply.items[0].candidates[0].mob.name, '白猿(white ape)');
});

test('other ZAP messages are answered without touching the sheet', async () => {
  reset();
  await ask({ type: 'ZAP_RIDDLES' });
  assert.equal(csvCalls.length, 0);
});

test('"update now" is not swallowed by a lookup that is already checking the cache', async () => {
  reset();
  await lookup();
  const pending = lookup();
  const refreshed = ask({ type: 'SHARED_REFRESH' }, settingsPage);
  await Promise.all([pending, refreshed]);
  assert.equal(csvCalls.length, 2, 'the forced update still fetched');
});

test('a sheet that never answers is given up on after the timeout and the reason says so', async () => {
  reset();
  csvFailure = 'hang';
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = lookup();
    while (!csvCalls.length) await new Promise(resolve => setImmediate(resolve));
    mock.timers.tick(15000);
    const reply = await pending;
    assert.equal(reply.ok, true, 'the built-in lookup still answers');
  } finally {
    mock.timers.reset();
  }
  assert.match(store.sharedCache.mob.error.reason, /逾時/);
});

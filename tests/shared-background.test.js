// 共用資料的 background 行為測試：在記憶體裡實際執行 background.js，假的 chrome（storage.local）與 fetch，
// 檢查發了幾次請求、查詢回覆有沒有套上共用路線、快取存了什麼。
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const extensionDir = path.join(__dirname, '..', 'catworld-auto-command');
const SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=0&single=true&output=csv';
const RIDDLE_SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=77&single=true&output=csv';
const OTHER_SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-other/pub?gid=0&single=true&output=csv';
const HEADER = '怪物名稱,指令,備註,更新者,更新時間';
const HOUR = 60 * 60 * 1000;

const mobs = [{ name: '白猿(white ape)', id: 'white ape', exp: 250000, location: '古墓', note: '', source: 'zap' }];
const riddles = [{ name: '獨孤九劍', page: 'qu1-1.htm', shared: [] }];
const pages = { 'qu1-1.htm': { steps: [{ no: 1, text: 'a', commands: 'run site' }, { no: 2, text: 'b', commands: '' }] } };
const RIDDLE_CSV = ['謎名稱,步驟,指令,備註,更新者,更新時間,步驟數', '獨孤九劍,2,run n;push stone,先買水,小明,2026-10-21 14:30,2', ''].join('\n');
const store = {};
const listeners = [];
const installedListeners = [];
const csvCalls = [];
const DEFAULT_CSV = `${HEADER}\n白猿(white ape),run e;push stone,先買貂皮衣,小明,2026-10-21 14:30\n`;
let csvBody = DEFAULT_CSV;
let csvFailure = null;
let failOnly = null;
let clock = Date.parse('2026-10-21T12:00:00Z');
Date.now = () => clock;

globalThis.importScripts = (...names) => names.forEach(name => require(path.join(extensionDir, name)));
globalThis.fetch = async (url, options) => {
  if (url === 'zap-data.json') return { ok: true, json: async () => ({ mobs, items: [], riddles, pages, routes: [], routeAliases: {} }) };
  csvCalls.push({ url, signal: options?.signal });
  const failing = csvFailure && (!failOnly || failOnly === url);
  if (failing && csvFailure === 'hang') {
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  }
  if (failing && csvFailure === 'network') throw new Error('network down');
  if (failing && csvFailure === 'http') return { ok: false, status: 403, text: async () => 'denied' };
  return { ok: true, status: 200, text: async () => (url === RIDDLE_SHEET ? RIDDLE_CSV : csvBody) };
};
const noop = { addListener() {} };
globalThis.chrome = {
  runtime: { id: 'me', onMessage: { addListener: fn => listeners.push(fn) }, onInstalled: { addListener: fn => installedListeners.push(fn) }, getURL: file => `chrome-extension://me/${file === 'zap-data.json' ? file : file}` },
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
  failOnly = null;
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

test('a row whose location no mob of that name has still applies by name, a matching location applies, and 停用 hides the route through a real lookup', async () => {
  reset();
  csvBody = '怪物名稱,位置,指令,備註,更新者,更新時間\n白猿(white ape),長安,run elsewhere,,小明,2026-10-21 14:30\n';
  assert.equal(routeOf(await lookup()).route.command, 'run elsewhere', 'a location nobody has is a typo, so the name decides');
  reset();
  csvBody = '怪物名稱,位置,指令,備註,更新者,更新時間\n白猿(white ape),古墓,run here,,小明,2026-10-21 14:30\n';
  assert.equal(routeOf(await lookup()).route.command, 'run here');
  reset();
  csvBody = '怪物名稱,位置,指令,備註,更新者,更新時間\n白猿(white ape),古墓,停用,錯的,小明,2026-10-21 14:30\n';
  const reply = await lookup();
  assert.equal(routeOf(reply), null);
  assert.deepEqual(reply.items[0].candidates[0].sharedDisabled, { by: '小明', note: '錯的' });
});

const riddleShared = () => ask({ type: 'ZAP_RIDDLE_SHARED' });

test('the riddle sheet is fetched on the first ZAP_RIDDLE_SHARED and answers the steps by page position', async () => {
  reset({ riddle: RIDDLE_SHEET });
  const reply = await riddleShared();
  assert.equal(reply.ok, true);
  assert.deepEqual(csvCalls.map(call => call.url), [RIDDLE_SHEET], 'only the riddle sheet is configured');
  assert.deepEqual([reply.steps['qu1-1.htm'][2].command, reply.steps['qu1-1.htm'][2].by, reply.steps['qu1-1.htm'][2].n], ['run n;push stone', '小明', 2]);
  assert.equal(store.sharedCache.riddle.url, RIDDLE_SHEET);
  assert.deepEqual([store.sharedCache.riddle.report.rows, store.sharedCache.riddle.report.used], [1, 1]);
  assert.equal(store.sharedCache.mob, undefined);
});

test('the two sheets are cached and refreshed independently', async () => {
  reset({ mob: SHEET, riddle: RIDDLE_SHEET });
  await lookup();
  assert.equal(csvCalls.length, 2, 'one lookup brings both layers up to date');
  clock += HOUR - 1000;
  await riddleShared();
  assert.equal(csvCalls.length, 2, 'both still fresh');
  clock += 2000;
  await riddleShared();
  assert.equal(csvCalls.length, 4, 'both stale, both fetched');
});

test('one sheet failing does not take the other layer away', async () => {
  reset({ mob: SHEET, riddle: RIDDLE_SHEET });
  await lookup();
  clock += HOUR + 1000;
  csvFailure = 'network';
  failOnly = RIDDLE_SHEET;
  const route = routeOf(await lookup());
  assert.equal(route.route.command, 'run e;push stone', 'the mob layer refreshed fine');
  assert.match(store.sharedCache.riddle.error.reason, /network down/);
  assert.equal((await riddleShared()).steps['qu1-1.htm'][2].command, 'run n;push stone', 'the riddle layer kept its old data');
  assert.equal(store.sharedCache.mob.error, undefined);
});

test('"update now" fetches both sheets', async () => {
  reset({ mob: SHEET, riddle: RIDDLE_SHEET });
  await lookup();
  const reply = await ask({ type: 'SHARED_REFRESH' }, settingsPage);
  assert.equal(csvCalls.length, 4);
  assert.deepEqual([reply.cache.mob.report.used, reply.cache.riddle.report.used], [1, 1]);
});

test('clearing the riddle link empties that layer; the riddle sheet is not fetched with the features off', async () => {
  reset({ riddle: RIDDLE_SHEET });
  await riddleShared();
  store.sharedSources = { riddle: '' };
  assert.deepEqual((await riddleShared()).steps, {});
  assert.equal(store.sharedCache.riddle, undefined);
  reset({ riddle: RIDDLE_SHEET }, { mobs: false, items: true, riddles: false });
  await riddleShared();
  assert.equal(csvCalls.length, 0);
});

test('on install or update the default shared links are filled in only when nothing was ever set', async () => {
  const { DEFAULT_SOURCES } = globalThis.CatworldSharedData;
  assert.ok(installedListeners.length >= 1, 'background listens to onInstalled');
  const run = async () => { for (const listener of installedListeners) await listener({ reason: 'install' }); };
  reset();
  delete store.sharedSources;
  await run();
  assert.deepEqual(store.sharedSources, DEFAULT_SOURCES);
  reset({ mob: '', riddle: '' });
  await run();
  assert.deepEqual(store.sharedSources, { mob: '', riddle: '' }, 'cleared on purpose stays cleared');
  reset({ mob: SHEET });
  await run();
  assert.deepEqual(store.sharedSources, { mob: SHEET }, 'existing settings are never touched');
});

test('the defaults alone do not fetch anything while both features are off', async () => {
  reset(undefined, { mobs: false, items: true, riddles: false });
  store.sharedSources = { ...globalThis.CatworldSharedData.DEFAULT_SOURCES };
  await lookup();
  assert.equal(csvCalls.length, 0);
});

// ---- 新怪 ----
const KING = '橫霸四方 忽必烈(king)';
const STR_HEADER = '怪物名稱,位置,強度,指令,備註,更新者,更新時間';
const suitable = () => ask({ type: 'ZAP_SUITABLE', exp: 414748, thresholds: undefined, grades: ['green', 'yellow'], query: '' });

test('a new mob from the sheet is in the suitable list and in a lookup, with its route and who added it', async () => {
  reset();
  csvBody = [STR_HEADER, `${KING},蒙古,250000,run e 5n,先買藥,小明,2026-10-21 14:30`].join('\n') + '\n';
  const list = await suitable();
  const entry = list.items.find(item => item.mob.name === KING);
  assert.ok(entry, 'the new mob is listed for an exp that can fight it');
  assert.deepEqual([entry.mob.source, entry.mob.by, entry.mob.exp, entry.grade], ['shared', '小明', 250000, 'green']);
  assert.equal(entry.route.route.command, 'run e 5n');
  const hint = await ask({ type: 'ZAP_LOOKUP', exp: 414748, names: [{ name: KING, count: 1 }] });
  const candidate = hint.items[0].candidates[0];
  assert.deepEqual([candidate.mob.name, candidate.idOnly, candidate.grade], [KING, false, 'green']);
  assert.equal(candidate.route.shared.by, '小明');
});

test('a new mob found only by its id still shows up in the lookup', async () => {
  reset();
  csvBody = [STR_HEADER, `${KING},,250000,,,小明,`].join('\n') + '\n';
  const hint = await ask({ type: 'ZAP_LOOKUP', exp: 414748, names: [{ name: '某某稱號 忽必烈(king)', count: 1 }] });
  assert.equal(hint.items[0].candidates[0].mob.name, KING);
  assert.equal(hint.items[0].candidates[0].idOnly, true);
});

test('an old cache without the mobs field, or a sheet without the strength column, behaves as before', async () => {
  reset();
  store.sharedCache = { mob: { url: SHEET, at: clock, routes: {}, report: { rows: 0, used: 0, dropped: [], unmatched: [], overflow: 0 } } };
  const list = await suitable();
  assert.equal(list.ok, true);
  assert.ok(list.items.every(item => item.mob.source !== 'shared'));
  reset();
  const plain = await suitable();
  assert.equal(plain.ok, true);
  assert.equal(plain.items.some(item => item.mob.name === KING), false);
});

test('with the mob and riddle features both off no new mob is fetched or shown', async () => {
  reset(undefined, { mobs: false, items: true, riddles: false });
  csvBody = [STR_HEADER, `${KING},蒙古,250000,run e,,小明,`].join('\n') + '\n';
  const list = await suitable();
  assert.equal(csvCalls.length, 0);
  assert.equal(list.items.some(item => item.mob.name === KING), false);
});

// ---- 修正內建怪的強度 ----
test('a strength on a built-in mob fixes its strength, so the grade in the lookup follows the corrected number', async () => {
  reset();
  const original = (await lookup()).items[0].candidates[0];
  assert.deepEqual([original.mob.exp, original.mob.fixed], [250000, undefined]);
  reset();
  csvBody = [STR_HEADER, '白猿(white ape),古墓,2000000,run e,只是路線,小明,2026-10-21 14:30'].join('\n') + '\n';
  const fixed = (await lookup()).items[0].candidates[0];
  assert.deepEqual([fixed.mob.exp, fixed.mob.fixed], [2000000, { by: '小明', original: 250000 }]);
  assert.notEqual(fixed.grade, original.grade, 'the grade is worked out from the corrected strength');
  assert.equal(fixed.mob.note, '', 'the built-in mob note is kept; the row note is only the route note');
  assert.equal(fixed.route.shared.note, '只是路線');
});

test('a fix is read from the cache, and an old cache without fixes changes nothing', async () => {
  reset();
  store.sharedCache = { mob: { url: SHEET, at: clock, routes: {}, mobs: {}, report: { rows: 0, used: 0, dropped: [], unmatched: [], overflow: 0 } } };
  const old = (await lookup()).items[0].candidates[0];
  assert.deepEqual([old.mob.exp, old.mob.fixed], [250000, undefined]);
});

test('the list of fitting mobs and its grades use the corrected strength', async () => {
  reset();
  csvBody = [STR_HEADER, '白猿(white ape),古墓,2000000,,,小明,2026-10-21 14:30'].join('\n') + '\n';
  const grade = (await lookup()).items[0].candidates[0].grade;
  const list = await ask({ type: 'ZAP_SUITABLE', exp: 414748, thresholds: undefined, grades: [grade], query: '白猿' });
  const entry = list.items.find(item => item.mob.name === '白猿(white ape)');
  assert.ok(entry, 'listed under the grade of the corrected number');
  assert.deepEqual([entry.mob.exp, entry.mob.fixed.original, entry.grade], [2000000, 250000, grade]);
  const old = await ask({ type: 'ZAP_SUITABLE', exp: 414748, thresholds: undefined, grades: ['green'], query: '白猿' });
  assert.equal(old.items.some(item => item.mob.name === '白猿(white ape)'), false, 'no longer green');
});

// ---- 刪列、多列與停用（跨兩次抓取）----
const refreshNow = () => ask({ type: 'SHARED_REFRESH' }, settingsPage);

test('deleting rows from the sheet between two fetches removes the new mob and restores the built-in strength', async () => {
  reset();
  csvBody = [STR_HEADER, `${KING},蒙古,250000,run e,,小明,2026-10-21 14:30`, '白猿(white ape),古墓,2000000,,,小明,2026-10-21 14:30'].join('\n') + '\n';
  const before = await suitable();
  assert.ok(before.items.some(item => item.mob.name === KING), 'the new mob is there');
  const fixed = (await lookup()).items[0].candidates[0];
  assert.equal(fixed.mob.exp, 2000000);
  csvBody = [STR_HEADER, '白猿(white ape),古墓,,run e,只剩路線,小明,2026-10-21 15:00'].join('\n') + '\n';
  assert.equal((await refreshNow()).ok, true);
  const after = await suitable();
  assert.equal(after.items.some(item => item.mob.name === KING), false, 'the mob is gone');
  const restored = (await lookup()).items[0].candidates[0];
  assert.deepEqual([restored.mob.exp, restored.mob.fixed], [250000, undefined], 'the strength is back to the built-in value');
  assert.equal(restored.route.route.command, 'run e', 'the route row is still there');
});

test('a newer row with only a route keeps the new mob, and 停用 on a new mob keeps the mob but takes its route away', async () => {
  reset();
  csvBody = [STR_HEADER, `${KING},蒙古,250000,run old,,甲,2026-10-20 09:00`, `${KING},蒙古,,run new,,乙,2026-10-21 09:00`].join('\n') + '\n';
  const list = await suitable();
  const entry = list.items.find(item => item.mob.name === KING);
  assert.deepEqual([entry.mob.exp, entry.mob.by, entry.route.route.command, entry.route.shared.by], [250000, '甲', 'run new', '乙']);
  reset();
  csvBody = [STR_HEADER, `${KING},蒙古,250000,停用,路線壞了,小明,`].join('\n') + '\n';
  const hint = (await ask({ type: 'ZAP_LOOKUP', exp: 414748, names: [{ name: KING, count: 1 }] })).items[0].candidates[0];
  assert.equal(hint.mob.name, KING);
  assert.equal(hint.route, null);
  assert.deepEqual(hint.sharedDisabled, { by: '小明', note: '路線壞了' });
});

test('a route row with a location the new mob does not have still gives the new mob its route in the list', async () => {
  reset();
  csvBody = [STR_HEADER, `${KING},,250000,,,甲,2026-10-20 09:00`, `${KING},蒙古,,run new,,乙,2026-10-21 09:00`].join('\n') + '\n';
  const entry = (await suitable()).items.find(item => item.mob.name === KING);
  assert.deepEqual([entry.mob.by, entry.route.route.command, entry.route.shared.by], ['甲', 'run new', '乙']);
});

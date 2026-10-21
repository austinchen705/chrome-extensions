// 背景程式（service worker）的行為測試：在 Node 的 vm 裡實際執行 background.js，chrome 與 fetch 都是假的。
// 檢查的是外部看得到的行為：發了幾次請求、系統通知有沒有建、storage.session 裡存了什麼、測試訊息的權限。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'catworld-auto-command');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, ms = 2000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
};

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const GAME = 'https://catworld.muds.tw/web';
const TOKEN = 'tok/en+abc==';
const USER_ID = 'U0123456789abcdef0123456789abcdef';
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 21, 0, 0, 0);
const ON = { lineNotify: { enabled: true, token: TOKEN, userId: USER_ID } };
const clone = value => JSON.parse(JSON.stringify(value));
const okFetch = async () => ({ ok: true, status: 200, text: async () => '{}' });

function loadBackground({ local = {}, session = {}, fetchImpl = okFetch, notifyThrows = false } = {}) {
  const store = { local: clone(local), session: clone(session) };
  const area = name => ({
    get: async keys => {
      const all = store[name];
      if (keys === null || keys === undefined) return clone(all);
      return Object.fromEntries([].concat(keys).filter(key => key in all).map(key => [key, clone(all[key])]));
    },
    set: async values => { Object.assign(store[name], clone(values)); },
    remove: async keys => { [].concat(keys).forEach(key => delete store[name][key]); },
  });
  const listeners = [];
  const notifications = [];
  const pushes = [];
  const noop = () => {};
  const chrome = {
    runtime: { id: EXT, getURL: file => `chrome-extension://${EXT}/${file}`, onMessage: { addListener: fn => listeners.push(fn) } },
    storage: { local: area('local'), session: area('session'), onChanged: { addListener: noop } },
    tabs: {
      onRemoved: { addListener: noop }, get: async () => { throw new Error('no tab'); }, remove: async () => {},
      update: async () => {}, create: async () => ({ id: 99 }), sendMessage: async () => {},
    },
    notifications: {
      create: (...args) => { notifications.push(args); if (notifyThrows) throw new Error('bad icon'); },
      clear: noop, onButtonClicked: { addListener: noop }, onClicked: { addListener: noop },
    },
    windows: { update: noop },
  };
  const context = vm.createContext({
    chrome, console, setTimeout, clearTimeout, URL,
    fetch: async (url, init) => { pushes.push({ url, init }); return fetchImpl(url, init); },
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(read(file), context, { filename: file }));
  // 可以指定「現在」的 Date：背景程式用 Date.now 算時間
  vm.runInContext('{ const RealDate = Date; globalThis.Date = class extends RealDate { static now() { return globalThis.__now ?? RealDate.now(); } }; }', context);
  vm.runInContext(read('background.js'), context, { filename: 'background.js' });

  const setNow = time => { context.__now = time; };
  // 模擬遊戲分頁的 content script 送來一則警報；回傳處理過程中有沒有丟例外
  const alert = (reason, tab = { id: 1, windowId: 1 }) => {
    let thrown = null;
    for (const listener of listeners) {
      try { listener({ type: 'ALERT', reason }, { tab, id: EXT, url: GAME }, () => {}); } catch (error) { thrown = error; }
    }
    return thrown;
  };
  // 設定頁（或別的來源）送「發送測試訊息」；沒有回應就是 undefined
  const lineTest = sender => new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), 150);
    for (const listener of listeners) listener({ type: 'LINE_TEST' }, sender, reply => { clearTimeout(timer); resolve(reply); });
  });
  const settingsPage = { id: EXT, url: `chrome-extension://${EXT}/popup.html?tab=1`, tab: { id: 7 } };
  const gamePage = { id: EXT, url: GAME, tab: { id: 1 } };
  const texts = () => pushes.map(push => JSON.parse(push.init.body).messages[0].text);
  return { store, notifications, pushes, texts, alert, lineTest, settingsPage, gamePage, setNow };
}

test('switch off: the system notification is created, nothing goes to LINE, no result is recorded', async () => {
  const bg = loadBackground({ local: { lineNotify: { ...ON.lineNotify, enabled: false } } });
  assert.equal(bg.alert('偵測到驗證碼'), null);
  await sleep(40);
  assert.equal(bg.notifications.length, 1);
  assert.equal(bg.pushes.length, 0);
  assert.equal('lineLastResult' in bg.store.session, false);
});

test('switch on: one alert makes one push with the formatted text and records an alert result', async () => {
  const bg = loadBackground({ local: ON });
  bg.setNow(T0);
  bg.alert('偵測到驗證碼');
  assert.ok(await waitFor(() => bg.pushes.length === 1));
  assert.equal(bg.notifications.length, 1);
  assert.match(bg.texts()[0], /^【CatWorld】偵測到驗證碼（\d\d:\d\d:\d\d）$/);
  assert.equal(bg.pushes[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(await waitFor(() => bg.store.session.lineLastResult?.source === 'alert'));
  assert.equal(bg.store.session.lineLastResult.ok, true);
  assert.equal(bg.store.session.lineLastResult.status, 200);
});

test('the same reason within the dedupe window is pushed once, but every alert still gets its system notification', async () => {
  const bg = loadBackground({ local: ON });
  bg.setNow(T0);
  bg.alert('A');
  assert.ok(await waitFor(() => bg.pushes.length === 1));
  bg.setNow(T0 + 9 * MIN);
  bg.alert('A');
  await sleep(40);
  assert.equal(bg.pushes.length, 1);
  assert.equal(bg.notifications.length, 2);
  assert.equal(bg.store.session.lineThrottle.skipped, 1);
  bg.setNow(T0 + 10 * MIN);
  bg.alert('A');
  assert.ok(await waitFor(() => bg.pushes.length === 2), 'after the window it goes again');
});

test('two alerts with the same reason arriving in the same instant still produce one push', async () => {
  const bg = loadBackground({ local: ON });
  bg.setNow(T0);
  bg.alert('A', { id: 1, windowId: 1 });
  bg.alert('A', { id: 2, windowId: 1 });
  await sleep(60);
  assert.equal(bg.pushes.length, 1, 'the bookkeeping is not racy');
  assert.equal(bg.store.session.lineThrottle.skipped, 1);
});

test('the hourly cap comes from the settings and skipped alerts are counted', async () => {
  const bg = loadBackground({ local: { lineNotify: { ...ON.lineNotify, hourlyLimit: 2 } } });
  bg.setNow(T0);
  bg.alert('a');
  bg.alert('b');
  bg.alert('c');
  await sleep(80);
  assert.equal(bg.pushes.length, 2);
  assert.equal(bg.store.session.lineThrottle.skipped, 1);
});

test('the limits survive the service worker being restarted, because they live in session storage', async () => {
  const first = loadBackground({ local: ON });
  first.setNow(T0);
  first.alert('A');
  assert.ok(await waitFor(() => first.pushes.length === 1));
  const second = loadBackground({ local: ON, session: first.store.session });
  second.setNow(T0 + MIN);
  second.alert('A');
  await sleep(40);
  assert.equal(second.pushes.length, 0, 'the new worker still remembers the push');
});

test('a throwing system notification does not stop the phone push', async () => {
  const bg = loadBackground({ local: ON, notifyThrows: true });
  bg.alert('A');
  assert.ok(await waitFor(() => bg.pushes.length === 1));
});

test('a failing LINE push (HTTP error or no network) never disturbs the system notification and is recorded without secrets', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: `bad ${TOKEN}` }) }),
    async () => { throw new TypeError(`offline ${TOKEN}`); },
  ]) {
    const bg = loadBackground({ local: ON, fetchImpl });
    assert.equal(bg.alert('A'), null, 'the handler does not throw');
    assert.ok(await waitFor(() => bg.store.session.lineLastResult?.ok === false));
    assert.equal(bg.notifications.length, 1);
    assert.equal(JSON.stringify(bg.store.session).includes(TOKEN), false);
  }
});

test('the test button from the settings page always sends, ignores the switch and the limits, and is not counted', async () => {
  const bg = loadBackground({ local: { lineNotify: { ...ON.lineNotify, enabled: false, hourlyLimit: 1 } } });
  bg.setNow(T0);
  const reply1 = await bg.lineTest(bg.settingsPage);
  const reply2 = await bg.lineTest(bg.settingsPage);
  assert.equal(reply1.ok, true);
  assert.equal(reply1.source, 'test');
  assert.equal(reply2.ok, true);
  assert.equal(bg.pushes.length, 2);
  assert.equal('lineThrottle' in bg.store.session, false, 'tests do not touch the alert bookkeeping');
});

test('only the extension\'s own pages can use the test button: the game page gets no answer and nothing is sent', async () => {
  const bg = loadBackground({ local: ON });
  assert.equal(await bg.lineTest(bg.gamePage), undefined);
  assert.equal(await bg.lineTest({ ...bg.settingsPage, id: 'someoneelse' }), undefined);
  assert.equal(bg.pushes.length, 0);
});

test('the test button still answers when the credentials are missing', async () => {
  const bg = loadBackground({ local: {} });
  const reply = await bg.lineTest(bg.settingsPage);
  assert.equal(reply.ok, false);
  assert.match(reply.reason, /token|userId/);
  assert.equal(bg.pushes.length, 0);
});

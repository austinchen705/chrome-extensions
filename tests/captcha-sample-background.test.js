// 驗證碼樣本收集的背景程式行為：在 Node 的 vm 裡實際執行 background.js，chrome 與 fetch 都是假的。
// 檢查的是外部看得到的行為：有沒有打網址、送了什麼、storage.session 裡記了什麼、失敗時警報的系統通知照建。
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
const URL = 'https://script.google.com/macros/s/AKfycb-example/exec';
const SAMPLE = { outcome: 'passed', answer: '62044', attempts: 1, html: '<span class="H7 B3">   </span>' };
const clone = value => JSON.parse(JSON.stringify(value));
const okFetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });

function loadBackground({ local = {}, fetchImpl = okFetch, timerScale = 1 } = {}) {
  const store = { local: clone(local), session: {} };
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
    runtime: {
      id: EXT, getURL: file => `chrome-extension://${EXT}/${file}`, getManifest: () => ({ version: '9.9.9', content_scripts: [{ js: [], css: [] }] }),
      onMessage: { addListener: fn => listeners.push(fn) }, onInstalled: { addListener: noop },
    },
    permissions: { contains: async () => false, onAdded: { addListener: noop }, onRemoved: { addListener: noop } },
    scripting: { registerContentScripts: async () => {}, unregisterContentScripts: async () => { throw new Error('Nonexistent script ID'); } },
    storage: { local: area('local'), session: area('session'), onChanged: { addListener: noop } },
    tabs: { onRemoved: { addListener: noop }, get: async () => { throw new Error('no tab'); }, remove: async () => {}, update: async () => {}, create: async () => ({ id: 99 }), sendMessage: async () => {} },
    notifications: { create: (...args) => { notifications.push(args); }, clear: noop, onButtonClicked: { addListener: noop }, onClicked: { addListener: noop } },
    windows: { update: noop },
  };
  const context = vm.createContext({
    chrome, console, clearTimeout, URL: globalThis.URL, AbortController,
    // 縮短逾時，測試才不用真的等 15 秒
    setTimeout: (fn, ms, ...args) => setTimeout(fn, Math.max(1, ms / timerScale), ...args),
    fetch: async (url, init) => { pushes.push({ url, init }); return fetchImpl(url, init); },
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(read(file), context, { filename: file }));
  vm.runInContext(read('background.js'), context, { filename: 'background.js' });

  // 模擬某個來源送來一則訊息；回傳處理過程中有沒有同步丟例外
  const send = (message, sender) => {
    let thrown = null;
    for (const listener of listeners) {
      try { listener(message, sender, () => {}); } catch (error) { thrown = error; }
    }
    return thrown;
  };
  const gamePage = { id: EXT, url: GAME, tab: { id: 1, windowId: 1 } };
  const settingsPage = { id: EXT, url: `chrome-extension://${EXT}/popup.html?tab=1` };
  const bodies = () => pushes.map(push => JSON.parse(push.init.body));
  return { store, notifications, pushes, bodies, send, gamePage, settingsPage };
}

test('with a collection url, one sample from the game page is one POST carrying the sample plus the extension version, and the result is recorded', async () => {
  const bg = loadBackground({ local: { captchaSampleUrl: URL } });
  assert.equal(bg.send({ type: 'CAPTCHA_SAMPLE', sample: SAMPLE }, bg.gamePage), null);
  assert.ok(await waitFor(() => bg.pushes.length === 1));
  assert.equal(bg.pushes[0].url, URL);
  assert.equal(bg.pushes[0].init.method, 'POST');
  assert.equal(bg.pushes[0].init.headers['Content-Type'], 'text/plain');
  assert.deepEqual(bg.bodies()[0], { ...SAMPLE, version: '9.9.9' });
  assert.ok(await waitFor(() => bg.store.session.captchaSampleLastResult?.ok === true));
  assert.equal(bg.store.session.captchaSampleLastResult.status, 200);
  assert.equal(bg.store.session.captchaSampleLastResult.outcome, 'passed');
  assert.equal(bg.notifications.length, 0, 'a sample is not an alert');
});

test('no url (never set, or cleared to blank) means nothing touches the network and nothing is recorded', async () => {
  for (const local of [{}, { captchaSampleUrl: '  ' }]) {
    const bg = loadBackground({ local });
    bg.send({ type: 'CAPTCHA_SAMPLE', sample: SAMPLE }, bg.gamePage);
    await sleep(40);
    assert.equal(bg.pushes.length, 0);
    assert.equal('captchaSampleLastResult' in bg.store.session, false);
  }
});

test('only game pages can submit samples: the settings page is ignored', async () => {
  const bg = loadBackground({ local: { captchaSampleUrl: URL } });
  bg.send({ type: 'CAPTCHA_SAMPLE', sample: SAMPLE }, bg.settingsPage);
  await sleep(40);
  assert.equal(bg.pushes.length, 0);
});

test('an HTTP error or no network never throws, is recorded as a failure, and the next alert still gets its system notification', async () => {
  for (const [fetchImpl, reason] of [
    [async () => ({ ok: false, status: 403, text: async () => '' }), /HTTP 403/],
    [async () => { throw new TypeError('Failed to fetch'); }, /Failed to fetch/],
  ]) {
    const bg = loadBackground({ local: { captchaSampleUrl: URL }, fetchImpl });
    assert.equal(bg.send({ type: 'CAPTCHA_SAMPLE', sample: SAMPLE }, bg.gamePage), null);
    assert.ok(await waitFor(() => bg.store.session.captchaSampleLastResult?.ok === false));
    assert.match(bg.store.session.captchaSampleLastResult.reason, reason);
    assert.equal(bg.pushes.length, 1, 'no retry');
    bg.send({ type: 'ALERT', reason: '偵測到驗證碼' }, bg.gamePage);
    await sleep(40);
    assert.equal(bg.notifications.length, 1);
  }
});

test('a request that hangs is cut off by the timeout and recorded as such', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const bg = loadBackground({ local: { captchaSampleUrl: URL }, fetchImpl, timerScale: 150 });
  bg.send({ type: 'CAPTCHA_SAMPLE', sample: SAMPLE }, bg.gamePage);
  assert.ok(await waitFor(() => bg.store.session.captchaSampleLastResult?.ok === false, 3000));
  assert.match(bg.store.session.captchaSampleLastResult.reason, /逾時/);
});

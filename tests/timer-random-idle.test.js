// 三件事（整個 content script 在 jsdom 裡跑，底座在 tests/helpers/game-page.js，計時器縮小 SCALE 倍；設定頁用真正的 popup.html）：
// 1. 隨機指令獨立於定時：各自開始、停止
// 2. idle：開始就先暫停定時、隨機與兩組觸發，idle 時間到自動繼續，再隔一段時間又 idle；停止 idle 讓暫停的繼續
// 3. 自動下 sc：開始定時／隨機時、送出 reward 之後各下一次（跟「在線獎勵自動領取」開關），不是人觸發
// 需要 jsdom 的部分沒裝就跳過
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
require('../catworld-auto-command/timer-settings.js');

const T = globalThis.CatworldTimer;

test('idle settings: defaults, bad values fall back, max never below min, decimals kept', () => {
  assert.deepEqual({ ...T.normalizeIdle(undefined) }, { everyMin: 20, everyMax: 40, durMin: 2, durMax: 5 });
  assert.deepEqual({ ...T.normalizeIdle({ everyMin: 'x', everyMax: -1, durMin: 0, durMax: 99999 }) }, { everyMin: 20, everyMax: 40, durMin: 2, durMax: 5 });
  assert.deepEqual({ ...T.normalizeIdle({ everyMin: 30, everyMax: 10, durMin: 1.5, durMax: 0.5 }) }, { everyMin: 30, everyMax: 30, durMin: 1.5, durMax: 1.5 });
  assert.deepEqual({ ...T.normalizeIdle({ everyMin: 0.05, everyMax: 0.1, durMin: 0.05, durMax: 0.05 }) }, { everyMin: 0.05, everyMax: 0.1, durMin: 0.05, durMax: 0.05 });
});

test('idleMs draws inside the range, in milliseconds', () => {
  assert.equal(T.idleMs(2, 4, () => 0), 120000);
  assert.equal(T.idleMs(2, 4, () => 1), 240000);
  assert.equal(T.idleMs(1, 1), 60000);
});

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // 沒裝 jsdom
}
const ui = JSDOM ? test : test.skip;
const gamePage = JSDOM ? require('./helpers/game-page') : null;
const SCALE = 10;
const count = (page, command) => page.sent.filter(sent => sent === command).length;
const status = page => page.ask({ type: 'STATUS' });
const keyword = (pattern, commands, extra) => ({ kind: 'keyword', enabled: true, pattern, commands, cooldown: 1, ...extra });
const config = rules => ({ rules, delayMax: 0, requireNormal: false });

// ---------- 隨機獨立 ----------
ui('the random timer starts and stops by itself, and the fixed timer is not touched', async () => {
  const { boot, waitFor } = gamePage;
  const page = await boot({ scale: SCALE, initialStore: { autoReward: false } });
  try {
    const settings = { fixedItems: [{ command: 'fx', minSeconds: 1, maxSeconds: 1 }], randomItems: [{ command: 'rd', minSeconds: 1, maxSeconds: 1 }], commandDelayMs: 0 };
    await page.ask({ type: 'START_RANDOM', settings });
    assert.ok(await waitFor(() => count(page, 'rd') >= 2, 2000), 'the random command is sent');
    assert.equal(count(page, 'fx'), 0, 'starting the random timer does not start the fixed one');
    let state = await status(page);
    assert.equal(state.running, false);
    assert.equal(state.randomRunning, true);
    await page.ask({ type: 'START', settings });
    assert.ok(await waitFor(() => count(page, 'fx') >= 1, 1000));
    await page.ask({ type: 'STOP' });
    state = await status(page);
    assert.equal(state.running, false);
    assert.equal(state.randomRunning, true, 'stopping the fixed timer leaves the random one running');
    const before = count(page, 'rd');
    assert.ok(await waitFor(() => count(page, 'rd') > before, 2000), 'and it keeps sending');
    await page.ask({ type: 'STOP_RANDOM' });
    state = await status(page);
    assert.equal(state.randomRunning, false);
    const after = page.sent.length;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(page.sent.length, after, 'nothing more after both are stopped');
  } finally {
    page.close();
  }
});

ui('the fixed timer does not start the random one any more', async () => {
  const { boot, waitFor } = gamePage;
  const page = await boot({ scale: SCALE, initialStore: { autoReward: false } });
  try {
    await page.ask({ type: 'START', settings: { fixedItems: [{ command: 'fx', minSeconds: 1, maxSeconds: 1 }], randomItems: [{ command: 'rd', minSeconds: 1, maxSeconds: 1 }], commandDelayMs: 0 } });
    assert.ok(await waitFor(() => count(page, 'fx') >= 2, 2000));
    assert.equal(count(page, 'rd'), 0);
    assert.equal((await status(page)).randomRunning, false);
  } finally {
    page.close();
  }
});

// ---------- idle ----------
const IDLE = { everyMin: 0.1, everyMax: 0.1, durMin: 0.1, durMax: 0.1 }; // 6 秒，縮小 10 倍後 0.6 秒

ui('idle pauses the fixed timer, the random timer and the triggers, then resumes by itself and idles again later', async () => {
  const { boot, waitFor } = gamePage;
  const page = await boot({ scale: SCALE, initialStore: { autoReward: false } });
  try {
    const settings = { fixedItems: [{ command: 'fx', minSeconds: 1, maxSeconds: 1 }], randomItems: [{ command: 'rd', minSeconds: 1, maxSeconds: 1 }], commandDelayMs: 0 };
    await page.ask({ type: 'START', settings });
    await page.ask({ type: 'START_RANDOM', settings });
    await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['drink'])]) });
    assert.ok(await waitFor(() => count(page, 'fx') >= 1 && count(page, 'rd') >= 1, 2000));
    await page.ask({ type: 'START_IDLE', settings: IDLE });
    assert.equal((await status(page)).idle.phase, 'idling');
    await new Promise(resolve => setTimeout(resolve, 80)); // 讓已排好的送完
    const during = page.sent.length;
    page.output('<span>你覺得口渴。</span>');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(page.sent.length, during, 'nothing is sent while idle, the keyword trigger included');
    assert.ok(await waitFor(async () => (await status(page)).idle?.phase === 'working', 2000), 'idle ends by itself');
    assert.ok(await waitFor(() => page.sent.length > during, 2000), 'the timers carry on after idle');
    assert.equal((await status(page)).running, true);
    assert.equal((await status(page)).randomRunning, true);
    assert.ok(await waitFor(async () => (await status(page)).idle?.phase === 'idling', 4000), 'and it idles again after the random wait');
  } finally {
    page.close();
  }
});

ui('stopping idle while idling lets the paused timers carry on at once; stopping everything does not', async () => {
  const { boot, waitFor } = gamePage;
  const page = await boot({ scale: SCALE, initialStore: { autoReward: false } });
  try {
    await page.ask({ type: 'START', settings: { fixedItems: [{ command: 'fx', minSeconds: 1, maxSeconds: 1 }], commandDelayMs: 0 } });
    assert.ok(await waitFor(() => count(page, 'fx') >= 1, 1000));
    await page.ask({ type: 'START_IDLE', settings: { everyMin: 60, everyMax: 60, durMin: 60, durMax: 60 } });
    await new Promise(resolve => setTimeout(resolve, 80));
    const during = count(page, 'fx');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(count(page, 'fx'), during, 'paused');
    await page.ask({ type: 'STOP_IDLE' });
    assert.equal((await status(page)).idle, null);
    assert.ok(await waitFor(() => count(page, 'fx') > during, 1500), 'resumed after the idle was stopped');
  } finally {
    page.close();
  }
  const second = await boot({ scale: SCALE, initialStore: { autoReward: false } });
  try {
    await second.ask({ type: 'START', settings: { fixedItems: [{ command: 'fx', minSeconds: 1, maxSeconds: 1 }], commandDelayMs: 0 } });
    await second.ask({ type: 'START_IDLE', settings: { everyMin: 60, everyMax: 60, durMin: 60, durMax: 60 } });
    await second.ask({ type: 'STOP' });
    assert.equal((await status(second)).running, false);
    assert.equal((await status(second)).idle?.phase, 'idling', 'stopping the fixed timer alone does not end idle');
  } finally {
    second.close();
  }
});

// ---------- 自動下 sc ----------
ui('starting the fixed or random timer sends sc once, first; not again within the gap; not when the switch is off', async () => {
  const { boot, waitFor } = gamePage;
  const page = await boot({ scale: SCALE });
  try {
    const settings = { fixedItems: [{ command: 'fx', minSeconds: 600, maxSeconds: 600 }], randomItems: [{ command: 'rd', minSeconds: 600, maxSeconds: 600 }], commandDelayMs: 0 };
    await page.ask({ type: 'START', settings });
    assert.ok(await waitFor(() => page.sent.includes('fx'), 1000));
    assert.deepEqual(page.sent.slice(0, 2), ['sc', 'fx'], 'sc goes out before the fixed command');
    await page.ask({ type: 'START_RANDOM', settings });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(count(page, 'sc'), 1, 'the second start right after does not ask again');
  } finally {
    page.close();
  }
  const off = await boot({ scale: SCALE, initialStore: { autoReward: false } });
  try {
    await off.ask({ type: 'START', settings: { fixedItems: [{ command: 'fx', minSeconds: 600, maxSeconds: 600 }], commandDelayMs: 0 } });
    assert.ok(await waitFor(() => off.sent.includes('fx'), 1000));
    assert.equal(count(off, 'sc'), 0);
  } finally {
    off.close();
  }
});

ui('no sc at start when a reward countdown is already scheduled', async () => {
  const { boot, waitFor } = gamePage;
  const page = await boot({ scale: 6000 });
  try {
    page.output('<span>在線獎勵： 30分鐘後可領取</span>');
    await new Promise(resolve => setTimeout(resolve, 20));
    await page.ask({ type: 'START', settings: { fixedItems: [{ command: 'fx', minSeconds: 600, maxSeconds: 600 }], commandDelayMs: 0 } });
    assert.ok(await waitFor(() => page.sent.includes('fx'), 1000));
    assert.equal(count(page, 'sc'), 0);
  } finally {
    page.close();
  }
});

ui('after reward is sent, sc follows by itself, and its countdown schedules the next reward', async () => {
  const { boot, waitFor } = gamePage;
  const page = await boot({ scale: 6000 });
  try {
    page.output('<span>在線獎勵： 0分鐘後可領取</span>');
    assert.ok(await waitFor(() => count(page, 'reward') === 1, 2000));
    assert.ok(await waitFor(() => count(page, 'sc') >= 2, 2000), 'a second sc is sent after reward (the first one went out just before it)');
    page.output('<span>在線獎勵： 1分鐘後可領取</span>');
    assert.ok(await waitFor(() => count(page, 'reward') === 2, 2000), 'the sc answer schedules the next reward');
  } finally {
    page.close();
  }
});

ui('with the reward switch off, nothing is sent after reward and nothing is scheduled', async () => {
  const { boot, waitFor } = gamePage;
  // 縮小 100 倍：領完獎之後的 sc 要等 200 毫秒，關開關一定來得及（縮小 6000 倍時只有 3 毫秒，整套並行時會搶在前面送出）
  const page = await boot({ scale: 100 });
  try {
    page.output('<span>在線獎勵： 0分鐘後可領取</span>');
    assert.ok(await waitFor(() => count(page, 'reward') === 1, 3000));
    page.changeListeners.forEach(listener => listener({ autoReward: { newValue: false } }, 'local'));
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(count(page, 'sc'), 1, 'only the sc that went out before reward: switching off cancels the one that would follow it');
  } finally {
    page.close();
  }
});

// ---------- 設定頁 ----------
const root = path.join(__dirname, '..', 'catworld-auto-command');
async function bootPopup(store = {}) {
  const sent = [];
  const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitUntil = async (condition, ms = 3000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (condition()) return true;
      await sleepMs(5);
    }
    return condition();
  };
  const dom = await JSDOM.fromFile(path.join(root, 'popup.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `file://${root.split(path.sep).join('/')}/popup.html`,
    beforeParse(window) {
      window.chrome = {
        runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: file => file, onMessage: { addListener() {} }, sendMessage: async () => ({}) },
        storage: {
          local: {
            get: async keys => Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, JSON.parse(JSON.stringify(store[key]))])),
            set: async values => { Object.assign(store, JSON.parse(JSON.stringify(values))); },
            remove: async key => { delete store[key]; },
          },
          sync: { get: async () => ({}), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener() {} },
        },
        tabs: {
          query: async () => [{ id: 1, url: 'https://catworld.muds.tw/web' }],
          get: async () => ({ id: 1, url: 'https://catworld.muds.tw/web' }),
          sendMessage: async (tabId, message) => { sent.push(message); return { ok: true }; },
          create: async () => {},
          update: async () => {},
        },
        permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  assert.ok(await waitUntil(() => doc.getElementById('idleEveryMin').value !== ''), 'the settings page loaded');
  return { dom, doc, store, sent, waitUntil };
}
const click = (page, id) => page.doc.getElementById(id).dispatchEvent(new page.dom.window.Event('click', { bubbles: true }));
const ofType = (page, type) => page.sent.filter(message => message.type === type);
const settingsOf = message => JSON.parse(JSON.stringify(message.settings));

ui('the settings page has separate fixed, random and idle tabs; random items are no longer on the fixed tab', async () => {
  const page = await bootPopup({ settings: { fixedItems: [{ command: 'fx', minSeconds: 5, maxSeconds: 6 }], randomItems: [{ command: 'rd', minSeconds: 5, maxSeconds: 6 }] } });
  try {
    const tabs = [...page.doc.querySelectorAll('[data-tab]')].map(tab => tab.dataset.tab);
    assert.deepEqual(tabs.slice(0, 3), ['timer', 'random', 'idle']);
    const pane = name => page.doc.querySelector(`[data-pane="${name}"]`);
    assert.equal(pane('timer').querySelector('#randomItems'), null, 'random items live on their own tab');
    assert.ok(pane('random').querySelector('#randomItems'));
    assert.equal(pane('random').querySelectorAll('#randomItems .ritem').length, 1);
    assert.ok(pane('idle').querySelector('#idleEveryMin'));
  } finally {
    page.dom.window.close();
  }
});

ui('Start on the fixed tab sends START without needing a random item, and Start on the random tab sends START_RANDOM', async () => {
  const page = await bootPopup({ settings: { fixedItems: [{ command: 'fx', minSeconds: 5, maxSeconds: 6 }], randomItems: [] } });
  try {
    click(page, 'start');
    assert.ok(await page.waitUntil(() => ofType(page, 'START').length === 1));
    click(page, 'randomStart');
    assert.ok(await page.waitUntil(() => /至少要有一個隨機指令/.test(page.doc.getElementById('randomStatus').textContent)));
    assert.equal(page.doc.getElementById('randomStatus').classList.contains('msg-error'), true);
    assert.equal(ofType(page, 'START_RANDOM').length, 0);
  } finally {
    page.dom.window.close();
  }
  const second = await bootPopup({ settings: { fixedItems: [], randomItems: [{ command: 'rd', minSeconds: 5, maxSeconds: 6 }] } });
  try {
    click(second, 'randomStart');
    assert.ok(await second.waitUntil(() => ofType(second, 'START_RANDOM').length === 1));
    assert.equal(settingsOf(ofType(second, 'START_RANDOM')[0]).randomItems[0].command, 'rd');
    click(second, 'randomStop');
    assert.ok(await second.waitUntil(() => ofType(second, 'STOP_RANDOM').length === 1));
    click(second, 'start');
    assert.ok(await second.waitUntil(() => /至少要有一個固定指令/.test(second.doc.getElementById('status').textContent)));
    assert.equal(ofType(second, 'START').length, 0);
  } finally {
    second.dom.window.close();
  }
});

ui('idle fields show the defaults, a change is saved fixed up, and Start sends the cleaned settings', async () => {
  const page = await bootPopup();
  try {
    const value = id => page.doc.getElementById(id).value;
    assert.deepEqual(['idleEveryMin', 'idleEveryMax', 'idleDurMin', 'idleDurMax'].map(value), ['20', '40', '2', '5']);
    const everyMax = page.doc.getElementById('idleEveryMax');
    everyMax.value = '5';
    everyMax.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.equal(value('idleEveryMax'), '20', 'a max below the min is raised to the min');
    assert.ok(await page.waitUntil(() => page.store.idleSettings?.everyMax === 20));
    click(page, 'idleStart');
    assert.ok(await page.waitUntil(() => ofType(page, 'START_IDLE').length === 1));
    assert.deepEqual(settingsOf(ofType(page, 'START_IDLE')[0]), { everyMin: 20, everyMax: 20, durMin: 2, durMax: 5 });
    click(page, 'idleStop');
    assert.ok(await page.waitUntil(() => ofType(page, 'STOP_IDLE').length === 1));
  } finally {
    page.dom.window.close();
  }
});

test('the new Start and Stop buttons (settings page and panel) are styled like the existing ones', () => {
  const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
  assert.match(html, /#start, #randomStart, #idleStart, \.tstart-btn \{ background:#222; color:white; \}/);
  assert.match(html, /#stop, #randomStop, #idleStop, \.tstop-btn \{ background:#eee; color:#222; \}/);
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.match(content, /\.mini button\.start, \.mini button\.tstart, \.mini button\.rstart, \.mini button\.istart, \.mini button\.hstart \{ background: #2f7d4a; \}/);
});

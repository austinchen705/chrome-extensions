// 整個 content script 在 jsdom 裡跑起來（載入 manifest 列的所有檔案、假的 chrome）的行為測試：
// 擴充功能重新載入之後留在頁面上的舊程式（連不上擴充功能的「孤兒」）不能繼續送指令、不能留下第二個面板，
// 偵測到驗證碼時就算通知送不出去也一定要停。需要 jsdom（devDependency）；沒裝就跳過。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // 沒裝 jsdom：整批跳過
}
const ui = JSDOM ? test : test.skip;

const root = path.join(__dirname, '..', 'catworld-auto-command');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const SCRIPTS = manifest.content_scripts[0].js;
const SPRITE = fs.readFileSync(path.join(__dirname, 'fixtures', 'captcha', 'sprite-62044.html'), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await condition()) return true;
    await sleep(10);
  }
  return Boolean(await condition());
};

// 一個遊戲頁：#content 是輸出區，#input 在表單裡（送出的指令記在 sent）
async function boot() {
  const dom = new JSDOM('<html><body><div id="content"><span id="message"></span></div><form id="f"><input id="input"></form></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const sent = [];
  w.document.getElementById('f').addEventListener('submit', event => {
    event.preventDefault();
    sent.push(w.document.getElementById('input').value);
  });
  const messageListeners = [];
  // 追蹤頁面開的計時器，測試結束時全部清掉（視窗不能 close：jsdom 關掉之後內部的 MutationObserver 還會跑一次而丟錯）
  const timers = [];
  ['setTimeout', 'setInterval'].forEach(name => {
    const original = w[name].bind(w);
    w[name] = (...args) => {
      const id = original(...args);
      timers.push(id);
      return id;
    };
  });
  const store = {};
  w.AudioContext = class {
    constructor() { this.state = 'suspended'; }
    resume() { return Promise.resolve(); }
    close() {}
  };
  w.chrome = {
    runtime: {
      id: 'ext',
      sendMessage: () => Promise.resolve({}),
      onMessage: { addListener: fn => messageListeners.push(fn) },
      getURL: file => file,
    },
    storage: {
      local: {
        get: async keys => Object.fromEntries([].concat(keys ?? []).filter(key => key in store).map(key => [key, store[key]])),
        set: async values => { Object.assign(store, values); },
      },
      onChanged: { addListener() {} },
    },
  };
  // content.js 啟動時有一段非同步的初始化（重新整理後自動停止等），等它跑完才開始操作
  const install = files => files.forEach(file => w.eval(fs.readFileSync(path.join(root, file), 'utf8')));
  install(SCRIPTS);
  await sleep(80);
  const ask = message => new Promise(resolve => {
    const handled = messageListeners.map(listener => listener(message, { id: 'ext' }, resolve)).some(result => result === true);
    if (!handled) resolve(undefined);
  });
  const hosts = () => [...w.document.documentElement.children].filter(element => element.shadowRoot?.querySelector('.label'));
  return { w, sent, ask, hosts, install, messageListeners, close: () => timers.forEach(id => { w.clearTimeout(id); w.clearInterval(id); }) };
}

const START = { type: 'START', settings: { commands: ['ps'], minSeconds: 1, maxSeconds: 1, commandDelayMs: 0 } };

ui('a running timer stops sending commands once the page is cut off from the extension, and its panel goes away', async () => {
  const page = await boot();
  try {
  await page.ask(START);
  assert.ok(await waitFor(() => page.sent.length >= 1, 4000), 'it sends commands while alive');
  assert.equal(page.hosts().length, 1);
  page.w.chrome.runtime.id = undefined; // 擴充功能重新載入後，舊頁面裡的 chrome.runtime.id 會失效
  await sleep(150);
  const before = page.sent.length;
  await sleep(2500);
  assert.equal(page.sent.length, before, 'no more commands after the context is gone');
  assert.equal(page.hosts().length, 0, 'the orphan panel is removed');
  } finally {
    page.close();
  }
});

ui('a captcha stops everything even when the notification cannot be sent', async () => {
  const page = await boot();
  try {
  await page.ask(START);
  assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
  page.w.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
  const holder = page.w.document.createElement('div');
  holder.innerHTML = `${SPRITE}`;
  page.w.document.getElementById('message').append(...holder.childNodes);
  assert.ok(await waitFor(async () => (await page.ask({ type: 'STATUS' }))?.running === false, 2000), 'the timer is stopped');
  const before = page.sent.length;
  await sleep(2200);
  assert.equal(page.sent.length, before, 'and nothing more is sent');
  } finally {
    page.close();
  }
});

ui('being replaced by a connection from elsewhere stops everything and rings once', async () => {
  const page = await boot();
  try {
  await page.ask(START);
  assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
  const alerts = [];
  page.w.chrome.runtime.sendMessage = message => { alerts.push(message); return Promise.resolve({}); };
  page.w.document.getElementById('message').append('有人從別處( 203.0.113.9 )連線取代你所控制的人物。');
  assert.ok(await waitFor(async () => (await page.ask({ type: 'STATUS' }))?.running === false, 2000), 'the timer is stopped');
  const before = page.sent.length;
  await sleep(2200);
  assert.equal(page.sent.length, before, 'and nothing more is sent');
  const takeover = alerts.filter(message => message.type === 'ALERT');
  assert.equal(takeover.length, 1);
  assert.ok(!/驗證/.test(takeover[0].reason), 'not treated as a captcha stop');
  assert.ok(!takeover[0].confirmable, 'rings once, no confirm needed');
  } finally {
    page.close();
  }
});

ui('a new instance injected into the same page replaces the leftover panel instead of adding a second one', async () => {
  const page = await boot();
  try {
  assert.equal(page.hosts().length, 1);
  // 備援注入是新的隔離環境：防重複的旗標是空的，模組全域則是新的環境重新載入的
  delete page.w.__catworldAutoCommandInstalled;
  page.install(['content.js']);
  assert.equal(page.hosts().length, 1, 'exactly one panel');
  } finally {
    page.close();
  }
});

// 整個 content script 在 jsdom 裡跑起來的共用底座：載入 manifest 列的所有檔案、假的 chrome、記下送出的指令（sent）與送給 background 的訊息（messages）。
// content-instance.test.js 與 captcha-solve.test.js 共用。需要 jsdom（devDependency）；沒裝時 ui 是 test.skip。
// scale：把頁面裡 setTimeout 的毫秒數除以 scale（驗證碼的 8 秒無回應、1 秒靜默等），測試才不用真的等。
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // 沒裝 jsdom：整批跳過
}
const ui = JSDOM ? test : test.skip;

const root = path.join(__dirname, '..', '..', 'catworld-auto-command');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const SCRIPTS = manifest.content_scripts[0].js;
const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'captcha', name), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await condition()) return true;
    await sleep(10);
  }
  return Boolean(await condition());
};

// 一個遊戲頁（照真實頁面的結構）：#content 是輸出區，#uptime 是輸出區外每秒跳的時鐘，#input 在表單裡（送出的指令記在 sent）
async function boot({ scale = 1 } = {}) {
  const dom = new JSDOM('<html><body><div id="main"><div id="content"><span id="message"></span></div></div><div id="buttons"><div id="uptime">00:00</div></div><form id="f"><input id="input"></form></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const sent = [];
  w.document.getElementById('f').addEventListener('submit', event => {
    event.preventDefault();
    sent.push(w.document.getElementById('input').value);
  });
  const messageListeners = [];
  const messages = [];
  // 追蹤頁面開的計時器，測試結束時全部清掉（視窗不能 close：jsdom 關掉之後內部的 MutationObserver 還會跑一次而丟錯）
  const timers = [];
  const realSetInterval = w.setInterval.bind(w);
  ['setTimeout', 'setInterval'].forEach(name => {
    const original = w[name].bind(w);
    w[name] = (fn, ms, ...args) => {
      const id = original(fn, scale === 1 ? ms : Math.max(1, Math.round((ms ?? 0) / scale)), ...args);
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
      sendMessage: message => { messages.push(message); return Promise.resolve({}); },
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
  // 模擬遊戲輸出：HTML 片段加進輸出區（和真實頁面一樣是新增節點）
  const output = html => {
    const holder = w.document.createElement('div');
    holder.innerHTML = html;
    w.document.getElementById('message').append(...holder.childNodes);
  };
  const running = async () => (await ask({ type: 'STATUS' }))?.running === true;
  // 右上角的時鐘每 ms 毫秒跳一次（真實頁面每秒；用視窗自己的、不縮放的計時器，close 才清得掉）：它不是遊戲回覆
  let clock = 0;
  const startClock = ms => { timers.push(realSetInterval(() => { clock += 1; w.document.getElementById('uptime').textContent = `00:${String(clock % 60).padStart(2, '0')}`; }, ms)); };
  return { w, sent, messages, ask, hosts, install, output, running, startClock, messageListeners, close: () => timers.forEach(id => { w.clearTimeout(id); w.clearInterval(id); }) };
}

const START = { type: 'START', settings: { commands: ['ps'], minSeconds: 1, maxSeconds: 1, commandDelayMs: 0 } };

module.exports = { ui, boot, sleep, waitFor, START, fixture, SCRIPTS };

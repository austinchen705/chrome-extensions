// 遊戲頁替設定頁代讀代寫巨集：整個 content script 在 jsdom 裡跑起來（載入 manifest 列的所有檔案、假的 chrome），
// 直接呼叫它註冊的 onMessage 監聽者送 MACRO_READ／MACRO_WRITE，看回覆與頁面的 localStorage.MACROS。
// 需要 jsdom（devDependency）；沒裝就跳過。
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
const plain = value => JSON.parse(JSON.stringify(value ?? null));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function boot({ macros = '[0]' } = {}) {
  const dom = new JSDOM('<html><body><div id="content"></div><form id="f"><input id="input"></form></body></html>', {
    url: 'https://catworld.muds.tw/web',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const timers = [];
  ['setTimeout', 'setInterval'].forEach(name => {
    const original = w[name].bind(w);
    w[name] = (...args) => {
      const id = original(...args);
      timers.push(id);
      return id;
    };
  });
  if (macros !== null) w.localStorage.setItem('MACROS', macros);
  const store = {};
  const listeners = [];
  w.AudioContext = class {
    constructor() { this.state = 'suspended'; }
    resume() { return Promise.resolve(); }
    close() {}
  };
  w.chrome = {
    runtime: { id: 'ext', sendMessage: () => Promise.resolve({}), onMessage: { addListener: fn => listeners.push(fn) }, getURL: file => file },
    storage: {
      local: {
        get: async keys => Object.fromEntries([].concat(keys ?? []).filter(key => key in store).map(key => [key, store[key]])),
        set: async values => { Object.assign(store, values); },
      },
      onChanged: { addListener() {} },
    },
  };
  SCRIPTS.forEach(file => w.eval(fs.readFileSync(path.join(root, file), 'utf8')));
  await sleep(80);
  const host = [...w.document.documentElement.children].find(element => element.shadowRoot?.querySelector('.label'));
  // 送一則訊息給所有監聽者，收第一個 sendResponse 的回覆
  const ask = message => new Promise(resolve => {
    listeners.forEach(listener => listener(message, { id: 'ext' }, reply => resolve(plain(reply))));
    setTimeout(() => resolve('no reply'), 200);
  });
  return { w, host, ask, close: () => {
    // 視窗不能 close()：content script 的觀察器會在關掉的 document 上丟例外（和其他整個 content script 的測試一樣只清計時器）
    timers.forEach(id => { w.clearTimeout(id); w.clearInterval(id); });
  } };
}

ui('MACRO_READ answers with the exact MACROS text of the page, and null when the game never stored any', async () => {
  const page = await boot({ macros: '[["112","look"],0]' });
  try {
    assert.deepEqual(await page.ask({ type: 'MACRO_READ' }), { ok: true, raw: '[["112","look"],0]' });
    page.w.localStorage.removeItem('MACROS');
    assert.deepEqual(await page.ask({ type: 'MACRO_READ' }), { ok: true, raw: null });
  } finally {
    page.close();
  }
});

ui('MACRO_WRITE writes the text as it is into the page storage, even text the game cannot read', async () => {
  const page = await boot();
  try {
    assert.deepEqual(await page.ask({ type: 'MACRO_WRITE', raw: '[["113","north"]]' }), { ok: true });
    assert.equal(page.w.localStorage.getItem('MACROS'), '[["113","north"]]');
    assert.deepEqual(await page.ask({ type: 'MACRO_WRITE', raw: 'not json at all' }), { ok: true });
    assert.equal(page.w.localStorage.getItem('MACROS'), 'not json at all', 'a restore puts back an unreadable backup exactly');
  } finally {
    page.close();
  }
});

ui('MACRO_WRITE without a text is refused and the stored macros stay', async () => {
  const page = await boot({ macros: '[0]' });
  try {
    for (const raw of [undefined, 5, null, ['x']]) {
      const reply = await page.ask({ type: 'MACRO_WRITE', raw });
      assert.equal(reply.ok, false);
      assert.ok(reply.error);
    }
    assert.equal(page.w.localStorage.getItem('MACROS'), '[0]');
  } finally {
    page.close();
  }
});

ui('the panel no longer has the export and import buttons, but still has the macro stop button', async () => {
  const page = await boot();
  try {
    const $ = selector => page.host.shadowRoot.querySelector(selector);
    assert.equal($('.mexport'), null);
    assert.equal($('.mimport'), null);
    assert.equal($('.macro-import'), null);
    assert.ok($('.mstop'));
  } finally {
    page.close();
  }
});

// 面板「巨集」列的匯出：整個 content script 在 jsdom 裡跑起來（載入 manifest 列的所有檔案、假的 chrome），
// 頁面放遊戲存巨集的 localStorage.MACROS。需要 jsdom（devDependency）；沒裝就跳過。
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await condition()) return true;
    await sleep(10);
  }
  return Boolean(await condition());
};

const game = (filled = {}) => Array.from({ length: 90 }, (_, index) => filled[index] ?? 0);
const MACROS = game({ 0: ['112', 'look'], 4: ['1281', 'run n;@等待 1;ne'] });

// 一個遊戲頁：localStorage.MACROS 是遊戲存的巨集，clipboard 是假的（記下寫進去的文字，可以設定成失敗）
async function boot({ macros = JSON.stringify(MACROS), notes = { 1: '開門', 5: '跑路' }, clipboard = 'ok', extraHtml = '' } = {}) {
  const dom = new JSDOM(`<html><body><div id="content"></div><form id="f"><input id="input"></form>${extraHtml}</body></html>`, {
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
  const copied = [];
  Object.defineProperty(w.navigator, 'clipboard', {
    value: { writeText: async text => { if (clipboard === 'fail') throw new Error('denied'); copied.push(text); } },
    configurable: true,
  });
  if (macros !== null) w.localStorage.setItem('MACROS', macros);
  const store = notes ? { macroNotes: notes } : {};
  w.AudioContext = class {
    constructor() { this.state = 'suspended'; }
    resume() { return Promise.resolve(); }
    close() {}
  };
  w.chrome = {
    runtime: { id: 'ext', sendMessage: () => Promise.resolve({}), onMessage: { addListener() {} }, getURL: file => file },
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
  const $ = selector => host.shadowRoot.querySelector(selector);
  return { w, $, copied, close: () => timers.forEach(id => { w.clearTimeout(id); w.clearInterval(id); }) };
}

ui('the macro row is always on the panel, with an empty status and nothing to stop while no macro runs', async () => {
  const page = await boot();
  try {
    assert.equal(page.$('.macro-line').hidden, false);
    assert.equal(page.$('.macro-text').textContent, '');
    assert.equal(page.$('.mstop').disabled, true);
    assert.ok(page.$('.mexport'), 'there is an export button');
  } finally {
    page.close();
  }
});

ui('export copies the game macros and the notes as one JSON text, and says so', async () => {
  const page = await boot();
  try {
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.copied.length === 1));
    const parsed = JSON.parse(page.copied[0]);
    assert.deepEqual([parsed.version, parsed.macros, parsed.notes], [1, MACROS, { 1: '開門', 5: '跑路' }]);
    assert.match(page.$('.macro-io-msg').textContent, /已複製/);
    assert.equal(page.$('.macro-io-text').hidden, true, 'no manual copy box when copying worked');
  } finally {
    page.close();
  }
});

ui('when the clipboard refuses, the text is put in a box to copy by hand, with a warning', async () => {
  const page = await boot({ clipboard: 'fail' });
  try {
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.$('.macro-io-text').hidden === false));
    assert.deepEqual(JSON.parse(page.$('.macro-io-text').value).macros, MACROS);
    assert.match(page.$('.macro-io-msg').textContent, /無法寫入剪貼簿/);
    assert.ok(page.$('.macro-io-msg').classList.contains('warn'));
  } finally {
    page.close();
  }
});

ui('a game with no stored macros exports 90 empty slots plus the notes and says there were none yet', async () => {
  const page = await boot({ macros: null });
  try {
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.copied.length === 1));
    const parsed = JSON.parse(page.copied[0]);
    assert.deepEqual([parsed.macros, parsed.notes], [game(), { 1: '開門', 5: '跑路' }]);
    assert.match(page.$('.macro-io-msg').textContent, /還沒有存過巨集/);
  } finally {
    page.close();
  }
});

ui('unreadable stored macros still export (as empty slots) and the panel warns instead of failing', async () => {
  const page = await boot({ macros: 'not json' });
  try {
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.copied.length === 1));
    assert.deepEqual(JSON.parse(page.copied[0]).macros, game());
    assert.match(page.$('.macro-io-msg').textContent, /讀不懂/);
    assert.ok(page.$('.macro-io-msg').classList.contains('warn'));
  } finally {
    page.close();
  }
});

ui('typing in the manual copy box never reaches the game', async () => {
  const page = await boot({ clipboard: 'fail' });
  try {
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.$('.macro-io-text').hidden === false));
    let leaked = 0;
    ['keydown', 'keyup', 'keypress', 'mousedown'].forEach(type => page.w.document.addEventListener(type, () => { leaked++; }));
    const box = page.$('.macro-io-text');
    box.dispatchEvent(new page.w.KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }));
    box.dispatchEvent(new page.w.MouseEvent('mousedown', { bubbles: true, composed: true }));
    assert.equal(leaked, 0);
  } finally {
    page.close();
  }
});

ui('the copy goes through the clipboard of the document the button lives in (the panel can be in a floating window)', async () => {
  const page = await boot();
  try {
    const other = new JSDOM('<div id="r"><button class="mexport"></button><div class="macro-io" hidden><div class="macro-io-msg"></div><textarea class="macro-io-text" hidden></textarea></div></div>', { url: 'https://catworld.muds.tw/web' });
    const there = [];
    Object.defineProperty(other.window.navigator, 'clipboard', { value: { writeText: async text => { there.push(text); } }, configurable: true });
    page.w.CatworldMacroIOUI.attach(other.window.document.getElementById('r'), {
      readRaw: () => JSON.stringify(MACROS),
      readNotes: async () => ({}),
    });
    other.window.document.querySelector('.mexport').click();
    assert.ok(await waitFor(() => there.length === 1));
    assert.equal(page.copied.length, 0, 'not the main window clipboard');
  } finally {
    page.close();
  }
});

ui('the status text of the macro row shows a running macro and is empty again when it ends', async () => {
  const page = await boot({ extraHtml: '<div id="macro_list"><div><input class="key" name="112"><input class="command" value="@等待 1;look"></div></div>' });
  try {
    page.w.document.body.dispatchEvent(new page.w.KeyboardEvent('keydown', { which: 112, keyCode: 112, bubbles: true }));
    assert.ok(await waitFor(() => page.$('.macro-text').textContent !== ''), 'the running macro shows in the row');
    assert.ok(await waitFor(() => page.$('.macro-text').textContent === '' && page.$('.mstop').disabled, 6000), 'the text goes away when the macro is done');
  } finally {
    page.close();
  }
});

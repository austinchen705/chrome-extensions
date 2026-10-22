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
  const changeListeners = [];
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
        set: async values => {
          const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }]));
          Object.assign(store, values);
          changeListeners.forEach(listener => listener(changes, 'local'));
        },
      },
      onChanged: { addListener: fn => changeListeners.push(fn) },
    },
  };
  SCRIPTS.forEach(file => w.eval(fs.readFileSync(path.join(root, file), 'utf8')));
  await sleep(80);
  const host = [...w.document.documentElement.children].find(element => element.shadowRoot?.querySelector('.label'));
  const $ = selector => host.shadowRoot.querySelector(selector);
  return { w, $, copied, store, close: () => timers.forEach(id => { w.clearTimeout(id); w.clearInterval(id); }) };
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
    ['keydown', 'keyup', 'keypress', 'mousedown', 'click'].forEach(type => page.w.document.addEventListener(type, () => { leaked++; }));
    const box = page.$('.macro-io-text');
    box.dispatchEvent(new page.w.KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }));
    box.dispatchEvent(new page.w.MouseEvent('mousedown', { bubbles: true, composed: true }));
    box.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true, composed: true }));
    assert.equal(leaked, 0);
  } finally {
    page.close();
  }
});

const FRAGMENT = '<div id="r"><button class="mexport"></button><button class="mimport"></button>'
  + '<div class="macro-import" hidden><textarea class="macro-import-text"></textarea><button class="macro-import-check"></button><button class="macro-import-cancel"></button></div>'
  + '<div class="macro-confirm" hidden><div class="macro-confirm-msg"></div><button class="macro-confirm-ok"></button><button class="macro-confirm-cancel"></button></div>'
  + '<div class="macro-io" hidden><div class="macro-io-msg"></div><textarea class="macro-io-text" hidden></textarea></div></div>';
// 另一個 document 裡的面板片段（置頂浮窗就是這樣）：回傳該 document 的剪貼簿記錄與常用節點
function elsewhere(page, deps, clipboard = 'ok') {
  const other = new JSDOM(FRAGMENT, { url: 'https://catworld.muds.tw/web' });
  const there = [];
  Object.defineProperty(other.window.navigator, 'clipboard', {
    value: { writeText: async text => { if (clipboard === 'fail') throw new Error('denied'); there.push(text); } },
    configurable: true,
  });
  page.w.CatworldMacroIOUI.attach(other.window.document.getElementById('r'), deps);
  const $ = selector => other.window.document.querySelector(selector);
  return { there, $ };
}
const depsOf = (extra = {}) => ({ readRaw: () => JSON.stringify(MACROS), readNotes: async () => ({}), ...extra });

ui('the copy goes through the clipboard of the document the button lives in (the panel can be in a floating window)', async () => {
  const page = await boot();
  try {
    const { there, $ } = elsewhere(page, depsOf());
    $('.mexport').click();
    assert.ok(await waitFor(() => there.length === 1));
    assert.equal(page.copied.length, 0, 'not the main window clipboard');
  } finally {
    page.close();
  }
});

ui('the panel is laid out again whenever the message or the manual copy box appears or goes away', async () => {
  const page = await boot();
  try {
    let calls = 0;
    let hide = null;
    page.w.setTimeout = fn => { hide = fn; return 1; };
    const { there, $ } = elsewhere(page, depsOf({ relayout: () => { calls++; } }));
    $('.mexport').click();
    assert.ok(await waitFor(() => there.length === 1));
    assert.ok(calls >= 1, 'laid out when the message showed up');
    assert.equal($('.macro-io').hidden, false);
    const before = calls;
    hide();
    assert.equal($('.macro-io').hidden, true, 'the message goes away by itself');
    assert.ok(calls > before, 'laid out again when it went away');
  } finally {
    page.close();
  }
});

ui('the manual copy box has no timer: it stays until the next export', async () => {
  const page = await boot();
  try {
    const timers = [];
    page.w.setTimeout = fn => { timers.push(fn); return timers.length; };
    const { $ } = elsewhere(page, depsOf(), 'fail');
    $('.mexport').click();
    assert.ok(await waitFor(() => $('.macro-io-text').hidden === false));
    assert.equal(timers.length, 0, 'no timer hides the box people still have to copy from');
  } finally {
    page.close();
  }
});

ui('notes that cannot be read only leave the notes out of the export, the macros still come out', async () => {
  const page = await boot();
  try {
    const { there, $ } = elsewhere(page, depsOf({ readNotes: async () => { throw new Error('storage gone'); } }));
    $('.mexport').click();
    assert.ok(await waitFor(() => there.length === 1));
    const parsed = JSON.parse(there[0]);
    assert.deepEqual([parsed.macros, parsed.notes], [MACROS, {}]);
  } finally {
    page.close();
  }
});

ui('when the game storage cannot be read at all the export is still made, as empty slots with a warning', async () => {
  const page = await boot();
  try {
    const { there, $ } = elsewhere(page, depsOf({ readRaw: () => { throw new Error('SecurityError'); } }));
    $('.mexport').click();
    assert.ok(await waitFor(() => there.length === 1));
    assert.deepEqual(JSON.parse(there[0]).macros, game());
    assert.match($('.macro-io-msg').textContent, /讀不懂/);
    assert.ok($('.macro-io-msg').classList.contains('warn'));
  } finally {
    page.close();
  }
});

ui('an empty string in the game storage is treated like nothing stored, without a damaged warning', async () => {
  const page = await boot({ macros: '' });
  try {
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.copied.length === 1));
    assert.match(page.$('.macro-io-msg').textContent, /還沒有存過巨集/);
    assert.equal(page.$('.macro-io-msg').classList.contains('warn'), false);
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

// ---- 匯入 ----
const plain = value => JSON.parse(JSON.stringify(value));
const NEW_MACROS = game({ 0: ['113', 'north'], 2: ['114', 'run e;@等待 2;look'] });
const IMPORT_TEXT = JSON.stringify({ version: 1, macros: NEW_MACROS, notes: { 2: '新備註', 3: '另一條' } });
const MACRO_ROWS = '<div id="macro_list">' + [1, 2, 3].map(n => `<div><span class="num">${n}</span><input class="key" name=""><input class="command" value=""></div>`).join('') + '</div>';

// 貼上文字、按「檢查」，回傳面板上看得到的東西
async function paste(page, value) {
  const area = page.$('.macro-import-text');
  area.value = value;
  area.dispatchEvent(new page.w.Event('input', { bubbles: true }));
  page.$('.macro-import-check').click();
  await sleep(10);
}

ui('the import box opens and closes with the import button, and the paste box is not tied to the game', async () => {
  const page = await boot();
  try {
    assert.ok(page.$('.mimport'), 'there is an import button');
    assert.equal(page.$('.macro-import').hidden, true);
    page.$('.mimport').click();
    assert.equal(page.$('.macro-import').hidden, false);
    page.$('.mimport').click();
    assert.equal(page.$('.macro-import').hidden, true);
    page.$('.mimport').click();
    let leaked = 0;
    ['keydown', 'keyup', 'keypress', 'mousedown', 'click'].forEach(type => page.w.document.addEventListener(type, () => { leaked++; }));
    const area = page.$('.macro-import-text');
    area.dispatchEvent(new page.w.KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }));
    area.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true, composed: true }));
    assert.equal(leaked, 0);
  } finally {
    page.close();
  }
});

ui('a good text asks for confirmation first: how many rows get replaced and the warnings, and nothing is written yet', async () => {
  const page = await boot({ extraHtml: MACRO_ROWS });
  try {
    const before = page.w.localStorage.getItem('MACROS');
    const notesBefore = JSON.stringify(page.store.macroNotes);
    page.$('.mimport').click();
    await paste(page, IMPORT_TEXT);
    assert.equal(page.$('.macro-confirm').hidden, false);
    const message = page.$('.macro-confirm-msg').textContent;
    assert.match(message, /將取代 2 列/, 'the game has two macros now');
    assert.match(message, /重新整理遊戲頁/);
    assert.match(message, /403/);
    assert.match(message, /蓋掉/);
    assert.match(message, /每個分頁/);
    assert.equal(page.w.localStorage.getItem('MACROS'), before, 'the game macros are untouched');
    assert.equal(JSON.stringify(page.store.macroNotes), notesBefore, 'the notes are untouched');
  } finally {
    page.close();
  }
});

ui('confirming replaces the whole list and the notes, updates the notes on screen right away, and says to refresh the game', async () => {
  const page = await boot({ extraHtml: MACRO_ROWS });
  try {
    page.$('.mimport').click();
    await paste(page, IMPORT_TEXT);
    page.$('.macro-confirm-ok').click();
    assert.ok(await waitFor(() => /已匯入/.test(page.$('.macro-io-msg').textContent)));
    assert.deepEqual(JSON.parse(page.w.localStorage.getItem('MACROS')), NEW_MACROS);
    assert.deepEqual(plain(page.store.macroNotes), { 2: '新備註', 3: '另一條' }, 'the old notes are gone, not merged');
    assert.match(page.$('.macro-io-msg').textContent, /重新整理遊戲頁/);
    const inputs = [...page.w.document.querySelectorAll('#macro_list input.note')];
    assert.deepEqual(inputs.map(input => input.value), ['', '新備註', '另一條'], 'the note boxes of the macro window followed');
    assert.equal(page.$('.macro-confirm').hidden, true);
    assert.equal(page.$('.macro-import').hidden, true);
    assert.equal(page.$('.macro-import-text').value, '', 'the pasted text is cleared');
  } finally {
    page.close();
  }
});

ui('an import writes the notes as someone else\'s change, so the note boxes accept it instead of writing the old text back', async () => {
  const page = await boot({ extraHtml: MACRO_ROWS });
  try {
    page.$('.mimport').click();
    await paste(page, IMPORT_TEXT);
    page.$('.macro-confirm-ok').click();
    assert.ok(await waitFor(() => /已匯入/.test(page.$('.macro-io-msg').textContent)));
    const note = page.w.document.querySelector('#macro_list input.note[data-row="2"]');
    note.value = '手動改的';
    note.dispatchEvent(new page.w.Event('input', { bubbles: true }));
    note.dispatchEvent(new page.w.Event('change', { bubbles: true }));
    await sleep(20);
    assert.equal(page.store.macroNotes[2], '手動改的', 'later edits of the notes still save normally');
    assert.equal(page.store.macroNotes[3], '另一條', 'and the imported notes are still there');
  } finally {
    page.close();
  }
});

ui('a bad text is refused with the reason, nothing is written and there is nothing to confirm', async () => {
  const page = await boot();
  try {
    const before = page.w.localStorage.getItem('MACROS');
    page.$('.mimport').click();
    for (const bad of ['not json', JSON.stringify({ version: 1, macros: game({ 0: ['112', 'a'], 1: ['112', 'b'] }) })]) {
      await paste(page, bad);
      assert.equal(page.$('.macro-confirm').hidden, true);
      assert.match(page.$('.macro-io-msg').textContent, /匯入失敗，沒有改動任何資料/);
      assert.ok(page.$('.macro-io-msg').classList.contains('alert'));
    }
    assert.match(page.$('.macro-io-msg').textContent, /重複/, 'the reason of the last one is shown');
    assert.equal(page.w.localStorage.getItem('MACROS'), before);
    assert.deepEqual(page.store.macroNotes, { 1: '開門', 5: '跑路' });
  } finally {
    page.close();
  }
});

ui('cancelling writes nothing, and changing the pasted text drops a confirmation that was already asked', async () => {
  const page = await boot();
  try {
    const before = page.w.localStorage.getItem('MACROS');
    page.$('.mimport').click();
    await paste(page, IMPORT_TEXT);
    page.$('.macro-confirm-cancel').click();
    assert.equal(page.$('.macro-confirm').hidden, true);
    assert.equal(page.w.localStorage.getItem('MACROS'), before);
    await paste(page, IMPORT_TEXT);
    assert.equal(page.$('.macro-confirm').hidden, false);
    const area = page.$('.macro-import-text');
    area.value = IMPORT_TEXT + ' ';
    area.dispatchEvent(new page.w.Event('input', { bubbles: true }));
    assert.equal(page.$('.macro-confirm').hidden, true, 'the old confirmation would apply text that is no longer in the box');
    page.$('.macro-confirm-ok').click();
    assert.equal(page.w.localStorage.getItem('MACROS'), before, 'and a stale confirm button does nothing');
    page.$('.macro-import-cancel').click();
    assert.equal(page.$('.macro-import').hidden, true);
  } finally {
    page.close();
  }
});

ui('what the export gives can be imported back and leaves the game macros and the notes the same', async () => {
  const page = await boot({ extraHtml: MACRO_ROWS });
  try {
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.copied.length === 1));
    const macrosBefore = page.w.localStorage.getItem('MACROS');
    const notesBefore = { ...page.store.macroNotes };
    page.$('.mimport').click();
    await paste(page, page.copied[0]);
    page.$('.macro-confirm-ok').click();
    assert.ok(await waitFor(() => /已匯入/.test(page.$('.macro-io-msg').textContent)));
    assert.deepEqual(JSON.parse(page.w.localStorage.getItem('MACROS')), JSON.parse(macrosBefore));
    assert.deepEqual(plain(page.store.macroNotes), plain(notesBefore));
  } finally {
    page.close();
  }
});

ui('when the game storage refuses the write, nothing changes and the panel says so', async () => {
  const page = await boot();
  try {
    const { there, $ } = elsewhere(page, depsOf({
      writeMacros: () => { throw new Error('QuotaExceededError'); },
      writeNotes: async () => { there.push('notes written'); },
    }));
    $('.mimport').click();
    $('.macro-import-text').value = IMPORT_TEXT;
    $('.macro-import-check').click();
    $('.macro-confirm-ok').click();
    await sleep(20);
    assert.match($('.macro-io-msg').textContent, /匯入失敗.*沒有改動/);
    assert.ok($('.macro-io-msg').classList.contains('alert'));
    assert.deepEqual(there, [], 'the notes were not touched either');
  } finally {
    page.close();
  }
});

ui('the import works in a panel that lives in another document too', async () => {
  const page = await boot();
  try {
    const written = [];
    const { $ } = elsewhere(page, depsOf({
      writeMacros: text => { written.push(text); },
      writeNotes: async notes => { written.push(notes); },
    }));
    $('.mimport').click();
    $('.macro-import-text').value = IMPORT_TEXT;
    $('.macro-import-check').click();
    assert.equal($('.macro-confirm').hidden, false);
    $('.macro-confirm-ok').click();
    await sleep(20);
    assert.deepEqual(plain([JSON.parse(written[0]), written[1]]), [NEW_MACROS, { 2: '新備註', 3: '另一條' }]);
  } finally {
    page.close();
  }
});

ui('closing the import box drops a confirmation that was waiting', async () => {
  const page = await boot();
  try {
    const before = page.w.localStorage.getItem('MACROS');
    page.$('.mimport').click();
    await paste(page, IMPORT_TEXT);
    assert.equal(page.$('.macro-confirm').hidden, false);
    page.$('.mimport').click();
    assert.equal(page.$('.macro-confirm').hidden, true);
    page.$('.macro-confirm-ok').click();
    await sleep(20);
    assert.equal(page.w.localStorage.getItem('MACROS'), before, 'a confirm button that is no longer on screen does nothing');
  } finally {
    page.close();
  }
});

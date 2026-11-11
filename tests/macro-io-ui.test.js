// 設定頁「遊戲巨集匯入匯出」：在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的）。
// 遊戲分頁是假的：chrome.tabs.sendMessage 回答 MACRO_READ／MACRO_WRITE，手上有一份遊戲存的 MACROS 文字，
// 可以設定成讀失敗、寫失敗（明確回 ok:false）、連不上、送出後斷線；備註與備份在假的 chrome.storage.local。
// 需要 jsdom（devDependency）；沒裝就跳過。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // 沒裝 jsdom：整批跳過
}
const ui = JSDOM ? test : test.skip;

const root = path.join(__dirname, '..', 'catworld-auto-command');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await condition()) return true;
    await sleep(5);
  }
  return Boolean(await condition());
};
const plain = value => JSON.parse(JSON.stringify(value));

const game = (filled = {}) => Array.from({ length: 90 }, (_, index) => filled[index] ?? 0);
const MACROS = game({ 0: ['112', 'look'], 4: ['1281', 'run n;@等待 1;ne'] });
const OLD_NOTES = { 1: '開門', 5: '跑路' };
const NEW_MACROS = game({ 0: ['113', 'north'], 2: ['114', 'run e;@等待 2;look'] });
const IMPORT_TEXT = JSON.stringify({ version: 1, macros: NEW_MACROS, notes: { 2: '新備註', 3: '另一條' } });
const OLD_BACKUP = { raw: JSON.stringify(game({ 9: ['120', 'old backup'] })), notes: { 9: '舊備份' }, at: 1 };

// tab：假的遊戲分頁。raw＝遊戲存的 MACROS（null＝沒存過）；readFails／writeFails＝明確回 ok:false；
// unreachable＝找不到分頁（writeUnreachable 只有寫的時候）；lostReply＝寫進去了但回覆沒回來；readHold＝MACRO_READ 等這個 promise 才回。
// storage：failGet／failSet 放鍵名，讀寫到這些鍵就丟例外；sets 記下每次 set 的內容
async function boot({ macros = JSON.stringify(MACROS), notes = OLD_NOTES, clipboard = 'ok', backup } = {}) {
  const tab = { raw: macros, writes: [], readFails: false, writeFails: false, unreachable: false, writeUnreachable: false, lostReply: false, readHold: null };
  const store = {};
  if (notes) store.macroNotes = notes;
  if (backup !== undefined) store.macroBackup = backup;
  const storage = { failGet: new Set(), failSet: new Set(), sets: [] };
  const changeListeners = [];
  const copied = [];
  const answer = async message => {
    if (tab.unreachable) throw new Error('No tab with id: 7.');
    if (message.type === 'MACRO_READ') {
      if (tab.readHold) await tab.readHold;
      if (tab.readFails) return { ok: false, error: 'SecurityError' };
      return { ok: true, raw: tab.raw };
    }
    if (message.type === 'MACRO_WRITE') {
      if (tab.writeUnreachable) throw new Error('No tab with id: 7.');
      if (tab.writeFails) return { ok: false, error: 'QuotaExceededError' };
      tab.raw = message.raw;
      tab.writes.push(message.raw);
      if (tab.lostReply) throw new Error('The message port closed before a response was received.');
      return { ok: true };
    }
    return undefined;
  };
  const dom = await JSDOM.fromFile(path.join(root, 'popup.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `file://${root.split(path.sep).join('/')}/popup.html`,
    beforeParse(window) {
      Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: async text => { if (clipboard === 'fail') throw new Error('denied'); copied.push(text); } },
        configurable: true,
      });
      window.chrome = {
        runtime: { id: 'ext', getManifest: () => ({ version: '0.0.0' }), getURL: file => file, onMessage: { addListener() {} }, sendMessage: async () => ({}) },
        storage: {
          local: {
            get: async keys => {
              const list = keys === null || keys === undefined ? Object.keys(store) : [].concat(typeof keys === 'object' && !Array.isArray(keys) ? Object.keys(keys) : keys);
              const bad = list.find(key => storage.failGet.has(key));
              if (bad) throw new Error('storage gone');
              return Object.fromEntries(list.filter(key => key in store).map(key => [key, plain(store[key])]));
            },
            set: async values => {
              if (Object.keys(values).some(key => storage.failSet.has(key))) throw new Error('quota');
              const copy = plain(values);
              storage.sets.push(copy);
              Object.assign(store, copy);
              const changes = Object.fromEntries(Object.entries(copy).map(([key, value]) => [key, { newValue: value }]));
              changeListeners.forEach(listener => { try { listener(changes, 'local'); } catch { /* 別的區塊的監聽者不關這裡的事 */ } });
            },
            remove: async keys => { [].concat(keys).forEach(key => { delete store[key]; }); },
          },
          sync: { get: async () => ({}), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener: fn => changeListeners.push(fn) },
        },
        tabs: {
          query: async () => [{ id: 7, url: 'https://catworld.muds.tw/web' }],
          get: async () => ({ id: 7, url: 'https://catworld.muds.tw/web' }),
          sendMessage: async (id, message) => answer(message),
          create: async () => {},
          update: async () => {},
        },
        permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        scripting: { executeScript: async () => { throw new Error('should not inject'); }, insertCSS: async () => {} },
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  assert.ok(await waitFor(() => doc.getElementById('huntFields')?.children.length > 0), 'popup.js ran to the end');
  const section = doc.getElementById('sec-macro');
  const $ = selector => section.querySelector(selector);
  const backupSets = () => storage.sets.filter(values => 'macroBackup' in values).map(values => values.macroBackup);
  return { dom, w: dom.window, $, tab, store, storage, copied, backupSets, close: () => dom.window.close() };
}

// 貼上文字、按「檢查」，等確認框出來（或錯誤訊息）
async function paste(page, value) {
  const area = page.$('.macro-import-text');
  area.value = value;
  area.dispatchEvent(new page.w.Event('input', { bubbles: true }));
  page.$('.macro-import-check').click();
  await waitFor(() => page.$('.macro-confirm').hidden === false || page.$('.macro-io').hidden === false, 300);
}
// 打開匯入框、貼上、檢查、確認取代，等到這次寫入的流程跑完
async function runImport(page, text = IMPORT_TEXT) {
  if (page.$('.macro-import').hidden) page.$('.mimport').click();
  await paste(page, text);
  assert.equal(page.$('.macro-confirm').hidden, false, 'the confirmation came');
  page.$('.macro-confirm-ok').click();
  await waitFor(() => page.$('.macro-io').hidden === false, 1000);
  await sleep(20);
}
const message = page => page.$('.macro-io-msg');

// ---- 匯出 ----

ui('export copies the game macros and the notes as one JSON text, and says so', async () => {
  const page = await boot();
  try {
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.copied.length === 1));
    const parsed = JSON.parse(page.copied[0]);
    assert.deepEqual([parsed.version, parsed.macros, parsed.notes], [1, MACROS, OLD_NOTES]);
    assert.match(message(page).textContent, /已複製/);
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
    assert.match(message(page).textContent, /無法寫入剪貼簿/);
    assert.ok(message(page).classList.contains('msg-warn'));
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
    assert.deepEqual([parsed.macros, parsed.notes], [game(), OLD_NOTES]);
    assert.match(message(page).textContent, /還沒有存過巨集/);
  } finally {
    page.close();
  }
});

ui('unreadable stored macros still export (as empty slots) with a warning instead of failing', async () => {
  const page = await boot({ macros: 'not json' });
  try {
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.copied.length === 1));
    assert.deepEqual(JSON.parse(page.copied[0]).macros, game());
    assert.match(message(page).textContent, /讀不懂/);
    assert.ok(message(page).classList.contains('msg-warn'));
  } finally {
    page.close();
  }
});

ui('an empty string in the game storage is treated like nothing stored, without a damaged warning', async () => {
  const page = await boot({ macros: '' });
  try {
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.copied.length === 1));
    assert.match(message(page).textContent, /還沒有存過巨集/);
    assert.equal(message(page).classList.contains('msg-warn'), false);
  } finally {
    page.close();
  }
});

ui('when the game tab answers that its storage cannot be read, the export is still made, as empty slots with a warning', async () => {
  const page = await boot();
  try {
    page.tab.readFails = true;
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.copied.length === 1));
    assert.deepEqual(JSON.parse(page.copied[0]).macros, game());
    assert.match(message(page).textContent, /讀不懂/);
    assert.ok(message(page).classList.contains('msg-warn'));
  } finally {
    page.close();
  }
});

ui('when the game tab cannot be reached the export fails with an error and nothing is copied', async () => {
  const page = await boot();
  try {
    page.tab.unreachable = true;
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.$('.macro-io').hidden === false));
    assert.match(message(page).textContent, /匯出失敗：連不上遊戲分頁/);
    assert.ok(message(page).classList.contains('msg-error'));
    await sleep(20);
    assert.deepEqual(page.copied, [], 'an empty export would look like a real backup');
    assert.equal(page.$('.macro-io-text').hidden, true, 'and there is nothing to copy by hand either');
  } finally {
    page.close();
  }
});

ui('notes that cannot be read only leave the notes out of the export, the macros still come out', async () => {
  const page = await boot();
  try {
    page.storage.failGet.add('macroNotes');
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.copied.length === 1));
    const parsed = JSON.parse(page.copied[0]);
    assert.deepEqual([parsed.macros, parsed.notes], [MACROS, {}]);
  } finally {
    page.close();
  }
});

ui('the manual copy box has no timer: it stays until the next export', async () => {
  const page = await boot({ clipboard: 'fail' });
  try {
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.$('.macro-io-text').hidden === false));
    await sleep(50);
    assert.equal(page.$('.macro-io').hidden, false);
    assert.equal(page.$('.macro-io-text').hidden, false);
  } finally {
    page.close();
  }
});

// ---- 匯入 ----

ui('the import box opens and closes with the import button', async () => {
  const page = await boot();
  try {
    assert.equal(page.$('.macro-import').hidden, true);
    page.$('.mimport').click();
    assert.equal(page.$('.macro-import').hidden, false);
    page.$('.mimport').click();
    assert.equal(page.$('.macro-import').hidden, true);
  } finally {
    page.close();
  }
});

ui('a good text asks for confirmation first: how many rows get replaced and the warnings, and nothing is written yet', async () => {
  const page = await boot();
  try {
    page.$('.mimport').click();
    await paste(page, IMPORT_TEXT);
    assert.equal(page.$('.macro-confirm').hidden, false);
    const text = page.$('.macro-confirm-msg').textContent;
    assert.match(text, /將取代 2 列/, 'the game has two macros now');
    assert.match(text, /重新整理遊戲頁/);
    assert.match(text, /403/);
    assert.match(text, /蓋掉/);
    assert.match(text, /每個分頁/);
    assert.deepEqual(page.tab.writes, [], 'the game macros are untouched');
    assert.deepEqual(plain(page.store.macroNotes), OLD_NOTES, 'the notes are untouched');
    assert.equal(page.store.macroBackup, undefined, 'and no backup yet');
  } finally {
    page.close();
  }
});

ui('confirming replaces the whole list and the notes (written as the macro-io writer), and says to refresh the game', async () => {
  const page = await boot();
  try {
    await runImport(page);
    assert.match(message(page).textContent, /已匯入/);
    assert.match(message(page).textContent, /重新整理遊戲頁/);
    assert.deepEqual(JSON.parse(page.tab.raw), NEW_MACROS);
    assert.deepEqual(plain(page.store.macroNotes), { 2: '新備註', 3: '另一條' }, 'the old notes are gone, not merged');
    assert.equal(page.store.macroNotesWriter, 'macro-io', 'the note boxes in the game take it as someone else\'s change');
    assert.equal(page.$('.macro-confirm').hidden, true);
    assert.equal(page.$('.macro-import').hidden, true);
    assert.equal(page.$('.macro-import-text').value, '', 'the pasted text is cleared');
  } finally {
    page.close();
  }
});

ui('a bad text is refused with the reason, nothing is written and there is nothing to confirm', async () => {
  const page = await boot();
  try {
    page.$('.mimport').click();
    for (const bad of ['not json', JSON.stringify({ version: 1, macros: game({ 0: ['112', 'a'], 1: ['112', 'b'] }) })]) {
      await paste(page, bad);
      assert.equal(page.$('.macro-confirm').hidden, true);
      assert.match(message(page).textContent, /匯入失敗，沒有改動任何資料/);
      assert.ok(message(page).classList.contains('msg-error'));
    }
    assert.match(message(page).textContent, /重複/, 'the reason of the last one is shown');
    assert.deepEqual(page.tab.writes, []);
    assert.deepEqual(plain(page.store.macroNotes), OLD_NOTES);
  } finally {
    page.close();
  }
});

ui('cancelling writes nothing, and changing the pasted text drops a confirmation that was already asked', async () => {
  const page = await boot();
  try {
    page.$('.mimport').click();
    await paste(page, IMPORT_TEXT);
    page.$('.macro-confirm-cancel').click();
    assert.equal(page.$('.macro-confirm').hidden, true);
    await paste(page, IMPORT_TEXT);
    assert.equal(page.$('.macro-confirm').hidden, false);
    const area = page.$('.macro-import-text');
    area.value = IMPORT_TEXT + ' ';
    area.dispatchEvent(new page.w.Event('input', { bubbles: true }));
    assert.equal(page.$('.macro-confirm').hidden, true, 'the old confirmation would apply text that is no longer in the box');
    page.$('.macro-confirm-ok').click();
    await sleep(30);
    assert.deepEqual(page.tab.writes, [], 'a stale confirm button does nothing');
    page.$('.macro-import-cancel').click();
    assert.equal(page.$('.macro-import').hidden, true);
  } finally {
    page.close();
  }
});

ui('closing the import box drops a confirmation that was waiting', async () => {
  const page = await boot();
  try {
    page.$('.mimport').click();
    await paste(page, IMPORT_TEXT);
    assert.equal(page.$('.macro-confirm').hidden, false);
    page.$('.mimport').click();
    assert.equal(page.$('.macro-confirm').hidden, true);
    page.$('.macro-confirm-ok').click();
    await sleep(30);
    assert.deepEqual(page.tab.writes, [], 'a confirm button that is no longer on screen does nothing');
  } finally {
    page.close();
  }
});

ui('a confirmation is not shown when the pasted text changes while the game tab is still counting the rows', async () => {
  const page = await boot();
  try {
    let release;
    page.tab.readHold = new Promise(resolve => { release = resolve; });
    page.$('.mimport').click();
    const area = page.$('.macro-import-text');
    area.value = IMPORT_TEXT;
    area.dispatchEvent(new page.w.Event('input', { bubbles: true }));
    page.$('.macro-import-check').click();
    await sleep(20);
    assert.equal(page.$('.macro-confirm').hidden, true, 'still waiting for the row count');
    area.value = 'something else';
    area.dispatchEvent(new page.w.Event('input', { bubbles: true }));
    release();
    page.tab.readHold = null;
    await sleep(40);
    assert.equal(page.$('.macro-confirm').hidden, true, 'the answer for the old text does not bring the confirmation back');
    page.$('.macro-confirm-ok').click();
    await sleep(30);
    assert.deepEqual(page.tab.writes, [], 'and nothing can be confirmed');
  } finally {
    page.close();
  }
});

ui('what the export gives can be imported back and leaves the game macros and the notes the same', async () => {
  const page = await boot();
  try {
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.copied.length === 1));
    const macrosBefore = page.tab.raw;
    await runImport(page, page.copied[0]);
    assert.match(message(page).textContent, /已匯入/);
    assert.deepEqual(JSON.parse(page.tab.raw), JSON.parse(macrosBefore));
    assert.deepEqual(plain(page.store.macroNotes), OLD_NOTES);
  } finally {
    page.close();
  }
});

ui('when the game tab refuses the write, nothing changes and the page says so', async () => {
  const page = await boot();
  try {
    page.tab.writeFails = true;
    await runImport(page);
    assert.match(message(page).textContent, /匯入失敗.*沒有改動/);
    assert.ok(message(page).classList.contains('msg-error'));
    assert.deepEqual(plain(page.store.macroNotes), OLD_NOTES, 'the notes were not touched either');
    assert.equal(page.storage.sets.some(values => 'macroNotes' in values), false);
  } finally {
    page.close();
  }
});

ui('a text that passes the check clears the earlier failure message, so an old error is not shown next to the confirmation', async () => {
  const page = await boot();
  try {
    page.$('.mimport').click();
    await paste(page, 'not json');
    assert.equal(page.$('.macro-io').hidden, false);
    assert.match(message(page).textContent, /匯入失敗/);
    await paste(page, IMPORT_TEXT);
    assert.equal(page.$('.macro-confirm').hidden, false);
    assert.equal(page.$('.macro-io').hidden, true, 'the old error message is gone');
  } finally {
    page.close();
  }
});

ui('when the current game macros cannot be read the confirmation still comes, counting 0 rows to replace', async () => {
  const page = await boot();
  try {
    page.tab.readFails = true;
    page.$('.mimport').click();
    await paste(page, IMPORT_TEXT);
    assert.equal(page.$('.macro-confirm').hidden, false);
    assert.match(page.$('.macro-confirm-msg').textContent, /將取代 0 列/);
  } finally {
    page.close();
  }
});

ui('pressing the confirm button twice writes once', async () => {
  const page = await boot();
  try {
    page.$('.mimport').click();
    await paste(page, IMPORT_TEXT);
    page.$('.macro-confirm-ok').click();
    page.$('.macro-confirm-ok').click();
    await sleep(60);
    assert.equal(page.tab.writes.length, 1);
  } finally {
    page.close();
  }
});

// ---- 匯入前的備份與還原上一份 ----

ui('there is nothing to restore before the first import: the restore button is off', async () => {
  const page = await boot();
  try {
    await sleep(30);
    assert.ok(page.$('.macro-restore'), 'there is a restore button');
    assert.equal(page.$('.macro-restore').disabled, true);
  } finally {
    page.close();
  }
});

ui('an import first keeps what the game had (the exact text) and the notes, and then the restore button is on', async () => {
  const page = await boot();
  try {
    const before = page.tab.raw;
    const before0 = Date.now();
    await runImport(page);
    const backup = plain(page.store.macroBackup);
    assert.equal(backup.raw, before, 'the exact text of the game');
    assert.deepEqual(backup.notes, OLD_NOTES);
    assert.ok(backup.at >= before0 && backup.at <= Date.now());
    assert.ok(await waitFor(() => page.$('.macro-restore').disabled === false));
  } finally {
    page.close();
  }
});

ui('only one backup is kept: the next import replaces it with what the game had just before that import', async () => {
  const page = await boot();
  try {
    await runImport(page);
    const afterFirst = page.tab.raw;
    await runImport(page, JSON.stringify({ version: 1, macros: game({ 7: ['115', 'second'] }), notes: {} }));
    assert.ok(await waitFor(() => page.tab.writes.length === 2));
    assert.equal(page.store.macroBackup.raw, afterFirst);
    assert.deepEqual(plain(page.store.macroBackup.notes), { 2: '新備註', 3: '另一條' });
  } finally {
    page.close();
  }
});

ui('the backup is never part of the export', async () => {
  const page = await boot();
  try {
    await runImport(page);
    page.$('.mexport').click();
    assert.ok(await waitFor(() => page.copied.length === 1));
    assert.equal(page.copied[0].includes('macroBackup'), false);
    assert.deepEqual(Object.keys(JSON.parse(page.copied[0])), ['version', 'macros', 'notes']);
  } finally {
    page.close();
  }
});

ui('if the backup cannot be written the import does not happen and nothing is touched', async () => {
  const page = await boot();
  try {
    page.storage.failSet.add('macroBackup');
    await runImport(page);
    assert.deepEqual(page.tab.writes, [], 'the macros were not written');
    assert.deepEqual(plain(page.store.macroNotes), OLD_NOTES, 'nor the notes');
    assert.match(message(page).textContent, /匯入失敗.*備份/);
    assert.ok(message(page).classList.contains('msg-error'));
  } finally {
    page.close();
  }
});

ui('restoring asks first, then puts the backed up macros and notes back, keeps the backup and says to refresh', async () => {
  const page = await boot();
  try {
    const original = page.tab.raw;
    await runImport(page);
    assert.notEqual(page.tab.raw, original);
    assert.ok(await waitFor(() => page.$('.macro-restore').disabled === false));
    page.$('.mimport').click();
    page.$('.macro-restore').click();
    assert.ok(await waitFor(() => page.$('.macro-confirm').hidden === false));
    const text = page.$('.macro-confirm-msg').textContent;
    assert.match(text, /備份/);
    assert.match(text, /取代目前 2 列/, 'the import left 2 macros');
    assert.match(text, /重新整理遊戲頁/);
    assert.doesNotMatch(text, /讀不懂/, 'a backup the game can read comes with no such warning');
    assert.equal(page.tab.writes.length, 1, 'nothing is written before the confirmation');
    page.$('.macro-confirm-ok').click();
    assert.ok(await waitFor(() => /已還原/.test(message(page).textContent)));
    assert.equal(page.tab.raw, original, 'the exact text came back');
    assert.deepEqual(plain(page.store.macroNotes), OLD_NOTES);
    assert.match(message(page).textContent, /重新整理遊戲頁/);
    assert.equal(page.store.macroBackup.raw, original, 'the backup is still there');
    assert.equal(page.$('.macro-restore').disabled, false);
  } finally {
    page.close();
  }
});

ui('cancelling a restore writes nothing, and the same backup can be restored again later', async () => {
  const page = await boot();
  try {
    const original = page.tab.raw;
    await runImport(page);
    const imported = page.tab.raw;
    assert.ok(await waitFor(() => page.$('.macro-restore').disabled === false));
    page.$('.mimport').click();
    page.$('.macro-restore').click();
    assert.ok(await waitFor(() => page.$('.macro-confirm').hidden === false));
    page.$('.macro-confirm-cancel').click();
    await sleep(20);
    assert.equal(page.tab.raw, imported);
    page.$('.macro-restore').click();
    assert.ok(await waitFor(() => page.$('.macro-confirm').hidden === false));
    page.$('.macro-confirm-ok').click();
    assert.ok(await waitFor(() => page.tab.raw === original));
  } finally {
    page.close();
  }
});

ui('a backup that is broken is refused with the reason and the current macros stay as they are', async () => {
  const page = await boot({ backup: { raw: 5 } });
  try {
    assert.ok(await waitFor(() => page.$('.macro-restore').disabled === false), 'something is stored, so the button asks about it');
    page.$('.mimport').click();
    page.$('.macro-restore').click();
    assert.ok(await waitFor(() => /還原失敗/.test(message(page).textContent)));
    assert.match(message(page).textContent, /備份/);
    assert.ok(message(page).classList.contains('msg-error'));
    assert.equal(page.$('.macro-confirm').hidden, true);
    assert.deepEqual(page.tab.writes, []);
  } finally {
    page.close();
  }
});

ui('when the backup cannot be read at all the restore says so and changes nothing', async () => {
  const page = await boot({ backup: OLD_BACKUP });
  try {
    assert.ok(await waitFor(() => page.$('.macro-restore').disabled === false));
    page.storage.failGet.add('macroBackup');
    page.$('.mimport').click();
    page.$('.macro-restore').click();
    assert.ok(await waitFor(() => page.$('.macro-io').hidden === false));
    assert.match(message(page).textContent, /還原失敗.*沒有改動任何資料.*讀不到備份.*storage gone/);
    assert.equal(page.$('.macro-confirm').hidden, true);
    assert.deepEqual(page.tab.writes, []);
  } finally {
    page.close();
  }
});

ui('a backup whose text the game cannot read is restored only after a warning, and as it is', async () => {
  const page = await boot({ backup: { raw: 'not json at all', notes: {}, at: 7 } });
  try {
    assert.ok(await waitFor(() => page.$('.macro-restore').disabled === false));
    page.$('.mimport').click();
    page.$('.macro-restore').click();
    assert.ok(await waitFor(() => page.$('.macro-confirm').hidden === false));
    assert.match(page.$('.macro-confirm-msg').textContent, /讀不懂.*載入失敗/, 'the warning says the game may fail to load');
    page.$('.macro-confirm-ok').click();
    assert.ok(await waitFor(() => page.tab.writes.length === 1));
    assert.deepEqual(page.tab.writes, ['not json at all'], 'the user decides, and the text goes back exactly');
  } finally {
    page.close();
  }
});

// ---- 備份與還原的失敗路徑 ----

ui('when the game tab refuses the import after the backup was written, the earlier backup is put back', async () => {
  const page = await boot({ backup: OLD_BACKUP });
  try {
    page.tab.writeFails = true;
    await runImport(page);
    assert.equal(page.backupSets().length, 2, 'the new backup, then the earlier one again');
    assert.deepEqual(plain(page.store.macroBackup), OLD_BACKUP, 'the backup people could go back to is the same as before');
    assert.match(message(page).textContent, /匯入失敗.*沒有改動/);
  } finally {
    page.close();
  }
});

ui('when the game tab cannot be reached for the write, it is a definite failure and the earlier backup is put back', async () => {
  const page = await boot({ backup: OLD_BACKUP });
  try {
    page.tab.writeUnreachable = true;
    await runImport(page);
    assert.match(message(page).textContent, /匯入失敗.*沒有改動.*No tab/);
    assert.ok(message(page).classList.contains('msg-error'));
    assert.doesNotMatch(message(page).textContent, /不確定/);
    assert.equal(page.backupSets().length, 2, 'the new backup, then the earlier one again');
    assert.deepEqual(plain(page.store.macroBackup), OLD_BACKUP);
    assert.deepEqual(page.tab.writes, []);
  } finally {
    page.close();
  }
});

ui('when the reply of the write is lost, the import counts as maybe written: the new backup stays and a warning says so', async () => {
  const page = await boot({ backup: OLD_BACKUP });
  try {
    const before = page.tab.raw;
    page.tab.lostReply = true;
    await runImport(page);
    assert.match(message(page).textContent, /不確定遊戲的巨集有沒有寫進去/);
    assert.ok(message(page).classList.contains('msg-warn'));
    assert.equal(page.backupSets().length, 1, 'the earlier backup is not put back');
    assert.equal(page.store.macroBackup.raw, before, 'the new backup is the way back');
    assert.deepEqual(plain(page.store.macroBackup.notes), OLD_NOTES);
    assert.ok(await waitFor(() => page.$('.macro-restore').disabled === false));
  } finally {
    page.close();
  }
});

ui('when only the notes cannot be written the import counts as done, so the new backup stays', async () => {
  const page = await boot({ backup: OLD_BACKUP });
  try {
    const before = page.tab.raw;
    page.storage.failSet.add('macroNotes');
    await runImport(page);
    assert.equal(page.backupSets().length, 1, 'no step back: the macros were replaced and the backup is how to undo that');
    assert.equal(page.store.macroBackup.raw, before);
    assert.equal(page.tab.writes.length, 1);
    assert.match(message(page).textContent, /巨集已寫入，但備註沒有寫進去/);
    assert.ok(message(page).classList.contains('msg-warn'));
  } finally {
    page.close();
  }
});

ui('a failed import does not write an old backup that never existed', async () => {
  const page = await boot();
  try {
    page.tab.writeFails = true;
    await runImport(page);
    assert.equal(page.backupSets().length, 1, 'only the backup of the current macros, nothing put back');
  } finally {
    page.close();
  }
});

ui('without the current notes there is no complete backup, so the import does not happen', async () => {
  const page = await boot({ backup: OLD_BACKUP });
  try {
    page.$('.mimport').click();
    await paste(page, IMPORT_TEXT);
    page.storage.failGet.add('macroNotes');
    page.$('.macro-confirm-ok').click();
    assert.ok(await waitFor(() => page.$('.macro-io').hidden === false));
    await sleep(20);
    assert.deepEqual([page.backupSets().length, page.tab.writes.length], [0, 0]);
    assert.match(message(page).textContent, /匯入失敗.*沒有改動.*備註.*備份/);
    assert.ok(message(page).classList.contains('msg-error'));
  } finally {
    page.close();
  }
});

ui('without being able to read the current game macros there is no backup, so the import does not happen', async () => {
  const page = await boot({ backup: OLD_BACKUP });
  try {
    page.tab.readFails = true;
    await runImport(page);
    assert.deepEqual([page.backupSets().length, page.tab.writes.length], [0, 0]);
    assert.deepEqual(plain(page.store.macroNotes), OLD_NOTES);
    assert.match(message(page).textContent, /匯入失敗.*沒有改動.*讀不到.*備份/);
  } finally {
    page.close();
  }
});

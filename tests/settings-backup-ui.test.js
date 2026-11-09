// 設定頁「設定備份」匯出：jsdom 載入真正的 popup.html 與 popup.js（Chrome API、剪貼簿、下載用假的）。需要 jsdom；沒裝就跳過。
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
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
};

async function boot(store = {}, { clipboardFails = false, readFails = false } = {}) {
  const listeners = [];
  const flags = { writeFails: false }; // 設定頁載入時自己也會寫儲存，所以寫入失敗要在載入完成後才打開
  const copied = [];
  const downloads = [];
  const dom = await JSDOM.fromFile(path.join(root, 'popup.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `file://${root.split(path.sep).join('/')}/popup.html`,
    beforeParse(window) {
      Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: async text => { if (clipboardFails) throw new Error('denied'); copied.push(text); } },
      });
      window.URL.createObjectURL = blob => { downloads.push({ blob }); return 'blob:fake'; };
      window.URL.revokeObjectURL = () => {};
      window.chrome = {
        runtime: { getManifest: () => ({ version: '9.9.9' }), getURL: file => file, onMessage: { addListener() {} }, sendMessage: async () => ({}) },
        storage: {
          local: {
            get: async keys => {
              if (readFails && Array.isArray(keys) && keys.includes('mapMonsters')) throw new Error('quota');
              return Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, JSON.parse(JSON.stringify(store[key]))]));
            },
            set: async values => { if (flags.writeFails) throw new Error('disk full'); Object.assign(store, JSON.parse(JSON.stringify(values))); },
            remove: async keys => { if (flags.writeFails) throw new Error('disk full'); [].concat(keys).forEach(key => { delete store[key]; }); },
          },
          sync: { get: async () => ({}), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener: listener => listeners.push(listener) },
        },
        tabs: { query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => { throw new Error('no tab'); }, create: async () => {}, update: async () => {} },
        permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  assert.ok(await waitFor(() => listeners.length > 0), 'the settings page loaded');
  // 下載用 <a download> 點一下：記下檔名並擋掉 jsdom 的導覽
  doc.addEventListener('click', event => {
    const link = event.target.closest?.('a[download]');
    if (link) { downloads.at(-1).name = link.getAttribute('download'); event.preventDefault(); }
  }, true);
  const click = id => doc.getElementById(id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const check = (id, value) => {
    const input = doc.getElementById(id);
    input.checked = value;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  return { dom, doc, copied, downloads, flags, click, check, text: id => doc.getElementById(id).textContent };
}

const STORE = {
  settings: { fixedItems: [{ command: 'ps', minSeconds: 5, maxSeconds: 9 }] },
  triggerGroupSettings: { combat: { rules: [] } },
  mapMonsters: { 'a/1': { mobs: ['x(1)'] } },
  lineNotify: { enabled: true, token: 'SECRET-TOKEN', userId: 'U123' },
  captchaSampleUrl: 'https://script.google.com/macros/s/abc/exec',
  running: true,
};

ui('the backup section lists every block, all ticked, and the secrets box is off', async () => {
  const page = await boot(STORE);
  try {
    const boxes = [...page.doc.querySelectorAll('#backupBlocks input[type="checkbox"]')];
    assert.equal(boxes.length, 8);
    assert.ok(boxes.every(box => box.checked));
    assert.equal(page.doc.getElementById('backupSecrets').checked, false);
    assert.equal(page.doc.getElementById('backupSecretWarn').hidden, true);
    assert.ok(page.doc.getElementById('sec-backup').classList.contains('fold'), 'the section is a remembered fold');
  } finally {
    page.dom.window.close();
  }
});

ui('copy puts the export on the clipboard: every block, no secrets, running state left out', async () => {
  const page = await boot(STORE);
  try {
    page.click('backupCopy');
    assert.ok(await waitFor(() => page.copied.length === 1));
    const data = JSON.parse(page.copied[0]);
    assert.equal(data.format, 'catworld-settings');
    assert.equal(data.exportedWith, '9.9.9');
    assert.deepEqual(data.blocks.timer.settings, STORE.settings);
    assert.deepEqual(data.blocks.data.mapMonsters, STORE.mapMonsters);
    assert.equal(data.secrets, undefined);
    assert.ok(!page.copied[0].includes('SECRET-TOKEN'));
    assert.ok(!page.copied[0].includes('"running"'));
    assert.match(page.text('backupMsg'), /已複製 8 個區塊/);
    assert.ok(!page.doc.getElementById('backupMsg').classList.contains('msg-error'));
  } finally {
    page.dom.window.close();
  }
});

ui('only the ticked blocks are exported', async () => {
  const page = await boot(STORE);
  try {
    for (const box of page.doc.querySelectorAll('#backupBlocks input')) page.check(box.id, box.id === 'backupBlock-trigger');
    page.click('backupCopy');
    assert.ok(await waitFor(() => page.copied.length === 1));
    assert.deepEqual(Object.keys(JSON.parse(page.copied[0]).blocks), ['trigger']);
    assert.match(page.text('backupMsg'), /已複製 1 個區塊/);
  } finally {
    page.dom.window.close();
  }
});

ui('ticking the secrets box shows the warning, adds the secrets and marks the message as a warning', async () => {
  const page = await boot(STORE);
  try {
    page.check('backupSecrets', true);
    assert.equal(page.doc.getElementById('backupSecretWarn').hidden, false);
    assert.match(page.text('backupSecretWarn'), /不要傳給別人/);
    page.click('backupCopy');
    assert.ok(await waitFor(() => page.copied.length === 1));
    const data = JSON.parse(page.copied[0]);
    assert.equal(data.secrets.lineNotify.token, 'SECRET-TOKEN');
    assert.equal(data.secrets.captchaSampleUrl, STORE.captchaSampleUrl);
    assert.match(page.text('backupMsg'), /含機密/);
    assert.ok(page.doc.getElementById('backupMsg').classList.contains('msg-warn'));
    page.check('backupSecrets', false);
    assert.equal(page.doc.getElementById('backupSecretWarn').hidden, true);
  } finally {
    page.dom.window.close();
  }
});

ui('nothing ticked gives a warning and copies nothing', async () => {
  const page = await boot(STORE);
  try {
    for (const box of page.doc.querySelectorAll('#backupBlocks input')) page.check(box.id, false);
    page.click('backupCopy');
    assert.ok(await waitFor(() => /至少勾選/.test(page.text('backupMsg'))));
    assert.ok(page.doc.getElementById('backupMsg').classList.contains('msg-warn'));
    assert.equal(page.copied.length, 0);
  } finally {
    page.dom.window.close();
  }
});

ui('a failed copy puts the text in a box to copy by hand and says why in red', async () => {
  const page = await boot(STORE, { clipboardFails: true });
  try {
    page.click('backupCopy');
    assert.ok(await waitFor(() => !page.doc.getElementById('backupFallback').hidden));
    assert.equal(JSON.parse(page.doc.getElementById('backupFallback').value).format, 'catworld-settings');
    assert.match(page.text('backupMsg'), /複製失敗：denied/);
    assert.ok(page.doc.getElementById('backupMsg').classList.contains('msg-error'));
  } finally {
    page.dom.window.close();
  }
});

ui('download hands the same JSON to a file named by date', async () => {
  const page = await boot(STORE);
  try {
    page.click('backupDownload');
    assert.ok(await waitFor(() => page.downloads.length === 1 && page.downloads[0].name));
    assert.match(page.downloads[0].name, /^catworld-settings-\d{4}-\d{2}-\d{2}\.json$/);
    const text = await new Promise(resolve => {
      const reader = new page.dom.window.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(page.downloads[0].blob);
    });
    assert.equal(Object.keys(JSON.parse(text).blocks).length, 8);
    assert.match(page.text('backupMsg'), /已下載 8 個區塊/);
  } finally {
    page.dom.window.close();
  }
});

ui('a storage read failure is shown in red and nothing is copied', async () => {
  const page = await boot(STORE, { readFails: true });
  try {
    page.click('backupCopy');
    assert.ok(await waitFor(() => /讀取設定失敗：quota/.test(page.text('backupMsg'))));
    assert.ok(page.doc.getElementById('backupMsg').classList.contains('msg-error'));
    assert.equal(page.copied.length, 0);
  } finally {
    page.dom.window.close();
  }
});

ui('unticking the secrets box clears a hand-copy box that holds secrets, and the warning names the sample URL', async () => {
  const page = await boot(STORE, { clipboardFails: true });
  try {
    page.check('backupSecrets', true);
    assert.match(page.text('backupSecretWarn'), /樣本收集網址/);
    page.click('backupCopy');
    assert.ok(await waitFor(() => !page.doc.getElementById('backupFallback').hidden));
    assert.ok(page.doc.getElementById('backupFallback').value.includes('SECRET-TOKEN'));
    page.check('backupSecrets', false);
    assert.equal(page.doc.getElementById('backupFallback').hidden, true);
    assert.equal(page.doc.getElementById('backupFallback').value, '');
  } finally {
    page.dom.window.close();
  }
});

// ---- 匯入 ----
const backupFile = (blocks, extra = {}) => JSON.stringify({ format: 'catworld-settings', version: 1, exportedWith: '1.0.0', exportedAt: '2026-11-10T00:00:00.000Z', blocks, ...extra });
const paste = (page, text) => {
  const box = page.doc.getElementById('backupImportText');
  box.value = text;
  box.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
};
const userKeys = store => Object.fromEntries(Object.entries(store).filter(([key]) => key !== 'popupTab')); // 設定頁載入時自己會存 popupTab
const planShown = page => !page.doc.getElementById('backupImportPlan').hidden;
const level = (page, id) => page.doc.getElementById(id).classList.contains('msg-error') ? 'error' : page.doc.getElementById(id).classList.contains('msg-warn') ? 'warn' : 'info';

ui('a valid file shows which blocks it will overwrite, ticked, and writes nothing yet', async () => {
  const store = { settings: { old: 1 } };
  const page = await boot(store);
  try {
    paste(page, backupFile({ timer: { settings: { fresh: 1 } }, chat: { chatReply: { enabled: true } } }));
    assert.ok(await waitFor(() => planShown(page)));
    const boxes = [...page.doc.querySelectorAll('#backupImportBlocks input')];
    assert.deepEqual(boxes.map(box => box.id), ['backupImportBlock-timer', 'backupImportBlock-chat']);
    assert.ok(boxes.every(box => box.checked));
    assert.match(page.text('backupImportBlocks'), /定時與隨機/);
    assert.equal(page.doc.getElementById('backupImportSecretsRow').hidden, true);
    assert.deepEqual(userKeys(store), { settings: { old: 1 } }, 'nothing is written before the confirmation');
  } finally {
    page.dom.window.close();
  }
});

ui('a bad file is refused whole, in red, with the reason, and nothing is offered', async () => {
  const store = { settings: { old: 1 } };
  const page = await boot(store);
  try {
    paste(page, '{"format":"nope"}');
    assert.ok(await waitFor(() => /不是設定備份/.test(page.text('backupImportMsg'))));
    assert.equal(level(page, 'backupImportMsg'), 'error');
    assert.equal(planShown(page), false);
    paste(page, backupFile({ timer: [] }));
    assert.ok(await waitFor(() => /定時與隨機/.test(page.text('backupImportMsg'))));
    assert.equal(planShown(page), false);
    assert.deepEqual(userKeys(store), { settings: { old: 1 } });
  } finally {
    page.dom.window.close();
  }
});

ui('confirming replaces the ticked blocks, removes their leftovers, leaves other blocks alone and tells to refresh', async () => {
  const store = { settings: { old: 1 }, idleSettings: { old: 1 }, triggerGroupSettings: { keep: 1 }, chatReply: { old: 1 }, running: true };
  const page = await boot(store);
  try {
    paste(page, backupFile({ timer: { settings: { fresh: 1 } }, chat: { chatReply: { fresh: 1 } } }));
    assert.ok(await waitFor(() => planShown(page)));
    page.check('backupImportBlock-chat', false);
    page.click('backupImportApply');
    assert.ok(await waitFor(() => store.settings?.fresh === 1));
    assert.ok(!('idleSettings' in store), 'a key of the block that the file does not have is removed');
    assert.deepEqual(store.chatReply, { old: 1 }, 'an unticked block is left alone');
    assert.deepEqual(store.triggerGroupSettings, { keep: 1 }, 'a block not in the file is left alone');
    assert.equal(store.running, true);
    assert.ok(await waitFor(() => /重新整理遊戲分頁/.test(page.text('backupImportMsg'))));
    assert.match(page.text('backupImportMsg'), /已匯入 1 個區塊/);
    assert.equal(level(page, 'backupImportMsg'), 'info');
    assert.equal(planShown(page), false);
    assert.equal(page.doc.getElementById('backupImportText').value, '');
  } finally {
    page.dom.window.close();
  }
});

ui('editing the text drops a pending check, and cancel clears everything', async () => {
  const store = { settings: { old: 1 } };
  const page = await boot(store);
  try {
    paste(page, backupFile({ timer: { settings: { fresh: 1 } } }));
    assert.ok(await waitFor(() => planShown(page)));
    paste(page, 'oops');
    assert.equal(planShown(page), false, 'the old result must not be confirmable against new text');
    paste(page, backupFile({ timer: { settings: { fresh: 1 } } }));
    assert.ok(await waitFor(() => planShown(page)));
    page.click('backupImportCancel');
    assert.equal(planShown(page), false);
    assert.equal(page.doc.getElementById('backupImportText').value, '');
    assert.deepEqual(userKeys(store), { settings: { old: 1 } });
  } finally {
    page.dom.window.close();
  }
});

ui('secrets in the file are offered but left unticked; only a ticked box replaces them', async () => {
  const store = { lineNotify: { token: 'old' }, captchaSampleUrl: 'https://old.test', settings: {} };
  const page = await boot(store);
  try {
    const text = backupFile({ timer: { settings: { fresh: 1 } } }, { secrets: { lineNotify: { token: 'new' } } });
    paste(page, text);
    assert.ok(await waitFor(() => planShown(page)));
    assert.equal(page.doc.getElementById('backupImportSecretsRow').hidden, false);
    assert.equal(page.doc.getElementById('backupImportSecrets').checked, false);
    page.click('backupImportApply');
    assert.ok(await waitFor(() => store.settings.fresh === 1));
    assert.deepEqual(store.lineNotify, { token: 'old' }, 'secrets untouched without the tick');
    paste(page, text);
    assert.ok(await waitFor(() => planShown(page)));
    page.check('backupImportSecrets', true);
    page.click('backupImportApply');
    assert.ok(await waitFor(() => store.lineNotify?.token === 'new'));
    assert.ok(!('captchaSampleUrl' in store), 'the secrets section replaces both secret keys');
  } finally {
    page.dom.window.close();
  }
});

ui('picking a file loads its text into the box and runs the same check', async () => {
  const page = await boot({});
  try {
    const input = page.doc.getElementById('backupImportFile');
    const file = new page.dom.window.File([backupFile({ timer: { settings: { a: 1 } } })], 'backup.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.ok(await waitFor(() => planShown(page)));
    assert.match(page.doc.getElementById('backupImportText').value, /catworld-settings/);
  } finally {
    page.dom.window.close();
  }
});

ui('nothing ticked is a warning, and a failed write is shown in red and keeps the plan', async () => {
  const store = { settings: { old: 1 } };
  const page = await boot(store);
  try {
    page.flags.writeFails = true;
    paste(page, backupFile({ timer: { settings: { fresh: 1 } } }));
    assert.ok(await waitFor(() => planShown(page)));
    page.check('backupImportBlock-timer', false);
    page.click('backupImportApply');
    assert.ok(await waitFor(() => /至少勾選/.test(page.text('backupImportMsg'))));
    assert.equal(level(page, 'backupImportMsg'), 'warn');
    page.check('backupImportBlock-timer', true);
    page.click('backupImportApply');
    assert.ok(await waitFor(() => /匯入失敗：disk full/.test(page.text('backupImportMsg'))));
    assert.equal(level(page, 'backupImportMsg'), 'error');
    assert.equal(planShown(page), true, 'the plan stays so it can be retried');
  } finally {
    page.dom.window.close();
  }
});

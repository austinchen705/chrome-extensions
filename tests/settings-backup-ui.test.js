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
            set: async values => { Object.assign(store, JSON.parse(JSON.stringify(values))); },
            remove: async key => { delete store[key]; },
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
  return { dom, doc, copied, downloads, click, check, text: id => doc.getElementById(id).textContent };
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

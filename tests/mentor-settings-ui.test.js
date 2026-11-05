// 設定頁「拜師導師路線」區塊：jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的），
// 檢查筆數、複製、匯入（整份檢查）、清除。需要 jsdom；沒裝就跳過。
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

async function boot(store = {}) {
  const listeners = [];
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
  assert.ok(await waitFor(() => listeners.length > 0), 'the settings page loaded the mentor section');
  const change = (id, value) => {
    const input = doc.getElementById(id);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  return { dom, doc, store, change, listeners };
}

const click = (page, id) => page.doc.getElementById(id).dispatchEvent(new page.dom.window.Event('click', { bubbles: true }));
const info = page => page.doc.getElementById('mentorInfo').textContent;
const msg = page => page.doc.getElementById('mentorMsg');
const importText = (page, text) => {
  page.doc.getElementById('mentorImportText').value = text;
  click(page, 'mentorImportApply');
};

ui('the section is a fold, and the count follows the stored edits', async () => {
  const page = await boot({ mentorRoutes: { '歐陽峰|基礎杖法': 'run e 5n 2o s', '李書文|基礎杖法': 'run e 5n 2o n' } });
  try {
    assert.equal(page.doc.getElementById('sec-mentor').tagName, 'DETAILS');
    assert.ok(await waitFor(() => /2 個功法/.test(info(page))));
    page.store.mentorRoutes = { '歐陽峰|基礎杖法': 'run e 5n 2o s' };
    page.listeners.forEach(listener => listener({ mentorRoutes: {} }, 'local'));
    assert.ok(await waitFor(() => /1 個功法/.test(info(page))), 'a change from another page shows without reopening');
    page.store.mentorRoutes = { bad: 5 };
    page.listeners.forEach(listener => listener({ mentorRoutes: {} }, 'local'));
    assert.ok(await waitFor(() => /還沒有/.test(info(page))), 'broken data counts as nothing');
  } finally {
    page.dom.window.close();
  }
});

ui('copy puts mentor, skill and command on the clipboard with the built-in names, and warns when there is nothing', async () => {
  const page = await boot({ mentorRoutes: { '歐陽峰|基礎杖法': 'run e 5n 2o s', '不存在的人|某功法': 'run e 5n n' } });
  try {
    let copied = null;
    Object.defineProperty(page.dom.window.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } }, configurable: true });
    click(page, 'mentorCopy');
    assert.ok(await waitFor(() => copied !== null));
    assert.equal(copied, '歐陽峰\t基礎杖法\trun e 5n 2o s\n不存在的人\t某功法\trun e 5n n');
    assert.match(msg(page).textContent, /已複製 2 筆/);
  } finally {
    page.dom.window.close();
  }
  const empty = await boot();
  try {
    click(empty, 'mentorCopy');
    assert.ok(await waitFor(() => msg(empty).textContent.includes('還沒有')));
    assert.equal(msg(empty).classList.contains('msg-warn'), true);
  } finally {
    empty.dom.window.close();
  }
});

ui('an import that passes is added to the edits; one bad line stops the whole import and writes nothing', async () => {
  const page = await boot({ mentorRoutes: { '歐陽峰|基礎杖法': 'run e 5n 2o s' } });
  try {
    importText(page, '李書文\t基礎杖法\trun e 5n 2o n\n壞掉沒有tab');
    assert.ok(await waitFor(() => msg(page).textContent.includes('第 2 行')));
    assert.equal(msg(page).classList.contains('msg-error'), true);
    assert.deepEqual(Object.keys(page.store.mentorRoutes), ['歐陽峰|基礎杖法'], 'nothing was written');
    importText(page, '李書文\t基礎杖法\trun e 5n 2o n\n歐陽峰\t基礎杖法\t@等待 abc');
    assert.ok(await waitFor(() => msg(page).textContent.includes('第 2 行')), 'a command the macro cannot read is a line error too');
    assert.equal(Object.keys(page.store.mentorRoutes).length, 1);
    importText(page, ' 李書文 \t基礎杖法\trun e 5n 2o n\n\n歐陽峰\t基礎杖法\trun e 5n 2o w\textra column');
    assert.ok(await waitFor(() => Object.keys(page.store.mentorRoutes).length === 2));
    assert.deepEqual(page.store.mentorRoutes, { '歐陽峰|基礎杖法': 'run e 5n 2o w', '李書文|基礎杖法': 'run e 5n 2o n' }, 'the imported one wins for the same skill');
    assert.match(msg(page).textContent, /已匯入 2 筆/);
    assert.equal(msg(page).classList.contains('msg-error'), false, 'the earlier red is cleared');
    assert.equal(page.doc.getElementById('mentorImportText').value, '');
    importText(page, '');
    assert.ok(await waitFor(() => msg(page).classList.contains('msg-error')));
  } finally {
    page.dom.window.close();
  }
});

ui('an imported skill the built-in data does not have is saved with a warning', async () => {
  const page = await boot();
  try {
    importText(page, '不存在的人\t某功法\trun e 5n n');
    assert.ok(await waitFor(() => page.store.mentorRoutes?.['不存在的人|某功法'] === 'run e 5n n'));
    assert.match(msg(page).textContent, /1 筆不在內建資料裡/);
    assert.equal(msg(page).classList.contains('msg-warn'), true);
  } finally {
    page.dom.window.close();
  }
});

ui('clear removes the edits only after the confirm', async () => {
  const page = await boot({ mentorRoutes: { '歐陽峰|基礎杖法': 'run e 5n 2o s' } });
  try {
    page.dom.window.confirm = () => false;
    click(page, 'mentorClear');
    await sleep(50);
    assert.ok('mentorRoutes' in page.store, 'declining keeps the edits');
    page.dom.window.confirm = () => true;
    click(page, 'mentorClear');
    assert.ok(await waitFor(() => !('mentorRoutes' in page.store)));
    assert.ok(await waitFor(() => /還沒有/.test(info(page))));
  } finally {
    page.dom.window.close();
  }
});

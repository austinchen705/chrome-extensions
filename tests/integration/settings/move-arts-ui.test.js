// 設定頁「悟招圖」：jsdom 載入真正的 popup.html 與 popup.js（Chrome API、下載用假的）。列表、刪除、匯出檔內容、匯入合併與壞檔。
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

const root = path.join(__dirname, '..', '..', '..', 'catworld-auto-command');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
};

const art = (skill, move) => ({ skill, move, lines: [[['圖', 'H1']]], nameCodes: [...move].map(() => 'H5'), at: 7 });
const STORED = { '牛蛇生死搏/對牛彈琴': art('牛蛇生死搏', '對牛彈琴'), '全真劍法/雁行斜擊': art('全真劍法', '雁行斜擊') };
const fileText = arts => JSON.stringify({ format: 'catworld-move-arts', version: 1, arts });

async function boot(store = {}) {
  const downloads = [];
  const dom = await JSDOM.fromFile(path.join(root, 'popup.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `file://${root.split(path.sep).join('/')}/popup.html`,
    beforeParse(window) {
      window.URL.createObjectURL = blob => { downloads.push({ blob }); return 'blob:fake'; };
      window.URL.revokeObjectURL = () => {};
      window.chrome = {
        runtime: { getManifest: () => ({ version: '9.9.9' }), getURL: file => file, onMessage: { addListener() {} }, sendMessage: async () => ({}) },
        storage: {
          local: {
            get: async keys => Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, JSON.parse(JSON.stringify(store[key]))])),
            set: async values => { Object.assign(store, JSON.parse(JSON.stringify(values))); },
            remove: async keys => { [].concat(keys).forEach(key => { delete store[key]; }); },
          },
          sync: { get: async () => ({}), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener() {} },
        },
        tabs: { query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => { throw new Error('no tab'); }, create: async () => {}, update: async () => {} },
        permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  assert.ok(await waitFor(() => doc.getElementById('moveArtCount').textContent !== ''), 'the settings page loaded the section');
  doc.addEventListener('click', event => {
    const link = event.target.closest?.('a[download]');
    if (link) { downloads.at(-1).name = link.getAttribute('download'); event.preventDefault(); }
  }, true);
  const $ = id => doc.getElementById(id);
  const pick = text => {
    const input = $('moveArtFile');
    const file = new dom.window.File([text], 'arts.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  const readBlob = blob => new Promise((resolve, reject) => {
    const reader = new dom.window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(blob);
  });
  return { dom, $, pick, downloads, readBlob, store, close: () => dom.window.close() };
}

ui('the section is a fold with an id, lists the stored moves as skill／move with a count, and shows 0 when there are none', async () => {
  const empty = await boot({});
  try {
    assert.equal(empty.$('sec-movearts').tagName, 'DETAILS');
    assert.equal(empty.$('moveArtCount').textContent, '已存 0 招');
    assert.equal(empty.$('moveArtExport').disabled, true, 'nothing to export');
  } finally { empty.close(); }
  const page = await boot({ moveArts: STORED });
  try {
    assert.equal(page.$('moveArtCount').textContent, '已存 2 招');
    assert.deepEqual([...page.$('moveArtList').children].map(row => row.querySelector('span').textContent), ['牛蛇生死搏／對牛彈琴', '全真劍法／雁行斜擊']);
  } finally { page.close(); }
});

ui('delete removes just that move from the storage and the list', async () => {
  const page = await boot({ moveArts: STORED });
  try {
    page.$('moveArtList').children[0].querySelector('button').click();
    assert.ok(await waitFor(() => page.$('moveArtCount').textContent === '已存 1 招'));
    assert.deepEqual(Object.keys(page.store.moveArts), ['全真劍法/雁行斜擊']);
    assert.equal(page.$('moveArtList').children.length, 1);
  } finally { page.close(); }
});

ui('export downloads catworld-move-arts.json holding every stored move', async () => {
  const page = await boot({ moveArts: STORED });
  try {
    page.$('moveArtExport').click();
    assert.ok(await waitFor(() => page.downloads.length === 1 && page.downloads[0].name));
    assert.equal(page.downloads[0].name, 'catworld-move-arts.json');
    const file = JSON.parse(await page.readBlob(page.downloads[0].blob));
    assert.equal(file.format, 'catworld-move-arts');
    assert.equal(file.exportedWith, '9.9.9');
    assert.deepEqual(file.arts, STORED);
    assert.match(page.$('moveArtMsg').textContent, /已下載 2 招/);
  } finally { page.close(); }
});

ui('import adds the moves it does not have, skips the ones it has, and says how many of each', async () => {
  const page = await boot({ moveArts: { '牛蛇生死搏/對牛彈琴': { ...STORED['牛蛇生死搏/對牛彈琴'], at: 1 } } });
  try {
    page.pick(fileText(STORED));
    assert.ok(await waitFor(() => /新增/.test(page.$('moveArtMsg').textContent)));
    assert.equal(page.$('moveArtMsg').textContent, '新增 1 招、略過 1 招（已有）');
    assert.equal(page.$('moveArtMsg').classList.contains('msg-error'), false);
    assert.equal(page.store.moveArts['牛蛇生死搏/對牛彈琴'].at, 1, 'an existing move is not replaced');
    assert.ok(page.store.moveArts['全真劍法/雁行斜擊']);
    assert.ok(await waitFor(() => page.$('moveArtCount').textContent === '已存 2 招'));
  } finally { page.close(); }
});

ui('a bad file is an error-level message and changes nothing, even when only one entry in it is bad', async () => {
  const page = await boot({ moveArts: { '全真劍法/雁行斜擊': STORED['全真劍法/雁行斜擊'] } });
  try {
    const before = JSON.stringify(page.store.moveArts);
    page.pick('not json');
    assert.ok(await waitFor(() => /匯入失敗/.test(page.$('moveArtMsg').textContent)));
    assert.match(page.$('moveArtMsg').textContent, /沒有改動任何資料.*JSON/);
    assert.equal(page.$('moveArtMsg').classList.contains('msg-error'), true);
    page.pick(fileText({ '牛蛇生死搏/對牛彈琴': STORED['牛蛇生死搏/對牛彈琴'], '甲/乙': { skill: '甲', move: '乙', lines: [[['x', 'H9']]], nameCodes: ['H1'] } }));
    assert.ok(await waitFor(() => /甲\/乙/.test(page.$('moveArtMsg').textContent)));
    assert.equal(JSON.stringify(page.store.moveArts), before);
    page.pick(fileText({ '牛蛇生死搏/對牛彈琴': STORED['牛蛇生死搏/對牛彈琴'] }));
    assert.ok(await waitFor(() => /^新增/.test(page.$('moveArtMsg').textContent)));
    assert.equal(page.$('moveArtMsg').classList.contains('msg-error'), false, 'the next good import clears the red');
  } finally { page.close(); }
});

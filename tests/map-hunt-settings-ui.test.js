// 設定頁「地圖巡怪」區塊：在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的），檢查欄位、預設值、存檔與讀回。需要 jsdom；沒裝就跳過。
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
  assert.ok(await waitFor(() => doc.getElementById('huntFields')?.children.length > 0), 'the hunt fields were built');
  return { dom, doc, store };
}
const field = (doc, key) => doc.getElementById(`hunt-${key}`);
const change = (dom, node, value) => {
  node.value = value;
  node.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};

ui('the hunt section is a closed fold with every field at its default', async () => {
  const { dom, doc } = await boot();
  try {
    const fold = doc.getElementById('sec-hunt');
    assert.equal(fold.tagName, 'DETAILS');
    assert.equal(fold.open, false);
    assert.equal(field(doc, 'healMode').value, 'eat');
    assert.equal(field(doc, 'eatBelow').value, '50');
    assert.equal(field(doc, 'restResume').value, '80');
    assert.equal(field(doc, 'afterKillCommand').value, 'gc');
    assert.equal(field(doc, 'refuseKeyword').value, '並不想跟你較量');
    assert.equal(field(doc, 'endKeywords').value, '一動也不動了、死了');
    assert.equal(field(doc, 'fightTimeoutSec').value, '60');
    assert.equal(field(doc, 'eatCommand').value, '', 'the eat command has no default');
  } finally {
    dom.window.close();
  }
});

ui('an edit is saved at once with the other fields, and a broken stored value falls back to the default', async () => {
  const { dom, doc, store } = await boot({ mapHuntSettings: { eatBelow: 'abc', healMode: 'rest', homeCommand: '  recall  ' } });
  try {
    assert.equal(field(doc, 'eatBelow').value, '50', 'a stored value that is not a number shows the default');
    assert.equal(field(doc, 'healMode').value, 'rest');
    assert.equal(field(doc, 'homeCommand').value, 'recall', 'stored text is trimmed');
    change(dom, field(doc, 'eatCommand'), 'eat pill;eat pill');
    assert.ok(await waitFor(() => store.mapHuntSettings?.eatCommand === 'eat pill;eat pill'));
    assert.equal(store.mapHuntSettings.healMode, 'rest', 'the rest of the settings are saved with it');
    change(dom, field(doc, 'eatBelow'), '35');
    assert.ok(await waitFor(() => store.mapHuntSettings.eatBelow === 35));
    change(dom, field(doc, 'eatBelow'), '250');
    assert.ok(await waitFor(() => store.mapHuntSettings.eatBelow === 50), 'out of range goes back to the default');
    assert.equal(field(doc, 'eatBelow').value, '50');
  } finally {
    dom.window.close();
  }
});

ui('the learned NPCs are listed, and the clear button forgets them', async () => {
  const { dom, doc, store } = await boot({ mapHuntNpcs: ['smith', 'banker'] });
  try {
    assert.ok(await waitFor(() => /smith、banker/.test(doc.getElementById('huntNpcs').textContent)), doc.getElementById('huntNpcs').textContent);
    assert.match(doc.getElementById('huntNpcs').textContent, /（2）/);
    doc.getElementById('huntNpcClear').click();
    assert.ok(await waitFor(() => store.mapHuntNpcs === undefined), 'the stored list is removed');
    assert.ok(await waitFor(() => /尚未學到/.test(doc.getElementById('huntNpcs').textContent)));
  } finally {
    dom.window.close();
  }
});

ui('with nothing learned the list says so', async () => {
  const { dom, doc } = await boot();
  try {
    assert.match(doc.getElementById('huntNpcs').textContent, /尚未學到/);
  } finally {
    dom.window.close();
  }
});

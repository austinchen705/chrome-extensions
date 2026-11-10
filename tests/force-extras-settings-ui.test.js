// 設定頁「內力可練上限」的其他加成欄位：在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的），
// 檢查欄位讀存 chrome.storage.local.forceExtras、不合法的值退回 0。需要 jsdom；沒裝就跳過。
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
const FIELDS = ['forceLevel', 'forceZhuguo', 'forceLaba', 'forceDongying', 'forceEquip'];

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
            remove: async key => { delete store[key]; },
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
  assert.ok(await waitFor(() => FIELDS.every(id => doc.getElementById(id))), 'the extras fields exist');
  await sleep(100);
  const change = (id, value) => {
    const input = doc.getElementById(id);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  return { dom, doc, store, change };
}

ui('with nothing stored every extra is blank or off, and a change is saved as one forceExtras object', async () => {
  const { dom, doc, store, change } = await boot();
  try {
    assert.deepEqual(FIELDS.map(id => doc.getElementById(id).type === 'checkbox' ? doc.getElementById(id).checked : doc.getElementById(id).value), ['', '', false, false, '']);
    change('forceLevel', '71');
    change('forceLaba', true);
    assert.ok(await waitFor(() => store.forceExtras?.level === 71 && store.forceExtras.laba === true), JSON.stringify(store.forceExtras));
    assert.deepEqual(store.forceExtras, { level: 71, zhuguo: 0, laba: true, dongying: false, equip: 0 });
  } finally {
    dom.window.close();
  }
});

ui('stored extras are shown, and junk is turned into 0 in the field and in storage', async () => {
  const { dom, doc, store, change } = await boot({ forceExtras: { level: 71, zhuguo: 3, laba: true, dongying: true, equip: 5 } });
  try {
    assert.deepEqual(['forceLevel', 'forceZhuguo', 'forceEquip'].map(id => doc.getElementById(id).value), ['71', '3', '5']);
    assert.equal(doc.getElementById('forceLaba').checked, true);
    assert.equal(doc.getElementById('forceDongying').checked, true);
    change('forceEquip', '-4');
    assert.ok(await waitFor(() => store.forceExtras?.equip === 0));
    assert.equal(doc.getElementById('forceEquip').value, '0', 'the field shows what was kept');
  } finally {
    dom.window.close();
  }
});

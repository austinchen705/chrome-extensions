// 設定頁「聊天回覆」區塊：在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的），
// 檢查欄位讀存 chrome.storage.local.chatReply、不合法的值退回預設。需要 jsdom；沒裝就跳過。
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
  assert.ok(await waitFor(() => doc.getElementById('chatThreshold').value !== ''), 'the settings page loaded the chat reply fields');
  const change = (id, value) => {
    const input = doc.getElementById(id);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  return { dom, doc, store, change };
}

ui('with nothing stored the fields show the defaults and the switch is off', async () => {
  const { dom, doc } = await boot();
  try {
    assert.equal(doc.getElementById('chatReplyOn').checked, false);
    assert.deepEqual(['chatThreshold', 'chatCooldown', 'chatPerHour'].map(id => doc.getElementById(id).value), ['0.5', '60', '10']);
    assert.equal(doc.getElementById('sec-chat').tagName, 'DETAILS');
  } finally {
    dom.window.close();
  }
});

ui('stored settings are shown, and a change is saved as one chatReply object', async () => {
  const { dom, doc, store, change } = await boot({ chatReply: { enabled: true, threshold: 0.7, cooldownSec: 120, perHour: 5 } });
  try {
    assert.equal(doc.getElementById('chatReplyOn').checked, true);
    assert.equal(doc.getElementById('chatThreshold').value, '0.7');
    change('chatCooldown', '300');
    assert.ok(await waitFor(() => store.chatReply?.cooldownSec === 300));
    assert.deepEqual(store.chatReply, { enabled: true, threshold: 0.7, cooldownSec: 300, perHour: 5 });
    change('chatReplyOn', false);
    assert.ok(await waitFor(() => store.chatReply.enabled === false));
  } finally {
    dom.window.close();
  }
});

ui('out-of-range values are clamped and blank ones fall back to the default, in the field and in storage', async () => {
  const { dom, doc, store, change } = await boot();
  try {
    change('chatThreshold', '5');
    change('chatCooldown', '99999');
    change('chatPerHour', '');
    assert.ok(await waitFor(() => store.chatReply?.perHour === 10));
    assert.deepEqual(store.chatReply, { enabled: false, threshold: 1, cooldownSec: 3600, perHour: 10 });
    assert.deepEqual(['chatThreshold', 'chatCooldown', 'chatPerHour'].map(id => doc.getElementById(id).value), ['1', '3600', '10']);
  } finally {
    dom.window.close();
  }
});

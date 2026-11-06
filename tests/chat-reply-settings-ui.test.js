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
  assert.ok(await waitFor(() => doc.getElementById('chatThreshold').value !== ''), 'the settings page loaded the chat reply fields');
  const change = (id, value) => {
    const input = doc.getElementById(id);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  return { dom, doc, store, change, listeners };
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
    assert.deepEqual(store.chatReply, { enabled: true, threshold: 0.7, cooldownSec: 300, perHour: 5, delayMin: 5, delayMax: 10 });
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
    assert.deepEqual(store.chatReply, { enabled: false, threshold: 1, cooldownSec: 3600, perHour: 10, delayMin: 5, delayMax: 10 });
    assert.deepEqual(['chatThreshold', 'chatCooldown', 'chatPerHour'].map(id => doc.getElementById(id).value), ['1', '3600', '10']);
  } finally {
    dom.window.close();
  }
});

const PAIRS = [{ said: '今天天氣真好', reply: '對啊出去走走', at: 1 }, { said: '吃飽沒', reply: '吃過了', at: 2 }];
const click = (page, id) => page.doc.getElementById(id).dispatchEvent(new page.dom.window.Event('click', { bubbles: true }));
const listed = page => [...page.doc.querySelectorAll('#chatPairsList .chat-pair-text')].map(node => node.textContent);

ui('the data set shows its count and list newest first, and one entry can be deleted', async () => {
  const page = await boot({ chatPairs: PAIRS });
  try {
    assert.ok(await waitFor(() => listed(page).length === 2));
    assert.deepEqual(listed(page), ['吃飽沒 → 吃過了', '今天天氣真好 → 對啊出去走走']);
    assert.match(page.doc.getElementById('chatPairsInfo').textContent, /資料集 2 筆/);
    page.doc.querySelector('#chatPairsList .chat-pair button').dispatchEvent(new page.dom.window.Event('click', { bubbles: true }));
    assert.ok(await waitFor(() => page.store.chatPairs.length === 1));
    assert.deepEqual(page.store.chatPairs.map(pair => pair.said), ['今天天氣真好']);
    assert.ok(await waitFor(() => listed(page).length === 1), 'the list redraws');
  } finally {
    page.dom.window.close();
  }
});

ui('clear removes everything only after the confirm, and the list is hidden when empty', async () => {
  const page = await boot({ chatPairs: PAIRS });
  try {
    assert.ok(await waitFor(() => listed(page).length === 2));
    page.dom.window.confirm = () => false;
    click(page, 'chatPairsClear');
    await sleep(50);
    assert.equal(page.store.chatPairs.length, 2, 'declining keeps the data');
    page.dom.window.confirm = () => true;
    click(page, 'chatPairsClear');
    assert.ok(await waitFor(() => !('chatPairs' in page.store)));
    assert.ok(await waitFor(() => page.doc.getElementById('chatPairsList').hidden));
  } finally {
    page.dom.window.close();
  }
});

ui('copy puts the export text on the clipboard', async () => {
  const page = await boot({ chatPairs: PAIRS });
  try {
    let copied = null;
    Object.defineProperty(page.dom.window.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } }, configurable: true });
    click(page, 'chatPairsCopy');
    assert.ok(await waitFor(() => copied !== null));
    assert.equal(copied, '今天天氣真好\t對啊出去走走\n吃飽沒\t吃過了');
  } finally {
    page.dom.window.close();
  }
});

ui('an import that passes is added after what is there, and one bad line stops the whole import without touching the data', async () => {
  const page = await boot({ chatPairs: PAIRS });
  const importText = text => {
    page.doc.getElementById('chatPairsImportText').value = text;
    click(page, 'chatPairsImportApply');
  };
  try {
    assert.ok(await waitFor(() => listed(page).length === 2));
    importText('新的話\t新的回覆\n吃飽沒\t吃過了\n壞掉沒有tab');
    assert.ok(await waitFor(() => page.doc.getElementById('chatPairsMsg').textContent.includes('第 3 行')));
    assert.equal(page.doc.getElementById('chatPairsMsg').classList.contains('msg-error'), true);
    assert.equal(page.store.chatPairs.length, 2, 'nothing was written');
    importText('新的話\t新的回覆\n吃飽沒\t吃過了');
    assert.ok(await waitFor(() => page.store.chatPairs.length === 3));
    assert.equal(page.store.chatPairs.at(-1).reply, '新的回覆', 'the import is the newest');
    assert.match(page.doc.getElementById('chatPairsMsg').textContent, /已匯入 1 筆.*1 筆已經有了/);
    assert.equal(page.doc.getElementById('chatPairsImportText').value, '', 'the box is emptied after a successful import');
  } finally {
    page.dom.window.close();
  }
});

ui('a pair the game page records later shows up in the list without reopening the page', async () => {
  const page = await boot({ chatPairs: PAIRS });
  try {
    assert.ok(await waitFor(() => listed(page).length === 2));
    page.store.chatPairs = [...PAIRS, { said: '剛來的話', reply: '剛回的', at: 3 }];
    page.listeners.forEach(listener => listener({ chatPairs: {} }, 'local'));
    assert.ok(await waitFor(() => listed(page).length === 3));
    assert.equal(listed(page)[0], '剛來的話 → 剛回的');
  } finally {
    page.dom.window.close();
  }
});

ui('the reply delay fields show 5 and 10 by default and are saved with the other chatReply fields', async () => {
  const { dom, doc, store, change } = await boot();
  try {
    assert.deepEqual(['chatDelayMin', 'chatDelayMax'].map(id => doc.getElementById(id).value), ['5', '10']);
    change('chatDelayMin', '12');
    assert.ok(await waitFor(() => store.chatReply?.delayMin === 12));
    assert.equal(store.chatReply.delayMax, 12, 'a maximum under the minimum is raised, in storage');
    assert.equal(doc.getElementById('chatDelayMax').value, '12', 'and in the field');
  } finally {
    dom.window.close();
  }
});

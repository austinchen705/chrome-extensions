// 設定頁「主要武器與裝備比較」的比較計分欄位：在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的），
// 檢查預設值、欄位讀存 chrome.storage.local.equipmentScore（整理後寫回欄位）、清空與還原預設。需要 jsdom；沒裝就跳過。
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

// gameReply：遊戲分頁對 START_CHAT_SCRIPT 的回覆（Error 就當成送不出去）；sentToGame 記下送給遊戲分頁的訊息
async function boot(store = {}, gameReply = { ok: true, scriptId: 'x' }) {
  const sentToGame = [];
  const changeListeners = [];
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
          onChanged: { addListener: listener => changeListeners.push(listener) },
        },
        tabs: {
          query: async () => [{ id: 7, url: 'https://catworld.muds.tw/web' }],
          get: async () => { throw new Error('no tab'); },
          sendMessage: async (id, message) => {
            sentToGame.push({ id, message });
            if (gameReply instanceof Error) throw gameReply;
            return typeof gameReply === 'function' ? gameReply(message) : gameReply;
          },
          create: async () => {},
          update: async () => {},
        },
        permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  assert.ok(await waitFor(() => doc.getElementById('scorePrimaryWeight').value !== ''), 'the settings page finished loading');
  const change = (id, value) => {
    const input = doc.getElementById(id);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  const click = id => doc.getElementById(id).dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  return { dom, doc, store, change, click, sentToGame, changeListeners };
}


const DEFAULTS = { primaryGap: 3, primaryWeight: 4, relatedWeight: 2, otherWeight: 1, ignored: ['重量', '硬度', '潛能', '損修'], related: ['攻擊', '輔助氣恢復', '內功'] };
const value = (doc, id) => doc.getElementById(id).value;

ui('with nothing stored the score fields show the built-in rule', async () => {
  const { dom, doc } = await boot();
  try {
    assert.deepEqual(['scorePrimaryGap', 'scorePrimaryWeight', 'scoreRelatedWeight', 'scoreOtherWeight'].map(id => value(doc, id)), ['3', '4', '2', '1']);
    assert.equal(value(doc, 'scoreRelated'), '攻擊、輔助氣恢復、內功');
    assert.equal(value(doc, 'scoreIgnored'), '重量、硬度、潛能、損修');
  } finally {
    dom.window.close();
  }
});

ui('a stored rule is shown, and a change is saved as one cleaned equipmentScore object and written back to the fields', async () => {
  const { dom, doc, store, change } = await boot({ equipmentScore: { ...DEFAULTS, primaryGap: 1, relatedWeight: 3, ignored: ['重量'] } });
  try {
    assert.equal(value(doc, 'scorePrimaryGap'), '1');
    assert.equal(value(doc, 'scoreRelatedWeight'), '3');
    assert.equal(value(doc, 'scoreIgnored'), '重量');
    change('scorePrimaryWeight', '2.5');
    assert.ok(await waitFor(() => store.equipmentScore?.primaryWeight === 2.5));
    assert.deepEqual(store.equipmentScore, { ...DEFAULTS, primaryGap: 1, primaryWeight: 2.5, relatedWeight: 3, ignored: ['重量'] });
    change('scoreRelated', '補助氣回復、 攻擊 、攻擊');
    assert.ok(await waitFor(() => store.equipmentScore.related.length === 2));
    assert.deepEqual(store.equipmentScore.related, ['輔助氣恢復', '攻擊'], 'names normalised and de-duplicated');
    assert.equal(value(doc, 'scoreRelated'), '輔助氣恢復、攻擊', 'the cleaned list is written back');
  } finally {
    dom.window.close();
  }
});

ui('bad numbers are cleaned, a blank number goes back to the default, and a cleared list means none', async () => {
  const { dom, doc, store, change } = await boot();
  try {
    change('scorePrimaryGap', '2.9');
    assert.ok(await waitFor(() => store.equipmentScore?.primaryGap === 2));
    assert.equal(value(doc, 'scorePrimaryGap'), '2');
    change('scorePrimaryWeight', '-5');
    assert.ok(await waitFor(() => store.equipmentScore.primaryWeight === 0));
    assert.equal(value(doc, 'scorePrimaryWeight'), '0');
    change('scoreOtherWeight', '99999');
    assert.ok(await waitFor(() => store.equipmentScore.otherWeight === 1000));
    change('scoreRelatedWeight', '');
    assert.ok(await waitFor(() => store.equipmentScore.relatedWeight === 2));
    assert.equal(value(doc, 'scoreRelatedWeight'), '2', 'blank goes back to the default');
    change('scoreIgnored', '');
    assert.ok(await waitFor(() => Array.isArray(store.equipmentScore.ignored) && store.equipmentScore.ignored.length === 0));
    assert.equal(value(doc, 'scoreIgnored'), '', 'ignore nothing');
  } finally {
    dom.window.close();
  }
});

ui('the reset button drops the stored rule and shows the built-in one again', async () => {
  const { dom, doc, store, click } = await boot({ equipmentScore: { ...DEFAULTS, primaryGap: 1, related: [] } });
  try {
    assert.equal(value(doc, 'scorePrimaryGap'), '1');
    assert.equal(value(doc, 'scoreRelated'), '');
    click('scoreReset');
    assert.ok(await waitFor(() => !('equipmentScore' in store)));
    assert.equal(value(doc, 'scorePrimaryGap'), '3');
    assert.equal(value(doc, 'scoreRelated'), '攻擊、輔助氣恢復、內功');
  } finally {
    dom.window.close();
  }
});

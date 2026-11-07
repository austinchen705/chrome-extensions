// 設定頁「劇本對話」區塊：在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的），
// 檢查欄位讀存 chrome.storage.local.chatScript、不合格的值被清掉、「現在開一場」把訊息送給遊戲分頁並顯示結果。需要 jsdom；沒裝就跳過。
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
  assert.ok(await waitFor(() => doc.getElementById('chatThreshold').value !== ''), 'the settings page finished loading');
  const change = (id, value) => {
    const input = doc.getElementById(id);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  const click = id => doc.getElementById(id).dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  return { dom, doc, store, change, click, sentToGame, changeListeners };
}

const AS_A = { chatScript: { enabled: true, role: 'A', partner: 'fenrir', partnerName: '' } };

ui('with nothing stored the switch is off, the role is B and the start button is disabled', async () => {
  const { dom, doc } = await boot();
  try {
    assert.equal(doc.getElementById('scriptOn').checked, false);
    assert.equal(doc.getElementById('scriptRole').value, 'B');
    assert.equal(doc.getElementById('scriptPartner').value, '');
    assert.equal(doc.getElementById('scriptStart').disabled, true);
    assert.equal(doc.getElementById('sec-script').tagName, 'DETAILS');
  } finally {
    dom.window.close();
  }
});

ui('stored settings are shown, and a change is saved as one chatScript object', async () => {
  const { dom, doc, store, change } = await boot({ chatScript: { enabled: true, role: 'A', partner: 'fenrir', partnerName: '緋爾' } });
  try {
    assert.equal(doc.getElementById('scriptOn').checked, true);
    assert.equal(doc.getElementById('scriptRole').value, 'A');
    assert.equal(doc.getElementById('scriptPartner').value, 'fenrir');
    assert.equal(doc.getElementById('scriptPartnerName').value, '緋爾');
    assert.equal(doc.getElementById('scriptStart').disabled, false);
    change('scriptPartner', ' akai ');
    assert.ok(await waitFor(() => store.chatScript?.partner === 'akai'));
    assert.deepEqual(store.chatScript, { enabled: true, role: 'A', partner: 'akai', partnerName: '緋爾', perDay: 3, typoRate: 3 });
    change('scriptRole', 'B');
    assert.ok(await waitFor(() => store.chatScript.role === 'B'));
    assert.equal(doc.getElementById('scriptStart').disabled, true);
  } finally {
    dom.window.close();
  }
});

ui('an ID that is not safe to put in a tell command is cleared, in the field and in storage', async () => {
  const { dom, doc, store, change } = await boot();
  try {
    change('scriptPartner', 'fen rir;quit');
    assert.ok(await waitFor(() => store.chatScript !== undefined));
    assert.equal(store.chatScript.partner, '');
    assert.equal(doc.getElementById('scriptPartner').value, '');
  } finally {
    dom.window.close();
  }
});

ui('the start button sends START_CHAT_SCRIPT to the game tab and shows the result', async () => {
  const page = await boot(AS_A);
  try {
    page.click('scriptStart');
    assert.ok(await waitFor(() => /開場了/.test(page.doc.getElementById('scriptMsg').textContent)));
    const start = page.sentToGame.find(item => item.message.type === 'START_CHAT_SCRIPT'); // 設定頁自己也會送 STATUS
    assert.equal(start?.id, 7);
    assert.equal(page.doc.getElementById('scriptMsg').classList.contains('msg-error'), false);
  } finally {
    page.dom.window.close();
  }
});

ui('a refusal from the game page, or a game page that cannot be reached, is shown in red', async () => {
  const refused = await boot(AS_A, { ok: false, error: '沒有可用的劇本' });
  try {
    refused.click('scriptStart');
    assert.ok(await waitFor(() => /沒有可用的劇本/.test(refused.doc.getElementById('scriptMsg').textContent)));
    assert.equal(refused.doc.getElementById('scriptMsg').classList.contains('msg-error'), true);
  } finally {
    refused.dom.window.close();
  }
  const broken = await boot(AS_A, new Error('Receiving end is gone'));
  try {
    broken.click('scriptStart');
    assert.ok(await waitFor(() => /Receiving end is gone/.test(broken.doc.getElementById('scriptMsg').textContent)));
    assert.equal(broken.doc.getElementById('scriptMsg').classList.contains('msg-error'), true);
  } finally {
    broken.dom.window.close();
  }
});

ui('the typo rate shows 3 by default, is saved with the other chatScript fields, and is clamped, in the field and in storage', async () => {
  const { dom, doc, store, change } = await boot();
  try {
    assert.equal(doc.getElementById('scriptTypoRate').value, '3');
    change('scriptTypoRate', '40');
    assert.ok(await waitFor(() => store.chatScript?.typoRate === 40));
    assert.deepEqual(store.chatScript, { enabled: false, role: 'B', partner: '', partnerName: '', perDay: 3, typoRate: 40 });
    change('scriptTypoRate', '0');
    assert.ok(await waitFor(() => store.chatScript.typoRate === 0));
    assert.equal(doc.getElementById('scriptTypoRate').value, '0', 'zero is kept, not turned back into the default');
    change('scriptTypoRate', '250');
    assert.ok(await waitFor(() => store.chatScript.typoRate === 100));
    assert.equal(doc.getElementById('scriptTypoRate').value, '100');
    change('scriptTypoRate', '');
    assert.ok(await waitFor(() => store.chatScript.typoRate === 3));
    assert.equal(doc.getElementById('scriptTypoRate').value, '3', 'blank falls back to the default');
  } finally {
    dom.window.close();
  }
});

ui('a stored typo rate is shown in the field', async () => {
  const { dom, doc } = await boot({ chatScript: { enabled: true, role: 'A', partner: 'fenrir', partnerName: '', typoRate: 12 } });
  try {
    assert.equal(doc.getElementById('scriptTypoRate').value, '12');
  } finally {
    dom.window.close();
  }
});

ui('the daily count field shows 3 by default and is saved with the other chatScript fields, clamped and with blank falling back to 3', async () => {
  const { dom, doc, store, change } = await boot();
  try {
    assert.equal(doc.getElementById('scriptPerDay').value, '3');
    change('scriptPerDay', '5');
    assert.ok(await waitFor(() => store.chatScript?.perDay === 5));
    change('scriptPerDay', '0');
    assert.ok(await waitFor(() => store.chatScript.perDay === 0));
    assert.equal(doc.getElementById('scriptPerDay').value, '0', 'zero is kept');
    change('scriptPerDay', '500');
    assert.ok(await waitFor(() => store.chatScript.perDay === 99));
    assert.equal(doc.getElementById('scriptPerDay').value, '99');
    change('scriptPerDay', '');
    assert.ok(await waitFor(() => store.chatScript.perDay === 3));
    assert.equal(doc.getElementById('scriptPerDay').value, '3');
  } finally {
    dom.window.close();
  }
});

const TODAY_KEY = () => {
  require('../catworld-auto-command/chat-script.js');
  return globalThis.CatworldChatScript.dayKey(Date.now());
};

ui('the status line shows the count of today and the round being played, and says so when nothing is going or the game page does not answer', async () => {
  let reply = { ok: true, chatScript: null };
  const page = await boot({ chatScript: { enabled: true, role: 'A', partner: 'fenrir', partnerName: '', perDay: 4 }, chatScriptState: { date: TODAY_KEY(), count: 2, recent: [] } }, message => (message.type === 'STATUS' ? reply : { ok: true }));
  const text = () => page.doc.getElementById('scriptStatus').textContent;
  try {
    assert.ok(await waitFor(() => text() === '今天 2/4 場；目前沒有進行中的一場'), text());
    reply = { ok: true, chatScript: { scriptId: 'x', turn: 3, total: 8, phase: 'wait' } };
    assert.ok(await waitFor(() => text() === '今天 2/4 場；進行中：劇本 x，已演 3/8 輪，等對方回'), text());
    page.store.chatScriptState = { date: TODAY_KEY(), count: 3, recent: ['x'] };
    page.changeListeners.forEach(listener => listener({ chatScriptState: { newValue: page.store.chatScriptState } }, 'local'));
    assert.ok(await waitFor(() => text().startsWith('今天 3/4 場')), text());
  } finally {
    page.dom.window.close();
  }
  const gone = await boot({ chatScript: { enabled: true, role: 'A', partner: 'fenrir', partnerName: '' } }, new Error('no game page'));
  try {
    assert.ok(await waitFor(() => gone.doc.getElementById('scriptStatus').textContent === '今天 0/3 場；遊戲頁沒有回應'), gone.doc.getElementById('scriptStatus').textContent);
  } finally {
    gone.dom.window.close();
  }
});

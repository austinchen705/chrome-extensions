// 設定頁「練功觸發」分頁的「隨機表情」：在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的），
// 檢查摺疊只在練功分頁、「試做一組」把 EMOTE_TRY 送給遊戲分頁並顯示結果、「上次」照 STATUS 的 emote 顯示。需要 jsdom；沒裝就跳過。
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

// gameReply：遊戲分頁的回覆（Error 就當成送不出去）；sentToGame 記下送給遊戲分頁的訊息
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

// 遊戲分頁：STATUS 回 status 物件，EMOTE_TRY 回 tryReply
const game = ({ status = {}, tryReply = { ok: true, commands: ['lazy', 'yawn'] } } = {}) => message => (message.type === 'STATUS' ? status : message.type === 'EMOTE_TRY' ? tryReply : {});

ui('the 隨機表情 fold is only on the practice trigger tab', async () => {
  const page = await boot({}, game());
  try {
    const fold = page.doc.getElementById('fold-emote');
    assert.ok(fold, 'there is a fold');
    assert.equal(fold.closest('[data-pane]').dataset.pane, 'practice');
    assert.equal(page.doc.querySelectorAll('#fold-emote').length, 1);
  } finally {
    page.dom.window.close();
  }
});

ui('試做一組 sends EMOTE_TRY to the game tab and shows what was done', async () => {
  const page = await boot({}, game());
  try {
    page.click('emoteTry');
    assert.ok(await waitFor(() => /lazy、yawn/.test(page.doc.getElementById('emoteMsg').textContent)));
    assert.equal(page.sentToGame.find(item => item.message.type === 'EMOTE_TRY')?.id, 7);
    assert.equal(page.doc.getElementById('emoteMsg').classList.contains('msg-error'), false);
  } finally {
    page.dom.window.close();
  }
});

ui('a refusal or an unreachable game tab is shown in red', async () => {
  const refused = await boot({}, game({ tryReply: { ok: false, error: '驗證碼或真人驗證處理中，不做表情' } }));
  try {
    refused.click('emoteTry');
    assert.ok(await waitFor(() => /真人驗證/.test(refused.doc.getElementById('emoteMsg').textContent)));
    assert.equal(refused.doc.getElementById('emoteMsg').classList.contains('msg-error'), true);
  } finally {
    refused.dom.window.close();
  }
  const broken = await boot({}, new Error('Receiving end is gone'));
  try {
    broken.click('emoteTry');
    assert.ok(await waitFor(() => broken.doc.getElementById('emoteMsg').textContent !== ''));
    assert.equal(broken.doc.getElementById('emoteMsg').classList.contains('msg-error'), true);
  } finally {
    broken.dom.window.close();
  }
});

ui('上次 shows the time and the emotes from STATUS, or that none was done yet', async () => {
  const at = new Date(2026, 10, 16, 9, 5).getTime();
  const done = await boot({}, game({ status: { emote: { at, commands: ['think', 'sigh'] } } }));
  try {
    assert.ok(await waitFor(() => done.doc.getElementById('emoteLast').textContent === '上次：09:05 做了 think、sigh'), done.doc.getElementById('emoteLast').textContent);
  } finally {
    done.dom.window.close();
  }
  const none = await boot({}, game({ status: { emote: null } }));
  try {
    assert.ok(await waitFor(() => none.doc.getElementById('emoteLast').textContent === '上次：還沒做過'), none.doc.getElementById('emoteLast').textContent);
  } finally {
    none.dom.window.close();
  }
});

ui('with nothing stored the switch is off and the chance is 5; a change is saved as one emoteSettings object', async () => {
  const page = await boot({}, game());
  try {
    assert.ok(await waitFor(() => page.doc.getElementById('emoteChance').value === '5'));
    assert.equal(page.doc.getElementById('emoteOn').checked, false);
    page.change('emoteOn', true);
    page.change('emoteChance', '12');
    assert.ok(await waitFor(() => page.store.emoteSettings?.chance === 12), JSON.stringify(page.store.emoteSettings));
    assert.deepEqual(page.store.emoteSettings, { enabled: true, chance: 12 });
  } finally {
    page.dom.window.close();
  }
});

ui('stored settings are shown, and a bad chance falls back to 5 in the field and in storage', async () => {
  const page = await boot({ emoteSettings: { enabled: true, chance: 30 } }, game());
  try {
    assert.ok(await waitFor(() => page.doc.getElementById('emoteChance').value === '30'));
    assert.equal(page.doc.getElementById('emoteOn').checked, true);
    page.change('emoteChance', '250');
    assert.ok(await waitFor(() => page.store.emoteSettings?.chance === 5));
    assert.equal(page.doc.getElementById('emoteChance').value, '5', 'the field shows what was kept');
  } finally {
    page.dom.window.close();
  }
});

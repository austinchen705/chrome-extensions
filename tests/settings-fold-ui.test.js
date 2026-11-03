// 設定頁的摺疊：下方設定區塊、固定／隨機指令、觸發規則卡片預設收起，標題或摘要寫出重點，展開狀態記在 storage。
// 在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的）。需要 jsdom；沒裝就跳過。
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
    if (await condition()) return true;
    await sleep(10);
  }
  return Boolean(await condition());
};

const STAT_RULE = { kind: 'stat', enabled: true, stat: '飲水', op: 'le', unit: 'pct', value: 30, commands: ['drink'], cooldown: 5, buffer: 10 };
const KEYWORD_RULE = { kind: 'keyword', enabled: true, pattern: '你覺得口渴', commands: ['drink'], cooldown: 5 };
const STOP_ONLY_RULE = { kind: 'keyword', enabled: true, pattern: '基礎不好', commands: [], cooldown: 5, stopGroup: true };

async function boot(stored = {}) {
  const store = JSON.parse(JSON.stringify(stored));
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
            set: async values => {
              Object.assign(store, JSON.parse(JSON.stringify(values)));
              changeListeners.forEach(listener => listener(Object.fromEntries(Object.keys(values).map(key => [key, { newValue: values[key] }])), 'local'));
            },
          },
          sync: { get: async () => ({}), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener: fn => changeListeners.push(fn) },
        },
        permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        tabs: { query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => ({ running: false }), create: async () => {}, update: async () => {} },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  if (!await waitFor(() => doc.getElementById('summaryFixed') && doc.querySelector('#rules-combat'), 1500)) {
    dom.window.close(); // 設定頁的計時器會讓程序一直活著，失敗時也要關掉
    assert.fail('the settings page is built');
  }
  await sleep(80);
  return { dom, doc, store, close: () => dom.window.close() };
}

ui('every folding block on the settings page starts closed', async () => {
  const page = await boot();
  try {
    const boxes = [...page.doc.querySelectorAll('details.fold')];
    assert.ok(boxes.length >= 14, 'timer lists, per-group delay and safety, and the ten lower blocks');
    assert.deepEqual(boxes.filter(box => box.open).map(box => box.id), []);
    assert.ok(boxes.every(box => box.id), 'each one has an id so its open state can be remembered');
  } finally {
    page.close();
  }
});

ui('the fixed and random lists say how many commands they hold and which, and follow edits', async () => {
  const page = await boot({ settings: {
    fixedItems: [{ command: 'ps;px', minSeconds: 5, maxSeconds: 9 }, { command: 'look', minSeconds: 5, maxSeconds: 9 }],
    randomItems: [],
  } });
  try {
    const { doc } = page;
    assert.equal(doc.getElementById('summaryFixed').textContent, '固定指令（2 項）：ps;px、look');
    assert.equal(doc.getElementById('summaryRandom').textContent, '隨機指令（無）');
    const first = doc.querySelector('#fixedItems [data-f="command"]');
    first.value = 'hp';
    first.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
    assert.equal(doc.getElementById('summaryFixed').textContent, '固定指令（2 項）：hp、look');
    doc.querySelector('#fixedItems .x').click();
    assert.equal(doc.getElementById('summaryFixed').textContent, '固定指令（1 項）：look');
  } finally {
    page.close();
  }
});

ui('a saved rule card is collapsed to one summary line and opens on click', async () => {
  const page = await boot({ triggerGroupSettings: { combat: { rules: [STAT_RULE, KEYWORD_RULE, STOP_ONLY_RULE] } } });
  try {
    const cards = [...page.doc.querySelectorAll('#rules-combat > .rule')];
    assert.equal(cards.length, 3);
    assert.deepEqual(cards.map(card => card.querySelector('.rule-summary').textContent), [
      '飲水 ≤ 30％　→　drink',
      '「你覺得口渴」　→　drink',
      '「基礎不好」　→　停止這組觸發',
    ]);
    cards.forEach(card => {
      assert.equal(card.querySelector('.rule-body').hidden, true);
      assert.equal(card.querySelector('.rule-summary').hidden, false);
    });
    cards[0].querySelector('.fold-toggle').click();
    assert.equal(cards[0].querySelector('.rule-body').hidden, false);
    assert.equal(cards[0].querySelector('.rule-summary').hidden, true);
    cards[0].querySelector('.rule-summary').click();
    assert.equal(cards[0].querySelector('.rule-body').hidden, true, 'a second click folds it again');
  } finally {
    page.close();
  }
});

ui('the summary follows edits and folding does not change what is saved', async () => {
  const page = await boot({ triggerGroupSettings: { combat: { rules: [KEYWORD_RULE] } } });
  try {
    const card = page.doc.querySelector('#rules-combat > .rule');
    const pattern = card.querySelector('[data-f="pattern"]');
    pattern.value = '你覺得餓了';
    pattern.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
    pattern.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.equal(card.querySelector('.rule-summary').textContent, '「你覺得餓了」　→　drink');
    assert.ok(await waitFor(() => page.store.triggerGroupSettings?.combat?.rules[0]?.pattern === '你覺得餓了'), 'edits to a folded card are saved');
    assert.deepEqual(page.store.triggerGroupSettings.combat.rules[0].commands, ['drink']);
  } finally {
    page.close();
  }
});

ui('a blank rule, and a rule added with the buttons, start open', async () => {
  const page = await boot();
  try {
    const first = page.doc.querySelector('#rules-combat > .rule');
    assert.equal(first.querySelector('.rule-body').hidden, false, 'the default blank rule is open');
    page.doc.getElementById('addKeyword-practice').click();
    const added = page.doc.querySelector('#rules-practice > .rule:last-child');
    assert.equal(added.querySelector('.rule-body').hidden, false);
    await sleep(60); // 新增後的儲存跑完，關掉視窗後才不會有殘留的非同步動作
  } finally {
    page.close();
  }
});

ui('the open state of a block is remembered and restored', async () => {
  const page = await boot({ popupFolds: { 'sec-line': true } });
  try {
    const { doc, store } = page;
    assert.equal(doc.getElementById('sec-line').open, true, 'restored from storage');
    assert.equal(doc.getElementById('sec-map').open, false);
    const map = doc.getElementById('sec-map');
    map.open = true;
    map.dispatchEvent(new page.dom.window.Event('toggle'));
    assert.ok(await waitFor(() => store.popupFolds?.['sec-map'] === true));
    assert.equal(store.popupFolds['sec-line'], true, 'the others are kept');
    assert.equal(store.popupFolds['fold-fixed'], false);
  } finally {
    page.close();
  }
});

ui('the shop minimum price setting shows the default, saves a valid value and refuses a bad one', async () => {
  const page = await boot();
  try {
    const { doc, store } = page;
    const input = doc.getElementById('shopMinPrice');
    assert.equal(input.value, '5', 'default 5S');
    input.value = '3.5';
    input.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.ok(await waitFor(() => store.shopMinPrice === 3.5));
    input.value = '-1';
    input.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.equal(input.value, '3.5', 'a bad value is put back');
    assert.equal(store.shopMinPrice, 3.5);
    await sleep(60);
  } finally {
    page.close();
  }
});

ui('a saved minimum price is shown when the settings page opens', async () => {
  const page = await boot({ shopMinPrice: 0 });
  try {
    assert.equal(page.doc.getElementById('shopMinPrice').value, '0');
  } finally {
    page.close();
  }
});

ui('the shop buy names setting shows the default, saves what is typed and keeps an empty value', async () => {
  const page = await boot();
  try {
    const { doc, store } = page;
    const input = doc.getElementById('shopBuyNames');
    assert.equal(input.value, '無名物品、無名藥草、不知名藥草');
    input.value = ' 包子、狗肉 ';
    input.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.ok(await waitFor(() => store.shopBuyNames === '包子、狗肉'));
    input.value = '';
    input.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.ok(await waitFor(() => store.shopBuyNames === ''), 'empty is a real value: no buy buttons');
    await sleep(60);
  } finally {
    page.close();
  }
});

ui('a saved buy names setting, even an empty one, is shown when the settings page opens', async () => {
  const empty = await boot({ shopBuyNames: '' });
  try {
    assert.equal(empty.doc.getElementById('shopBuyNames').value, '');
  } finally {
    empty.close();
  }
  const set = await boot({ shopBuyNames: '包子' });
  try {
    assert.equal(set.doc.getElementById('shopBuyNames').value, '包子');
  } finally {
    set.close();
  }
});

ui('the shop skip names setting shows the default horses, saves what is typed and keeps an empty value', async () => {
  const page = await boot();
  try {
    const { doc, store } = page;
    const input = doc.getElementById('shopSkipNames');
    assert.equal(input.value, '赤兔馬、白馬、烏黑駒、自由行走的花的赤兔馬');
    input.value = ' 馬 ';
    input.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.ok(await waitFor(() => store.shopSkipNames === '馬'));
    input.value = '';
    input.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.ok(await waitFor(() => store.shopSkipNames === ''));
    await sleep(60);
  } finally {
    page.close();
  }
});

ui('a saved skip names setting, even an empty one, is shown when the settings page opens', async () => {
  const empty = await boot({ shopSkipNames: '' });
  try {
    assert.equal(empty.doc.getElementById('shopSkipNames').value, '');
  } finally {
    empty.close();
  }
  const set = await boot({ shopSkipNames: '馬' });
  try {
    assert.equal(set.doc.getElementById('shopSkipNames').value, '馬');
  } finally {
    set.close();
  }
});

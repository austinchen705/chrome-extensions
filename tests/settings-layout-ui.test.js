// 設定頁的版面：「設定」分頁收所有全域區塊（分四組）、觸發規則清單可收起並在標題寫摘要、
// 定時與隨機改了就存、功能之間的依賴提示。在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的）。需要 jsdom；沒裝就跳過。
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
const OFF_RULE = { kind: 'keyword', enabled: false, pattern: '你覺得口渴', commands: ['drink'], cooldown: 5 };

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
    dom.window.close();
    assert.fail('the settings page is built');
  }
  await sleep(80);
  const fire = (node, type) => node.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  const toggle = (id, on) => { const box = doc.getElementById(id); box.checked = on; fire(box, 'change'); };
  return { dom, doc, store, fire, toggle, close: () => dom.window.close() };
}

const SECTIONS = ['features', 'alert', 'stopwords', 'chat', 'script', 'reward', 'grade', 'weapon', 'shared', 'map', 'mentor', 'shop', 'hunt', 'extra', 'backup', 'line', 'captcha'];

ui('the tabs end with 設定, and all 17 global blocks live in it, grouped in four folds, none under the trigger tabs', async () => {
  const page = await boot();
  try {
    const { doc } = page;
    assert.deepEqual([...doc.querySelectorAll('.tabs [data-tab]')].map(tab => tab.textContent), ['定時送出', '隨機送出', 'Idle', '戰鬥觸發', '練功觸發', '設定']);
    const pane = doc.querySelector('[data-pane="settings"]');
    SECTIONS.forEach(name => assert.ok(pane.querySelector(`#sec-${name}`), `sec-${name} is in the settings tab`));
    assert.deepEqual([...pane.querySelectorAll(':scope > details.group')].map(box => box.id), ['grp-assist', 'grp-auto', 'grp-alert', 'grp-data']);
    assert.equal(pane.querySelectorAll('details.group details.alertbox').length, 17, 'every block sits inside one of the groups');
    ['combat', 'practice'].forEach(id => assert.equal(doc.querySelectorAll(`[data-pane="${id}"] details.alertbox`).length, 0, `${id} has none of the global blocks`));
    assert.equal(doc.querySelectorAll('details.fold[open]').length, 0, 'folds, groups included, start closed');
  } finally {
    page.close();
  }
});

ui('the buttons that used to sit at the bottom went to the block they belong to', async () => {
  const page = await boot();
  try {
    const { doc } = page;
    assert.ok(doc.querySelector('[data-pane="timer"] #test'), 'the ps test reports in the timer status line, so it lives on that tab');
    assert.ok(doc.querySelector('#sec-alert #beep'));
    assert.ok(doc.querySelector('#sec-features #skills'));
    assert.ok(doc.getElementById('fold-notes'), 'the general note is one fold shown on every tab');
  } finally {
    page.close();
  }
});

ui('a remembered settings tab is shown again; an unknown one falls back to the timer tab', async () => {
  const saved = await boot({ popupTab: 'settings' });
  try {
    assert.equal(saved.doc.querySelector('[data-pane="settings"]').hidden, false);
    assert.equal(saved.doc.querySelector('[data-pane="timer"]').hidden, true);
  } finally {
    saved.close();
  }
  const unknown = await boot({ popupTab: 'nowhere' });
  try {
    assert.equal(unknown.doc.querySelector('[data-pane="timer"]').hidden, false);
  } finally {
    unknown.close();
  }
});

ui('the rule list is one fold per group whose title counts the rules, and cards stay its direct children', async () => {
  const page = await boot({ triggerGroupSettings: { combat: { rules: [STAT_RULE, OFF_RULE] } } });
  try {
    const { doc } = page;
    const fold = doc.getElementById('fold-rules-combat');
    assert.equal(fold.open, false, 'closed by default');
    assert.equal(doc.getElementById('rulesSummary-combat').textContent, '觸發規則（2 條，1 條關閉）');
    assert.equal(doc.querySelectorAll('#rules-combat > .rule').length, 2);
    assert.ok(fold.contains(doc.getElementById('addRule-combat')) && fold.contains(doc.getElementById('addKeyword-combat')), 'adding is done with the list open');
    doc.getElementById('addKeyword-combat').click();
    assert.equal(doc.getElementById('rulesSummary-combat').textContent, '觸發規則（3 條，1 條關閉）');
    doc.querySelector('#rules-combat > .rule:last-child .x').click();
    assert.equal(doc.getElementById('rulesSummary-combat').textContent, '觸發規則（2 條，1 條關閉）');
    const off = doc.querySelectorAll('#rules-combat > .rule')[1].querySelector('[data-f="enabled"]');
    off.checked = true;
    page.fire(off, 'change');
    assert.equal(doc.getElementById('rulesSummary-combat').textContent, '觸發規則（2 條）');
    assert.equal(doc.getElementById('rulesSummary-practice').textContent, '觸發規則（1 條）', 'the other group counts its own rules');
    await sleep(60);
  } finally {
    page.close();
  }
});

ui('the long notes of a trigger tab are folded into one 使用說明 block', async () => {
  const page = await boot();
  try {
    const help = page.doc.getElementById('fold-help-combat');
    assert.equal(help.open, false);
    assert.match(help.textContent, /數值規則：精氣神等數值達到門檻就送指令/);
    assert.match(help.textContent, /修改規則後要重新按「開始觸發」才會套用/);
  } finally {
    page.close();
  }
});

ui('the timer and random tabs save on every edit, without pressing 開始', async () => {
  const page = await boot({ settings: { fixedItems: [{ command: 'ps', minSeconds: 30, maxSeconds: 40 }], randomItems: [{ command: 'look', minSeconds: 30, maxSeconds: 40 }], commandDelayMs: 500 } });
  try {
    const { doc, store } = page;
    const fixed = doc.querySelector('#fixedItems [data-f="command"]');
    fixed.value = 'hp';
    page.fire(fixed, 'input');
    page.fire(fixed, 'change');
    assert.ok(await waitFor(() => store.settings.fixedItems[0].command === 'hp'), 'a fixed command edit is saved');
    const delay = doc.getElementById('commandDelayMs');
    delay.value = '800';
    page.fire(delay, 'change');
    assert.ok(await waitFor(() => store.settings.commandDelayMs === 800), 'the command interval is saved');
    const random = doc.querySelector('#randomItems [data-f="command"]');
    random.value = 'score';
    page.fire(random, 'change');
    assert.ok(await waitFor(() => store.settings.randomItems[0].command === 'score'), 'a random command edit is saved');
    assert.equal(store.settings.fixedItems[0].command, 'hp', 'one save carries both lists');
    doc.querySelector('#randomItems .x').click();
    assert.ok(await waitFor(() => store.settings.randomItems.length === 0), 'removing a row is saved');
  } finally {
    page.close();
  }
});

const hintOf = (doc, host) => [...doc.querySelectorAll(`[data-dep="${host}"]`)].filter(node => !node.hidden);

ui('a block whose feature is off says so, and the warning clears when the feature is turned on', async () => {
  const page = await boot();
  try {
    const { doc } = page;
    ['sec-grade', 'sec-weapon', 'sec-mentor', 'sec-hunt'].forEach(host => {
      assert.equal(hintOf(doc, host).length, 1, `${host} warns by default (the feature is off)`);
      assert.ok(doc.getElementById(host).classList.contains('has-dep'), `${host} title is marked`);
      assert.ok(hintOf(doc, host)[0].classList.contains('msg-warn'));
    });
    page.toggle('featureMobs', true);
    assert.equal(hintOf(doc, 'sec-grade').length, 0);
    assert.equal(doc.getElementById('sec-grade').classList.contains('has-dep'), false);
    page.toggle('featureItems', true);
    assert.equal(hintOf(doc, 'sec-weapon').length, 0);
    assert.equal(hintOf(doc, 'sec-shop').length, 0, 'the shop warning needs the shop on');
    page.toggle('featureShop', true);
    assert.equal(hintOf(doc, 'sec-shop').length, 0, 'items is on, so the worn gear can be read');
    page.toggle('featureItems', false);
    assert.equal(hintOf(doc, 'sec-shop').length, 1, 'shop on and items off: no 讀取目前穿著');
    assert.match(hintOf(doc, 'sec-shop')[0].textContent, /讀取目前穿著/);
    page.toggle('featureWhisper', false);
    assert.equal(hintOf(doc, 'sec-features').length, 1, 'the whisper colour is useless with the whisper block off');
    await sleep(60); // 勾選功能後的儲存跑完，關掉視窗後才不會有殘留的非同步動作
  } finally {
    page.close();
  }
});

ui('script dialogue asks for the partner id, notes 0 per day, and explains what it takes over from whispers', async () => {
  const page = await boot();
  try {
    const { doc } = page;
    assert.equal(hintOf(doc, 'sec-script').length, 0, 'nothing to say while it is off');
    page.toggle('scriptOn', true);
    const texts = () => hintOf(doc, 'sec-script').map(node => node.textContent);
    assert.ok(texts().some(text => /對方的英文 ID/.test(text)), 'no partner id yet');
    assert.ok(texts().some(text => /不會進密語區/.test(text)), 'the info line');
    assert.equal(hintOf(doc, 'sec-script').filter(node => node.classList.contains('msg-warn')).length, 1, 'the info line is not a warning');
    const partner = doc.getElementById('scriptPartner');
    partner.value = 'fox';
    page.fire(partner, 'change');
    assert.ok(!texts().some(text => /對方的英文 ID/.test(text)));
    const perDay = doc.getElementById('scriptPerDay');
    perDay.value = '0';
    page.fire(perDay, 'change');
    assert.ok(texts().some(text => /每天最多 0 場/.test(text)));
    assert.ok(doc.getElementById('sec-script').classList.contains('has-dep'));
    await sleep(60);
  } finally {
    page.close();
  }
});

ui('an empty stop-keyword list is flagged', async () => {
  const page = await boot();
  try {
    const { doc } = page;
    assert.equal(hintOf(doc, 'sec-stopwords').length, 0, 'the default list is jrealm');
    const list = doc.getElementById('stopKeywordsList');
    list.value = '';
    page.fire(list, 'change');
    assert.equal(hintOf(doc, 'sec-stopwords').length, 1);
    await sleep(60);
  } finally {
    page.close();
  }
});

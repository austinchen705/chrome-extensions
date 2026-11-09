// 安全機制的「角色狀態」：勾選框開著時，角色狀態（遊戲的 #status）要在「允許的狀態」清單裡才觸發，清單用複合選單選（預設只有「正常」，
// 內建選項 忙碌、中毒、酒醉，另有一個欄位自己加其他狀態）。純函式（trigger-engine.js 整理設定與判斷）、整個 content script 在 jsdom 裡實際觸發、設定頁的選單。
// 需要 jsdom 的部分沒裝就跳過
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('../catworld-auto-command/trigger-engine.js');

const E = globalThis.CatworldTriggerEngine;
const norm = raw => E.normalizeConfig({ rules: [], ...raw }).allowedStatuses;

test('allowed statuses default to normal only, and normal can never be taken out', () => {
  assert.deepEqual(norm({}), ['正常']);
  assert.deepEqual(norm({ allowedStatuses: [] }), ['正常']);
  assert.deepEqual(norm({ allowedStatuses: ['忙碌'] }), ['正常', '忙碌']);
  assert.deepEqual(norm({ allowedStatuses: ['忙碌', '正常'] }), ['正常', '忙碌']);
});

test('the list is cleaned: trimmed, no blanks, no repeats, no non-text, short names only, a limited number', () => {
  assert.deepEqual(norm({ allowedStatuses: ['  中毒 ', '', '   ', '中毒', 5, null, {}, '酒醉'] }), ['正常', '中毒', '酒醉']);
  assert.deepEqual(norm({ allowedStatuses: ['x'.repeat(21), 'x'.repeat(20)] }), ['正常', 'x'.repeat(20)]);
  assert.equal(norm({ allowedStatuses: Array.from({ length: 50 }, (_, i) => `狀態${i}`) }).length, 21, 'normal plus at most 20 more');
  assert.deepEqual(norm({ allowedStatuses: '忙碌' }), ['正常'], 'not a list: ignored');
  assert.deepEqual(E.STATUS_PRESETS, ['忙碌', '中毒', '酒醉']);
});

const keyword = (pattern, commands, extra) => ({ kind: 'keyword', enabled: true, pattern, commands, cooldown: 1, ...extra });
function engine(config, status) {
  const sent = [];
  let clock = 1000;
  const io = { now: () => clock, readStat: () => null, status: () => status.value, send: commands => sent.push(commands), onDisable() {} };
  const created = E.createEngine({ delayMax: 0, ...config }, io);
  return { created, sent, tick: ms => { clock += ms; } };
}

test('a keyword rule fires only while the status is on the allowed list', () => {
  const status = { value: '正常' };
  const { created, sent } = engine({ rules: [keyword('口渴', ['drink'])], requireNormal: true, allowedStatuses: ['正常', '忙碌'] }, status);
  created.onText('你覺得口渴。\n');
  assert.equal(sent.length, 1, 'normal');
  [['中毒', 0], [null, 0], ['忙碌', 1]].forEach(([value, expected], index) => {
    const fresh = engine({ rules: [keyword('口渴', ['drink'])], requireNormal: true, allowedStatuses: ['正常', '忙碌'] }, { value });
    fresh.created.onText(`你覺得口渴。${index}\n`);
    assert.equal(fresh.sent.length, expected, `${value}`);
  });
});

test('with the switch off the status is not looked at', () => {
  const { created, sent } = engine({ rules: [keyword('口渴', ['drink'])], requireNormal: false }, { value: '中毒' });
  created.onText('你覺得口渴。\n');
  assert.equal(sent.length, 1);
});

test('a stat rule is held back in a status that is not allowed, with a note that says which status', () => {
  const sent = [];
  const status = { value: '中毒' };
  const rule = { kind: 'stat', stat: '氣', op: 'le', value: 50, unit: 'abs', commands: ['eat'], cooldown: 5, buffer: 0, enabled: true };
  const created = E.createEngine({ rules: [rule], requireNormal: true, allowedStatuses: ['正常', '忙碌'], delayMax: 0 }, {
    now: () => 1000, readStat: () => ({ value: 10, max: 100 }), status: () => status.value, send: commands => sent.push(commands), onDisable() {},
  });
  created.tick();
  assert.equal(sent.length, 0);
  assert.match(created.snapshot().rules[0].text + created.snapshot().rules[0].note, /中毒/, 'the note names the status that held it back');
  status.value = '忙碌';
  created.tick();
  assert.equal(sent.length, 1, 'an allowed status lets it fire');
});

test('an io that only has isNormal keeps working as before', () => {
  const sent = [];
  const created = E.createEngine({ rules: [keyword('口渴', ['drink'])], delayMax: 0 }, { now: () => 1000, readStat: () => null, isNormal: () => true, send: commands => sent.push(commands), onDisable() {} });
  created.onText('你覺得口渴。\n');
  assert.equal(sent.length, 1);
});

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // 沒裝 jsdom
}
const ui = JSDOM ? test : test.skip;
const gamePage = JSDOM ? require('./helpers/game-page') : null;
const SCALE = 10;
const config = (rules, extra) => ({ rules, delayMax: 0, requireNormal: true, ...extra });
const setStatus = (page, text) => { page.w.document.getElementById('status').textContent = text; };

ui('in the game page a rule fires in an allowed status and not in the others, and the group stays on', async () => {
  const { boot, waitFor, sleep } = gamePage;
  const page = await boot({ scale: SCALE });
  try {
    page.w.document.body.insertAdjacentHTML('beforeend', '<div id="status">中毒</div>');
    await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['drink'])], { allowedStatuses: ['正常', '忙碌'] }) });
    page.output('<span>你覺得口渴。</span>');
    await sleep(400);
    assert.equal(page.sent.length, 0, 'poisoned: held back');
    assert.equal((await page.ask({ type: 'STATUS' })).triggerGroups.practice.on, true);
    setStatus(page, '忙碌');
    await sleep(1200); // 規則冷卻用真實時鐘
    page.output('<span>你又覺得口渴。</span>');
    assert.ok(await waitFor(() => page.sent.includes('drink'), 2000), 'busy is on the list');
  } finally {
    page.close();
  }
});

ui('an old saved config without the list behaves as before: only normal passes', async () => {
  const { boot, waitFor, sleep } = gamePage;
  const page = await boot({ scale: SCALE });
  try {
    page.w.document.body.insertAdjacentHTML('beforeend', '<div id="status">忙碌</div>');
    await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['drink'])]) });
    page.output('<span>你覺得口渴。</span>');
    await sleep(400);
    assert.equal(page.sent.length, 0);
    setStatus(page, '正常');
    await sleep(1200);
    page.output('<span>你又覺得口渴。</span>');
    assert.ok(await waitFor(() => page.sent.includes('drink'), 2000));
  } finally {
    page.close();
  }
});

// ---- 設定頁 ----
const root = path.join(__dirname, '..', 'catworld-auto-command');
async function bootPopup(store) {
  const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitUntil = async (condition, ms = 3000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (condition()) return true;
      await sleepMs(5);
    }
    return condition();
  };
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
  assert.ok(await waitUntil(() => doc.querySelectorAll('#rules-practice > .rule').length > 0), 'the rule cards are drawn');
  return { dom, doc, store, waitUntil };
}
const change = (page, element) => element.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
const preset = (page, group, name) => page.doc.querySelector(`#statuses-${group} input[data-status="${name}"]`);

ui('the settings page shows the stored list: presets ticked, anything else in the box', async () => {
  const store = { triggerGroupSettings: { practice: { rules: [keyword('口渴', ['pw'])], delayMax: 0, allowedStatuses: ['正常', '中毒', '昏迷', '發呆'] } } };
  const page = await bootPopup(store);
  try {
    assert.deepEqual(['忙碌', '中毒', '酒醉'].map(name => preset(page, 'practice', name).checked), [false, true, false]);
    assert.equal(page.doc.getElementById('statusCustom-practice').value, '昏迷、發呆');
    assert.equal(page.doc.querySelector('#statuses-practice input:disabled').checked, true, 'normal is shown ticked and locked');
    assert.equal(preset(page, 'combat', '中毒').checked, false, 'the combat tab has its own, still the default');
  } finally {
    page.dom.window.close();
  }
});

ui('ticking presets and typing other statuses is saved as one list, normal first', async () => {
  const store = { triggerGroupSettings: { practice: { rules: [keyword('口渴', ['pw'])], delayMax: 0 } } };
  const page = await bootPopup(store);
  try {
    preset(page, 'practice', '酒醉').checked = true;
    preset(page, 'practice', '忙碌').checked = true;
    const custom = page.doc.getElementById('statusCustom-practice');
    custom.value = ' 昏迷、、發呆 ,中毒 ';
    change(page, custom);
    assert.ok(await page.waitUntil(() => store.triggerGroupSettings.practice.allowedStatuses?.length > 1));
    assert.deepEqual(JSON.parse(JSON.stringify(store.triggerGroupSettings.practice.allowedStatuses)), ['正常', '忙碌', '酒醉', '昏迷', '發呆', '中毒']);
  } finally {
    page.dom.window.close();
  }
});

ui('the settings page has no master checkbox any more: only ticked statuses may trigger, and saving writes no requireNormal', async () => {
  const store = { triggerGroupSettings: { practice: { rules: [keyword('口渴', ['pw'])], delayMax: 0 } } };
  const page = await bootPopup(store);
  try {
    assert.equal(page.doc.getElementById('requireNormal-practice'), null);
    assert.equal(page.doc.getElementById('requireNormal-combat'), null);
    preset(page, 'practice', '中毒').checked = true;
    change(page, preset(page, 'practice', '中毒'));
    assert.ok(await page.waitUntil(() => store.triggerGroupSettings.practice.allowedStatuses?.includes('中毒')));
    assert.equal('requireNormal' in store.triggerGroupSettings.practice, false, 'the old switch is no longer written');
  } finally {
    page.dom.window.close();
  }
});

ui('a config saved with the old switch turned off comes back with the known statuses ticked, so it stays close to what it did', async () => {
  const store = { triggerGroupSettings: { practice: { rules: [keyword('口渴', ['pw'])], delayMax: 0, requireNormal: false } } };
  const page = await bootPopup(store);
  try {
    assert.deepEqual(['忙碌', '中毒', '酒醉'].map(name => preset(page, 'practice', name).checked), [true, true, true]);
    const stay = { triggerGroupSettings: { practice: { rules: [keyword('口渴', ['pw'])], delayMax: 0, requireNormal: false, allowedStatuses: ['正常', '中毒'] } } };
    const other = await bootPopup(stay);
    try {
      assert.deepEqual(['忙碌', '中毒', '酒醉'].map(name => preset(other, 'practice', name).checked), [false, true, false], 'a list that was already chosen is kept as it is');
    } finally {
      other.dom.window.close();
    }
  } finally {
    page.dom.window.close();
  }
});

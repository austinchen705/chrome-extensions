// 觸發規則的「最後一個指令後面加隨機數字」：引擎的檢查與抽數字（純函式）、整個 content script 在 jsdom 裡命中後實際送出的指令、
// 設定頁規則卡片的勾選與範圍欄。需要 jsdom 的部分沒裝就跳過
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('../catworld-auto-command/trigger-engine.js');

const E = globalThis.CatworldTriggerEngine;

test('rule keeps a valid number range, swaps a reversed one, drops junk', () => {
  const rule = number => E.normalizeConfig({ rules: [{ kind: 'keyword', pattern: 'x', commands: ['pw'], number }] }).rules[0];
  assert.deepEqual(rule({ min: 50, max: 150 }).number, { min: 50, max: 150 });
  assert.deepEqual(rule({ min: 9, max: 3 }).number, { min: 3, max: 9 });
  assert.equal('number' in rule({ min: 'x', max: 3 }), false);
  assert.equal('number' in rule({ min: 1, max: 2000000 }), false);
  assert.equal('number' in rule(undefined), false);
  const stat = E.normalizeConfig({ rules: [{ kind: 'stat', stat: '氣血', op: 'le', value: 10, commands: ['pw'], number: { min: 1, max: 2 } }] }).rules[0];
  assert.deepEqual(stat.number, { min: 1, max: 2 });
});

test('withNumber appends to the last command only, inside the range, fresh each call', () => {
  const number = { min: 50, max: 150 };
  assert.deepEqual(E.withNumber(['eat', 'pw'], number, () => 0), ['eat', 'pw 50']);
  assert.deepEqual(E.withNumber(['pw'], number, () => 0.999999), ['pw 150']);
  assert.deepEqual(E.withNumber(['eat', 'pw'], undefined), ['eat', 'pw']);
  assert.deepEqual(E.withNumber([], number), []);
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(E.withNumber(['pw'], { min: 1, max: 3 })[0]);
  assert.deepEqual([...seen].sort(), ['pw 1', 'pw 2', 'pw 3']);
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
const keyword = (pattern, commands, extra) => ({ kind: 'keyword', enabled: true, pattern, commands, cooldown: 3, ...extra });
const config = rules => ({ rules, delayMax: 0, requireNormal: false });

ui('a firing rule sends its last command with a number in range', async () => {
  const { boot, waitFor } = gamePage;
  const page = await boot({ scale: SCALE });
  try {
    await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['eat', 'pw'], { number: { min: 50, max: 52 }, cooldown: 1 })]) });
    page.output('<span>你覺得口渴。</span>');
    assert.ok(await waitFor(() => page.sent.some(s => /^pw (50|51|52)$/.test(s)), 1500));
    assert.ok(page.sent.includes('eat'), 'the other command is sent as it is');
    assert.ok(!page.sent.includes('pw'), 'the bare command is not sent');
  } finally {
    page.close();
  }
});

ui('the number also works for a stop-group rule and a priority rule', async () => {
  const { boot, waitFor } = gamePage;
  const page = await boot({ scale: SCALE });
  try {
    await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['pw'], { number: { min: 7, max: 7 }, stopGroup: true })]) });
    page.output('<span>你覺得口渴。</span>');
    assert.ok(await waitFor(() => page.sent.includes('pw 7'), 1500));
  } finally {
    page.close();
  }
  const page2 = await boot({ scale: SCALE });
  try {
    await page2.ask({ type: 'START_TRIGGER', group: 'combat', config: config([keyword('口渴', ['pw'], { number: { min: 8, max: 8 }, priority: true })]) });
    page2.output('<span>你覺得口渴。</span>');
    assert.ok(await waitFor(() => page2.sent.includes('pw 8'), 1500));
  } finally {
    page2.close();
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
const f = (card, name) => card.querySelector(`[data-f="${name}"]`);

ui('the rule card shows the range only when ticked, and the change is saved with the rule', async () => {
  const store = { triggerGroupSettings: { practice: { rules: [keyword('口渴', ['pw'])], delayMax: 0, requireNormal: false } } };
  const page = await bootPopup(store);
  try {
    const card = page.doc.querySelector('#rules-practice > .rule');
    assert.equal(f(card, 'numOn').checked, false);
    assert.equal(card.querySelector('.numrange').hidden, true);
    f(card, 'numOn').checked = true;
    f(card, 'numOn').dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.equal(card.querySelector('.numrange').hidden, false);
    f(card, 'numMin').value = '30';
    f(card, 'numMax').value = '';
    f(card, 'numMax').dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.ok(await page.waitUntil(() => store.triggerGroupSettings.practice.rules[0].number));
    assert.deepEqual(JSON.parse(JSON.stringify(store.triggerGroupSettings.practice.rules[0].number)), { min: 30, max: 150 }, 'a blank bound falls back to 150');
    f(card, 'numOn').checked = false;
    f(card, 'numOn').dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.ok(await page.waitUntil(() => !('number' in store.triggerGroupSettings.practice.rules[0])));
  } finally {
    page.dom.window.close();
  }
});

ui('a stored range comes back ticked in the card', async () => {
  const store = { triggerGroupSettings: { practice: { rules: [keyword('口渴', ['pw'], { number: { min: 60, max: 90 } })], delayMax: 0, requireNormal: false } } };
  const page = await bootPopup(store);
  try {
    const card = page.doc.querySelector('#rules-practice > .rule');
    assert.equal(f(card, 'numOn').checked, true);
    assert.deepEqual([f(card, 'numMin').value, f(card, 'numMax').value], ['60', '90']);
  } finally {
    page.dom.window.close();
  }
});

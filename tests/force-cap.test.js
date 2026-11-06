// 內力可練上限：解析 hp／sk／enable 的輸出、算上限、打 hp 時在輸出下面多一行。
// 純函式直接測；遊戲頁用整個 content script 在 jsdom 裡跑（樣本是使用者貼的真實輸出）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ui, boot, waitFor, sleep } = require('./helpers/game-page');

const root = path.join(__dirname, '..', 'catworld-auto-command');
require('../catworld-auto-command/force-cap.js');
const F = globalThis.CatworldForceCap;

const HP = `hp
 精：  168/  168 (100%)    靈力：    0 /    0 (+0)
 氣：    0/ 1306 (100%)    內力： 1046 / 1560 (+10)
 神：  138/  138 (100%)    法力：    0 /    0 (+0)
 食物：  786/  800         潛能： 114
 飲水：  817/  800         經驗： 45702
 目前狀態: 正常
`;
const SC = `│  ╞═════╡  氣 ：    0/ 1306 (100%)    內力： 1046 / 1560 (+10)     │
│物│膽識： 30 │ 食物：  786/  800           潛能： 114                   │
`;
const ENABLE = `以下是你目前使用中的特殊技能。
  內功 (force)        ： 六合童子功            有效等級：244
  輕功 (dodge)        ： 般若行步              有效等級： 21
`;
const SK = `你目前所學過的技能：(6)

ˇ般若行步 (banro-step)              - 初學乍練  18/   105 ( 29%)
　內功心法 (force)                   - 出神入化 156/     0 (  0%)
ˇ六合童子功 (six-of-force)          - 出神入化 166/  5059 ( 16%)
`;

test('parsers read the real hp, sk and enable output', () => {
  assert.deepEqual(F.parseHp(HP), { cur: 1046, max: 1560 });
  assert.equal(F.parseHp(SC), null, 'the character sheet has the same line but is not hp');
  assert.equal(F.parseBase(SK), 156, 'the force skill, not 六合童子功 (166)');
  assert.equal(F.parseEffective(ENABLE), 244);
  assert.equal(F.parseBase(ENABLE), null);
  assert.equal(F.parseEffective(SK), null);
  assert.equal(F.parseHp(null), null);
});

test('cap is force level x 10 plus the effective level over 5, rounded down', () => {
  assert.equal(F.cap(156, 244), 1608);
  assert.equal(F.cap(156, 4), 1560);
  assert.equal(F.cap(0, 0), 0);
});

test('describe says how far from the cap, and asks for sk / enable when a level is unknown', () => {
  const levels = { base: 156, effective: 244, baseAt: 1000, effectiveAt: 2000 };
  assert.equal(F.describe(levels, { cur: 1046, max: 1560 }, at => `t${at}`).text, '內力可練上限：1608（目前最大 1560，還差 48，等級讀於 t1000）');
  assert.match(F.describe(levels, { cur: 1, max: 1608 }).text, /已達上限/);
  assert.match(F.describe(levels, { cur: 1, max: 1700 }).text, /已超過 92/);
  assert.equal(F.describe({ base: 156 }, { cur: 1, max: 1560 }).text, '內力可練上限：還不知道，先打 enable 讓我記下等級');
  assert.equal(F.describe(undefined, { cur: 1, max: 1560 }).text, '內力可練上限：還不知道，先打 sk、enable 讓我記下等級');
  assert.equal(F.describe(undefined, { cur: 1, max: 1560 }).level, 'warn');
});

const box = page => page.w.document.querySelector('[data-catworld-forcecap]');

ui('sk and enable record the levels, then hp gets a line under its output', async () => {
  const page = await boot();
  try {
    page.output(`<span>${SK}</span>`);
    assert.ok(await waitFor(() => page.store.forceLevels?.base === 156));
    page.output(`<span>${ENABLE}</span>`);
    assert.ok(await waitFor(() => page.store.forceLevels?.effective === 244));
    assert.equal(box(page), null, 'sk and enable alone show nothing');
    page.output(`<span>${HP}</span>`);
    assert.ok(await waitFor(() => box(page)));
    assert.match(box(page).textContent, /內力可練上限：1608（目前最大 1560，還差 48/);
  } finally {
    page.close();
  }
});

ui('hp before the levels are known asks for sk and enable; the character sheet shows nothing', async () => {
  const page = await boot();
  try {
    page.output(`<span>${SC}</span>`);
    await sleep(600);
    assert.equal(box(page), null);
    page.output(`<span>${HP}</span>`);
    assert.ok(await waitFor(() => box(page)));
    assert.match(box(page).textContent, /先打 sk、enable/);
  } finally {
    page.close();
  }
});

ui('output split across batches is still read, and the switch turns it off', async () => {
  const page = await boot({ initialStore: { forceLevels: { base: 156, effective: 244 }, zapFeatures: { forceCap: false } } });
  try {
    page.output(`<span>${HP}</span>`);
    await sleep(600);
    assert.equal(box(page), null, 'switched off');
  } finally {
    page.close();
  }
  const on = await boot({ initialStore: { forceLevels: { base: 156, effective: 244 } } });
  try {
    HP.split('\n').forEach(row => on.output(`<span>${row}\n</span>`));
    assert.ok(await waitFor(() => box(on)));
    assert.match(box(on).textContent, /1608/);
    assert.equal(on.w.document.querySelectorAll('[data-catworld-forcecap]').length, 1, 'one line, not one per batch');
  } finally {
    on.close();
  }
});

test('the module is wired in the manifest and the settings page', () => {
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).content_scripts[0].js.includes('force-cap.js'));
  assert.match(fs.readFileSync(path.join(root, 'popup.html'), 'utf8'), /id="featureForceCap"/);
  assert.match(fs.readFileSync(path.join(root, 'popup.js'), 'utf8'), /forceCap: 'featureForceCap'/);
});

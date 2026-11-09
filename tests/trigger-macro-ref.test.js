// 觸發規則的指令欄可以寫 `@巨集 N`（N 是遊戲巨集視窗的第幾列，1～90）：規則命中的當下才去讀遊戲存在 localStorage.MACROS 的那一格，
// 把裡面的指令當巨集（依 ; 與 @等待 拆開依序送出）接在規則其他指令的位置。純函式（macro-io.js）加整個 content script 在 jsdom 裡命中後實際送出的指令。
// 需要 jsdom 的部分沒裝就跳過
const test = require('node:test');
const assert = require('node:assert/strict');
require('../catworld-auto-command/macro-io.js');

const M = globalThis.CatworldMacroIO;
const slots = (...cells) => JSON.stringify(cells.concat(Array(90 - cells.length).fill(0)));

test('macroRef recognises @巨集 N and nothing else', () => {
  assert.equal(M.macroRef('@巨集 3'), 3);
  assert.equal(M.macroRef('  @巨集3  '), 3);
  assert.equal(M.macroRef('@巨集   12'), 12);
  assert.equal(M.macroRef('@巨集 90'), 90);
  ['look', '@巨集', '@巨集 x', '@巨集 3 4', 'look @巨集 3', '@等待 3', '@macro 3', '@巨集 -1', '@巨集 1.5'].forEach(text => assert.equal(M.macroRef(text), null, text));
});

test('expandMacroRefs puts the slot text where the reference was and leaves other commands alone', () => {
  const raw = slots(['65', 'look;@等待 2;pw'], ['', 'eat leg']);
  assert.deepEqual(M.expandMacroRefs(['ps', '@巨集 1', '@巨集 2'], raw), { commands: ['ps', 'look;@等待 2;pw', 'eat leg'], errors: [] });
  assert.deepEqual(M.expandMacroRefs(['ps'], raw), { commands: ['ps'], errors: [] }, 'no reference, nothing read');
  assert.deepEqual(M.expandMacroRefs([], raw), { commands: [], errors: [] });
});

test('a reference that cannot be resolved is dropped with a reason, and the other commands are kept', () => {
  const raw = slots(['65', ''], 0, ['66', '   ']);
  const result = M.expandMacroRefs(['ps', '@巨集 1', '@巨集 2', '@巨集 3', '@巨集 0', '@巨集 91'], raw);
  assert.deepEqual(result.commands, ['ps']);
  assert.equal(result.errors.length, 5);
  assert.match(result.errors[0], /第 1 列.*沒有指令/, 'a key without a command');
  assert.match(result.errors[1], /第 2 列.*沒有指令/, 'an empty row');
  assert.match(result.errors[2], /第 3 列.*沒有指令/, 'blanks only');
  assert.match(result.errors[3], /1～90/);
  assert.match(result.errors[4], /1～90/);
});

test('the game has never saved macros, or the saved text is damaged: nothing runs and it says why', () => {
  assert.match(M.expandMacroRefs(['@巨集 1'], null).errors[0], /還沒有存過巨集/);
  assert.match(M.expandMacroRefs(['@巨集 1'], 'not json').errors[0], /讀不懂/);
  assert.deepEqual(M.expandMacroRefs(['@巨集 1', 'ps'], null).commands, ['ps']);
  assert.deepEqual(M.expandMacroRefs(['ps'], 'not json'), { commands: ['ps'], errors: [] }, 'damaged text does not matter when nothing refers to a slot');
});

test('a reference inside the slot text is not expanded again', () => {
  const raw = slots(['65', '@巨集 2;look'], ['66', 'pw']);
  assert.deepEqual(M.expandMacroRefs(['@巨集 1'], raw).commands, ['@巨集 2;look']);
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
const keyword = (pattern, commands, extra) => ({ kind: 'keyword', enabled: true, pattern, commands, cooldown: 1, ...extra });
const config = rules => ({ rules, delayMax: 0, requireNormal: false });
// 底座的頁面沒有 localStorage：放一個記憶體版的（遊戲存巨集的地方）
const MEMORY_STORAGE = "const mem = {}; Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: key => (key in mem ? mem[key] : null), setItem: (key, value) => { mem[key] = String(value); } } });";
const setMacros = (page, text) => page.w.localStorage.setItem('MACROS', text);

for (const group of ['combat', 'practice']) {
  ui(`a ${group} rule that says @巨集 3 sends what the game keeps in row 3 as a macro`, async () => {
    const { boot, waitFor } = gamePage;
    const page = await boot({ scale: SCALE, preload: MEMORY_STORAGE });
    try {
      setMacros(page, slots(0, 0, ['65', 'look;pw']));
      await page.ask({ type: 'START_TRIGGER', group, config: config([keyword('口渴', ['@巨集 3'])]) });
      page.output('<span>你覺得口渴。</span>');
      assert.ok(await waitFor(() => page.sent.length >= 2, 2000));
      assert.deepEqual(page.sent.slice(0, 2), ['look', 'pw']);
      assert.ok(!page.sent.some(text => text.includes('@巨集')), 'the reference itself is never typed into the game');
    } finally {
      page.close();
    }
  });
}

ui('other commands of the rule keep their place around the macro, and @等待 inside the row waits', async () => {
  const { boot, waitFor } = gamePage;
  const page = await boot({ scale: SCALE, preload: MEMORY_STORAGE });
  try {
    setMacros(page, slots(['65', 'look;@等待 1;pw']));
    await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['eat', '@巨集 1', 'drink'])]) });
    page.output('<span>你覺得口渴。</span>');
    assert.ok(await waitFor(() => page.sent.includes('drink'), 4000));
    assert.deepEqual(page.sent.slice(0, 4), ['eat', 'look', 'pw', 'drink']);
  } finally {
    page.close();
  }
});

ui('the row is read when the rule fires, so a later edit is used the next time', async () => {
  const { boot, waitFor, sleep } = gamePage;
  const page = await boot({ scale: SCALE, preload: MEMORY_STORAGE });
  try {
    setMacros(page, slots(['65', 'look']));
    await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['@巨集 1'])]) });
    page.output('<span>你覺得口渴。</span>');
    assert.ok(await waitFor(() => page.sent.includes('look'), 2000));
    page.output('<span>你看了看四周。</span>'); // 遊戲有回應，看門狗才不會停掉整組
    setMacros(page, slots(['65', 'pw']));
    await sleep(1300); // 規則的冷卻 1 秒用真實時鐘（底座只縮小計時器）
    page.output('<span>你又覺得口渴。</span>');
    assert.ok(await waitFor(() => page.sent.includes('pw'), 3000), 'the edited row is the one that runs');
  } finally {
    page.close();
  }
});

ui('an empty row or macros the game never saved send nothing, and the rule keeps working afterwards', async () => {
  const { boot, waitFor, sleep } = gamePage;
  const page = await boot({ scale: SCALE, preload: MEMORY_STORAGE });
  try {
    await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['@巨集 5']), keyword('肚子餓', ['eat'])]) });
    page.output('<span>你覺得口渴。</span>');
    await sleep(600);
    assert.equal(page.sent.length, 0, 'nothing is sent for a row that is not there');
    page.output('<span>你覺得肚子餓。</span>');
    assert.ok(await waitFor(() => page.sent.includes('eat'), 2000), 'the other rule is not affected');
    const status = await page.ask({ type: 'STATUS' });
    assert.equal(status.triggerGroups.practice.on, true, 'the group is still on');
  } finally {
    page.close();
  }
});

ui('a stop-group rule and a priority rule expand the reference too, and the random number goes on the last command', async () => {
  const { boot, waitFor } = gamePage;
  for (const extra of [{ stopGroup: true }, { priority: true }, { number: { min: 7, max: 7 } }]) {
    const page = await boot({ scale: SCALE, preload: MEMORY_STORAGE });
    try {
      setMacros(page, slots(['65', 'look;pw']));
      await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['@巨集 1'], extra)]) });
      page.output('<span>你覺得口渴。</span>');
      const last = extra.number ? 'pw 7' : 'pw';
      assert.ok(await waitFor(() => page.sent.includes(last), 3000), `${JSON.stringify(extra)}: ${JSON.stringify(page.sent)}`);
      assert.ok(page.sent.includes('look'));
    } finally {
      page.close();
    }
  }
});

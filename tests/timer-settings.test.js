// 定時分頁的固定指令：每個指令一列、各有自己的秒數（timer-settings.js 的 normalizeFixedItems）；
// 舊格式（commands 一行一個 + 共用 minSeconds / maxSeconds）要轉成「一項、指令用 ; 接起來」，行為才和以前「每輪全部依序送出」一樣
const test = require('node:test');
const assert = require('node:assert/strict');
require('../catworld-auto-command/timer-settings.js');

const T = globalThis.CatworldTimer;

test('fixed items: new format is cleaned, blank rows dropped, seconds clamped', () => {
  const items = T.normalizeFixedItems({ fixedItems: [
    { command: ' ps ', minSeconds: 5, maxSeconds: 3 },
    { command: '', minSeconds: 1, maxSeconds: 2 },
    { command: 'px', minSeconds: 0, maxSeconds: 'x' },
  ] });
  assert.deepEqual(items, [
    { command: 'ps', minSeconds: 5, maxSeconds: 5 },
    { command: 'px', minSeconds: 30, maxSeconds: 30 },
  ]);
  assert.deepEqual(T.normalizeFixedItems({ fixedItems: [] }), [], 'an emptied list stays empty');
});

test('fixed items: old format (one list + shared seconds) becomes one item joined with ;', () => {
  assert.deepEqual(T.normalizeFixedItems({ commands: ['ps', 'px', ' '], minSeconds: 20, maxSeconds: 25 }),
    [{ command: 'ps;px', minSeconds: 20, maxSeconds: 25 }]);
  assert.deepEqual(T.normalizeFixedItems({ commands: ['ps'] }), [{ command: 'ps', minSeconds: 30, maxSeconds: 40 }]);
  assert.deepEqual(T.normalizeFixedItems({ commands: [], minSeconds: 20, maxSeconds: 25 }), [], 'old settings with no fixed command');
});

test('fixed items: never configured gives the default ps;px 30~40', () => {
  assert.deepEqual(T.normalizeFixedItems({}), [{ command: 'ps;px', minSeconds: 30, maxSeconds: 40 }]);
  assert.deepEqual(T.normalizeFixedItems(undefined), [{ command: 'ps;px', minSeconds: 30, maxSeconds: 40 }]);
  assert.deepEqual(T.normalizeFixedItems({ randomItems: [{ command: 'look', minSeconds: 5, maxSeconds: 6 }] }),
    [{ command: 'ps;px', minSeconds: 30, maxSeconds: 40 }]);
});

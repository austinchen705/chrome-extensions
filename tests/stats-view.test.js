const test = require('node:test');
const assert = require('node:assert/strict');
require(process.env.STATS_VIEW_SOURCE || '../catworld-auto-command/stats-view.js');

const V = globalThis.CatworldStatsView;
const ORDER = ['經驗', '精', '氣', '神', '靈力', '內力', '法力', '食物', '飲水'];
// 照遊戲狀態視窗真實讀到的畫面（內力、靈力、法力的目前值可以是上限的兩倍）
const SAMPLE = {
  精: { value: 1452, max: 1452 }, 氣: { value: 35, max: 3654 }, 神: { value: 714, max: 714 },
  靈力: { value: 2080, max: 1040 }, 內力: { value: 6380, max: 3190 }, 法力: { value: 800, max: 400 },
  食物: { value: 805, max: 900 }, 飲水: { value: 532, max: 900 },
};
const byLabel = rows => Object.fromEntries(rows.map(row => [row.label, row]));

test('every row shows 目前值／上限（百分比） and the experience shows only its current value', () => {
  const rows = byLabel(V.rows(SAMPLE, 414748));
  assert.equal(rows.經驗.text, '414748');
  assert.equal(rows.經驗.percent, null);
  assert.equal(rows.精.text, '1452/1452（100%）');
  assert.equal(rows.氣.text, '35/3654（1%）');
  assert.equal(rows.食物.text, '805/900（89%）');
});

test('a current value above the maximum is shown as it is, not squashed to 100%', () => {
  const rows = byLabel(V.rows(SAMPLE, 1));
  assert.equal(rows.內力.text, '6380/3190（200%）');
  assert.equal(rows.內力.percent, 200);
  assert.equal(rows.靈力.text, '2080/1040（200%）');
  assert.equal(rows.法力.percent, 200);
});

test('the rows come in a fixed order: experience first, then the stats in the order the trigger engine reads them', () => {
  assert.deepEqual(V.rows(SAMPLE, 1).map(row => row.label), ORDER);
  assert.deepEqual(V.rows({}, NaN).map(row => row.label), ORDER, 'unreadable rows are still there');
});

test('a reading that cannot be read shows a dash and does not affect the others', () => {
  const rows = byLabel(V.rows({ ...SAMPLE, 氣: null, 神: undefined, 精: { value: NaN, max: 100 } }, NaN));
  assert.equal(rows.氣.text, '—');
  assert.equal(rows.神.text, '—');
  assert.equal(rows.精.text, '—');
  assert.equal(rows.經驗.text, '—');
  assert.equal(rows.內力.text, '6380/3190（200%）');
});

test('no percentage when the maximum is zero or unreadable', () => {
  const rows = byLabel(V.rows({ ...SAMPLE, 精: { value: 800, max: 0 }, 氣: { value: 35, max: NaN }, 神: { value: 5, max: -3 } }, 0));
  assert.equal(rows.精.text, '800/0');
  assert.equal(rows.精.percent, null);
  assert.equal(rows.氣.text, '35/—');
  assert.equal(rows.氣.percent, null);
  assert.equal(rows.神.text, '5/—', 'a negative maximum is nonsense, treated as unreadable');
  assert.equal(rows.經驗.text, '0', 'zero experience is a real value');
});

test('a current value of zero is shown as 0 with its percentage', () => {
  const rows = byLabel(V.rows({ ...SAMPLE, 食物: { value: 0, max: 900 } }, 1));
  assert.equal(rows.食物.text, '0/900（0%）');
  assert.equal(rows.食物.percent, 0);
});

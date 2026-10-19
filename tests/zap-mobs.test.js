const test = require('node:test');
const assert = require('node:assert/strict');
require('../catworld-auto-command/zap-mobs.js');

const Z = globalThis.CatworldZapMobs;
const E = 414748;

const mob = (name, exp, location = '', extra = {}) => ({
  name,
  id: /\(([^)]*)\)\s*$/.exec(name)?.[1].toLowerCase() ?? '',
  exp,
  location,
  note: '',
  source: 'zap',
  ...extra,
});

test('gradeOf calibration points from real play', () => {
  const green = Z.gradeOf(250000, E);
  assert.equal(green.grade, 'green');
  assert.ok(Math.abs(green.q - 1.2056) < 0.001);
  assert.equal(Z.gradeOf(500000, E).grade, 'yellow');
  assert.equal(Z.gradeOf(207374, E).grade, 'white');
  assert.equal(Z.gradeOf(2000000, E).grade, 'red');
});

test('gradeOf is unknown when strength or exp is unusable', () => {
  const unknown = { q: null, grade: 'unknown' };
  assert.deepEqual(Z.gradeOf(null, E), unknown);
  assert.deepEqual(Z.gradeOf(250000, NaN), unknown);
  assert.deepEqual(Z.gradeOf(250000, 0), unknown);
  assert.deepEqual(Z.gradeOf(250000, -5), unknown);
});

test('normalizeThresholds falls back to defaults unless 1 < greenMax < yellowMax', () => {
  [{ greenMax: 0.5, yellowMax: 3 }, { greenMax: 3, yellowMax: 2 }, undefined, { greenMax: 'a' }]
    .forEach(raw => assert.deepEqual(Z.normalizeThresholds(raw), Z.DEFAULT_THRESHOLDS));
  assert.deepEqual(Z.normalizeThresholds({ greenMax: 2, yellowMax: 4 }), { greenMax: 2, yellowMax: 4 });
});

test('parseMobLines reads the sample room and merges repeated lines', () => {
  const text = [
    '迴廊 - ',
    '    你正站在迴廊轉角的地方，迴廊從這往東及北邊而去。',
    '    這裡明顯的出口是 north 和 east。',
    '  ※第四代全真弟子(alltruth taoist) [fight][kill]',
    '  ※第四代全真弟子(alltruth taoist) [fight][kill]',
    '  ※第四代全真弟子(alltruth taoist) [fight][kill]',
  ].join('\n');
  assert.deepEqual(Z.parseMobLines(text), [{ name: '第四代全真弟子(alltruth taoist)', count: 3 }]);
});

test('parseMobLines tolerates full-width parens, extra spaces and any tag set', () => {
  const [first] = Z.parseMobLines('※護衛團 蒙古兵（Guard）  [fight][kill][look]');
  assert.equal(Z.normalizeName(first.name), Z.normalizeName('護衛團 蒙古兵(Guard)'));
  const many = Array(20).fill('※老虎(tiger) [fight][kill]').join('\n');
  assert.deepEqual(Z.parseMobLines(many), [{ name: '老虎(tiger)', count: 20 }]);
  const two = Z.parseMobLines('※老虎(tiger) [fight]\n※野狗(Dog) [fight]\n※老虎(tiger) [fight]');
  assert.deepEqual(two.map(item => [item.name, item.count]), [['老虎(tiger)', 2], ['野狗(Dog)', 1]]);
});

test('parseMobLines ignores lines that do not start with ※', () => {
  assert.deepEqual(Z.parseMobLines('【謠言】某人﹕老虎(tiger)出現了'), []);
  assert.deepEqual(Z.parseMobLines('你說道：※老虎(tiger)'), []);
  assert.deepEqual(Z.parseMobLines('老虎(tiger) [fight][kill]'), []);
});

test('findMobs matches full name first, falls back to id only', () => {
  const mobs = [mob('老虎(tiger)', 105000, '桃花島'), mob('老虎(tiger)', 500, '長安城')];
  const full = Z.findMobs(mobs, '老虎(TIGER)');
  assert.equal(full.length, 2);
  assert.ok(full.every(hit => hit.idOnly === false));
  const byId = Z.findMobs(mobs, '某前綴 老虎(tiger)');
  assert.equal(byId.length, 2);
  assert.ok(byId.every(hit => hit.idOnly === true));
  assert.deepEqual(Z.findMobs(mobs, '不存在(nobody)'), []);
});

test('describe gives no candidates for an unknown mob', () => {
  const [result] = Z.describe([mob('老虎(tiger)', 500)], [{ name: '不存在(nobody)', count: 1 }], E);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.count, 1);
});

test('describe grades every candidate of a same-name mob', () => {
  const mobs = [mob('老虎(tiger)', 105000, '桃花島'), mob('老虎(tiger)', 500, '長安城')];
  const [result] = Z.describe(mobs, [{ name: '老虎(tiger)', count: 1 }], 100000);
  assert.deepEqual(result.candidates.map(c => [c.mob.location, c.grade]), [['桃花島', 'yellow'], ['長安城', 'white']]);
});

test('suitable returns green by default, sorted by strength', () => {
  const mobs = [mob('甲(a)', 250000, '蒙古'), mob('乙(b)', 60000, '襄陽'), mob('丙(c)', null, '蒙古')];
  assert.deepEqual(Z.suitable(mobs, E).map(item => item.mob.name), ['甲(a)']);
  const wide = Z.suitable(mobs, E, undefined, { grades: ['green', 'yellow', 'white'] });
  assert.deepEqual(wide.map(item => item.mob.name), ['甲(a)', '乙(b)']);
  const mongol = Z.suitable(mobs, E, undefined, { grades: ['green', 'white'], query: '蒙古' });
  assert.deepEqual(mongol.map(item => item.mob.name), ['甲(a)']);
  assert.deepEqual(Z.suitable(mobs, NaN), []);
});

test('handleMessage answers ZAP_SUITABLE and ignores other types', () => {
  const mobs = [mob('甲(a)', 250000, '蒙古')];
  const reply = Z.handleMessage(mobs, { type: 'ZAP_SUITABLE', exp: E });
  assert.equal(reply.ok, true);
  assert.equal(reply.total, 1);
  assert.equal(reply.items.length, 1);
  assert.equal(Z.handleMessage(mobs, { type: 'START' }), null);
});

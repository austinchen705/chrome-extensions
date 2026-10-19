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

test('limitHints keeps the first max items and counts the rest', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ name: `怪${i}(m${i})`, count: 1 }));
  const { shown, hidden } = Z.limitHints(items, 8);
  assert.equal(shown.length, 8);
  assert.equal(hidden, 4);
  assert.deepEqual(Z.limitHints(items.slice(0, 3), 8), { shown: items.slice(0, 3), hidden: 0 });
});

test('recentFilter suppresses names shown within the window', () => {
  const last = {};
  assert.deepEqual(Z.recentFilter(['a'], 1000, last, 10000), ['a']);
  assert.deepEqual(Z.recentFilter(['a'], 5000, last, 10000), []);
  assert.deepEqual(Z.recentFilter(['a', 'b'], 5000, last, 10000), ['b']);
  assert.deepEqual(Z.recentFilter(['a'], 12000, last, 10000), ['a']);
});

test('parseMobLines strips status markers the game puts after the name', () => {
  const text = [
    '  ※千夫長 蒙古兵(guard) <昏迷不醒> [fight][kill]',
    '  ※橫霸四方 忽必烈(king) <戰鬥中> [fight][kill]',
    '  ※大臣(noble) [fight][kill]',
  ].join('\n');
  assert.deepEqual(Z.parseMobLines(text).map(item => item.name), ['千夫長 蒙古兵(guard)', '橫霸四方 忽必烈(king)', '大臣(noble)']);
});

test('textFromAdded joins node texts with no separator, so a line split across spans parses', () => {
  const pieces = ['  ', '※', '千夫長', ' 蒙古兵(guard)', ' <戰鬥中>', ' ', '[fight][kill]', '\n  ', '※', '橫霸四方', ' 忽必烈(king) ', '[fight][kill]'];
  assert.deepEqual(Z.parseMobLines(Z.textFromAdded(pieces)).map(item => item.name), ['千夫長 蒙古兵(guard)', '橫霸四方 忽必烈(king)']);
});

test('findMobs ignores spacing differences between the game and the table', () => {
  const mobs = [mob('猛虎大將軍蒙古將軍(General)', 500000, '蒙古'), mob('征南大將軍 蒙古將軍(general)', 450000, '襄陽')];
  const hits = Z.findMobs(mobs, '猛虎大將軍 蒙古將軍(general)');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].idOnly, false);
  assert.equal(hits[0].mob.exp, 500000);
});

test('metaText keeps a known strength when the grade is unavailable', () => {
  const known = { mob: { exp: 250000, location: '蒙古', note: '' }, q: null, idOnly: false };
  assert.match(Z.metaText(known), /強度 250000/);
  assert.doesNotMatch(Z.metaText(known), /強度未知/);
  assert.match(Z.metaText({ mob: { exp: null, location: '隨機出現', note: '' }, q: null, idOnly: false }), /強度未知/);
  assert.match(Z.metaText({ mob: { exp: 250000, location: '蒙古', note: '' }, q: 1.2056, idOnly: true }), /q=1\.21.*僅 ID 命中/);
});

test('gradeOf matches the game colours the user observed at exp 416944', () => {
  const E2 = 416944;
  assert.equal(Z.gradeOf(250000, E2).grade, 'green', '忽必烈');
  assert.equal(Z.gradeOf(370000, E2).grade, 'green', '丐幫長老：強度比經驗小');
  assert.equal(Z.gradeOf(390000, E2).grade, 'green', '六合門 夏老：強度比經驗小');
  assert.equal(Z.gradeOf(500000, E2).grade, 'yellow', '猛虎大將軍 蒙古將軍：強度比經驗大');
});

const routes = [
  { name: '華山', path: 't 2s nw w t' },
  { name: '蒙古', path: 't 4n 2w t' },
  { name: '天魔塔', path: 't 9n' },
  { name: '襄陽城', path: 't 3e' },
  { name: '冰火島', path: 't 5s' },
  { name: '礦坑', path: 't 2w' },
  { name: '黑木崖', path: 't 6n' },
];

test('routeFor matches a location name exactly', () => {
  const hit = Z.routeFor('華山', routes);
  assert.equal(hit.exact, true);
  assert.equal(hit.route.name, '華山');
});

test('routeFor accepts a location that starts with the place name, or the other way round', () => {
  assert.deepEqual([Z.routeFor('天魔塔2f', routes).route.name, Z.routeFor('天魔塔2f', routes).exact], ['天魔塔', false]);
  assert.equal(Z.routeFor('冰火島沙灘', routes).route.name, '冰火島');
  assert.equal(Z.routeFor('襄陽', routes).route.name, '襄陽城');
});

test('routeFor does not guess when the place only appears inside the location name', () => {
  assert.equal(Z.routeFor('往黑木崖渡口', routes), null);
  assert.equal(Z.routeFor('金礦坑南方小鎮', routes), null);
  assert.equal(Z.routeFor('隨機出現', routes), null);
  assert.equal(Z.routeFor('', routes), null);
  assert.equal(Z.routeFor(undefined, routes), null);
});

test('routeFor prefers an exact token, then the longest partial one', () => {
  assert.equal(Z.routeFor('襄陽、華山', routes).route.name, '華山', 'an exact token beats an earlier partial one');
  const longer = [{ name: '天魔', path: 'a' }, { name: '天魔塔', path: 'b' }];
  assert.equal(Z.routeFor('天魔塔1f', longer).route.name, '天魔塔');
});

test('routeCommand starts from the inn like every other map path', () => {
  assert.equal(Z.routeCommand({ name: '華山', path: 't 2s nw w t' }), 'run e 5n 2o t 2s nw w t');
});

test('handleMessage attaches the route to monster candidates and to the suitable list', () => {
  const mobs = [mob('甲(a)', 250000, '華山'), mob('乙(b)', 250000, '三絕門')];
  const lookup = Z.handleMessage(mobs, { type: 'ZAP_LOOKUP', exp: E, names: [{ name: '甲(a)', count: 1 }, { name: '乙(b)', count: 1 }] }, routes);
  assert.equal(lookup.items[0].candidates[0].route.route.name, '華山');
  assert.equal(lookup.items[1].candidates[0].route, null);
  const list = Z.handleMessage(mobs, { type: 'ZAP_SUITABLE', exp: E }, routes);
  assert.equal(list.items.find(item => item.mob.name === '甲(a)').route.route.path, 't 2s nw w t');
  assert.equal(list.items.find(item => item.mob.name === '乙(b)').route, null);
});

test('most real mobs get a route from the real data', () => {
  const data = require('../catworld-auto-command/zap-data.json');
  const withRoute = data.mobs.filter(entry => Z.routeFor(entry.location, data.routes));
  assert.ok(withRoute.length / data.mobs.length > 0.6, `only ${withRoute.length}/${data.mobs.length}`);
});

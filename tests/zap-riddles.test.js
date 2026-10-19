const test = require('node:test');
const assert = require('node:assert/strict');
require('../catworld-auto-command/zap-riddles.js');

const R = globalThis.CatworldZapRiddles;
const stats = { exp: 414748, force: 2022 };

test('parseCondition covers every form in the index', () => {
  assert.deepEqual(R.parseCondition('無'), { exp: null, force: null, unreadable: false });
  assert.deepEqual(R.parseCondition('2 萬 EXP'), { exp: 20000, force: null, unreadable: false });
  assert.equal(R.parseCondition('80 萬 EXP').exp, 800000);
  assert.deepEqual(R.parseCondition('內力 2000'), { exp: null, force: 2000, unreadable: false });
  assert.deepEqual(R.parseCondition('內力 300 [天賦]'), { exp: null, force: 300, unreadable: true });
  assert.deepEqual(R.parseCondition('內力 ???? [天賦]'), { exp: null, force: null, unreadable: true });
  ['龍掌相關技能70', '製藥學技能 161', '需為新手', '未知', '不一定'].forEach(text => assert.equal(R.parseCondition(text).unreadable, true, text));
  assert.deepEqual(R.parseCondition('50 萬 EXP [註]'), { exp: 500000, force: null, unreadable: true });
});

test('classify uses exp and max force', () => {
  assert.equal(R.classify('無', stats), 'ok');
  assert.equal(R.classify('20 萬 EXP', stats), 'ok');
  assert.equal(R.classify('80 萬 EXP', stats), 'unmet');
  assert.equal(R.classify('內力 2000', stats), 'ok');
  assert.equal(R.classify('內力 2500', stats), 'unmet');
  assert.equal(R.classify('內力 300 [天賦]', stats), 'check');
  assert.equal(R.classify('150 萬 EXP [註]', stats), 'unmet');
  assert.equal(R.classify('需為新手', stats), 'check');
});

test('classify treats unreadable stats as check, not unmet', () => {
  const unknown = { exp: NaN, force: NaN };
  assert.equal(R.classify('80 萬 EXP', unknown), 'check');
  assert.equal(R.classify('內力 2000', unknown), 'check');
  assert.equal(R.classify('無', unknown), 'ok');
});

test('unmet beats check', () => {
  assert.equal(R.classify('內力 300 [天賦]', { exp: 414748, force: 100 }), 'unmet');
});

const riddle = (name, difficulty, extra = {}) => ({ id: `x/${name}`, category: 'x', name, condition: '無', hint: '', difficulty, reward: '', page: null, shared: [], ...extra });

test('groupRiddles sorts by difficulty then original order', () => {
  const list = [riddle('A', '難'), riddle('B', '極易'), riddle('C', '極易'), riddle('D', '????'), riddle('E', '一般')];
  assert.deepEqual(R.groupRiddles(list, stats).ok.map(item => item.name), ['B', 'C', 'E', 'A', 'D']);
});

test('groupRiddles splits riddles into the three groups', () => {
  const list = [riddle('ok', '易'), riddle('check', '易', { condition: '未知' }), riddle('unmet', '易', { condition: '80 萬 EXP' })];
  const groups = R.groupRiddles(list, stats);
  assert.deepEqual([groups.ok.length, groups.check.length, groups.unmet.length], [1, 1, 1]);
  assert.equal(groups.unmet[0].name, 'unmet');
});

test('searchRiddles matches name, hint, reward and category', () => {
  const list = [
    riddle('獨孤九劍', '極易', { hint: '風清揚', reward: '學會此技能', category: '技能類' }),
    riddle('屠龍刀', '易', { hint: '冰火島', reward: '屠龍刀', category: '治裝類' }),
  ];
  assert.deepEqual(R.searchRiddles(list, '九劍').map(item => item.name), ['獨孤九劍']);
  assert.deepEqual(R.searchRiddles(list, '冰火').map(item => item.name), ['屠龍刀']);
  assert.deepEqual(R.searchRiddles(list, '學會').map(item => item.name), ['獨孤九劍']);
  assert.deepEqual(R.searchRiddles(list, '治裝').map(item => item.name), ['屠龍刀']);
  assert.equal(R.searchRiddles(list, '').length, 2);
  assert.equal(R.searchRiddles(list, ' 屠 龍 ').length, 1);
});

test('splitCommands drops empty pieces', () => {
  assert.deepEqual(R.splitCommands('run e;;give a to b; '), ['run e', 'give a to b']);
  assert.deepEqual(R.splitCommands('run e；look'), ['run e', 'look']);
  assert.equal(R.joinCommands(R.splitCommands(' run e ; look ')), 'run e;look');
});

const page = { steps: [{ no: 1, text: 'a', commands: 'run e' }, { no: 2, text: 'b', commands: '' }, { no: 3, text: 'c', commands: 'look' }] };

test('effectiveStep prefers the edit, then the site, then none', () => {
  const edits = { 'p.htm': { n: 3, cmds: { 1: 'north' } } };
  assert.deepEqual(R.effectiveStep(page, 1, edits, 'p.htm'), { commands: 'north', source: 'edited', stale: false });
  assert.deepEqual(R.effectiveStep(page, 3, edits, 'p.htm'), { commands: 'look', source: 'site', stale: false });
  assert.deepEqual(R.effectiveStep(page, 2, edits, 'p.htm'), { commands: '', source: 'none', stale: false });
  assert.equal(R.effectiveStep(page, 9, edits, 'p.htm').source, 'none');
});

test('effectiveStep flags stale edits when the step count changed', () => {
  assert.equal(R.effectiveStep(page, 1, { 'p.htm': { n: 5, cmds: { 2: 'x' } } }, 'p.htm').stale, true);
  assert.equal(R.effectiveStep(page, 1, { 'p.htm': { n: 3, cmds: { 2: 'x' } } }, 'p.htm').stale, false);
  assert.equal(R.effectiveStep(page, 1, {}, 'p.htm').stale, false);
});

test('setEdit adds, removes and does not mutate', () => {
  const before = {};
  const added = R.setEdit(before, 'p.htm', 3, 2, 'look');
  assert.deepEqual(before, {});
  assert.deepEqual(added, { 'p.htm': { n: 3, cmds: { 2: 'look' } } });
  const two = R.setEdit(added, 'p.htm', 3, 1, 'run e');
  assert.deepEqual(two['p.htm'].cmds, { 1: 'run e', 2: 'look' });
  const removed = R.setEdit(two, 'p.htm', 3, 2, '  ');
  assert.deepEqual(removed['p.htm'].cmds, { 1: 'run e' });
  assert.deepEqual(two['p.htm'].cmds, { 1: 'run e', 2: 'look' });
  assert.deepEqual(R.setEdit(removed, 'p.htm', 3, 1, ''), {});
});

test('parseImport rejects malformed input', () => {
  const bad = [
    'not json',
    '{}',
    JSON.stringify({ riddleCommands: { 'p.htm': { n: 'x', cmds: {} } }, riddleDone: {} }),
    JSON.stringify({ riddleCommands: { 'p.htm': { n: 3, cmds: { 1: 5 } } }, riddleDone: {} }),
    JSON.stringify({ riddleCommands: {}, riddleDone: { a: 'yes' } }),
  ];
  bad.forEach(text => assert.equal(R.parseImport(text).ok, false, text));
  const good = R.parseImport(JSON.stringify({ riddleCommands: { 'p.htm': { n: 3, cmds: { 1: 'run e' } } }, riddleDone: { 'x/a': true } }));
  assert.equal(good.ok, true);
  assert.deepEqual(good.riddleDone, { 'x/a': true });
  assert.equal(good.riddleCommands['p.htm'].cmds['1'], 'run e');
});

test('handleMessage answers ZAP_RIDDLES and ignores other types', () => {
  const data = { riddles: [riddle('A', '易')], pages: { 'p.htm': { steps: [], text: 't' } } };
  const reply = R.handleMessage(data, { type: 'ZAP_RIDDLES' });
  assert.equal(reply.ok, true);
  assert.equal(reply.riddles.length, 1);
  assert.equal(reply.pages['p.htm'].text, 't');
  assert.deepEqual(R.handleMessage({}, { type: 'ZAP_RIDDLES' }), { ok: true, riddles: [], pages: {} });
  assert.equal(R.handleMessage(data, { type: 'ZAP_ITEM' }), null);
});

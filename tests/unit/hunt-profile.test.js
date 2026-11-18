const test = require('node:test');
const assert = require('node:assert/strict');
require('../../catworld-auto-command/hunt-profile.js');
const P = globalThis.CatworldHuntProfile;

const send = (at, command) => ({ at, kind: 'send', command });
const sendAll = (start, step, commands) => commands.map((command, index) => send(start + index * step, command));

test('classify: walk, look, attack by the settings, and everything else', () => {
  assert.equal(P.classify('n'), 'walk');
  assert.equal(P.classify('2e'), 'walk');
  assert.equal(P.classify('su'), 'walk');
  assert.equal(P.classify('l'), 'look');
  assert.equal(P.classify('k 1'), 'attack');
  assert.equal(P.classify('fight 2'), 'attack');
  assert.equal(P.classify('k'), 'other', 'no target, not an attack');
  assert.equal(P.classify('pp'), 'other');
  assert.equal(P.classify('run e 5n'), 'other');
  assert.equal(P.classify('hit 1'), 'other');
  assert.equal(P.classify('hit 1', { fightCommand: 'hit' }), 'attack');
  assert.equal(P.classify('smash 3', { killCommand: 'smash' }), 'attack');
  assert.equal(P.classify(''), 'other');
});

test('extract: a sequence like the real manual record counts the typo and the k attack verb', () => {
  // 使用者真實紀錄的開頭：runtxiang→runtoxiang 打錯字改正，走路、k 1 開打、pp 特攻、倒下後 l edf gc
  const events = [
    ...sendAll(0, 1500, ['runtxiang', 'runtoxiang', 's', 's', 's', 'n', 'e', 'e', 'e']),
    { at: 13500, kind: 'room', room: 'x/1' },
    send(14800, 'k 1'), send(16000, 'pp'), send(17200, 'pp'),
    { at: 17900, kind: 'down' },
    send(18500, 'l'), send(19500, 'edf'), send(20500, 'gc'), send(21500, 'l'),
    send(23000, 's'), send(24200, 's'),
  ];
  const out = P.extract(events);
  assert.equal(out.commands, 18);
  assert.equal(out.typos, 1);
  assert.equal(out.rooms, 1);
  assert.equal(out.downs, 1);
  assert.deepEqual(out.firstAttack, { k: 1 });
  assert.deepEqual(out.reactGaps, [1300]);
  assert.deepEqual(out.afterDown, { 'l;edf;gc;l': 1 });
  assert.deepEqual(out.habitKill, { l: 2, edf: 1 });
  assert.deepEqual(out.fights, [[{ cmd: 'pp', count: 2, gaps: [1200] }]]);
  assert.deepEqual(out.walkGaps, [1500, 1500, 1500, 1500, 1500, 1500, 1200]);
});

test('extract: walk gaps over 5 seconds, and reactions over 8 seconds, are not samples', () => {
  const out = P.extract([send(0, 'n'), send(5000, 'n'), send(10001, 'n'), { at: 11000, kind: 'room', room: 'a/b' }, send(19001, 'k 1')]);
  assert.deepEqual(out.walkGaps, [5000]);
  assert.deepEqual(out.reactGaps, []);
});

test('extract: a look also starts a reaction, and only the first attack after it counts', () => {
  const out = P.extract([send(0, 'l'), send(900, 'k 1'), send(1500, 'k 2')]);
  assert.deepEqual(out.reactGaps, [900]);
  assert.deepEqual(out.firstAttack, { k: 1 });
});

test('extract: the attack right after a knockout inside 10 seconds is the finishing verb, later ones are not', () => {
  const near = P.extract([send(0, 'f 1'), { at: 1000, kind: 'knockout' }, send(4000, 'k 1')]);
  assert.deepEqual(near.knockoutAttack, { k: 1 });
  const late = P.extract([{ at: 0, kind: 'knockout' }, send(11000, 'k 1')]);
  assert.deepEqual(late.knockoutAttack, {});
});

test('extract: after a down, repeated commands collapse (gc x4 is gc), and the window ends at the next walk', () => {
  const out = P.extract([
    { at: 0, kind: 'down' }, send(500, 'gc'), send(900, 'gc'), send(1300, 'gc'), send(1700, 'gc'), send(2200, 'edf'), send(2800, 'n'), send(3200, 'gc'),
  ]);
  assert.deepEqual(out.afterDown, { 'gc;edf': 1 });
  const slow = P.extract([{ at: 0, kind: 'down' }, send(11000, 'gc')]);
  assert.deepEqual(slow.afterDown, {}, 'over 10 seconds is not the after-kill routine');
});

test('extract: a fight only keeps commands repeated inside it, with their gaps, and a fight with no down is dropped', () => {
  const out = P.extract([
    send(0, 'k 1'), send(1000, 'pf'), send(3000, 'pf'), send(7000, 'pf'), send(7500, 'ca'), { at: 8000, kind: 'down' },
    send(9000, 'k 2'), send(9500, 'pp'), send(10000, 'pp'), send(10500, 'n'),
  ]);
  assert.deepEqual(out.fights, [[{ cmd: 'pf', count: 3, gaps: [2000, 4000] }]]);
});

test('extract: typos need two letters, an edit distance of one, within 5 seconds, and not a doubling or two walks', () => {
  assert.equal(P.extract([send(0, 'bw'), send(800, 'nw')]).typos, 1);
  assert.equal(P.extract([send(0, 'k @'), send(800, 'k 2')]).typos, 1);
  assert.equal(P.extract([send(0, 'nw'), send(800, 'ne')]).typos, 0, 'two walks');
  assert.equal(P.extract([send(0, 'ss'), send(800, 's')]).typos, 0, 'a doubling is a repeat');
  assert.equal(P.extract([send(0, 'e'), send(800, 'w')]).typos, 0, 'one letter');
  assert.equal(P.extract([send(0, 'bw'), send(6000, 'nw')]).typos, 0, 'too slow');
});

test('extract: habit commands after arriving skip the first look, and stop at the first walk or attack', () => {
  const out = P.extract([
    { at: 0, kind: 'room', room: 'a/b' }, send(500, 'l'), send(1000, 'hp'), send(1500, 'l'), send(2000, 'k 1'), send(2500, 'i'),
  ]);
  assert.deepEqual(out.habitArrive, { hp: 1, l: 1 });
});

test('extract: garbage events are ignored', () => {
  const out = P.extract([null, { kind: 'send' }, { at: 'x', kind: 'send', command: 'n' }, send(0, '')]);
  assert.equal(out.commands, 0);
  assert.equal(P.extract('nope').commands, 0);
});

test('merge: counts add up, segments go up by one, and each sample list keeps only the newest', () => {
  const first = P.merge(undefined, { commands: 3, typos: 1, rooms: 2, downs: 1, walkGaps: [100, 200], firstAttack: { k: 2 } });
  assert.equal(first.segments, 1);
  const second = P.merge(first, { commands: 4, rooms: 1, walkGaps: [300], firstAttack: { k: 1, fight: 1 } });
  assert.equal(second.segments, 2);
  assert.equal(second.commands, 7);
  assert.equal(second.rooms, 3);
  assert.deepEqual(second.walkGaps, [100, 200, 300]);
  assert.deepEqual(second.firstAttack, { k: 3, fight: 1 });
  const many = P.merge({ walkGaps: Array.from({ length: P.SAMPLE_MAX }, (_, i) => i) }, { walkGaps: [9001, 9002] });
  assert.equal(many.walkGaps.length, P.SAMPLE_MAX);
  assert.deepEqual(many.walkGaps.slice(-2), [9001, 9002]);
  assert.equal(many.walkGaps[0], 2);
  assert.deepEqual(first.firstAttack, { k: 2 }, 'the input is not changed');
});

test('merge: a count table keeps the most used keys', () => {
  const big = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`cmd${i}`, 5]));
  const out = P.merge({ afterDown: big }, { afterDown: { top: 9 } });
  assert.equal(Object.keys(out.afterDown).length, 100);
  assert.equal(out.afterDown.top, 9);
});

test('normalizeProfile: garbage becomes an empty profile, bad fields are dropped and good ones kept', () => {
  [null, undefined, 'x', 5, [], [1, 2]].forEach(raw => assert.deepEqual(P.normalizeProfile(raw), P.emptyProfile()));
  const out = P.normalizeProfile({
    segments: 2.5, commands: -1, rooms: 4, downs: '3', walkGaps: [100, 'x', NaN, -5, 200], reactGaps: 'no',
    firstAttack: { k: 3, '': 2, bad: -1, half: 1.5 }, afterDown: [1], habitArrive: { l: 2 },
    fights: [[{ cmd: 'pp', count: 3, gaps: [1000, 'x'] }, { cmd: 'z', count: 1 }], 'no', []],
  });
  assert.equal(out.segments, 0);
  assert.equal(out.commands, 0);
  assert.equal(out.rooms, 4);
  assert.equal(out.downs, 0);
  assert.deepEqual(out.walkGaps, [100, 200]);
  assert.deepEqual(out.reactGaps, []);
  assert.deepEqual(out.firstAttack, { k: 3 });
  assert.deepEqual(out.afterDown, {});
  assert.deepEqual(out.habitArrive, { l: 2 });
  assert.deepEqual(out.fights, [[{ cmd: 'pp', count: 3, gaps: [1000] }]]);
});

test('stops: a room counts as a stop only when a non-walk command follows before the next walk or room', () => {
  const events = [
    { at: 0, kind: 'room', room: 'a/1' }, send(500, 'n'),
    { at: 1000, kind: 'room', room: 'a/2' }, { at: 1500, kind: 'room', room: 'a/3' },
    { at: 2000, kind: 'room', room: 'a/4' }, send(2500, 'l'), send(3000, 'hp'), send(3500, 'e'),
    { at: 4000, kind: 'room', room: 'a/5' }, send(4500, 'k 1'),
  ];
  const out = P.extract(events);
  assert.equal(out.rooms, 5);
  assert.equal(out.stops, 2, 'only the rooms where the player did something');
  assert.equal(P.merge(P.merge(undefined, out), out).stops, 4);
  assert.equal(P.normalizeProfile({ rooms: 3 }).stops, 0, 'an old stored profile reads as 0');
  assert.equal(P.emptyProfile().stops, 0);
});

const FIELDS = [
  { key: 'commandGapMinMs', label: '指令間隔最短', min: 0, max: 3000 },
  { key: 'commandGapMaxMs', label: '最長', min: 0, max: 3000 },
  { key: 'reactMinMs', label: '反應最短', min: 0, max: 5000 },
  { key: 'reactMaxMs', label: '反應最長', min: 0, max: 5000 },
  { key: 'fightCommand', label: '開打用的指令' },
  { key: 'killCommand', label: '打死用的指令' },
  { key: 'specialCommand', label: '特攻指令' },
  { key: 'specialIntervalSec', label: '最小間隔（秒）', min: 1, max: 600 },
  { key: 'afterKillCommand', label: '怪倒下後送的指令' },
  { key: 'typoPercent', label: '打錯字機率 %', min: 0, max: 20 },
];
const rowOf = (rows, key) => rows.find(row => row.keys[0] === key);
const SETTINGS = { commandGapMinMs: 1000, commandGapMaxMs: 2000, reactMinMs: 800, reactMaxMs: 1500, fightCommand: 'fight', killCommand: 'kill', specialCommand: '', specialIntervalSec: 10, afterKillCommand: 'gc', typoPercent: 2 };

test('suggest: an empty profile asks for more data on every row, without values', () => {
  const rows = P.suggest(undefined, SETTINGS, FIELDS);
  assert.equal(rows.length, 7);
  rows.forEach(row => { assert.equal(row.enough, false); assert.equal(row.value, null); assert.ok(row.need > 0); });
  assert.equal(rowOf(rows, 'commandGapMinMs').need, 30);
  assert.equal(rowOf(rows, 'typoPercent').need, 200);
});

test('suggest: gaps need exactly 30 (walk) or 15 (reaction), then take the 20th and 80th percentile rounded to 100 ms', () => {
  const gaps = n => Array.from({ length: n }, (_, i) => 500 + i * 100);
  assert.equal(rowOf(P.suggest({ walkGaps: gaps(29) }, SETTINGS, FIELDS), 'commandGapMinMs').need, 1);
  const row = rowOf(P.suggest({ walkGaps: gaps(30) }, SETTINGS, FIELDS), 'commandGapMinMs');
  assert.equal(row.enough, true);
  assert.deepEqual(row.value, { commandGapMinMs: 1100, commandGapMaxMs: 2800 });
  assert.match(row.basis, /30 個/);
  assert.equal(rowOf(P.suggest({ reactGaps: gaps(14) }, SETTINGS, FIELDS), 'reactMinMs').enough, false);
  assert.equal(rowOf(P.suggest({ reactGaps: gaps(15) }, SETTINGS, FIELDS), 'reactMinMs').enough, true);
});

test('suggest: values are clamped to the field range and the longest is never below the shortest', () => {
  const huge = Array.from({ length: 30 }, () => 4900);
  const row = rowOf(P.suggest({ walkGaps: huge }, SETTINGS, FIELDS), 'commandGapMinMs');
  assert.deepEqual(row.value, { commandGapMinMs: 3000, commandGapMaxMs: 3000 });
  const typo = rowOf(P.suggest({ commands: 200, typos: 150 }, SETTINGS, FIELDS), 'typoPercent');
  assert.equal(typo.value.typoPercent, 20);
});

test('suggest: the fight and kill verbs are the most used ones, same as now is flagged', () => {
  const profile = { firstAttack: { k: 8, fight: 3 }, knockoutAttack: { kill: 5 } };
  const rows = P.suggest(profile, SETTINGS, FIELDS);
  assert.deepEqual(rowOf(rows, 'fightCommand').value, { fightCommand: 'k' });
  assert.equal(rowOf(rows, 'fightCommand').same, false);
  assert.match(rowOf(rows, 'fightCommand').basis, /11 次.*「k」8 次/);
  assert.equal(rowOf(rows, 'killCommand').enough, true, 'exactly 5');
  assert.equal(rowOf(rows, 'killCommand').same, true, 'kill is already set');
  assert.equal(rowOf(P.suggest({ firstAttack: { k: 9 } }, SETTINGS, FIELDS), 'fightCommand').need, 1);
});

test('suggest: the special is the repeated command in the most fights, its interval the median in seconds, the runner-up in the basis', () => {
  const fight = (cmd, count, gaps) => ({ cmd, count, gaps });
  const fights = [
    ...Array.from({ length: 5 }, () => [fight('pp', 4, [3000, 3000, 6000])]),
    [fight('pf', 12, [3000]), fight('hp', 2, [1000])],
  ];
  const row = rowOf(P.suggest({ fights }, SETTINGS, FIELDS), 'specialCommand');
  assert.equal(row.enough, true);
  assert.deepEqual(row.value, { specialCommand: 'pp', specialIntervalSec: 3 });
  assert.match(row.basis, /另有 pf 12 次/);
  assert.equal(rowOf(P.suggest({ fights: fights.slice(0, 4) }, SETTINGS, FIELDS), 'specialCommand').need, 1);
  const same = rowOf(P.suggest({ fights }, { ...SETTINGS, specialCommand: 'PP', specialIntervalSec: 3 }, FIELDS), 'specialCommand');
  assert.equal(same.same, true);
});

test('suggest: the after-kill sequence needs 10 downs and is compared ignoring spaces around ;', () => {
  const profile = { downs: 10, afterDown: { 'l;gc': 6, gc: 3 } };
  const row = rowOf(P.suggest(profile, SETTINGS, FIELDS), 'afterKillCommand');
  assert.deepEqual(row.value, { afterKillCommand: 'l;gc' });
  assert.equal(rowOf(P.suggest({ ...profile, downs: 9 }, SETTINGS, FIELDS), 'afterKillCommand').need, 1);
  assert.equal(rowOf(P.suggest(profile, { ...SETTINGS, afterKillCommand: 'l ; gc' }, FIELDS), 'afterKillCommand').same, true);
});

test('suggest: the typo percentage is typos over commands, rounded; equal to now is flagged', () => {
  assert.equal(rowOf(P.suggest({ commands: 199, typos: 9 }, SETTINGS, FIELDS), 'typoPercent').need, 1);
  const row = rowOf(P.suggest({ commands: 200, typos: 9 }, SETTINGS, FIELDS), 'typoPercent');
  assert.equal(row.value.typoPercent, 5);
  assert.equal(row.same, false);
  assert.equal(rowOf(P.suggest({ commands: 200, typos: 4 }, SETTINGS, FIELDS), 'typoPercent').same, true);
});

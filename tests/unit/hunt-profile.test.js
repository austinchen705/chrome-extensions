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

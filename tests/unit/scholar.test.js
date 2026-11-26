// 六脈神劍（落魄書生）的判讀（純函式）。樣本是遊戲的真實輸出（tests/fixtures/scholar/）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require(path.join(__dirname, '..', '..', 'catworld-auto-command', 'scholar.js'));
const S = globalThis.CatworldScholar;

const sample = name => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'scholar', `${name}.txt`), 'utf8');

test('parseSpirit reads the spirit number from sc', () => {
  assert.equal(S.parseSpirit(sample('sc-spirit-31')), 31);
  assert.equal(S.parseSpirit(sample('sc-spirit-20')), 20);
  assert.equal(S.parseSpirit('沒有這一行'), null);
});

test('parseSkillCount reads the count on the first line and whether six-vein-sword is listed', () => {
  assert.deepEqual(S.parseSkillCount(sample('sk-28')), { count: 28, hasSixVein: false });
  assert.deepEqual(S.parseSkillCount(sample('sk-29-has-six-vein')), { count: 29, hasSixVein: true });
  assert.equal(S.parseSkillCount(''), null);
});

test('without six-vein the skill count may be at most the spirit; over by one means abandon 1', () => {
  assert.deepEqual(S.canStart({ spirit: 28, skills: 28, hasSixVein: false }), { ok: true, limit: 28, abandon: 0 });
  assert.deepEqual(S.canStart({ spirit: 28, skills: 29, hasSixVein: false }), { ok: false, limit: 28, abandon: 1 });
  assert.deepEqual(S.canStart({ spirit: 20, skills: 28, hasSixVein: false }), { ok: false, limit: 20, abandon: 8 });
});

test('with six-vein the limit is spirit + 1', () => {
  assert.deepEqual(S.canStart({ spirit: 28, skills: 29, hasSixVein: true }), { ok: true, limit: 29, abandon: 0 });
  assert.deepEqual(S.canStart({ spirit: 28, skills: 30, hasSixVein: true }), { ok: false, limit: 29, abandon: 1 });
});

test('real samples: spirit 31 with 28 skills and spirit 20 with 29 skills', () => {
  const sk28 = S.parseSkillCount(sample('sk-28'));
  const sk29 = S.parseSkillCount(sample('sk-29-has-six-vein'));
  assert.equal(S.canStart({ spirit: S.parseSpirit(sample('sc-spirit-31')), skills: sk28.count, hasSixVein: sk28.hasSixVein }).ok, true);
  assert.deepEqual(S.canStart({ spirit: S.parseSpirit(sample('sc-spirit-20')), skills: sk29.count, hasSixVein: sk29.hasSixVein }), { ok: false, limit: 21, abandon: 8 });
});

test('classifyLine recognises each scholar message from the real samples', () => {
  const lines = name => sample(name).split('\n').map(line => S.classifyLine(line)).filter(Boolean);
  assert.deepEqual(S.classifyLine('  ※落魄書生(dire scholar)'), { kind: 'appear' });
  assert.deepEqual(S.classifyLine(sample('look-scholar-plain').trimEnd().split('\n').at(-1)), { kind: 'appear' });
  assert.deepEqual(lines('scholar-leaves').map(hit => hit.kind), ['request', 'leave', 'leave', 'leave']);
  assert.deepEqual(lines('scholar-leaves').filter(hit => hit.kind === 'leave').map(hit => hit.direction), ['東邊', '東北', '北']);
  assert.deepEqual(lines('scholar-fail').map(hit => hit.kind), ['followed', 'request', 'given', 'failed', 'vanish']);
  assert.deepEqual(lines('scholar-success').map(hit => hit.kind), ['given', 'success', 'vanish']);
  assert.deepEqual(lines('scholar-already').map(hit => hit.kind), ['request', 'given', 'already']);
});

test('a request keeps the raw middle part (garbled item names included) and the whole sentence', () => {
  assert.deepEqual(S.classifyLine('落魄書生說道：誰能給我蟹珠玄鐵q石a呢？'), { kind: 'request', item: '蟹珠玄鐵q石a', line: '落魄書生說道：誰能給我蟹珠玄鐵q石a呢？' });
  assert.equal(S.classifyLine('你看到一個房間。'), null);
  // 頻道轉貼（論壇樣本）：書生不在身邊，不算
  assert.equal(S.classifyLine('【臥龍谷】老衲(oldna)：落魄書生說道：誰能給我q銀菩d猴靴信呢？'), null);
  assert.equal(S.classifyLine('ct 落魄書生說道：誰能給我q銀菩d猴靴信呢？'), null);
  assert.deepEqual(S.classifyLine('> 落魄書生說道：你已經對六脈有相當的領悟了，我不能再教你什麼了。'), { kind: 'already' });
  assert.equal(S.classifyLine(''), null);
  assert.equal(S.classifyLine(undefined), null);
});

const MIN = 60 * 1000;
const T0 = 1_000_000_000_000;
const here = { area: 'plain', areaName: '平原', room: 'a1' };

test('addSighting: appear opens a record, later requests append to the same encounter without repeating the last sentence', () => {
  let records = S.addSighting([], { kind: 'appear', sinceSpawnSec: 42, ...here }, T0);
  assert.deepEqual(records, [{ at: T0, sinceSpawnSec: 42, area: 'plain', areaName: '平原', room: 'a1', said: [], matched: null, result: null }]);
  records = S.addSighting(records, { kind: 'request', line: '甲', ...here }, T0 + 3000);
  records = S.addSighting(records, { kind: 'request', line: '甲', ...here }, T0 + 4000);
  records = S.addSighting(records, { kind: 'request', line: '乙', ...here }, T0 + 5000);
  records = S.addSighting(records, { kind: 'appear', ...here }, T0 + 6000);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].said, ['甲', '乙']);
  assert.equal(records[0].at, T0, 'the first sighting time is kept');
});

test('addSighting: a request with no record yet opens one; an unreadable room is filled in later', () => {
  let records = S.addSighting([], { kind: 'request', line: '甲', sinceSpawnSec: null }, T0);
  assert.equal(records.length, 1);
  assert.equal(records[0].room, null);
  assert.equal(records[0].sinceSpawnSec, null);
  assert.deepEqual(records[0].said, ['甲']);
  records = S.addSighting(records, { kind: 'appear', ...here }, T0 + 1000);
  assert.equal(records[0].room, 'a1');
});

test('endSighting: after the vanish line the next sighting is a new record', () => {
  let records = S.addSighting([], { kind: 'appear', sinceSpawnSec: 10, ...here }, T0);
  records = S.endSighting(records);
  assert.equal(records[0].ended, true);
  assert.equal(S.endSighting(records), records, 'ending twice changes nothing');
  assert.deepEqual(S.endSighting([]), []);
  records = S.addSighting(records, { kind: 'appear', sinceSpawnSec: 100, ...here }, T0 + 90_000);
  assert.equal(records.length, 2);
});

test('addSighting: passing the next 15-minute respawn starts a new record even without a vanish line', () => {
  // respawn was at T0 - 100s, so the next one is at T0 + 800s
  const first = S.addSighting([], { kind: 'appear', sinceSpawnSec: 100, ...here }, T0);
  assert.equal(S.addSighting(first, { kind: 'appear', ...here }, T0 + 799_000).length, 1);
  assert.equal(S.addSighting(first, { kind: 'appear', ...here }, T0 + 800_000).length, 2);
  // unreadable respawn seconds: a new record only after 15 minutes since the last sighting
  const blind = S.addSighting([], { kind: 'appear', sinceSpawnSec: null, ...here }, T0);
  assert.equal(S.addSighting(blind, { kind: 'appear', ...here }, T0 + 15 * MIN - 1).length, 1);
  assert.equal(S.addSighting(blind, { kind: 'appear', ...here }, T0 + 15 * MIN).length, 2);
});

test('addSighting keeps at most 200 records and drops the oldest', () => {
  let records = [];
  for (let i = 0; i < 205; i++) records = S.endSighting(S.addSighting(records, { kind: 'appear', sinceSpawnSec: 0, ...here }, T0 + i * 1000));
  assert.equal(records.length, 200);
  assert.equal(records[0].at, T0 + 5000);
  assert.equal(records.at(-1).at, T0 + 204_000);
});

test('addSighting and endSighting do not change the input', () => {
  const records = Object.freeze([Object.freeze({ at: T0, sinceSpawnSec: 1, area: null, areaName: '', room: null, said: Object.freeze([]), matched: null, result: null })]);
  assert.doesNotThrow(() => S.addSighting(records, { kind: 'request', line: '甲' }, T0 + 1000));
  assert.doesNotThrow(() => S.endSighting(records));
});

test('isOutdoor: an indented time-of-day or weather line between the description and the exits line means outdoor', () => {
  const outdoor = fs.readdirSync(path.join(__dirname, '..', 'fixtures', 'scholar')).filter(name => /^look-outdoor-/.test(name));
  assert.ok(outdoor.length >= 4);
  outdoor.forEach(name => assert.equal(S.isOutdoor(sample(name.replace(/\.txt$/, ''))), true, name));
  assert.equal(S.isOutdoor(sample('look-scholar-plain')), true);
});

test('isOutdoor: indoor rooms stay false even with a P.S. line or a hint after the exits line', () => {
  const indoor = fs.readdirSync(path.join(__dirname, '..', 'fixtures', 'scholar')).filter(name => /^look-indoor-/.test(name));
  assert.ok(indoor.length >= 5);
  indoor.forEach(name => assert.equal(S.isOutdoor(sample(name.replace(/\.txt$/, ''))), false, name));
});

test('isOutdoor: no exits line is unknown, and only the last description counts', () => {
  assert.equal(S.isOutdoor('測試房間 - \n    這裡是房間。'), null);
  assert.equal(S.isOutdoor(''), null);
  assert.equal(S.isOutdoor(undefined), null);
  const text = `${sample('look-outdoor-street')}\n${sample('look-indoor-temple')}`;
  assert.equal(S.isOutdoor(text), false);
  assert.equal(S.isOutdoor(`${sample('look-indoor-temple')}\n${sample('look-outdoor-street')}`), true);
});

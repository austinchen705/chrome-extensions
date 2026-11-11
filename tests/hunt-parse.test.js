// 地圖巡怪用的輸出解析（純函式）：l、finger、time。樣本是遊戲的真實輸出（tests/fixtures/hunt/）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require(path.join(__dirname, '..', 'catworld-auto-command', 'hunt-parse.js'));
const P = globalThis.CatworldHuntParse;

const sample = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'hunt', `${name}.txt`), 'utf8');

test('time: the Taipei time line is read as UTC+8 and given back as epoch milliseconds', () => {
  // 2026-11-04 09:55:01 台北時間 = 01:55:01 UTC
  assert.equal(P.parseTime(sample('time')), Date.UTC(2026, 10, 4, 1, 55, 1));
});

test('time: no Taipei time line means failure (null)', () => {
  assert.equal(P.parseTime('[小貓的世界]\n小貓時間為丙寅年八月十八日午時。'), null);
  assert.equal(P.parseTime(''), null);
  assert.equal(P.parseTime(undefined), null);
});

test('finger: a player record is a player', () => {
  assert.equal(P.parseFinger(sample('finger-player')), 'player');
});

test('finger: not found is an NPC (no real NPC sample yet: the user only said it says it cannot be found)', () => {
  assert.equal(P.parseFinger('> finger ferryman\n找不到這個人。'), 'npc');
});

test('finger: anything else is unknown, and the caller treats unknown as a player', () => {
  assert.equal(P.parseFinger(''), 'unknown');
  assert.equal(P.parseFinger('> finger abau\n你的動作太快了。'), 'unknown');
  assert.equal(P.parseFinger(undefined), 'unknown');
});

const exitsOf = text => [...P.parseLook(text).exits];

test('look exits: full direction names become commands, one or several exits', () => {
  assert.deepEqual(exitsOf(sample('look-garden')), ['s', 'w']);
  assert.deepEqual(exitsOf(sample('look-valley')), ['e', 'nw']);
  assert.deepEqual(exitsOf(sample('look-treetop-fighting')), ['d', 'u']);
  assert.deepEqual(exitsOf(sample('look-career')), ['u'], '「這裡唯一的出口是 up」');
});

test('look exits: the combined up/down directions, an unknown word is kept as it is, no exit line means none', () => {
  assert.deepEqual(exitsOf('這裡明顯的出口是 eastup、westdown 和 enter。'), ['eu', 'wd', 'enter']);
  assert.deepEqual(exitsOf('這裡明顯的出口是 southeast, northeast 和 north。'), ['se', 'ne', 'n']);
  assert.deepEqual(exitsOf('沒有出口的一段文字'), []);
  assert.deepEqual(exitsOf(undefined), []);
});

const monstersOf = text => JSON.parse(JSON.stringify(P.parseLook(text).monsters));

test('look monsters: one entry per ※ line, same-name monsters are not merged', () => {
  const three = monstersOf(sample('look-garden'));
  assert.equal(three.length, 3);
  three.forEach((mob, i) => assert.deepEqual(mob, { name: '峨嵋派 第五代弟子', id: 'emei pupil', full: '峨嵋派 第五代弟子(emei pupil)', state: '', ref: ['emei pupil', 'emei pupil 2', 'emei pupil 3'][i] }));
});

test('look monsters: the state tag is kept, corpses and the prompt are not monsters', () => {
  assert.deepEqual(monstersOf(sample('look-treetop-fighting')), [{ name: '炎蛛', id: 'fire spider', full: '炎蛛(fire spider)', state: '戰鬥中', ref: 'fire spider' }]);
  assert.deepEqual(monstersOf(sample('look-treetop-ko')), [{ name: '炎蛛', id: 'fire spider', full: '炎蛛(fire spider)', state: '昏迷不醒', ref: 'fire spider' }]);
});

test('look monsters: ids shared by several monsters get their place in the room as ref (fight guard would hit the first one)', () => {
  const refs = monstersOf(sample('look-parade')).map(mob => [mob.name, mob.ref]);
  assert.deepEqual(refs, [['襄陽守軍 小隊長', 'guard'], ['襄陽守軍 中隊長', 'guard 2'], ['襄陽守軍 中隊長', 'guard 3'], ['「郭家女婿」耶律齊', 'ya lu chi']]);
});

test('look monsters: rooms with only people and items have none', () => {
  assert.deepEqual(monstersOf(sample('look-career')), []);
  assert.deepEqual(monstersOf(sample('look-valley')), []);
});

const peopleOf = text => JSON.parse(JSON.stringify(P.parseLook(text).people));

test('look people: every line with an ID and a <state> that is not a monster, nine players in the career room', () => {
  const ids = peopleOf(sample('look-career')).map(person => person.id);
  assert.deepEqual(ids, ['sxd', 'kenpi', 'fanfist', 'fanwhip', 'fansword', 'fffantisy', 'fanew', 'ffantisy', 'kikky']);
  assert.equal(peopleOf(sample('look-career'))[1].state, '發呆六分鐘');
});

test('look people: a lone player in the valley, and the long title line is still one person', () => {
  assert.deepEqual(peopleOf(sample('look-valley')), [{ id: 'geats', state: '發呆四分鐘', ref: 'geats' }]);
});

test('look people: items without a state, corpses, monsters, the door in the description and the prompt are not people', () => {
  assert.deepEqual(peopleOf(sample('look-garden')), []);
  assert.deepEqual(peopleOf(sample('look-treetop-fighting')), []);
  assert.deepEqual(peopleOf(sample('look-treetop-ko')), []);
  const career = peopleOf(sample('look-career')).map(person => person.id);
  assert.ok(!career.includes('waterskin') && !career.includes('meat'));
});

test('look exits: a word with a hyphen or a digit is kept whole as the command', () => {
  assert.deepEqual(exitsOf('這裡明顯的出口是 north-east 和 door2。'), ['north-east', 'door2']);
});

test('look monsters: full is the same text the map collector stores for the same line', () => {
  require(path.join(__dirname, '..', 'catworld-auto-command', 'zap-mobs.js'));
  const line = '  ※「縣城官兵」 官兵(Soldier) <戰鬥中> [fight][kill]';
  const stored = globalThis.CatworldZapMobs.parseMobLines(line)[0].name;
  assert.equal(P.parseLook(line).monsters[0].full, stored);
  const garden = sample('look-garden');
  assert.equal(P.parseLook(garden).monsters[0].full, globalThis.CatworldZapMobs.parseMobLines(garden)[0].name);
});

test('look: when the text holds two room descriptions (the one printed on arrival, then the l), only the last one counts', () => {
  const both = `${sample('look-garden')}\n${sample('look-career')}`;
  const info = P.parseLook(both);
  assert.deepEqual([...info.exits], ['u']);
  assert.deepEqual(JSON.parse(JSON.stringify(info.monsters)), [], 'the monsters of the first room are not counted');
  assert.equal(info.people.length, 9);
});

test('look: a player whose title or name contains the exits sentence does not cut the people list before it', () => {
  const text = [
    '    這裡明顯的出口是 east。',
    '  普通百姓 甲(alpha) <發呆中>',
    '  某人說「這裡明顯的出口是 west」乙(beta) <發呆中>',
  ].join('\n');
  const info = P.parseLook(text);
  assert.deepEqual([...info.exits], ['e']);
  assert.deepEqual(info.people.map(person => person.id), ['alpha', 'beta']);
});

test('parseLoad reads the load percentage from the first line of i, and nothing when it is not there', () => {
  assert.equal(P.parseLoad(sample('inventory')), 23);
  assert.equal(P.parseLoad('你身上帶著下列這些東西( 載重 95% ):'), 95);
  assert.equal(P.parseLoad('你身上帶著下列這些東西( 載重 100％ ):'), 100, 'a full-width percent sign');
  assert.equal(P.parseLoad('你身上沒有帶任何東西。'), null);
  assert.equal(P.parseLoad(''), null);
  assert.equal(P.parseLoad(undefined), null);
});

test('parseInventory reads name, ID, the * mark and the worn ˇ mark, and numbers items that share an ID', () => {
  const items = P.parseInventory(sample('inventory-marked'));
  assert.equal(items.length, 14);
  assert.deepEqual(items[1], { name: '一瓶普洱茶', id: 'puer tea', ref: 'puer tea', marked: true, worn: false });
  assert.deepEqual(items[4], { name: '黑羽長風鎧', id: 'black armor', ref: 'black armor', marked: false, worn: false });
  assert.deepEqual(items.filter(item => item.worn).map(item => item.id), ['cloth', 'rusty ring']);
  assert.deepEqual(items.filter(item => item.id === 'small stone').map(item => item.ref), ['small stone', 'small stone 2'], 'the second of two same-ID items is "ID 2"');
  assert.deepEqual(P.parseInventory('你身上帶著下列這些東西( 載重 29% ):\n> give ring to x\n你給某人一枚銀戒指。'), [], 'the header, echoes and replies are not items');
});

// 玩家沒在發呆時，名字後面沒有 <狀態>：真實輸出（玩家的稱號、名字已換成假的）
test('a player without any status tag is a person, because the line carries a title; a lone item name is not', () => {
  const people = peopleOf(sample('look-player-no-state'));
  assert.deepEqual(people, [{ id: 'somebody', state: '', ref: 'somebody' }]);
  const monsters = monstersOf(sample('look-player-no-state'));
  assert.deepEqual(monsters.map(mob => mob.ref), ['guard', 'guard 2', 'guard 3'], 'the three guards are still counted among themselves');
  const items = ['這裡明顯的出口是 east。', '  紙皮水袋(waterskin)', '  狗肉(meat)', '  炎蛛的屍體(corpse) [sac]'].join('\n');
  assert.deepEqual(peopleOf(items), [], 'items and corpses are not people');
  const titled = ['這裡明顯的出口是 east。', '  普通百姓 店小二(waiter)'].join('\n');
  assert.deepEqual(peopleOf(titled).map(person => person.id), ['waiter'], 'a title and a name with a space between is a person to ask about');
});

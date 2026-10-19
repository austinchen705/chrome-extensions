const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../catworld-auto-command/zap-equipment.js');

const E = globalThis.CatworldZapEquipment;
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'equipment', name), 'utf8');
const identify = () => E.parseEquipmentBlocks(fixture('identify-sample.txt'));
const byName = name => identify().find(block => block.name === name);

test('parseEquipmentBlocks reads the real identify sample', () => {
  assert.deepEqual(identify().map(block => block.name),
    ['霧起時', '鋼盔甲', '時光的河流', '銅棒', '鉗鐵護手', '星河', '護身符', '粗麻拳套', '殘缺的白鐵刀', '骷髏戒指']);
});

test('parseEquipmentBlocks reads an armor block with attributes and potential', () => {
  const mist = byName('霧起時');
  assert.equal(mist.category, '披風類防具');
  assert.equal(mist.kind, 'armor');
  assert.equal(mist.primary, 21);
  assert.equal(mist.needExp, 100000);
  assert.deepEqual(mist.attrs, [{ name: '精傷害減少', value: 1 }]);
});

test('parseEquipmentBlocks keeps several attributes including negative ones', () => {
  assert.deepEqual(byName('鋼盔甲').attrs, [
    { name: '行動', value: 2 }, { name: '攻擊', value: 5 }, { name: '重量', value: -8 },
  ]);
  assert.equal(byName('鋼盔甲').primary, 37);
});

test('parseEquipmentBlocks handles a block without rank or attributes', () => {
  const river = byName('時光的河流');
  assert.equal(river.primary, 23);
  assert.deepEqual(river.attrs, []);
  assert.equal(river.needExp, 150000);
});

test('parseEquipmentBlocks reads a weapon', () => {
  const club = byName('銅棒');
  assert.equal(club.category, '杖類武器');
  assert.equal(club.kind, 'weapon');
  assert.equal(club.primary, 48);
  assert.equal(club.needExp, 0);
});

test('parseEquipmentBlocks normalises attribute names', () => {
  assert.deepEqual(byName('殘缺的白鐵刀').attrs, [{ name: '輔助精恢復', value: 5 }, { name: '招架', value: 2 }]);
  const old = E.parseEquipmentBlocks('此物名曰 ：甲，盔甲類防具\n防 禦 力 ：9 / 9\n屬    性 ：+3   補助精回復\n佩帶條件 ：經驗 0');
  assert.deepEqual(old[0].attrs, [{ name: '輔助精恢復', value: 3 }]);
});

test('parseEquipmentBlocks ignores noise between blocks', () => {
  assert.deepEqual(byName('護身符').attrs, [], 'the 特殊物品 line is not an attribute');
  assert.deepEqual(byName('粗麻拳套').attrs, [], 'the picture after it is not an attribute');
  assert.equal(byName('骷髏戒指').primary, 5);
  assert.equal(identify().length, 10, 'no block is made out of the pictures or the closing lines');
});

test('parseEquipmentBlocks reads the view samples', () => {
  const [cloak] = E.parseEquipmentBlocks(fixture('view-samples.txt'));
  assert.equal(cloak.name, '暮歌');
  assert.equal(cloak.category, '披風類防具');
  assert.equal(cloak.primary, 31);
  assert.deepEqual(cloak.attrs, [{ name: '棒法', value: 4 }, { name: '拳腳', value: 9 }]);
  assert.equal(cloak.needExp, 400000, 'the 使用者 prefix is skipped');
  const [armor] = E.parseEquipmentBlocks(fixture('view-sample-armor.txt'));
  assert.equal(armor.name, '黑羽長風鎧');
  assert.equal(armor.primary, 48);
  assert.deepEqual(armor.attrs, [{ name: '攻擊', value: 22 }]);
  assert.equal(armor.needExp, 150000);
});

test('normalizeAttrName', () => {
  assert.equal(E.normalizeAttrName('補助精回復'), '輔助精恢復');
  assert.equal(E.normalizeAttrName('輔助氣恢復'), '輔助氣恢復');
  assert.equal(E.normalizeAttrName(' 劍術 '), '劍術');
});

test('parseEquipmentBlocks returns nothing for plain text', () => {
  assert.deepEqual(E.parseEquipmentBlocks('你拿著無名物品給衰老頭看了一下...'), []);
  assert.deepEqual(E.parseEquipmentBlocks(''), []);
});

const piece = (name, primary, attrs = [], extra = {}) => ({
  name, category: '披風類防具', kind: 'armor', primary, attrs, needExp: 0, ...extra,
});
const base = (name, primary, attrs = []) => ({ name, primary, attrs, needExp: 0, readAt: 0 });
const stats = { mainWeapon: '劍', exp: 414748 };

test('relatedAttrNames follows the main weapon type', () => {
  assert.ok(['攻擊', '劍術', '劍法'].every(name => E.relatedAttrNames('劍').includes(name)));
  assert.ok(E.relatedAttrNames('拳套').includes('拳腳'));
  ['', undefined, '法師'].forEach(value => assert.deepEqual(E.relatedAttrNames(value), ['攻擊']));
});

test('scoreAttrs weights related attributes double and ignores weight and hardness', () => {
  assert.equal(E.scoreAttrs([{ name: '攻擊', value: 5 }, { name: '行動', value: 2 }, { name: '重量', value: -8 }], ['攻擊']), 12);
  assert.equal(E.scoreAttrs([{ name: '抵抗', value: -3 }], ['攻擊']), -3);
  assert.equal(E.scoreAttrs([{ name: '硬度', value: 50 }], ['攻擊']), 0);
});

test('compareEquipment says worse when the primary value is much lower', () => {
  const result = E.compareEquipment(piece('霧起時', 21, [{ name: '精傷害減少', value: 1 }]),
    [base('暮歌', 31, [{ name: '棒法', value: 4 }, { name: '拳腳', value: 9 }])], stats);
  assert.equal(result.verdict, 'worse');
  assert.equal(result.against, '暮歌');
  assert.ok(result.reasons.includes('防禦 -10'));
});

test('compareEquipment says worse for the real steel armor against the black armor', () => {
  const steel = piece('鋼盔甲', 37, [{ name: '行動', value: 2 }, { name: '攻擊', value: 5 }, { name: '重量', value: -8 }], { category: '盔甲類防具' });
  assert.equal(E.compareEquipment(steel, [base('黑羽長風鎧', 48, [{ name: '攻擊', value: 22 }])], stats).verdict, 'worse');
});

test('compareEquipment says better when the primary value is much higher', () => {
  const result = E.compareEquipment(piece('新披風', 40), [base('暮歌', 31)], stats);
  assert.equal(result.verdict, 'better');
  assert.equal(result.text, '比現在好，建議留下');
});

test('compareEquipment decides by attributes when the primary values are close', () => {
  const plus = [{ name: '攻擊', value: 5 }];
  const better = E.compareEquipment(piece('甲', 31, plus), [base('乙', 30)], stats);
  assert.equal(better.verdict, 'better');
  assert.ok(better.reasons.includes('多了 攻擊 +5'));
  const worse = E.compareEquipment(piece('甲', 30), [base('乙', 31, plus)], stats);
  assert.equal(worse.verdict, 'worse');
  assert.ok(worse.reasons.includes('少了 攻擊 5'));
  const equal = E.compareEquipment(piece('甲', 30, plus), [base('乙', 30, plus)], stats);
  assert.equal(equal.verdict, 'equal');
  assert.equal(equal.text, '相當');
});

test('compareEquipment has no baseline to compare with', () => {
  const none = E.compareEquipment(piece('甲', 30), [], stats);
  assert.deepEqual([none.verdict, none.text, none.against], ['none', '沒有基準可比', null]);
  assert.equal(E.compareEquipment(piece('甲', null), [base('乙', 30)], stats).verdict, 'none');
  assert.equal(E.compareEquipment(piece('甲', 30), [base('乙', null)], stats).verdict, 'none');
});

test('compareEquipment compares against the weakest of several worn pieces', () => {
  const rings = [base('戒指 A', 5), base('戒指 B', 20)];
  const better = E.compareEquipment(piece('新戒指', 12), rings, stats);
  assert.deepEqual([better.verdict, better.against], ['better', '戒指 A']);
  assert.equal(E.compareEquipment(piece('新戒指', 1), rings, stats).verdict, 'worse');
  assert.equal(E.compareEquipment(piece('新戒指', 4), rings, stats).verdict, 'equal');
});

test('compareEquipment flags an item the user cannot wear yet', () => {
  const heavy = piece('重甲', 50, [], { needExp: 500000 });
  assert.equal(E.compareEquipment(heavy, [base('暮歌', 31)], stats).blocked, true);
  assert.equal(E.compareEquipment(heavy, [base('暮歌', 31)], { mainWeapon: '劍', exp: NaN }).blocked, false);
  assert.equal(E.compareEquipment(piece('輕甲', 50, [], { needExp: 100 }), [base('暮歌', 31)], stats).blocked, false);
});

test('compareEquipment copes with an unset main weapon', () => {
  const result = E.compareEquipment(piece('甲', 31, [{ name: '攻擊', value: 5 }]), [base('乙', 30)], { exp: 1000 });
  assert.equal(result.verdict, 'better');
});

test('parseWornHtml reads the real inventory', () => {
  const worn = E.parseWornHtml(fixture('inventory.html'));
  assert.equal(worn.length, 11);
  assert.deepEqual(worn.find(item => item.name === '吳鉤劍').weapon, true);
  assert.equal(worn.find(item => item.name === '金線手套').weapon, false, 'a name split across spans is joined');
  assert.ok(worn.some(item => item.name === '青絲頭巾'));
  assert.ok(worn.every(item => /^\d+$/.test(item.id)));
  assert.ok(!worn.some(item => item.name.includes('蜆精') || item.name.includes('禮盒')), 'unworn items are left out');
});

test('parseWornHtml pairs the mark and the view link on the same line only', () => {
  const html = [
    '<span> *</span><span>ˇ</span><span>勁衣</span>(power cloth) [<a target="view #111">view</a>][<a target="remove #111">remove</a>]',
    '<span> *</span>  三瓶<span>蜆精</span>(clam essence) [<a target="view #222">view</a>]',
  ].join('\n');
  assert.deepEqual(E.parseWornHtml(html), [{ name: '勁衣', id: '111', weapon: false }]);
});

const worn = (name, id = '1', weapon = false) => ({ name, id, weapon });

test('baseline helpers group by category and never mutate', () => {
  const [cloak] = E.parseEquipmentBlocks(fixture('view-samples.txt'));
  const [armor] = E.parseEquipmentBlocks(fixture('view-sample-armor.txt'));
  const store = E.replaceBaseline([cloak, armor], 5000);
  assert.deepEqual(Object.keys(store).sort(), ['披風類防具', '盔甲類防具']);
  assert.deepEqual(store['披風類防具'][0], { name: '暮歌', primary: 31, attrs: cloak.attrs, needExp: 400000, readAt: 5000 });
  const before = JSON.stringify(store);
  const updated = E.upsertBaseline(store, { ...cloak, primary: 33 }, 6000);
  assert.equal(updated['披風類防具'].length, 1, 'same category and name replaces');
  assert.equal(updated['披風類防具'][0].primary, 33);
  assert.equal(updated['披風類防具'][0].readAt, 6000);
  const added = E.upsertBaseline(store, { ...cloak, name: '另一件' }, 6000);
  assert.equal(added['披風類防具'].length, 2, 'a different name is added');
  assert.equal(JSON.stringify(store), before, 'the input store is untouched');
});

test('tracker splits an identify run into candidates and later view blocks into passive ones', () => {
  const tracker = E.createTracker();
  tracker.feed(fixture('identify-sample.txt'), 1000);
  const first = tracker.flush(1100);
  assert.equal(first.candidates.length, 10);
  assert.deepEqual(first.passive, []);
  tracker.feed(fixture('view-samples.txt'), 2000);
  const second = tracker.flush(2100);
  assert.deepEqual(second.candidates, []);
  assert.deepEqual(second.passive.map(block => block.name), ['暮歌']);
});

test('tracker joins a block that arrives in two feeds', () => {
  const tracker = E.createTracker();
  tracker.feed('> 你想請馬鑑定師鑑定所有無名物。\n此物名曰 ：星河，項鍊類防具\n硬    度 ：64\n防 禦 力 ：10 / 10\n', 1000);
  tracker.feed('屬    性 ：+5   抵抗\n佩帶條件 ：經驗 150000\n馬鑑定師說道：共鑑定一樣無名物，歡迎再次光臨。\n', 1200);
  const { candidates } = tracker.flush(1300);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].attrs, [{ name: '抵抗', value: 5 }]);
  assert.equal(candidates[0].needExp, 150000);
});

test('tracker knows when an identify run is open', () => {
  const tracker = E.createTracker();
  assert.equal(tracker.running(0), false);
  tracker.feed('> 你想請馬鑑定師鑑定所有無名物。\n', 0);
  assert.equal(tracker.running(1000), true);
  tracker.feed('馬鑑定師說道：共鑑定十樣無名物，歡迎再次光臨。\n', 2000);
  assert.equal(tracker.running(2500), false);
});

test('tracker closes a run that never ends after the timeout', () => {
  const tracker = E.createTracker({ runTimeoutMs: 30000 });
  tracker.feed('> 你想請馬鑑定師鑑定所有無名物。\n', 0);
  tracker.feed('此物名曰 ：星河，項鍊類防具\n防 禦 力 ：10 / 10\n', 1000);
  assert.equal(tracker.running(30000), true);
  assert.equal(tracker.running(31001), false);
});

test('tracker only allows a passive update for a uniquely named worn piece', () => {
  const tracker = E.createTracker();
  tracker.setWorn([worn('暮歌'), worn('暮歌', '2'), worn('勁衣', '3')]);
  assert.equal(tracker.isPassiveUpdatable('勁衣'), true);
  assert.equal(tracker.isPassiveUpdatable('暮歌'), false, 'two worn pieces share the name');
  assert.equal(tracker.isPassiveUpdatable('銅棒'), false, 'not worn at all');
  assert.deepEqual(tracker.wornNames().sort(), ['勁衣', '暮歌', '暮歌']);
});

test('tracker recognises an end line that is split across two feeds', () => {
  const tracker = E.createTracker();
  tracker.feed('> 你想請馬鑑定師鑑定所有無名物。\n此物名曰 ：星河，項鍊類防具\n防 禦 力 ：10 / 10\n馬鑑定師說道：共鑑定一', 1000);
  tracker.feed('樣無名物，歡迎再次光臨。\n', 1200);
  assert.equal(tracker.flush(1300).candidates.length, 1);
  assert.equal(tracker.running(1500), false, 'the run is closed by the split end line');
  tracker.feed('此物名曰 ：吳鉤劍，劍類武器\n傷 害 力 ：66 / 66\n', 120000);
  const later = tracker.flush(120100);
  assert.deepEqual([later.candidates.length, later.passive.length], [0, 1], 'a later view block is passive');
});

test('tracker recognises a start line that is split across two feeds', () => {
  const tracker = E.createTracker();
  tracker.feed('> 你想請馬鑑定師鑑', 1000);
  tracker.feed('定所有無名物。\n此物名曰 ：星河，項鍊類防具\n防 禦 力 ：10 / 10\n', 1100);
  assert.equal(tracker.running(1200), true);
  assert.equal(tracker.flush(1300).candidates.length, 1);
});

test('tracker closes a run that timed out even when no end line ever arrives', () => {
  const tracker = E.createTracker({ runTimeoutMs: 30000 });
  tracker.feed('> 你想請馬鑑定師鑑定所有無名物。\n此物名曰 ：星河，項鍊類防具\n防 禦 力 ：10 / 10\n', 1000);
  assert.equal(tracker.flush(1100).candidates.length, 1);
  tracker.feed('此物名曰 ：吳鉤劍，劍類武器\n傷 害 力 ：66 / 66\n', 100000);
  const later = tracker.flush(100100);
  assert.deepEqual([later.candidates.length, later.passive.length], [0, 1]);
});

test('mergeBaseline keeps the old entry of a piece that was expected but not read', () => {
  const [cloak] = E.parseEquipmentBlocks(fixture('view-samples.txt'));
  const [armor] = E.parseEquipmentBlocks(fixture('view-sample-armor.txt'));
  const old = E.replaceBaseline([cloak, armor], 1000);
  const [fresh] = E.parseEquipmentBlocks(fixture('view-samples.txt'));
  const merged = E.mergeBaseline(old, [{ ...fresh, primary: 33 }], ['暮歌', '黑羽長風鎧'], 5000);
  assert.equal(merged['披風類防具'][0].primary, 33, 'the freshly read piece is updated');
  assert.equal(merged['披風類防具'][0].readAt, 5000);
  assert.equal(merged['盔甲類防具'][0].name, '黑羽長風鎧', 'the piece that did not answer is kept');
  assert.equal(merged['盔甲類防具'][0].readAt, 1000, 'with its old timestamp');
});

test('mergeBaseline drops pieces that are no longer worn', () => {
  const [cloak] = E.parseEquipmentBlocks(fixture('view-samples.txt'));
  const old = E.replaceBaseline([cloak], 1000);
  assert.deepEqual(E.mergeBaseline(old, [], ['勁衣'], 5000), {}, 'not in the worn list and not read');
});

test('compareEquipment phrases a missing attribute without a misleading plus sign', () => {
  const candidate = piece('甲', 30, [{ name: '攻擊', value: -20 }]);
  const result = E.compareEquipment(candidate, [base('乙', 30)], stats);
  assert.ok(result.reasons.includes('少了 攻擊 20'));
  const gone = E.compareEquipment(piece('甲', 30), [base('乙', 30, [{ name: '攻擊', value: 5 }])], stats);
  assert.ok(gone.reasons.includes('少了 攻擊 5'));
});

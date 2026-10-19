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
  assert.ok(worse.reasons.includes('少了 攻擊 +5'));
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

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

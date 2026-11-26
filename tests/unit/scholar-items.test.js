// 六脈神劍的書生物品清單：產生工具的解析（網站 qu1-7 的存檔）與身上物品的對照（真實的 i 輸出）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const { parseScholarItems, categoryOf } = require(path.join(root, 'tools', 'gen-scholar-items.js'));
require(path.join(root, 'catworld-auto-command', 'hunt-parse.js'));
require(path.join(root, 'catworld-auto-command', 'scholar.js'));
const S = globalThis.CatworldScholar;

const fixture = name => fs.readFileSync(path.join(root, 'tests', 'fixtures', 'scholar', name), 'utf8');
const items = parseScholarItems(fixture('qu1-7.htm'));
const byName = name => items.find(item => item.name === name);

test('the parser reads about 70 items from the saved qu1-7 table, header rows are regions and not items', () => {
  assert.ok(items.length >= 65 && items.length <= 75, `got ${items.length}`);
  assert.equal(byName('物品名'), undefined);
  assert.equal(byName('長安'), undefined);
  assert.equal(new Set(items.map(item => item.name)).size, items.length, 'names are unique');
});

test('known items carry the region and how from the page', () => {
  assert.deepEqual(byName('唐詩三百首').ways, [['長安', '魏無極']]);
  assert.deepEqual(byName('玄鐵石').ways, [['火燄山', '漁夫 [解謎]']]);
  assert.deepEqual(byName('白金盔甲').ways[0][0], '其他類');
  assert.match(byName('白金盔甲').ways[0][1], /^無名盔甲的鑑定物/);
  assert.deepEqual(byName('撞鬼藥').ways, [['神龍島', '神龍教秘寶 [解謎]']]);
  assert.deepEqual(byName('長白山人蔘').ways, [['其他類', '部份藥店販賣']]);
  assert.ok(byName('銀猴靴'));
});

test('the same item in several regions is one row with every way', () => {
  assert.deepEqual(byName('桃符紙').ways.map(([region]) => region), ['長安', '華山']);
  assert.deepEqual(byName('詩籤').ways.map(([region]) => region), ['江凌', '不夜天']);
  assert.deepEqual(byName('五行入門術').ways.map(([region]) => region), ['蘇州', '桃花島']);
});

test('categories follow the how text: buy, riddle, identify, pick, else kill; several ways take the easiest', () => {
  assert.equal(categoryOf('醉仙樓客棧買'), 'buy');
  assert.equal(categoryOf('部份藥店販賣'), 'buy');
  assert.equal(categoryOf('漁夫 [解謎]'), 'riddle');
  assert.equal(categoryOf('無名物品的鑑定物'), 'identify');
  assert.equal(categoryOf('六樓敲下'), 'pick');
  assert.equal(categoryOf('一樓箱子'), 'pick');
  assert.equal(categoryOf('醉仙樓客棧 2e 地上撿'), 'pick');
  assert.equal(categoryOf('魏無極'), 'kill');
  const category = name => byName(name).category;
  assert.equal(category('玄鐵石'), 'riddle');
  assert.equal(category('白金盔甲'), 'identify');
  assert.equal(category('長白山人蔘'), 'buy');
  assert.equal(category('唐詩三百首'), 'kill');
  assert.equal(category('紅寶石'), 'pick');
  assert.equal(category('五行入門術'), 'buy', 'buy in 蘇州 wins over the 桃花島 way');
});

test('scholar-items-data.js is what the generator makes from the saved page (run node tools/gen-scholar-items.js after the site changes)', () => {
  const sandbox = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'catworld-auto-command', 'scholar-items-data.js'), 'utf8'), sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.globalThis.CatworldScholarItems)), items.map(item => [item.name, item.category, item.ways]));
});

// ---- matchInventory ----
const list = [['玄鐵石'], ['白金盔甲'], ['蠻牛'], ['三字經'], ['人蔘'], ['小石頭'], ['苜蓿草'], ['高麗人蔘茶']];
const find = (text, name) => S.matchInventory(list, text).find(match => match.name === name);

test('matchInventory reads the real inventory: quantity prefixes are stripped and quantities counted', () => {
  const text = fixture('inventory-no-bag.txt');
  assert.deepEqual(find(text, '蠻牛'), { name: '蠻牛', have: true, qty: 44, id: 'bull energy' });
  assert.deepEqual(find(text, '小石頭'), { name: '小石頭', have: true, qty: 13, id: 'small stone' });
  assert.deepEqual(find(text, '苜蓿草'), { name: '苜蓿草', have: true, qty: 2, id: 'alfalfa' });
  assert.deepEqual(find(text, '高麗人蔘茶'), { name: '高麗人蔘茶', have: true, qty: 9, id: 'ginseng tea' });
  assert.equal(find(text, '玄鐵石').have, false);
  assert.equal(find(text, '白金盔甲').id, null);
});

test('matchInventory needs the whole name after a quantity prefix, so 人蔘 is not found inside 珍品．人蔘 or 高麗人蔘茶', () => {
  const text = fixture('inventory-no-bag.txt');
  assert.equal(find(text, '人蔘').have, false);
});

test('matchInventory handles synthetic lines: one stone, one armor, a name that starts with a numeral, split stacks', () => {
  const text = [
    '你身上帶著下列這些東西( 載重 28% ):',
    ' *  一顆玄鐵石(stone)',
    ' *  一件白金盔甲(armor)',
    '    三字經(sanzijing)',
    ' *  二顆玄鐵石(stone)',
  ].join('\n');
  assert.deepEqual(find(text, '玄鐵石'), { name: '玄鐵石', have: true, qty: 3, id: 'stone' });
  assert.deepEqual(find(text, '白金盔甲'), { name: '白金盔甲', have: true, qty: 1, id: 'armor' });
  assert.deepEqual(find(text, '三字經'), { name: '三字經', have: true, qty: 1, id: 'sanzijing' });
  assert.equal(find('', '玄鐵石').have, false);
});

test('buyMacroText puts recall first and normalises separators; an empty field gives nothing', () => {
  assert.equal(S.buyMacroText('buy a; @巨集 3\nbuy b；'), 'recall;buy a;@巨集 3;buy b');
  assert.equal(S.buyMacroText('  ; '), '');
  assert.equal(S.buyMacroText(undefined), '');
});

test('missingToRun keeps list order and only rows that are missing and have a command', () => {
  const list = [['甲'], ['乙'], ['丙'], ['丁']];
  const owned = { 甲: { have: false }, 乙: { have: true }, 丙: { have: false } };
  assert.deepEqual(S.missingToRun(list, owned, { 甲: 'x', 乙: 'y', 丙: ' ', 丁: 'z' }), ['甲']);
  assert.deepEqual(S.missingToRun(list, null, { 甲: 'x' }), [], 'not read yet');
});

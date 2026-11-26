// 六脈神劍的袋子：l <袋子> 的解析（真實樣本 tests/fixtures/scholar/look-bag.txt）、身上與袋子的定位、設定「袋子」的整理
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
require(path.join(root, 'catworld-auto-command', 'hunt-parse.js'));
require(path.join(root, 'catworld-auto-command', 'scholar.js'));
require(path.join(root, 'catworld-auto-command', 'map-hunt.js'));
const S = globalThis.CatworldScholar;
const M = globalThis.CatworldMapHunt;
const sample = name => fs.readFileSync(path.join(root, 'tests', 'fixtures', 'scholar', name), 'utf8');
const BAG = sample('look-bag.txt');
const BODY = sample('inventory-no-bag.txt');
const SYNTHETIC = ['一個綠色布袋(bag)。', '裡面有：', '      一顆玄鐵石(stone)', '      二株不知名藥草(unknown herb)'].join('\n');

test('parseBag lists the items after 裡面有, identical ids get a numbered ref', () => {
  const items = S.parseBag(BAG);
  assert.equal(items.length, 17);
  assert.deepEqual(items.find(item => item.name === '錐心杵'), { name: '錐心杵', id: 'staff', ref: 'staff' });
  const herbs = items.filter(item => item.id === 'unknown herb').map(item => item.ref);
  assert.deepEqual(herbs, ['unknown herb', 'unknown herb 2', 'unknown herb 3', 'unknown herb 4', 'unknown herb 5']);
});

test('parseBag: no 裡面有 (empty bag, no reply) is an empty list; the header lines are not items', () => {
  assert.deepEqual(S.parseBag('人妖無敵的綠色布袋(green bag)。\n這是一口普通的布袋(help bag)。'), []);
  assert.deepEqual(S.parseBag(''), []);
  assert.deepEqual(S.parseBag(undefined), []);
});

test('locateItem: the body wins, then the bags in order; refs are the ones give / get need', () => {
  const bags = [{ bag: 'bag', text: BAG }, { bag: 'bag 2', text: SYNTHETIC }];
  assert.deepEqual(S.locateItem('錐心杵', BODY, bags), { where: 'bag', bag: 'bag', ref: 'staff', id: 'staff' });
  assert.deepEqual(S.locateItem('玄鐵石', BODY, bags), { where: 'bag', bag: 'bag 2', ref: 'stone', id: 'stone' });
  assert.deepEqual(S.locateItem('蠻牛', BODY, bags), { where: 'body', ref: 'bull energy', id: 'bull energy' });
  assert.equal(S.locateItem('白金盔甲', BODY, bags), null);
  assert.equal(S.locateItem('玄鐵石', BODY, []), null);
  assert.equal(S.locateItem('玄鐵石', BODY, undefined), null);
});

test('locateItem: the name matches after a quantity prefix (the second herb is numbered 2)', () => {
  const text = ['裡面有：', '      不知名藥草(unknown herb)', '      無名物品(unknown object)', '      二株不知名藥草(unknown herb)'].join('\n');
  assert.deepEqual(S.locateItem('不知名藥草', '', [{ bag: 'bag', text }]), { where: 'bag', bag: 'bag', ref: 'unknown herb', id: 'unknown herb' });
  assert.equal(S.parseBag(text)[2].ref, 'unknown herb 2');
});

test('matchInventory with bags: have counts the bag, bags lists where and how many, without bags the result has no bags field', () => {
  const list = [['玄鐵石'], ['蠻牛'], ['白金盔甲'], ['不知名藥草']];
  const find = (name, bags) => S.matchInventory(list, BODY, bags).find(match => match.name === name);
  const bags = [{ bag: 'bag', text: BAG }, { bag: 'bag 2', text: SYNTHETIC }];
  assert.deepEqual(find('玄鐵石', bags), { name: '玄鐵石', have: true, qty: 0, id: 'stone', bags: [{ bag: 'bag 2', qty: 1 }] });
  assert.deepEqual(find('不知名藥草', bags).bags, [{ bag: 'bag', qty: 5 }, { bag: 'bag 2', qty: 2 }]);
  assert.deepEqual(find('蠻牛', bags), { name: '蠻牛', have: true, qty: 44, id: 'bull energy', bags: [] });
  assert.equal(find('白金盔甲', bags).have, false);
  assert.deepEqual(find('玄鐵石'), { name: '玄鐵石', have: false, qty: 0, id: null });
});

test('the 袋子 setting keeps safe refs only: bag, bag 2, green bag; invalid and duplicate ones are dropped, at most five', () => {
  assert.equal(M.normalizeSettings({ scholarBags: ' bag 2 、BAG,bad;bag,green  bag, bag 2, x1, 3, $(rm)' }).scholarBags, 'bag 2、BAG、green bag');
  assert.equal(M.normalizeSettings({}).scholarBags, '');
  assert.equal(M.normalizeSettings({ scholarBags: 'a, b, c, d, e, f, g' }).scholarBags, 'a、b、c、d、e');
  assert.deepEqual(M.bagList({ scholarBags: 'bag、bag 2' }), ['bag', 'bag 2']);
  assert.equal(M.FIELDS.find(field => field.key === 'scholarBags').group, 'scholar');
});

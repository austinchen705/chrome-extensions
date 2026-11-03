// 內建資料（map-data.js、shop-data.js）要和 docs/data 的 TSV 一致：改了 TSV 卻忘了重新產生，別人更新後拿到的會是舊資料
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const tsv = name => fs.readFileSync(path.join(root, 'docs/data', name), 'utf8').split('\n').filter(Boolean).slice(1).map(line => line.split('\t'));
const data = (file, key) => {
  const sandbox = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'catworld-auto-command', file), 'utf8'), sandbox);
  return JSON.parse(JSON.stringify(sandbox.globalThis[key])); // 跨 vm 的陣列原型不同，deepStrictEqual 會失敗
};

test('map-data.js has exactly the rooms and monsters of docs/data/map-monsters.tsv (run node tools/gen-map-data.js after editing the TSV)', () => {
  const built = data('map-data.js', 'CatworldMapData');
  const rows = tsv('map-monsters.tsv');
  assert.equal(built.length, rows.length);
  assert.deepEqual(built.map(([area, areaName, room, mobs]) => [area, areaName, room, mobs.join(',')]), rows);
});

test('shop-data.js has exactly the items of docs/data/shop-items.tsv (run node tools/gen-shop-data.js after editing the TSV)', () => {
  const built = data('shop-data.js', 'CatworldShopData');
  const rows = tsv('shop-items.tsv');
  assert.equal(built.length, rows.length);
  assert.deepEqual(built.map(([name, category, primary, needExp, attrs]) => [name, category, primary === null ? '' : String(primary), String(needExp), attrs.map(([attr, value]) => `${attr}${value >= 0 ? '+' : ''}${value}`).join(' ')]), rows);
});

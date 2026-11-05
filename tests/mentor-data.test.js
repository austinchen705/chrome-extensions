// 內建導師資料（mentor-data.js）要和 docs/data/mentors.tsv 一致，並檢查產生腳本的規則：
// 多位導師拆開、兩個分頁合併、格式錯誤與筆數異常時失敗。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { build, render } = require('../tools/gen-mentor-data');

const root = path.join(__dirname, '..');
const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);
const HEAD = ['導師', '功法', '路線', '類別', '最高等級', '配合心法', '來源'].join(TAB) + NL;
const line = (...cells) => cells.join(TAB) + NL;
const rowsOf = text => build(HEAD + text, { minRows: 1 });

test('mentor-data.js is exactly what node tools/gen-mentor-data.js makes from docs/data/mentors.tsv', () => {
  const file = fs.readFileSync(path.join(root, 'catworld-auto-command/mentor-data.js'), 'utf8');
  const sandbox = { globalThis: {} };
  vm.runInNewContext(file, sandbox);
  const built = JSON.parse(JSON.stringify(sandbox.globalThis.CatworldMentorData));
  assert.deepEqual(built, build(fs.readFileSync(path.join(root, 'docs/data/mentors.tsv'), 'utf8')).rows);
  assert.equal(file, render(built));
});

test('the built-in data gives each mentor of a shared row only their own route (no row keeps two routes joined by a double slash)', () => {
  const built = build(fs.readFileSync(path.join(root, 'docs/data/mentors.tsv'), 'utf8')).rows;
  const routeOf = (mentor, skill) => built.find(row => row[0] === mentor && row[1] === skill)?.[2];
  ['喬峰', '洪七公'].forEach(mentor => assert.ok(routeOf(mentor, '降龍十八掌'), mentor));
  ['楊過', '小龍女'].forEach(mentor => assert.ok(routeOf(mentor, '玉女劍法'), mentor));
  assert.notEqual(routeOf('喬峰', '降龍十八掌'), routeOf('洪七公', '降龍十八掌'));
  assert.notEqual(routeOf('楊過', '玉女劍法'), routeOf('小龍女', '玉女劍法'));
  assert.deepEqual(built.filter(row => row[2].includes(' // ')), []);
});

test('a row with several mentors separated by a slash becomes one row per mentor that all share the route', () => {
  const { rows } = rowsOf(line('甲/乙', '功法', 'run e', '掌拳類', '', '心法', '配合'));
  assert.deepEqual(rows, [['甲', '功法', 'run e', '掌拳類', '', '心法'], ['乙', '功法', 'run e', '掌拳類', '', '心法']]);
});

test('whitespace in a cell is flattened to single spaces', () => {
  const { rows } = rowsOf(line('甲', '功法', 'run   e  n', '', '600', '', '最高'));
  assert.equal(rows[0][2], 'run e n');
});

test('the same mentor and skill in both sheets becomes one row: route, category and heart from the pairing sheet, highest level from the highest-mentor sheet', () => {
  const { rows, report } = rowsOf(line('甲', '功法', 'run e (push a) n', '', '600', '', '最高') + line('甲', '功法', 'run e 謎 n', '刀類', '', '心法', '配合'));
  assert.deepEqual(rows, [['甲', '功法', 'run e 謎 n', '刀類', '600', '心法']]);
  assert.deepEqual(report.conflicts, [{ mentor: '甲', skill: '功法', 最高: 'run e (push a) n', 配合: 'run e 謎 n' }]);
});

test('a pair with the same route in both sheets is not reported as a conflict', () => {
  const { report } = rowsOf(line('甲', '功法', 'run e', '', '600', '', '最高') + line('甲', '功法', 'run e', '刀類', '', '心法', '配合'));
  assert.deepEqual(report.conflicts, []);
});

test('a bad row stops the build: wrong column count, missing field, unknown source, or a duplicate in one sheet', () => {
  assert.throws(() => rowsOf(['甲', '功法', 'run e'].join(TAB) + NL), /欄位數不對/);
  assert.throws(() => rowsOf(line('', '功法', 'run e', '', '', '', '最高')), /格式不對/);
  assert.throws(() => rowsOf(line('甲', '功法', '', '', '', '', '最高')), /格式不對/);
  assert.throws(() => rowsOf(line('甲', '功法', 'run e', '', '', '', '別的')), /格式不對/);
  assert.throws(() => rowsOf(line('甲', '功法', 'run e', '', '', '', '最高') + line('甲', '功法', 'run w', '', '', '', '最高')), /重複/);
});

test('too few rows stop the build, so a broken source does not overwrite the data', () => {
  assert.throws(() => build(HEAD + line('甲', '功法', 'run e', '', '', '', '最高')), /不覆寫/);
});

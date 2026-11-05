// 內建導師資料（mentor-data.js）要和 docs/data/mentors.tsv 一致，並檢查產生腳本的規則：
// 多位導師拆開、兩個分頁合併、格式錯誤與筆數異常時失敗。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { build, render } = require('../tools/gen-mentor-data');
const { parseRoute } = require('../tools/mentor-route');

const root = path.join(__dirname, '..');
const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);
const HEAD = ['導師', '功法', '路線', '類別', '最高等級', '配合心法', '來源'].join(TAB) + NL;
const line = (...cells) => cells.join(TAB) + NL;
const rowsOf = text => build(HEAD + text, { minRows: 1 });
// 資料列前六欄（導師、功法、路線、類別、最高等級、配合心法）；後面四欄是路線轉出來的巨集指令等
const core = rows => rows.map(row => row.slice(0, 6));

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
  assert.deepEqual(core(rows), [['甲', '功法', 'run e', '掌拳類', '', '心法'], ['乙', '功法', 'run e', '掌拳類', '', '心法']]);
});

test('whitespace in a cell is flattened to single spaces', () => {
  const { rows } = rowsOf(line('甲', '功法', 'run   e  n', '', '600', '', '最高'));
  assert.equal(rows[0][2], 'run e n');
});

test('the same mentor and skill in both sheets becomes one row: route, category and heart from the pairing sheet, highest level from the highest-mentor sheet', () => {
  const { rows, report } = rowsOf(line('甲', '功法', 'run e (push a) n', '', '600', '', '最高') + line('甲', '功法', 'run e 謎 n', '刀類', '', '心法', '配合'));
  assert.deepEqual(core(rows), [['甲', '功法', 'run e 謎 n', '刀類', '600', '心法']]);
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

// ---- 路線轉巨集指令（tools/mentor-route.js） ----
const INN = 'run e 5n 2o';

test('a plain route from the inn becomes one command with nothing left over', () => {
  assert.deepEqual(parseRoute(`${INN} sw w t s 2w`), { command: `${INN} sw w t s 2w`, rest: '', notes: [], reason: '' });
});

test('an english command in parentheses becomes its own command, separated by a semicolon', () => {
  assert.equal(parseRoute(`${INN} sw w t (push stone) run 9s e (push book)`).command, `${INN} sw w t;push stone;run 9s e;push book`);
});

test('an obvious typo in a command is fixed, and a command may take a Chinese argument', () => {
  assert.equal(parseRoute(`${INN} n (oepn door) run 2u`).command, `${INN} n;open door;run 2u`);
  assert.equal(parseRoute(`${INN} n (touch 石壁) run s`).command, `${INN} n;touch 石壁;run s`);
});

test('a command written outside parentheses is also recognised', () => {
  assert.equal(parseRoute(`${INN} se t 6s e 2n push 櫃子`).command, `${INN} se t 6s e 2n;push 櫃子`);
});

test('a Chinese hint in parentheses is a note, not a command, and so is whatever follows a double slash', () => {
  const nested = parseRoute(`${INN} t 2s (s底) e`);
  assert.deepEqual([nested.command, nested.notes], [`${INN} t 2s e`, ['s底']]);
  assert.deepEqual(parseRoute(`${INN} 2w(需穿真武令)`).notes, ['需穿真武令']);
  const tail = parseRoute(`${INN} 7s 4w n //桃花島`);
  assert.deepEqual([tail.command, tail.notes], [`${INN} 7s 4w n`, ['桃花島']]);
});

test('a riddle marker stops the command right before it and keeps the rest of the route as text', () => {
  const result = parseRoute(`${INN} sw w t nu 謎 run 7e 8n e`);
  assert.deepEqual([result.command, result.rest], [`${INN} sw w t nu`, '謎 run 7e 8n e']);
  const twice = parseRoute(`${INN} t 10n 謎 run 2n u 謎 run e s`);
  assert.equal(twice.command, `${INN} t 10n`);
  assert.equal(twice.rest, '謎 run 2n u 謎 run e s', 'only the first riddle is a stop; the rest stays as text');
});

test('a route that does not start from the inn, or has a word it cannot read, is not walked automatically', () => {
  assert.equal(parseRoute('run 2e u').command, '');
  assert.match(parseRoute('(從黑木崖本島開始) up (open door) run 2u').reason, /醉仙樓/);
  const unreadable = parseRoute(`${INN} t 神秘 e`);
  assert.deepEqual([unreadable.command, unreadable.rest], ['', '']);
  assert.match(unreadable.reason, /無法判讀/);
  assert.match(parseRoute(`${INN} t sww e`).reason, /無法判讀/, 'a word that is not a known direction is not sent');
});

test('any route that starts with run e 5n is from the inn, whether it leaves with o, o o or 2o', () => {
  ['run e 5n o 2s e s t', 'run e 5n o o 2ne t', 'run e 5n 2o sw t'].forEach(route => assert.equal(parseRoute(route).command, route));
  assert.equal(parseRoute('run e 5nn t').command, '');
});

test('a riddle is filled in from another route of the same mentor that spells out the command at the same place', () => {
  const built = rowsOf(
    line('甲', '功法一', `${INN} t 謎 run e`, '', '', '', '配合') +
    line('甲', '功法二', `${INN} t (worship tomb) run e`, '', '100', '', '最高') +
    line('乙', '功法三', `${INN} t 謎 run e`, '', '', '', '配合')).rows;
  const byName = Object.fromEntries(built.map(row => [`${row[0]}${row[1]}`, row]));
  assert.equal(byName['甲功法一'][6], `${INN} t;worship tomb;run e`);
  assert.equal(byName['甲功法一'][7], '');
  assert.equal(byName['甲功法一'][2], `${INN} t 謎 run e`, 'the route as written is kept for display');
  assert.deepEqual(byName['甲功法一'][8], ['已用另一條路線補上謎：worship tomb'], 'the player is told the riddle was filled in');
  assert.equal(byName['乙功法三'][6], `${INN} t`, 'another mentor spelling it out does not count');
  assert.equal(byName['乙功法三'][7], '謎 run e');
  assert.deepEqual(byName['乙功法三'][8], []);
});

test('a riddle is not filled in from a route in the same sheet, because it cannot be told to be the same step', () => {
  const built = rowsOf(
    line('甲', '功法一', `${INN} t 謎`, '', '', '', '配合') +
    line('甲', '功法二', `${INN} t push 櫃子`, '', '', '', '配合')).rows;
  assert.deepEqual([built[0][6], built[0][7], built[0][8]], [`${INN} t`, '謎', []]);
  assert.equal(built[1][6], `${INN} t;push 櫃子`);
});

test('the built-in data walks 小龍女 all the way and stops 玄智和尚 at the riddle', () => {
  const built = build(fs.readFileSync(path.join(root, 'docs/data/mentors.tsv'), 'utf8')).rows;
  const find = (mentor, skill) => built.find(row => row[0] === mentor && row[1] === skill);
  assert.match(find('小龍女', '美女拳法')[6], /;worship tomb;/);
  assert.equal(find('小龍女', '美女拳法')[7], '');
  assert.equal(find('玄智和尚', '誦經')[7], '謎 run 7e 8n e');
  assert.equal(find('東方不敗', '柔虹指法')[6], '');
  assert.deepEqual(find('小龍女', '美女拳法')[8], ['已用另一條路線補上謎：worship tomb']);
  assert.deepEqual([find('洪七公', '降龍十八掌')[6].includes('push'), find('洪七公', '降龍十八掌')[7]], [false, '謎'], 'the same-sheet guess is not used');
  assert.equal(find('王重陽', '基本劍術')[6], 'run e 5n o 2s e s t 3sw 2su wu 2su wu w n 3w nw 2wu n');
});

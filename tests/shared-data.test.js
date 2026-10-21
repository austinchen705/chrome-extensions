// 共用資料模組（Google 試算表發布的 CSV → 共用層）的測試：給 CSV 與怪物表，檢查產生的共用層與報告。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require(path.join(__dirname, '..', 'catworld-auto-command', 'zap-mobs.js'));
require(path.join(__dirname, '..', 'catworld-auto-command', 'shared-data.js'));
const Z = globalThis.CatworldZapMobs;
const S = globalThis.CatworldSharedData;

const HEADER = '怪物名稱,指令,備註,更新者,更新時間';
const MOBS = [
  { name: '白猿(white ape)', id: 'white ape', exp: 100, location: '古墓' },
  { name: '玉蜂(bee)', id: 'bee', exp: 100, location: '古墓' },
];
const build = (...lines) => S.buildMobRoutes([HEADER, ...lines].join('\n'), MOBS);

test('a row becomes a shared route keyed like the personal layer', () => {
  const result = build('白猿(white ape),run e 5n 2o t;push stone,先買貂皮衣,小明,2026-10-21 14:30');
  assert.equal(result.ok, true);
  const key = Z.customKey('白猿(white ape)');
  assert.deepEqual(result.routes[key], { command: 'run e 5n 2o t;push stone', by: '小明', note: '先買貂皮衣', at: result.routes[key].at });
  assert.ok(Number.isFinite(result.routes[key].at));
  assert.deepEqual([result.report.rows, result.report.used, result.report.dropped.length], [1, 1, 0]);
});

test('names match ignoring spaces and case, like the personal layer', () => {
  const result = build('白猿 (White Ape),run n,,小明,2026-10-21 14:30');
  assert.ok(result.routes[Z.customKey('白猿(white ape)')]);
});

test('columns are found by header text, in any order', () => {
  const csv = '更新者,指令,怪物名稱,更新時間,備註\n小華,run w,玉蜂(bee),2026-10-21 10:00,小心\n';
  const result = S.buildMobRoutes(csv, MOBS);
  assert.deepEqual([result.routes[Z.customKey('玉蜂(bee)')].command, result.routes[Z.customKey('玉蜂(bee)')].by, result.routes[Z.customKey('玉蜂(bee)')].note], ['run w', '小華', '小心']);
});

test('a sheet missing a required column is an error, not an empty layer', () => {
  const result = S.buildMobRoutes('怪物名稱,備註\n白猿(white ape),x\n', MOBS);
  assert.equal(result.ok, false);
  assert.match(result.error, /指令/);
});

test('quoted cells keep commas and doubled quotes (Google quotes them)', () => {
  const result = build('"白猿(white ape)","run n;push ""stone"",x","第一行",小明,2026-10-21 14:30');
  assert.equal(result.routes[Z.customKey('白猿(white ape)')].command, 'run n;push "stone",x');
});

test('quoted cells with a comma and a line break survive in note', () => {
  const result = build('白猿(white ape),run n,"a,b\nc",小明,2026-10-21 14:30');
  assert.equal(result.routes[Z.customKey('白猿(white ape)')].note, 'a,b\nc');
});

test('rows without a name or without a command are dropped and listed with the row number', () => {
  const result = build(',run n,,小明,', '玉蜂(bee),,,小明,', '白猿(white ape),run e,,小明,');
  assert.deepEqual(Object.keys(result.routes), [Z.customKey('白猿(white ape)')]);
  assert.deepEqual(result.report.dropped.map(item => item.row), [2, 3], 'row numbers count the header as row 1, like the sheet');
  assert.ok(result.report.dropped.every(item => item.reason));
});

test('blank lines are skipped without counting as rows', () => {
  const result = build('', '白猿(white ape),run e,,小明,', '', '');
  assert.deepEqual([result.report.rows, result.report.used], [1, 1]);
});

test('with several rows for one mob the newest update time wins', () => {
  const result = build(
    '白猿(white ape),run old,,甲,2026-10-20 09:00',
    '白猿(white ape),run new,,乙,2026/10/21 09:30:15',
    '白猿(white ape),run mid,,丙,2026-10-20 23:00');
  assert.equal(result.routes[Z.customKey('白猿(white ape)')].command, 'run new');
  assert.equal(result.report.used, 1);
});

test('a row whose time cannot be read counts as oldest; equal times go to the later row', () => {
  const unreadable = build('白猿(white ape),run dated,,甲,2026-10-20 09:00', '白猿(white ape),run undated,,乙,昨天');
  assert.equal(unreadable.routes[Z.customKey('白猿(white ape)')].command, 'run dated');
  const blank = build('白猿(white ape),run first,,甲,', '白猿(white ape),run second,,乙,');
  assert.equal(blank.routes[Z.customKey('白猿(white ape)')].command, 'run second');
  const tie = build('白猿(white ape),run first,,甲,2026-10-20 09:00', '白猿(white ape),run second,,乙,2026-10-20 09:00');
  assert.equal(tie.routes[Z.customKey('白猿(white ape)')].command, 'run second');
});

test('a mob that is not in the data is kept and reported as unmatched', () => {
  const result = build('不存在的怪(nobody),run n,,小明,2026-10-21 14:30');
  assert.ok(result.routes[Z.customKey('不存在的怪(nobody)')]);
  assert.deepEqual(result.report.unmatched, [{ row: 2, name: '不存在的怪(nobody)' }]);
});

test('commands made only of walking and interaction verbs pass', () => {
  ['run e 5n 2o t', 'run n;push stone;touch 石壁;enter hole;climb stair;worship tomb;open door;squeeze 狹道;jump hole;walk 小橋;give oldman barley;buy 6;ask beggar about 鐵燄令;dis 岸邊;knife 森林;@等待 3;@wait 2-4;n;2e;nu',
  ].forEach(command => assert.deepEqual(S.checkCommand(command), { ok: true }, command));
});

test('commands that drop, sell, quit, fight, perform or change equipment are refused', () => {
  ['drop sword', 'sell all', 'quit', 'kill soldier', 'k soldier', 'fight soldier', 'perform dodge.fast', 'pf dodge', 'enable staff none', 'wield sword', 'unwield 1', 'exert heal', 'cast fire'].forEach(command => {
    const result = S.checkCommand(`run n;${command}`);
    assert.equal(result.ok, false, command);
    assert.ok(result.reason.includes(command.split(' ')[0]), command);
  });
});

test('one bad segment anywhere refuses the whole command, and the row is dropped', () => {
  const result = build('白猿(white ape),run n;drop gold;run s,,小明,2026-10-21 14:30', '玉蜂(bee),run n,,小明,2026-10-21 14:30');
  assert.deepEqual(Object.keys(result.routes), [Z.customKey('玉蜂(bee)')]);
  assert.equal(result.report.dropped.length, 1);
  assert.equal(result.report.dropped[0].row, 2);
  assert.match(result.report.dropped[0].reason, /drop/);
});

test('a dropped row never hides an older allowed row of the same mob', () => {
  const result = build('白猿(white ape),run good,,甲,2026-10-20 09:00', '白猿(white ape),quit,,乙,2026-10-21 09:00');
  assert.equal(result.routes[Z.customKey('白猿(white ape)')].command, 'run good');
});

test('a segment longer than 500 characters drops the row', () => {
  const result = build(`白猿(white ape),run ${'n '.repeat(260)},,小明,`);
  assert.deepEqual(Object.keys(result.routes), []);
  assert.match(result.report.dropped[0].reason, /500/);
});

test('empty segments between semicolons are harmless', () => {
  assert.deepEqual(S.checkCommand('run n;;run s;'), { ok: true });
});

test('only a Google Sheets link published as CSV is accepted', () => {
  const good = 'https://docs.google.com/spreadsheets/d/e/2PACX-abc123/pub?gid=0&single=true&output=csv';
  assert.deepEqual(S.checkUrl(good), { ok: true, url: good });
  assert.deepEqual(S.checkUrl(`  ${good}  `), { ok: true, url: good }, 'surrounding spaces are trimmed');
  ['', 'hello', 'http://docs.google.com/spreadsheets/d/e/x/pub?output=csv',
    'https://evil.example.com/spreadsheets/d/e/x/pub?output=csv',
    'https://mail.google.com/spreadsheets/d/e/x/pub?output=csv',
    'https://docs.google.com.evil.example/spreadsheets/d/e/x/pub?output=csv',
    'https://docs.google.com/spreadsheets/d/e/x/pub?output=html',
    'https://docs.google.com/document/d/e/x/pub?output=csv',
  ].forEach(url => {
    const result = S.checkUrl(url);
    assert.equal(result.ok, false, url);
    assert.match(result.error, /發布到網路/, url);
  });
});

test('an empty sheet (header only) is a valid, empty layer', () => {
  const result = S.buildMobRoutes(`${HEADER}\n`, MOBS);
  assert.deepEqual([result.ok, Object.keys(result.routes).length, result.report.rows], [true, 0, 0]);
});

test('a byte-order mark in front of the header does not break the column lookup', () => {
  const result = S.buildMobRoutes(`﻿${HEADER}\n白猿(white ape),run e,,小明,\n`, MOBS);
  assert.equal(result.ok, true);
  assert.equal(result.report.used, 1);
});

test('overlay puts the shared route in front of the built-in one, with the update info', () => {
  const key = Z.customKey('白猿(white ape)');
  const shared = { [key]: { command: 'run shared', by: '小明', note: '備註', at: 1 } };
  const builtin = { name: '古墓派', path: 't', npc: '', riddle: false };
  const reply = { ok: true, items: [{ mob: MOBS[0], q: 1, grade: 'green', route: { route: builtin, exact: false } }] };
  const out = S.overlayReply(reply, shared);
  assert.deepEqual(out.items[0].route, { route: { name: '白猿(white ape)', path: '', command: 'run shared' }, exact: true, shared: { by: '小明', note: '備註' } });
  assert.equal(reply.items[0].route.route, builtin, 'does not mutate the input');
});

test('overlay reaches the candidates of a lookup reply and leaves unmatched mobs alone', () => {
  const key = Z.customKey('白猿(white ape)');
  const shared = { [key]: { command: 'run shared', by: '小明', note: '', at: 1 } };
  const own = { route: { name: 'x', path: 'n' }, exact: true };
  const reply = { ok: true, items: [{ name: '白猿(white ape)', count: 1, candidates: [{ mob: MOBS[0], route: null }, { mob: MOBS[1], route: own }] }] };
  const out = S.overlayReply(reply, shared);
  assert.equal(out.items[0].candidates[0].route.route.command, 'run shared');
  assert.equal(out.items[0].candidates[0].route.shared.by, '小明');
  assert.ok(out.items[0].candidates[1].route === own, 'a mob without a shared row keeps its built-in route');
});

test('overlay with no shared layer returns the reply as is', () => {
  const reply = { ok: true, items: [{ mob: MOBS[0], route: null }] };
  assert.ok(S.overlayReply(reply, {}) === reply);
  assert.ok(S.overlayReply(reply, undefined) === reply);
  const failed = { ok: false, error: 'x' };
  assert.ok(S.overlayReply(failed, { a: { command: 'run n' } }) === failed);
});

test('commands carrying a line break or a full-width semicolon are refused (they could hide a second command)', () => {
  ['run n\ndrop all', 'run n\r\ndrop all', 'run n；drop all'].forEach(command => {
    const result = S.checkCommand(command);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.match(result.reason, /換行|全形/);
  });
});

test('an update time outside the calendar is unreadable instead of rolling over to another date', () => {
  ['2026-13-45 25:61', '2026-02-31 10:00', '2026-10-21 24:00', '2026-10-21 10:60', '2026-00-10 10:00'].forEach(text => {
    assert.ok(Number.isNaN(S.parseTime(text)), text);
  });
  ['2026-10-21 23:59:59', '2026-02-28', '2026/1/5 0:00'].forEach(text => assert.ok(Number.isFinite(S.parseTime(text)), text));
});

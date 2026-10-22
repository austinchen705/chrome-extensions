// 共用資料模組（Google 試算表發布的 CSV → 共用層）的測試：給 CSV 與怪物表，檢查產生的共用層與報告。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

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
  assert.deepEqual(result.report.unmatched, [{ row: 2, name: '不存在的怪(nobody)', reason: '資料裡沒有這個怪物' }]);
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

// ---- 位置欄（選填）與「停用」----
const HEADER_LOC = '怪物名稱,位置,指令,備註,更新者,更新時間';
const WILD = [
  { name: '老虎(tiger)', id: 'tiger', exp: 100, location: '桃花島' },
  { name: '老虎(tiger)', id: 'tiger', exp: 100, location: '長安城' },
  { name: '野狗(dog)', id: 'dog', exp: 5, location: '蒙古、襄陽' },
];
const buildLoc = (...lines) => S.buildMobRoutes([HEADER_LOC, ...lines].join('\n'), WILD);
// 查詢回覆：每個地點的老虎各一個候選，回傳每個候選套完共用層後的指令（沒有路線回 null）
const commands = shared => {
  const reply = { ok: true, items: [{ name: '老虎(tiger)', count: 2, candidates: WILD.slice(0, 2).map(mob => ({ mob, route: null })) }] };
  return S.overlayReply(reply, shared).items[0].candidates.map(item => item.route?.route?.command ?? null);
};

test('the location column is optional: with it a row only reaches the mobs at that place', () => {
  const { routes } = buildLoc('老虎(tiger),桃花島,run e,,小明,2026-10-21 14:30');
  assert.deepEqual(commands(routes), ['run e', null]);
});

test('without a location a row reaches every mob of that name, and a located row wins at its own place', () => {
  const { routes } = buildLoc('老虎(tiger),,run all,,小明,2026-10-21 14:30', '老虎(tiger),長安城,run city,,小華,2026-10-20 09:00');
  assert.deepEqual(commands(routes), ['run all', 'run city'], 'the located row wins even though it is older');
});

test('locations match ignoring spaces, and one place of a multi-place mob is enough', () => {
  const { routes } = buildLoc('老虎(tiger), 桃 花 島 ,run e,,小明,', '野狗(dog),襄陽,run w,,小明,');
  assert.deepEqual(commands(routes), ['run e', null]);
  const dog = S.overlayReply({ ok: true, items: [{ mob: WILD[2], route: null }] }, routes);
  assert.equal(dog.items[0].route.route.command, 'run w');
});

test('the same mob and place twice still takes the newest row; different places do not clash', () => {
  const { routes, report } = buildLoc(
    '老虎(tiger),桃花島,run old,,甲,2026-10-20 09:00', '老虎(tiger),桃花島,run new,,乙,2026-10-21 09:00', '老虎(tiger),長安城,run city,,丙,2026-10-19 09:00');
  assert.deepEqual(commands(routes), ['run new', 'run city']);
  assert.equal(report.used, 2);
});

test('a location that no mob of that name has is reported as unmatched but kept', () => {
  const result = buildLoc('老虎(tiger),火星,run e,,小明,', '不存在(x),,run e,,小明,');
  assert.deepEqual(result.report.unmatched.map(item => [item.row, item.name, item.location ?? '']), [[2, '老虎(tiger)', '火星'], [3, '不存在(x)', '']]);
  assert.equal(result.report.used, 2);
});

// 內建怪沒有位置、或填的位置對不上時，列仍然套用（位置只是用來在同名怪之間挑，挑不到就退回名稱）
const NO_PLACE = { name: '野狗(Dog)', id: 'dog', exp: 5, location: '' };
const route = (reply, shared, extra) => S.overlayReply(reply, shared, extra).items[0].route?.route?.command ?? null;
const single = mob => ({ ok: true, items: [{ mob, route: null }] });

test('a row with a location still reaches a built-in mob that has no location', () => {
  const { routes } = S.buildMobRoutes([HEADER_LOC, '野狗(Dog),長安城,run city,,小明,'].join('\n'), [NO_PLACE]);
  assert.equal(route(single(NO_PLACE), routes), 'run city');
});

test('a location no mob of that name has still applies by name, below a row for the right place and a row without a location', () => {
  const { routes } = buildLoc('老虎(tiger),火星,run mars,,甲,2026-10-21 09:00');
  assert.deepEqual(commands(routes), ['run mars', 'run mars'], 'applied to every mob of that name');
  const exact = buildLoc('老虎(tiger),火星,run mars,,甲,2026-10-21 09:00', '老虎(tiger),桃花島,run peach,,乙,2026-10-19 09:00');
  assert.deepEqual(commands(exact.routes), ['run peach', 'run mars'], 'the row for its own place wins');
  const plain = buildLoc('老虎(tiger),火星,run mars,,甲,2026-10-21 09:00', '老虎(tiger),,run all,,乙,2026-10-19 09:00');
  assert.deepEqual(commands(plain.routes), ['run all', 'run all'], 'a row without a location beats a mismatched one');
});

test('several rows whose locations all miss: the newest one is used', () => {
  const { routes } = buildLoc('老虎(tiger),火星,run old,,甲,2026-10-19 09:00', '老虎(tiger),木星,run new,,乙,2026-10-21 09:00');
  assert.deepEqual(commands(routes), ['run new', 'run new']);
});

const HEADER_STRENGTH = '怪物名稱,位置,強度,指令,備註,更新者,更新時間';

test('a located row for a built-in mob that has no location is not a new mob (there is no place to differ from)', () => {
  const sheet = [HEADER_STRENGTH, '野狗(Dog),長安城,500,run city,,小明,'].join('\n');
  const built = S.buildMobRoutes(sheet, [NO_PLACE]);
  assert.equal(built.report.created, 0);
  assert.deepEqual(Object.keys(built.mobs), []);
  assert.equal(route(single(NO_PLACE), built.routes), 'run city');
  const stale = { [Z.customKey('野狗(Dog)|長安城')]: { name: '野狗(Dog)', id: 'dog', exp: 500, location: '長安城', note: '', by: '小明' } };
  assert.deepEqual(S.applySharedMobs([NO_PLACE], stale), [NO_PLACE], 'an older cache is not added twice either');
});

test('a route that belongs to a mob the sheet created stays with it and does not fall back onto built-in mobs', () => {
  const sheet = [HEADER_STRENGTH, '老虎(tiger),火星,500,run mars,,小明,'].join('\n');
  const built = S.buildMobRoutes(sheet, WILD);
  assert.equal(built.report.created, 1);
  const mobs = S.applySharedMobs(WILD, built.mobs);
  const created = mobs.find(mob => mob.source === 'shared');
  const reply = { ok: true, items: [{ name: '老虎(tiger)', count: 3, candidates: [WILD[0], WILD[1], created].map(mob => ({ mob, route: null })) }] };
  const out = S.overlayReply(reply, built.routes, built.mobs).items[0].candidates.map(item => item.route?.route?.command ?? null);
  assert.deepEqual(out, [null, null, 'run mars']);
});

test('a row that only applies through its name is still listed as a warning, saying it was applied', () => {
  const result = buildLoc('老虎(tiger),火星,run e,,小明,');
  assert.deepEqual(result.report.unmatched.map(item => item.reason), ['這個怪物沒有在「火星」，已改用名稱套用']);
});

test('a sheet without the location column still works (the column is optional)', () => {
  const result = S.buildMobRoutes('怪物名稱,指令\n老虎(tiger),run e\n', WILD);
  assert.equal(result.ok, true);
  assert.deepEqual(commands(result.routes), ['run e', 'run e']);
});

test('the command 停用 turns the route off for that mob instead of being checked as a command', () => {
  const result = buildLoc('老虎(tiger),桃花島,停用,路線是錯的,小明,2026-10-21 14:30');
  assert.equal(result.ok, true);
  assert.deepEqual(result.report.dropped, []);
  const reply = { ok: true, items: [{ mob: WILD[0], route: { route: { name: '桃花島', path: 'x' }, exact: false } }, { mob: WILD[1], route: { route: { name: '長安', path: 'y' }, exact: true } }] };
  const out = S.overlayReply(reply, result.routes);
  assert.equal(out.items[0].route, null, 'the built-in route is hidden');
  assert.deepEqual(out.items[0].sharedDisabled, { by: '小明', note: '路線是錯的' });
  assert.equal(out.items[1].route.route.name, '長安', 'the other place is untouched');
  assert.equal(out.items[1].sharedDisabled, undefined);
});

test('停用 is an exact word: with anything else around it the row goes through the command check', () => {
  const result = buildLoc('老虎(tiger),,停用;run e,,小明,');
  assert.deepEqual(Object.keys(result.routes), []);
  assert.match(result.report.dropped[0].reason, /停用/);
});

test('the newest row decides between 停用 and a route', () => {
  const later = buildLoc('老虎(tiger),桃花島,停用,,甲,2026-10-20 09:00', '老虎(tiger),桃花島,run again,,乙,2026-10-21 09:00');
  assert.deepEqual(commands(later.routes), ['run again', null]);
  const earlier = buildLoc('老虎(tiger),桃花島,run before,,甲,2026-10-20 09:00', '老虎(tiger),桃花島,停用,,乙,2026-10-21 09:00');
  assert.deepEqual(commands(earlier.routes), [null, null]);
});

// ---- 解謎指令分頁 ----
require(path.join(__dirname, '..', 'catworld-auto-command', 'zap-riddles.js'));
const R = globalThis.CatworldZapRiddles;
const RIDDLE_HEADER = '謎名稱,步驟,指令,備註,更新者,更新時間,步驟數';
const step = (no, extra = {}) => ({ no, text: `第${no}步`, commands: '', ...extra });
const RIDDLES = [
  { name: '獨孤九劍', page: 'a.htm', shared: [] },
  { name: '玉蕭劍法', page: 'b.htm', shared: ['彈指神通'] },
  { name: '彈指神通', page: 'b.htm', shared: ['玉蕭劍法'] },
];
const PAGES = {
  'a.htm': { steps: [step(1), step(2), step(3)] },
  // 共用頁：兩個謎各自從 1 開始編號，位置 1～2 是玉蕭劍法、3～5 是彈指神通
  'b.htm': { steps: [step(1, { heading: '玉蕭劍法：' }), step(2), step(1, { heading: '彈指神通：' }), step(2), step(3)] },
};
const buildRiddle = (...lines) => S.buildRiddleSteps([RIDDLE_HEADER, ...lines].join('\n'), RIDDLES, PAGES);

test('a riddle row lands on the page position of that step and keeps who wrote it', () => {
  const result = buildRiddle('獨孤九劍,2,run n;push stone,先買水,小明,2026-10-21 14:30,3');
  assert.equal(result.ok, true);
  const entry = result.steps['a.htm'][2];
  assert.deepEqual({ command: entry.command, by: entry.by, note: entry.note, n: entry.n }, { command: 'run n;push stone', by: '小明', note: '先買水', n: 3 });
  assert.ok(Number.isFinite(entry.at));
  assert.deepEqual([result.report.rows, result.report.used, result.report.dropped.length], [1, 1, 0]);
});

test('on a page shared by several riddles the step number is the one printed inside that riddle\'s own section', () => {
  const result = buildRiddle('玉蕭劍法,2,run jade,,甲,', '彈指神通,2,run finger,,乙,', '彈指神通,3,run finger3,,乙,');
  assert.deepEqual(Object.fromEntries(Object.entries(result.steps['b.htm']).map(([position, entry]) => [position, entry.command])), { 2: 'run jade', 4: 'run finger', 5: 'run finger3' });
});

test('the step count is optional and stays out of the entry when blank or not a number', () => {
  const result = buildRiddle('獨孤九劍,1,run a,,甲,,', '獨孤九劍,2,run b,,甲,,abc', '獨孤九劍,3,run c,,甲,,0');
  ['1', '2', '3'].forEach(position => assert.equal(result.steps['a.htm'][position].n ?? null, null, position));
});

test('the step count and the other columns are optional columns', () => {
  const result = S.buildRiddleSteps('謎名稱,步驟,指令\n獨孤九劍,1,run a\n', RIDDLES, PAGES);
  assert.equal(result.ok, true);
  assert.equal(result.steps['a.htm'][1].command, 'run a');
});

test('a riddle sheet missing a required column is an error', () => {
  const result = S.buildRiddleSteps('謎名稱,指令\n獨孤九劍,run a\n', RIDDLES, PAGES);
  assert.equal(result.ok, false);
  assert.match(result.error, /步驟/);
});

test('rows with a blank or non-numeric step, a blank name or a blank command are dropped with their row numbers', () => {
  const result = buildRiddle('獨孤九劍,,run a,,甲,', '獨孤九劍,二,run a,,甲,', ',1,run a,,甲,', '獨孤九劍,1,,,甲,', '獨孤九劍,1,run ok,,甲,');
  assert.deepEqual(result.report.dropped.map(item => item.row), [2, 3, 4, 5]);
  assert.equal(result.report.used, 1);
});

test('a riddle or a step the data does not have is reported as unmatched and never reaches the layer', () => {
  const result = buildRiddle('不存在的謎,1,run a,,甲,', '獨孤九劍,9,run a,,甲,', '獨孤九劍,1,run ok,,甲,');
  assert.deepEqual(result.report.unmatched.map(item => [item.row, item.name, item.step]), [[2, '不存在的謎', 1], [3, '獨孤九劍', 9]]);
  assert.deepEqual(Object.keys(result.steps), ['a.htm']);
  assert.deepEqual(Object.keys(result.steps['a.htm']), ['1']);
});

test('riddle names match ignoring spaces and case; the newest row for one step wins', () => {
  const result = buildRiddle('獨孤 九劍,1,run old,,甲,2026-10-20 09:00', '獨孤九劍,1,run new,,乙,2026-10-21 09:00');
  assert.equal(result.steps['a.htm'][1].command, 'run new');
  assert.equal(result.report.used, 1);
});

test('riddle commands go through the same whitelist, and 停用 hides the step\'s command', () => {
  const result = buildRiddle('獨孤九劍,1,run n;drop gold,,甲,', '獨孤九劍,2,停用,指令是錯的,小明,2026-10-21 14:30');
  assert.deepEqual(result.report.dropped.map(item => item.row), [2]);
  assert.match(result.report.dropped[0].reason, /drop/);
  const off = result.steps['a.htm'][2];
  assert.deepEqual([off.command, off.disabled, off.by, off.note], ['', true, '小明', '指令是錯的']);
});

// 步驟欄是「這個謎的第幾步」，不看頁面印的編號（一頁有兩個編號清單時印的編號會重複）
test('printed step numbers may repeat on a page: a row still lands on the n-th step of the riddle', () => {
  const pages = { 'a.htm': { steps: [step(1), step(2), step(1), step(2), step(3)] } };
  const csv = [RIDDLE_HEADER, '獨孤九劍,3,run third,,甲,', '獨孤九劍,5,run fifth,,甲,', '獨孤九劍,6,run none,,甲,'].join('\n');
  const result = S.buildRiddleSteps(csv, RIDDLES, pages);
  assert.deepEqual(Object.entries(result.steps['a.htm']).map(([position, entry]) => [position, entry.command]), [['3', 'run third'], ['5', 'run fifth']]);
  assert.deepEqual(result.report.unmatched.map(item => [item.row, item.step]), [[4, 6]]);
});

test('with the real riddle data every step of every riddle can be reached by its own number', () => {
  const data = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'catworld-auto-command', 'zap-data.json'), 'utf8'));
  data.riddles.filter(riddle => data.pages[riddle.page]?.steps.length).forEach(riddle => {
    const mine = R.sectionSteps(riddle, data.pages[riddle.page]);
    const lines = mine.map((_, i) => `${riddle.name},${i + 1},run ${i + 1},,甲,`);
    const result = S.buildRiddleSteps([RIDDLE_HEADER, ...lines].join('\n'), data.riddles, data.pages);
    assert.equal(result.report.unmatched.length, 0, riddle.name);
    const reached = Object.keys(result.steps[riddle.page] ?? {}).map(Number);
    assert.ok(reached.every(position => mine.includes(position)), riddle.name);
    // 同一頁只有一個謎時，每一步都各有自己的鍵（共用頁與沒分段的頁，同頁的謎共用同一組位置）
    if (!data.riddles.some(other => other !== riddle && other.page === riddle.page)) assert.deepEqual(reached.sort((a, b) => a - b), mine, riddle.name);
  });
});

test('the shared step is used in place of the site\'s command, but your own edit still wins', () => {
  const page = { steps: [{ no: 1, text: 't', commands: 'run site' }, { no: 2, text: 't', commands: '' }] };
  const shared = { 'x.htm': { 1: { command: 'run shared', by: '小明', note: '備註', n: 2 }, 2: { command: '', disabled: true, by: '小華', note: '' } } };
  const noEdits = {};
  assert.deepEqual(R.effectiveStep(page, 1, noEdits, 'x.htm', shared), { commands: 'run shared', source: 'shared', stale: false, shared: { by: '小明', note: '備註' } });
  const mine = { 'x.htm': { n: 2, cmds: { 1: 'run mine' } } };
  assert.equal(R.effectiveStep(page, 1, mine, 'x.htm', shared).commands, 'run mine');
  assert.equal(R.effectiveStep(page, 1, mine, 'x.htm', shared).source, 'edited');
  assert.equal(R.effectiveStep(page, 1, noEdits, 'x.htm', undefined).source, 'site', 'no shared layer: unchanged behaviour');
  const off = R.effectiveStep(page, 2, noEdits, 'x.htm', shared);
  assert.deepEqual([off.commands, off.source, off.shared.by], ['', 'shared-off', '小華']);
});

test('a shared step is flagged as changed only when its step count was filled in and differs from now', () => {
  const page = { steps: [{ no: 1, text: 't', commands: '' }, { no: 2, text: 't', commands: '' }] };
  const at = n => R.effectiveStep(page, 1, {}, 'x.htm', { 'x.htm': { 1: { command: 'run a', by: '', note: '', n } } }).stale;
  assert.deepEqual([at(2), at(3), at(undefined), at(null)], [false, true, false, false]);
});

// ---- 報告：原因文字、列數上限、逐列顯示 ----
test('every unmatched row says what could not be matched', () => {
  const mob = buildLoc('不存在(x),,run e,,小明,', '老虎(tiger),火星,run e,,小明,');
  assert.deepEqual(mob.report.unmatched.map(item => item.reason), ['資料裡沒有這個怪物', '這個怪物沒有在「火星」，已改用名稱套用']);
  const riddle = buildRiddle('不存在的謎,1,run a,,甲,', '獨孤九劍,9,run a,,甲,');
  assert.deepEqual(riddle.report.unmatched.map(item => item.reason), ['資料裡沒有這個謎', '這個謎沒有第 9 步']);
});

test('a sheet longer than the row limit reads the first rows only and counts the rest', () => {
  assert.equal(S.MAX_ROWS, 2000);
  const lines = Array.from({ length: S.MAX_ROWS + 5 }, (_, i) => `怪物${i}(m${i}),run e,,小明,`);
  const mob = S.buildMobRoutes(['怪物名稱,指令,備註,更新者,更新時間', ...lines].join('\n'), []);
  assert.deepEqual([mob.report.rows, mob.report.used, mob.report.overflow], [S.MAX_ROWS + 5, S.MAX_ROWS, 5]);
  assert.ok(mob.routes[Z.customKey('怪物1999(m1999)')]);
  assert.equal(mob.routes[Z.customKey('怪物2000(m2000)')], undefined);
  const riddleLines = Array.from({ length: S.MAX_ROWS + 3 }, () => '獨孤九劍,1,run e,,甲,');
  const riddle = S.buildRiddleSteps([RIDDLE_HEADER, ...riddleLines].join('\n'), RIDDLES, PAGES);
  assert.deepEqual([riddle.report.rows, riddle.report.overflow], [S.MAX_ROWS + 3, 3]);
});

test('a sheet within the limit has no overflow', () => {
  assert.equal(buildLoc('老虎(tiger),,run e,,小明,').report.overflow, 0);
});

test('reportLines lists every dropped and unmatched row with its row number and reason', () => {
  const mob = buildLoc('老虎(tiger),,drop x,,小明,', '不存在(x),,run e,,小明,', '老虎(tiger),火星,run e,,小明,');
  assert.deepEqual(S.reportLines(mob.report), [
    '第 2 列：丟掉（不允許的指令「drop」）',
    '第 3 列：不存在(x)　資料裡沒有這個怪物',
    '第 4 列：老虎(tiger)（火星）　這個怪物沒有在「火星」，已改用名稱套用',
  ]);
  const riddle = buildRiddle('獨孤九劍,9,run a,,甲,');
  assert.deepEqual(S.reportLines(riddle.report), ['第 2 列：獨孤九劍 第 9 步　這個謎沒有第 9 步']);
});

test('reportLines mentions rows beyond the limit and cuts a long list', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `x${i}(x),drop y,,小明,`);
  const mob = S.buildMobRoutes(['怪物名稱,指令,備註,更新者,更新時間', ...lines].join('\n'), []);
  const out = S.reportLines(mob.report, 30);
  assert.equal(out.length, 31);
  assert.equal(out[30], '…還有 20 筆沒有顯示');
  const big = S.buildMobRoutes(['怪物名稱,指令,備註,更新者,更新時間', ...Array.from({ length: S.MAX_ROWS + 4 }, (_, i) => `m${i}(m),run e,,,`)].join('\n'), []);
  assert.ok(S.reportLines(big.report).includes(`第 ${S.MAX_ROWS + 2} 列以後共 4 列超過上限（${S.MAX_ROWS} 列）沒有讀`));
  assert.deepEqual(S.reportLines(null), [], 'no report, no lines');
});

test('reportLines puts dropped and unmatched rows in sheet order', () => {
  const mob = buildLoc('不存在(x),,run e,,小明,', '老虎(tiger),,drop x,,小明,', '不存在(y),,run e,,小明,');
  assert.deepEqual(S.reportLines(mob.report).map(line => line.slice(0, 5)), ['第 2 列', '第 3 列', '第 4 列']);
});

// ---- 設定頁摘要文字 ----
const at = text => `<${text}>`;
const okEntry = (extra = {}) => ({ url: 'u', at: 1, report: { rows: 3, used: 2, overflow: 0, dropped: [{ row: 2, reason: 'x' }], unmatched: [{ row: 3, name: 'n', reason: 'y' }] }, ...extra });

test('the summary says not set / not fetched yet when there is nothing to show', () => {
  assert.equal(S.describeSheet('mob', '', null, at), '怪物路線：尚未設定');
  assert.match(S.describeSheet('riddle', 'u', null, at), /^解謎指令：尚未抓取/);
});

test('the summary counts rows, used entries, dropped and unmatched rows with the sheet\'s own unit', () => {
  assert.equal(S.describeSheet('mob', 'u', okEntry({ at: 5 }), at), '怪物路線：上次更新 <5>：共 3 列，生效 2 隻，丟掉 1 列，對不到怪物 1 筆');
  assert.match(S.describeSheet('riddle', 'u', okEntry(), at), /生效 2 步，丟掉 1 列，對不到謎或步驟 1 筆/);
});

test('rows beyond the limit are said to be unread, so "共 N 列" does not claim they were used', () => {
  const entry = okEntry();
  entry.report = { ...entry.report, rows: 2005, used: 2000, overflow: 5 };
  assert.match(S.describeSheet('mob', 'u', entry, at), /共 2005 列（其中 5 列超過上限沒有讀）/);
});

test('a failed update shows why and what the layer is still using', () => {
  const withOld = S.describeSheet('mob', 'u', okEntry({ at: 5, error: { at: 9, reason: 'HTTP 403' } }), at);
  assert.match(withOld, /^怪物路線：更新失敗（<9>）：HTTP 403/);
  assert.match(withOld, /目前使用：上次更新 <5>：共 3 列/);
  assert.ok(withOld.includes('\n'), 'the reason and the data in use are on separate lines');
  const noData = S.describeSheet('riddle', 'u', { url: 'u', at: null, report: null, error: { at: 9, reason: 'x' } }, at);
  assert.match(noData, /目前使用：沒有可用的資料/);
});

test('with both features off the summary says nothing is fetched instead of showing the last result', () => {
  const off = S.describeSheet('mob', 'u', okEntry(), at, { mobs: false, riddles: false });
  assert.match(off, /^怪物路線：.*不會抓取/);
  assert.doesNotMatch(off, /上次更新/);
  assert.equal(S.describeSheet('mob', '', null, at, { mobs: false, riddles: false }), '怪物路線：尚未設定', 'no link, nothing to say about fetching');
  assert.match(S.describeSheet('mob', 'u', okEntry(), at, { mobs: true, riddles: true }), /上次更新/);
  assert.match(S.describeSheet('mob', 'u', okEntry(), at), /上次更新/, 'on by default');
});

test('a rejected link says it was not saved and which link is still in use', () => {
  const withOld = S.describeRejectedUrl('riddle', '不是連結', true);
  assert.match(withOld, /^解謎指令：不是連結/);
  assert.match(withOld, /沒有儲存/);
  assert.match(withOld, /原本的連結/);
  const first = S.describeRejectedUrl('mob', '不是連結', false);
  assert.match(first, /沒有儲存/);
  assert.doesNotMatch(first, /原本的連結/);
});

// ---- 白名單定稿與 README ----
test('the interaction verbs found in the riddle steps and the sheets are allowed', () => {
  ['ride 2', 'search 金色粉末', 'unlock door', 'nod chian', 'knock pallow', 'insert stick', 'wash face', 'fly tree', 'tan qin', 'recall', 'get stone', 'up', 'down'].forEach(command => {
    assert.deepEqual(S.checkCommand(command), { ok: true }, command);
  });
});

test('verbs that fight, change equipment, change your master, sell, speak aloud or put things away stay refused', () => {
  ['k yuen', 'kill wian', 'do kill *', 'wield sword', 'unwield 1', 'wear suit', 'apprentice master', 'enable move none', 'respirate 10', 'meditate 10', 'mp founder', 'view @staff', 'drop x', 'sell x', 'quit', 'perform x', 'exert heal', 'rum s', 'say 大家好', 'put key into box'].forEach(command => {
    assert.equal(S.checkCommand(command).ok, false, command);
  });
});

test('give, buy and pay are allowed only with small, specific arguments', () => {
  ['give wrapper to master', 'give 5 coin to x', 'buy 10', 'buy 20', 'buy sword 3', 'pay', 'pay 100', 'pay 50 to x'].forEach(command => {
    assert.deepEqual(S.checkCommand(command), { ok: true }, command);
  });
  [['give all to bob', /give/], ['GIVE ALL TO bob', /give/], ['give * to bob', /give/], ['buy all', /buy/], ['buy 21', /buy/], ['buy sword 999', /buy/], ['pay 101', /pay/], ['pay 5000 to x', /pay/]].forEach(([command, word]) => {
    const result = S.checkCommand(command);
    assert.equal(result.ok, false, command);
    assert.match(result.reason, word, command);
  });
  assert.equal(S.checkCommand('run n;give all to bob;run s').ok, false, 'one bad segment refuses the whole command');
});

test('a link without gid is accepted but the summary warns that it reads the first tab', () => {
  const withGid = 'https://docs.google.com/spreadsheets/d/e/2PACX-x/pub?gid=77&single=true&output=csv';
  const noGid = 'https://docs.google.com/spreadsheets/d/e/2PACX-x/pub?output=csv';
  assert.equal(S.checkUrl(noGid).ok, true, 'a working single-tab link must keep working');
  assert.match(S.describeSheet('mob', noGid, okEntry({ url: noGid }), at), /沒有 gid.*第一個分頁/);
  assert.doesNotMatch(S.describeSheet('mob', withGid, okEntry({ url: withGid }), at), /gid/);
  assert.doesNotMatch(S.describeSheet('mob', 'u', okEntry(), at), /gid/, 'an unparsable link is not our business here');
  assert.match(S.describeSheet('mob', noGid, null, at), /沒有 gid/, 'also before the first fetch');
});

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const readmeStart = README.indexOf('## 共用資料（Google 試算表）');
const readmeSection = README.slice(readmeStart, README.indexOf('\n## ', readmeStart + 5));

test('README lists exactly the verbs the module allows', () => {
  assert.ok(readmeSection.length > 200, 'README has the shared data section');
  const line = readmeSection.split('\n').find(text => text.startsWith('允許的動詞：'));
  assert.ok(line, 'the allowed verbs line exists');
  const listed = [...line.matchAll(/`([a-z]+)`/g)].map(match => match[1]).sort();
  assert.deepEqual(listed, [...S.ALLOWED_VERBS].sort());
});

// 標題列放在程式碼區塊裡，Tab 才不會被 Markdown 渲染成空白、也不會併成一段
test('the header rows in README code blocks keep their tabs and put every column where the parsers expect it', () => {
  const blocks = [...readmeSection.matchAll(/```\n([^\n]*)\n```/g)].map(match => match[1]);
  // 依內容找標題列（節裡還有別的程式碼區塊，例如連結）；要求欄名後面緊接 Tab，Tab 被改成空白就找不到
  const mobBlock = blocks.find(block => block.startsWith('怪物名稱\t'));
  const riddleBlock = blocks.find(block => block.startsWith('謎名稱\t'));
  assert.ok(mobBlock && riddleBlock, 'one tab-separated header block for each sheet');
  const [mobHeader, riddleHeader] = [mobBlock, riddleBlock].map(block => block.replace(/\t/g, ','));
  const mob = S.buildMobRoutes(`${mobHeader}\n老虎(tiger),桃花島,run e,備註X,小明,2026-10-21 14:30\n`, WILD);
  assert.deepEqual(Object.values(mob.routes).map(entry => [entry.command, entry.note, entry.by]), [['run e', '備註X', '小明']]);
  assert.ok(mob.routes[`${Z.customKey('老虎(tiger)')}|${Z.customKey('桃花島')}`], 'the location column is the second one');
  const riddle = S.buildRiddleSteps(`${riddleHeader}\n獨孤九劍,2,run e,備註X,小明,2026-10-21 14:30,3\n`, RIDDLES, PAGES);
  const entry = riddle.steps['a.htm'][2];
  assert.deepEqual([entry.command, entry.note, entry.by, entry.n], ['run e', '備註X', '小明', 3]);
});

test('the default sheet links are valid published CSV links, one tab each, and the README shows the same ones', () => {
  const { mob, riddle } = S.DEFAULT_SOURCES;
  [mob, riddle].forEach(url => {
    assert.equal(S.checkUrl(url).ok, true, url);
    assert.ok(new URL(url).searchParams.get('gid'), 'a link with gid reads a specific tab');
  });
  assert.notEqual(new URL(mob).searchParams.get('gid'), new URL(riddle).searchParams.get('gid'));
  assert.ok(readmeSection.includes(mob) && readmeSection.includes(riddle), 'README lists the defaults');
});

// 只勾了其中一個功能時，另一個功能的那份表還是會抓（任何一個開著兩份都抓），但面板用不到它，要說明
test('when only the other feature is on, a sheet says its own feature is off and the panel will not use it', () => {
  const onlyRiddles = { mobs: false, riddles: true };
  const mob = S.describeSheet('mob', 'u', okEntry({ at: 5 }), at, onlyRiddles);
  assert.match(mob, /^怪物路線：上次更新 <5>/, 'the fetched result is still shown');
  assert.match(mob, /「怪物查詢」沒勾.*不會用到/);
  assert.doesNotMatch(S.describeSheet('riddle', 'u', okEntry(), at, onlyRiddles), /沒勾/, 'the riddle sheet has its feature on');
  const onlyMobs = { mobs: true, riddles: false };
  assert.match(S.describeSheet('riddle', 'u', okEntry(), at, onlyMobs), /「解謎清單」沒勾.*不會用到/);
  assert.doesNotMatch(S.describeSheet('mob', 'u', okEntry(), at, onlyMobs), /沒勾/);
  const beforeFetch = S.describeSheet('mob', 'u', null, at, onlyRiddles);
  assert.ok(beforeFetch.includes('尚未抓取') && beforeFetch.includes('「怪物查詢」沒勾'), 'also before the first fetch');
});

// ---- 訊息等級（error 紅、warn 琥珀、info 不上色）----
const levels = parts => parts.map(part => part.level);
const BOTH = { mobs: true, riddles: true };

test('each line of a sheet summary carries a level: failures are errors, cautions are warnings, plain results are info', () => {
  assert.deepEqual(S.describeSheetParts('mob', '', null, at, BOTH), [{ level: 'info', text: '怪物路線：尚未設定' }]);
  assert.deepEqual(levels(S.describeSheetParts('riddle', 'u', null, at, BOTH)), ['info'], 'not fetched yet is neutral');
  const clean = okEntry();
  clean.report = { rows: 2, used: 2, overflow: 0, dropped: [], unmatched: [] };
  assert.deepEqual(levels(S.describeSheetParts('mob', 'u', clean, at, BOTH)), ['info'], 'everything went through');
  assert.deepEqual(levels(S.describeSheetParts('mob', 'u', okEntry(), at, BOTH)), ['warn'], 'some rows were dropped or unmatched');
  const over = okEntry();
  over.report = { ...clean.report, rows: 2005, overflow: 5 };
  assert.deepEqual(levels(S.describeSheetParts('mob', 'u', over, at, BOTH)), ['warn']);
  assert.deepEqual(levels(S.describeSheetParts('mob', 'u', okEntry(), at, { mobs: false, riddles: false })), ['warn'], 'nothing is fetched while both features are off');
});

test('a failed update is an error line followed by a plain line about the data still in use', () => {
  const parts = S.describeSheetParts('mob', 'u', okEntry({ at: 5, error: { at: 9, reason: 'HTTP 403' } }), at, BOTH);
  assert.deepEqual(levels(parts), ['error', 'info']);
  assert.match(parts[0].text, /^怪物路線：更新失敗（<9>）：HTTP 403$/);
  assert.match(parts[1].text, /^目前使用：上次更新 <5>/);
});

test('the extra notes are warnings, and the plain text of the parts is what describeSheet returns', () => {
  const noGid = 'https://docs.google.com/spreadsheets/d/e/2PACX-x/pub?output=csv';
  const parts = S.describeSheetParts('mob', noGid, okEntry({ url: noGid }), at, { mobs: false, riddles: true });
  assert.deepEqual(levels(parts), ['warn', 'warn', 'warn'], 'summary, the feature note and the gid note');
  assert.equal(S.describeSheet('mob', noGid, okEntry({ url: noGid }), at, { mobs: false, riddles: true }), parts.map(part => part.text).join('\n'));
});

test('report entries are errors for dropped rows, warnings for unmatched rows and the row limit, and info for the cut-off note', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `x${i}(x),drop y,,小明,`);
  const mob = S.buildMobRoutes(['怪物名稱,指令,備註,更新者,更新時間', ...lines].join('\n'), []);
  const entries = S.reportEntries(mob.report, 30);
  assert.equal(entries.length, 31);
  assert.ok(entries.slice(0, 30).every(entry => entry.level === 'error'));
  assert.deepEqual(entries[30], { level: 'info', text: '…還有 10 筆沒有顯示' });
  const mixed = buildLoc('不存在(x),,run e,,小明,', '老虎(tiger),,drop x,,小明,');
  assert.deepEqual(levels(S.reportEntries(mixed.report)), ['warn', 'error']);
  const big = S.buildMobRoutes(['怪物名稱,指令,備註,更新者,更新時間', ...Array.from({ length: S.MAX_ROWS + 2 }, (_, i) => `m${i}(m),run e,,,`)].join('\n'), []);
  assert.equal(S.reportEntries(big.report, 5).at(-1).level, 'warn', 'the row-limit note stays last and visible');
  assert.deepEqual(S.reportEntries(null), []);
  assert.deepEqual(S.reportLines(mixed.report), S.reportEntries(mixed.report).map(entry => entry.text), 'reportLines is the plain text of the entries');
});

// ---- 共用表新增怪物（強度欄）----
const HEADER_STR = '怪物名稱,位置,強度,指令,備註,更新者,更新時間';
const buildStr = (...lines) => S.buildMobRoutes([HEADER_STR, ...lines].join('\n'), WILD);
const KING = '橫霸四方 忽必烈(king)';

test('strength is a plain number or a 萬 / W / 1W5 style number, between 1 and 100 million', () => {
  const ok = text => S.parseStrength(text);
  assert.deepEqual([ok('250000'), ok(' 250000 ')].map(r => r.value), [250000, 250000]);
  assert.deepEqual(['25萬', '25W', '25w', '25 萬'].map(text => ok(text).value), [250000, 250000, 250000, 250000]);
  assert.deepEqual(['1W5', '2w1', '1W25', '1.5萬', '1W'].map(text => ok(text).value), [15000, 21000, 12500, 15000, 10000]);
  assert.equal(ok('100000000').ok, true, 'the limit itself is allowed');
  ['', '   ', '-5', '0', 'abc', '25X', '1e5', '1,000', 'W5', '12.5.1萬'].forEach(text => {
    const r = ok(text);
    assert.equal(r.ok, false, JSON.stringify(text));
    assert.ok(r.reason, JSON.stringify(text));
  });
  const over = ok('100000001');
  assert.equal(over.ok, false);
  assert.match(over.reason, /1 億/);
  assert.match(ok('25X').reason, /萬|W/, 'the reason shows the accepted ways to write it');
});

test('a row with a strength for a mob the data does not have creates a new mob, with its route when it has a command', () => {
  const result = buildStr(`${KING},蒙古,250000,run e 5n,先買藥,小明,2026-10-21 14:30`);
  assert.equal(result.ok, true);
  const key = `${Z.customKey(KING)}|${Z.customKey('蒙古')}`;
  const mob = result.mobs[key];
  assert.deepEqual([mob.name, mob.id, mob.exp, mob.location, mob.note, mob.by], [KING, 'king', 250000, '蒙古', '先買藥', '小明']);
  assert.equal(result.routes[key].command, 'run e 5n');
  assert.deepEqual([result.report.created, result.report.dropped.length, result.report.unmatched.length], [1, 0, 0], 'it is not reported as unmatched');
});

test('a new mob may have no command (no route), and no location (the key is just the name)', () => {
  const result = buildStr(`${KING},,25W,,,小明,`);
  assert.equal(result.ok, true);
  const key = Z.customKey(KING);
  assert.equal(result.mobs[key].exp, 250000);
  assert.equal(result.mobs[key].location, '');
  assert.equal(result.routes[key], undefined, 'no command, no route');
  assert.equal(result.report.dropped.length, 0);
});

test('a new mob needs a bracketed id and a valid strength, or the whole row is dropped with the reason', () => {
  const result = buildStr('橫霸四方 忽必烈,蒙古,250000,run e,,小明,', `${KING},蒙古,很強,run e,,小明,`, `${KING},蒙古,100000001,run e,,小明,`, `${KING},蒙古,-5,run e,,小明,`);
  assert.deepEqual(Object.keys(result.mobs), []);
  assert.deepEqual(result.report.dropped.map(item => item.row), [2, 3, 4, 5]);
  assert.match(result.report.dropped[0].reason, /括號 ID/);
  assert.match(result.report.dropped[1].reason, /萬|W/);
  assert.match(result.report.dropped[2].reason, /1 億/);
  assert.deepEqual(Object.keys(result.routes), [], 'a dropped row never leaves a route behind');
});

test('without a strength a name the data does not have stays unmatched, and a row without strength still needs a command', () => {
  const result = buildStr(`${KING},蒙古,,run e,,小明,`, '不存在(x),,,,,小明,');
  assert.deepEqual(Object.keys(result.mobs), []);
  assert.equal(result.report.created, 0);
  assert.deepEqual(result.report.unmatched.map(item => [item.row, item.reason]), [[2, '資料裡沒有這個怪物']]);
  assert.deepEqual(result.report.dropped.map(item => [item.row, item.reason]), [[3, '指令是空的']]);
});

test('the same name at a place the data does not know is a new mob; at a known place or with no place it is not', () => {
  const result = buildStr('老虎(tiger),火星,5000,run e,,甲,', '老虎(tiger),桃花島,5000,run w,,乙,', '老虎(tiger),,5000,run n,,丙,');
  assert.deepEqual(Object.values(result.mobs).map(mob => [mob.name, mob.location]), [['老虎(tiger)', '火星']]);
  assert.equal(result.report.created, 1);
  assert.equal(result.routes[Z.customKey('老虎(tiger)')].command, 'run n', 'the other rows are plain route rows');
});

test('the new mobs are appended to the built-in mobs without touching the input, and never duplicate a mob the data has by now', () => {
  const result = buildStr(`${KING},蒙古,250000,run e,備註X,小明,`);
  const before = JSON.stringify(WILD);
  const merged = S.applySharedMobs(WILD, result.mobs);
  assert.equal(JSON.stringify(WILD), before, 'the input is not changed');
  assert.equal(merged.length, WILD.length + 1);
  assert.deepEqual(merged.slice(0, WILD.length), WILD);
  const added = merged.at(-1);
  assert.deepEqual([added.name, added.id, added.exp, added.location, added.note, added.source, added.by], [KING, 'king', 250000, '蒙古', '備註X', 'shared', '小明']);
  const nowBuiltIn = S.applySharedMobs([...WILD, { name: KING, id: 'king', exp: 300000, location: '蒙古', note: '', source: 'zap' }], result.mobs);
  assert.equal(nowBuiltIn.length, WILD.length + 1, 'the zap data won since it now has this mob');
  assert.equal(S.applySharedMobs(WILD, undefined).length, WILD.length);
  assert.equal(S.applySharedMobs(WILD, {}).length, WILD.length);
});

test('the route given with a new mob reaches that mob through the overlay', () => {
  const result = buildStr(`${KING},蒙古,250000,run e 5n,,小明,`);
  const merged = S.applySharedMobs(WILD, result.mobs);
  const mob = merged.at(-1);
  const out = S.overlayReply({ ok: true, items: [{ mob, route: null }] }, result.routes);
  assert.equal(out.items[0].route.route.command, 'run e 5n');
});

// ---- 修正內建怪的強度（名稱＋位置對得上內建怪、有填強度）----
const buildFix = (...lines) => S.buildMobRoutes([HEADER_STRENGTH, ...lines].join('\n'), WILD);
const expOf = (mobs, location) => mobs.filter(mob => mob.location === location).map(mob => mob.exp);

test('a row that matches a built-in mob and has a strength fixes that strength and creates nothing', () => {
  const result = buildFix('老虎(tiger),桃花島,5000,,只是備註,小明,2026-10-21 14:30');
  assert.equal(result.ok, true);
  const key = Z.customKey('老虎(tiger)|桃花島');
  assert.deepEqual([result.fixes[key].exp, result.fixes[key].by], [5000, '小明']);
  assert.deepEqual([result.report.created, Object.keys(result.mobs).length, result.report.dropped.length, result.report.unmatched.length], [0, 0, 0, 0]);
  assert.deepEqual(result.routes, {}, 'no command, so no route');
  assert.equal(result.report.used, 1);
});

test('a row with a strength and a command fixes the strength and gives the route; the strength accepts the same forms as a new mob', () => {
  const result = buildFix('老虎(tiger),桃花島,25萬,run e,備註,小明,');
  assert.equal(result.fixes[Z.customKey('老虎(tiger)|桃花島')].exp, 250000);
  assert.equal(result.routes[Z.customKey('老虎(tiger)|桃花島')].command, 'run e');
});

test('without a strength a row never touches the strength of a built-in mob', () => {
  const result = buildFix('老虎(tiger),桃花島,,run e,,小明,');
  assert.deepEqual(result.fixes, {});
});

test('an invalid strength on a built-in mob drops the whole row, route included', () => {
  const result = buildFix('老虎(tiger),桃花島,很強,run e,,小明,');
  assert.deepEqual([result.fixes, result.routes, result.mobs], [{}, {}, {}]);
  assert.match(result.report.dropped[0].reason, /看不懂/);
  assert.equal(result.report.dropped[0].row, 2);
});

test('the fix only changes the strength: name, id, location and the mob note stay, and the original value is kept', () => {
  const withNote = WILD.map(mob => ({ ...mob, note: '內建備註' }));
  const result = buildFix('老虎(tiger),桃花島,5000,run e,路線備註,小明,');
  const before = JSON.stringify(withNote);
  const merged = S.applySharedMobs(withNote, result.mobs, result.fixes);
  assert.equal(JSON.stringify(withNote), before, 'the input is not changed');
  assert.deepEqual(expOf(merged, '桃花島'), [5000]);
  const fixed = merged[0];
  assert.deepEqual([fixed.name, fixed.id, fixed.location, fixed.note, fixed.source], ['老虎(tiger)', 'tiger', '桃花島', '內建備註', undefined]);
  assert.deepEqual(fixed.fixed, { by: '小明', original: 100 });
  assert.deepEqual(merged.slice(1), withNote.slice(1), 'the others are untouched');
  assert.equal(result.routes[Z.customKey('老虎(tiger)|桃花島')].note, '路線備註', 'the row note is the route note only');
});

test('a fix reaches every same-name mob without a location, and only the matching place with one', () => {
  const all = S.applySharedMobs(WILD, {}, buildFix('老虎(tiger),,5000,,,小明,').fixes);
  assert.deepEqual([...expOf(all, '桃花島'), ...expOf(all, '長安城')], [5000, 5000]);
  const one = S.applySharedMobs(WILD, {}, buildFix('老虎(tiger),長安城,5000,,,小明,').fixes);
  assert.deepEqual([...expOf(one, '桃花島'), ...expOf(one, '長安城')], [100, 5000]);
  const dog = S.applySharedMobs(WILD, {}, buildFix('野狗(dog), 襄陽 ,7,,,小明,').fixes);
  assert.equal(dog.find(mob => mob.id === 'dog').exp, 7, 'one place of a multi-place mob is enough, spaces ignored');
});

test('a fix for a built-in mob without a location applies whatever location the row gives', () => {
  const NONE = { name: '黑熊(Bear)', id: 'bear', exp: 600, location: '' };
  const result = S.buildMobRoutes([HEADER_STRENGTH, '黑熊(Bear),長安城,900,,,小明,'].join('\n'), [NONE]);
  assert.equal(result.report.created, 0);
  assert.equal(S.applySharedMobs([NONE], {}, result.fixes)[0].exp, 900);
});

test('the same mob and place twice takes the newest row for the fix', () => {
  const result = buildFix('老虎(tiger),桃花島,111,,,甲,2026-10-20 09:00', '老虎(tiger),桃花島,222,,,乙,2026-10-21 09:00');
  assert.deepEqual([result.fixes[Z.customKey('老虎(tiger)|桃花島')].exp, result.fixes[Z.customKey('老虎(tiger)|桃花島')].by], [222, '乙']);
});

test('a fix never reaches the mobs the sheet added, and applySharedMobs without fixes behaves as before', () => {
  const created = buildFix(`${KING},蒙古,250000,,,小明,`);
  const merged = S.applySharedMobs(WILD, created.mobs, created.fixes);
  assert.equal(merged.at(-1).exp, 250000);
  assert.equal(merged.at(-1).fixed, undefined);
  assert.equal(S.applySharedMobs(WILD, {}, undefined), WILD);
  assert.equal(S.applySharedMobs(WILD, {}, {}), WILD);
  assert.equal(S.applySharedMobs(WILD, {}, { [Z.customKey('不存在(x)')]: { exp: 1, by: '', at: null } }), WILD, 'a fix that matches no mob changes nothing');
});

test('a fix and 停用 on one row: the strength is fixed and the route is turned off', () => {
  const result = buildFix('老虎(tiger),桃花島,5000,停用,路線不對,小明,');
  const key = Z.customKey('老虎(tiger)|桃花島');
  assert.equal(result.fixes[key].exp, 5000);
  assert.equal(result.routes[key].disabled, true);
});

test('for a built-in mob without a location a row without a location beats located rows, which fall back to the newest', () => {
  const NONE = { name: '黑熊(Bear)', id: 'bear', exp: 600, location: '' };
  const fix = (...lines) => S.applySharedMobs([NONE], {}, S.buildMobRoutes([HEADER_STRENGTH, ...lines].join('\n'), [NONE]).fixes)[0].exp;
  assert.equal(fix('黑熊(Bear),長安城,900,,,甲,2026-10-21 09:00', '黑熊(Bear),,700,,,乙,2026-10-18 09:00'), 700);
  assert.equal(fix('黑熊(Bear),長安城,900,,,甲,2026-10-19 09:00', '黑熊(Bear),蒙古,800,,,乙,2026-10-21 09:00'), 800);
  assert.equal(fix('黑熊(Bear),蒙古,800,,,乙,2026-10-21 09:00', '黑熊(Bear),長安城,900,,,甲,2026-10-19 09:00'), 800, 'the newest wins whatever the row order');
});

test('a mob the sheet added and a fix for the built-in mobs of the same name do not disturb each other', () => {
  const result = buildFix('老虎(tiger),華山,500,run hs,,甲,', '老虎(tiger),,5000,,,乙,');
  assert.equal(result.report.created, 1);
  const merged = S.applySharedMobs(WILD, result.mobs, result.fixes);
  assert.deepEqual([merged[0].exp, merged[1].exp], [5000, 5000]);
  assert.deepEqual([merged.at(-1).location, merged.at(-1).exp, merged.at(-1).fixed], ['華山', 500, undefined]);
});

// ---- 同一隻怪多列：各欄各取最新有填的那一列 ----
const KEY_KING = Z.customKey(KING);
const KING_HEADER = '怪物名稱,位置,強度,指令,備註,更新者,更新時間';
const buildKing = (...lines) => S.buildMobRoutes([KING_HEADER, ...lines].join('\n'), WILD);

test('a newer row that only changes the route keeps the mob an older row defined, and takes over the route', () => {
  const result = buildKing(`${KING},,250000,run old,舊備註,甲,2026-10-20 09:00`, `${KING},,,run new,,乙,2026-10-21 09:00`);
  assert.deepEqual([result.mobs[KEY_KING].exp, result.mobs[KEY_KING].by, result.mobs[KEY_KING].note], [250000, '甲', '舊備註']);
  assert.deepEqual([result.routes[KEY_KING].command, result.routes[KEY_KING].by], ['run new', '乙']);
  assert.equal(result.report.unmatched.length, 0);
});

test('a newer row that only gives a strength keeps the route of an older row', () => {
  const result = buildKing(`${KING},,100,run old,,甲,2026-10-20 09:00`, `${KING},,500,,,乙,2026-10-21 09:00`);
  assert.deepEqual([result.mobs[KEY_KING].exp, result.routes[KEY_KING].command], [500, 'run old']);
  const fix = buildFix('老虎(tiger),桃花島,5000,run old,,甲,2026-10-20 09:00', '老虎(tiger),桃花島,6000,,,乙,2026-10-21 09:00');
  assert.deepEqual([fix.fixes[Z.customKey('老虎(tiger)|桃花島')].exp, fix.routes[Z.customKey('老虎(tiger)|桃花島')].command], [6000, 'run old']);
  const reversed = buildFix('老虎(tiger),桃花島,6000,,,乙,2026-10-21 09:00', '老虎(tiger),桃花島,5000,,,甲,2026-10-20 09:00');
  assert.equal(reversed.fixes[Z.customKey('老虎(tiger)|桃花島')].exp, 6000, 'the newest fix wins whatever the row order');
  const noTime = buildFix('老虎(tiger),桃花島,6000,,,乙,2026-10-21 09:00', '老虎(tiger),桃花島,5000,,,甲,');
  assert.equal(noTime.fixes[Z.customKey('老虎(tiger)|桃花島')].exp, 6000, 'a row without a time is the oldest');
  const tie = buildFix('老虎(tiger),桃花島,5000,,,甲,2026-10-21 09:00', '老虎(tiger),桃花島,6000,,,乙,2026-10-21 09:00');
  assert.equal(tie.fixes[Z.customKey('老虎(tiger)|桃花島')].exp, 6000, 'the same time: the later row wins');
});

test('the newest strength wins whatever the row order, and rows without a time are the oldest (the later row wins a tie)', () => {
  const exp = (...lines) => buildKing(...lines).mobs[KEY_KING].exp;
  assert.equal(exp(`${KING},,100,,,甲,2026-10-20 09:00`, `${KING},,200,,,乙,2026-10-21 09:00`), 200);
  assert.equal(exp(`${KING},,200,,,乙,2026-10-21 09:00`, `${KING},,100,,,甲,2026-10-20 09:00`), 200);
  assert.equal(exp(`${KING},,200,,,乙,2026-10-21 09:00`, `${KING},,100,,,甲,`), 200, 'a row without a time is older than one with a time');
  assert.equal(exp(`${KING},,100,,,甲,`, `${KING},,200,,,乙,看不懂的時間`), 200, 'two unknown times: the later row wins');
  assert.equal(exp(`${KING},,100,,,甲,2026-10-21 09:00`, `${KING},,200,,,乙,2026-10-21 09:00`), 200, 'the same time: the later row wins');
});

test('a dropped row never takes part: it does not hide an older valid row', () => {
  const strength = buildKing(`${KING},,100,run old,,甲,2026-10-20 09:00`, `${KING},,很強,run bad,,乙,2026-10-21 09:00`);
  assert.deepEqual([strength.mobs[KEY_KING].exp, strength.routes[KEY_KING].command], [100, 'run old'], 'the invalid strength drops the whole newer row, route too');
  const command = buildKing(`${KING},,100,run old,,甲,2026-10-20 09:00`, `${KING},,,drop x,,乙,2026-10-21 09:00`);
  assert.deepEqual([command.mobs[KEY_KING].exp, command.routes[KEY_KING].command], [100, 'run old']);
  assert.equal(command.report.dropped.length, 1);
});

test('a row removed from the sheet takes its contribution away: the mob goes, the fix is gone', () => {
  const both = buildKing(`${KING},,100,run e,,甲,2026-10-20 09:00`, '老虎(tiger),桃花島,5000,,,乙,');
  assert.ok(both.mobs[KEY_KING]);
  assert.equal(both.fixes[Z.customKey('老虎(tiger)|桃花島')].exp, 5000);
  const without = buildKing();
  assert.deepEqual([without.mobs, without.fixes, without.routes], [{}, {}, {}]);
  assert.equal(S.applySharedMobs(WILD, without.mobs, without.fixes), WILD, 'built-in strength is back');
});

test('停用 on a new mob only takes its route away: the mob stays', () => {
  const result = buildKing(`${KING},蒙古,250000,停用,路線壞了,小明,`);
  assert.equal(result.mobs[Z.customKey(`${KING}|蒙古`)].exp, 250000);
  assert.equal(result.routes[Z.customKey(`${KING}|蒙古`)].disabled, true);
  const merged = S.applySharedMobs(WILD, result.mobs, result.fixes);
  const out = S.overlayReply({ ok: true, items: [{ mob: merged.at(-1), route: { route: { command: 'builtin' } } }] }, result.routes);
  assert.equal(out.items[0].route, null);
  assert.deepEqual(out.items[0].sharedDisabled, { by: '小明', note: '路線壞了' });
});

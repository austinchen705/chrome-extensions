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

// 巨集匯入匯出的純函式模組（不碰 DOM 與 chrome）：讀遊戲存的巨集、產生匯出文字。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require(path.join(__dirname, '..', 'catworld-auto-command', 'macro-io.js'));
const M = globalThis.CatworldMacroIO;

// 遊戲存的格式：長度 90，每格 0（空）或 [按鍵值字串, 指令字串]
const game = (filled = {}) => Array.from({ length: 90 }, (_, index) => filled[index] ?? 0);
const SAMPLE = game({ 0: ['112', 'look'], 4: ['1281', 'run n;@等待 1;ne'] });

test('the game keeps exactly 90 slots and the export carries a version number', () => {
  assert.equal(M.COUNT, 90);
  assert.equal(M.VERSION, 1);
});

test('a stored list of 90 slots is read as it is', () => {
  const result = M.readMacros(JSON.stringify(SAMPLE));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.macros, SAMPLE);
  assert.deepEqual(M.readMacros(SAMPLE).macros, SAMPLE, 'an array works too');
});

test('nothing stored yet (or an empty string, which the game also reads as nothing) is 90 empty slots, reported as missing rather than damaged', () => {
  [null, undefined, ''].forEach(raw => {
    const result = M.readMacros(raw);
    assert.equal(result.status, 'missing');
    assert.deepEqual(result.macros, game());
  });
});

test('unreadable data is 90 empty slots and reported as damaged', () => {
  ['not json', '{"a":1}', '42', '"x"'].forEach(raw => {
    const result = M.readMacros(raw);
    assert.equal(result.status, 'damaged', JSON.stringify(raw));
    assert.deepEqual(result.macros, game());
  });
});

test('one bad slot becomes empty and marks the data damaged, the good slots survive; a short list is padded and a long one cut', () => {
  const raw = game({ 0: ['112', 'look'], 1: [112, 'x'], 2: ['a'], 3: 'oops', 4: ['113', 5], 5: ['114', 'a', 'extra'] });
  const result = M.readMacros(JSON.stringify(raw));
  assert.equal(result.status, 'damaged');
  assert.deepEqual(result.macros[0], ['112', 'look']);
  assert.deepEqual(result.macros.slice(1, 6), [0, 0, 0, 0, 0]);
  const short = M.readMacros(JSON.stringify([['112', 'look']]));
  assert.equal(short.macros.length, 90);
  assert.deepEqual(short.macros[0], ['112', 'look']);
  assert.equal(short.status, 'ok');
  const long = M.readMacros(JSON.stringify([...SAMPLE, ['999', 'extra']]));
  assert.equal(long.macros.length, 90);
  assert.equal(long.status, 'damaged');
});

test('the export text is JSON with the version, the game list as it is, and only the notes that have text', () => {
  const text = M.exportText(SAMPLE, { 1: '開門', 5: '  ', 7: '', 90: '最後一格' });
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ['version', 'macros', 'notes']);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.macros, SAMPLE);
  assert.deepEqual(parsed.notes, { 1: '開門', 90: '最後一格' });
});

test('notes that do not fit (wrong rows, not text, not an object) are left out of the export', () => {
  const parsed = JSON.parse(M.exportText(SAMPLE, { 0: 'a', 91: 'b', x: 'c', 2: 5, 3: null, 4: 'ok' }));
  assert.deepEqual(parsed.notes, { 4: 'ok' });
  [null, undefined, [], 'text', 7].forEach(notes => assert.deepEqual(JSON.parse(M.exportText(SAMPLE, notes)).notes, {}));
});

test('exporting nothing gives 90 empty slots plus the notes', () => {
  const parsed = JSON.parse(M.exportText(M.readMacros(null).macros, { 3: '備註' }));
  assert.deepEqual(parsed.macros, game());
  assert.deepEqual(parsed.notes, { 3: '備註' });
});

// ---- 匯入：檢查貼進來的文字，通過才給正規化後的 90 格與備註 ----
const text = (extra = {}) => JSON.stringify({ version: 1, macros: SAMPLE, notes: { 1: '開門' }, ...extra });
const slot = (index, cell) => {
  const macros = game();
  macros[index] = cell; // 直接指定那一格（game() 的 ?? 會把 null 變成 0）
  return JSON.stringify({ version: 1, macros });
};
const fails = (raw, pattern) => {
  const result = M.parseImport(raw);
  assert.equal(result.ok, false, String(raw).slice(0, 60));
  if (pattern) assert.match(result.error, pattern, String(raw).slice(0, 60));
  return result;
};

test('what the export gives is accepted as it is, notes included', () => {
  const result = M.parseImport(M.exportText(SAMPLE, { 1: '開門', 5: '跑路' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.macros, SAMPLE);
  assert.deepEqual(result.notes, { 1: '開門', 5: '跑路' });
});

test('fewer than 90 slots are padded with empty ones, exactly 90 is fine, more than 90 is refused', () => {
  const short = M.parseImport(JSON.stringify({ version: 1, macros: [['112', 'look']] }));
  assert.equal(short.ok, true);
  assert.equal(short.macros.length, 90);
  assert.deepEqual([short.macros[0], short.macros[1]], [['112', 'look'], 0]);
  assert.equal(M.parseImport(text()).ok, true);
  fails(JSON.stringify({ version: 1, macros: [...SAMPLE, 0] }), /90/);
});

test('text that is not an export object is refused with a reason', () => {
  fails('not json', /JSON/);
  ['[]', 'null', '42', '"x"', 'true'].forEach(raw => fails(raw, /物件/));
  fails(JSON.stringify({ macros: SAMPLE }), /版本/);
  fails(JSON.stringify({ version: 2, macros: SAMPLE }), /版本/);
  fails(JSON.stringify({ version: '1', macros: SAMPLE }), /版本/);
  fails(JSON.stringify({ version: 1 }), /macros/);
  fails(JSON.stringify({ version: 1, macros: 'x' }), /macros/);
  fails(JSON.stringify({ version: 1, macros: {} }), /macros/);
});

test('a slot of the wrong shape is refused and the message says which row', () => {
  [1, 'str', null, [1, 2], ['a'], ['1', 'a', 'b'], ['1', 5], {}].forEach(cell => fails(slot(6, cell), /第 7 列/));
  assert.equal(M.parseImport(slot(6, 0)).ok, true);
});

test('the key value must be empty (no key set yet) or a whole number the game can make', () => {
  ['abc', '0', '-5', '1.5', '4096', ' 12', '1e3', '12 '].forEach(key => fails(slot(0, [key, 'look']), /按鍵值/));
  ['', '1', '112', '1281', '4095'].forEach(key => assert.equal(M.parseImport(slot(0, [key, 'look'])).ok, true, `key ${JSON.stringify(key)}`));
});

test('a command can be at most 1000 characters', () => {
  fails(slot(2, ['112', 'x'.repeat(1001)]), /第 3 列.*1000/);
  assert.equal(M.parseImport(slot(2, ['112', 'x'.repeat(1000)])).ok, true);
  assert.equal(M.parseImport(slot(2, ['112', ''])).ok, true, 'an empty command is what the game stores for a key without a command');
});

test('two rows with the same key combination are refused and both rows are named; empty keys may repeat', () => {
  const result = fails(JSON.stringify({ version: 1, macros: game({ 2: ['112', 'a'], 6: ['112', 'b'] }) }), /第 3 列.*第 7 列/);
  assert.match(result.error, /重複/);
  assert.equal(M.parseImport(JSON.stringify({ version: 1, macros: game({ 2: ['', 'a'], 6: ['', 'b'] }) })).ok, true);
});

test('notes are optional; when there they must be an object of text for rows 1 to 90, at most 200 characters each', () => {
  assert.deepEqual(M.parseImport(JSON.stringify({ version: 1, macros: SAMPLE })).notes, {});
  fails(text({ notes: null }), /備註/);
  fails(text({ notes: [] }), /備註/);
  fails(text({ notes: 'x' }), /備註/);
  fails(text({ notes: { 0: 'a' } }), /備註.*0/);
  fails(text({ notes: { 91: 'a' } }), /備註.*91/);
  fails(text({ notes: { x: 'a' } }), /備註/);
  fails(text({ notes: { 3: 5 } }), /備註.*3/);
  fails(text({ notes: { 3: 'x'.repeat(201) } }), /備註.*3.*200/);
  assert.deepEqual(M.parseImport(text({ notes: { 3: 'x'.repeat(200), 4: '  ' } })).notes, { 3: 'x'.repeat(200) }, 'blank notes are dropped');
});

test('fields the format does not know are ignored', () => {
  const result = M.parseImport(text({ extra: { a: 1 }, author: 'me' }));
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result).sort(), ['macros', 'notes', 'ok']);
});

test('countFilled counts the rows that hold a macro', () => {
  assert.equal(M.countFilled(SAMPLE), 2);
  assert.equal(M.countFilled(game()), 0);
  assert.equal(M.countFilled(M.readMacros(null).macros), 0);
});

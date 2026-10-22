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

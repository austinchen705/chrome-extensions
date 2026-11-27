// 悟招圖：從真實的悟招訊息（tests/fixtures/moves/learn-cow.html）解析出字元圖與招式名顏色，以及匯入的檢查與合併。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../../catworld-auto-command/move-fx.js');
require('../../catworld-auto-command/move-arts.js');
const A = globalThis.CatworldMoveArts;
const FX = globalThis.CatworldMoveFx;

// 很小的 span 切分器：<span class="H5 X">文字</span>，文字裡的 &lt; &gt; &amp; 換回來
const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const spansFromHtml = html => [...html.matchAll(/<span class="([^"]*)">([\s\S]*?)<\/span>/g)].map(match => ({ classes: match[1].split(/\s+/), text: decode(match[2]) }));
const COW = spansFromHtml(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'moves', 'learn-cow.html'), 'utf8'));

test('the fixture splits into the 23 spans the game printed', () => {
  assert.equal(COW.length, 23);
  assert.ok(COW.every(span => span.classes.includes('X')));
});

test('parseLearn turns the real announcement into exactly the art that was hard-coded for 對牛彈琴, with the learner turned into "你"', () => {
  const learned = A.parseLearn(COW);
  assert.equal(learned.skill, '牛蛇生死搏');
  assert.equal(learned.move, '對牛彈琴');
  assert.deepEqual(learned.lines, FX.MOVE_ART['對牛彈琴']);
  assert.deepEqual(learned.nameCodes, ['H5', 'H7', 'N7', 'N7']);
  assert.ok(!JSON.stringify(learned).includes('穆寇達') && !JSON.stringify(learned).includes('mukoda'), 'the learner name and id are never kept');
});

test('parseLearn gives null for what is not a learn announcement or cannot be read safely', () => {
  assert.equal(A.parseLearn([]), null);
  assert.equal(A.parseLearn(null), null);
  assert.equal(A.parseLearn([{ text: '有氣質一招一式地揮灑...全新劍意源源湧出...\n', classes: ['H3', 'X'] }]), null, 'the 連城訣 block has no 悟出了新');
  assert.equal(A.parseLearn([{ text: '悟出了新牛蛇生死搏>\n之中的一招:『對牛彈琴』\n', classes: ['H5', 'X'] }]), null, 'no "<" before the mark: the learner cannot be replaced');
  assert.equal(A.parseLearn([{ text: '<某人悟出了新牛蛇生死搏>\n只見天地同鳴\n', classes: ['H5', 'X'] }]), null, 'no move line');
});

test('parseLearn keeps going when the lines arrive with CRLF, a missing colour class, and a second announcement right after', () => {
  const one = [{ text: 'ab <甲(', classes: ['H1', 'X'] }, { text: 'jia', classes: ['H2', 'X'] }, { text: ')悟出了新甲武功>\r\n', classes: ['H3', 'X'] }, { text: '<之中的一招:『甲乙』>\r\n', classes: ['X'] }];
  const learned = A.parseLearn([...one, ...one.map(span => ({ ...span, text: span.text.replace('甲乙', '丙丁') }))]);
  assert.deepEqual(learned.lines, [[['ab ', 'H1'], ['<你悟出了新甲武功>', 'H1']], [['<之中的一招:『甲乙』>', 'N7']]]);
  assert.deepEqual(learned.nameCodes, ['N7', 'N7'], 'no colour class falls back to N7, and the second announcement is not mixed in');
});

test('the palette covers every code the game uses, N0 is drawn visible', () => {
  ['N', 'H'].forEach(prefix => [0, 1, 2, 3, 4, 5, 6, 7].forEach(n => assert.ok(FX.ART_COLOR[`${prefix}${n}`], `${prefix}${n}`)));
  assert.equal(FX.ART_COLOR.N0, '#666666');
  assert.equal(FX.ART_COLOR.H1, '#ff0000');
  assert.equal(FX.ART_COLOR.N4, 'rgb(0,0,238)');
});

const entry = (extra = {}) => ({ skill: '牛蛇生死搏', move: '對牛彈琴', lines: FX.MOVE_ART['對牛彈琴'], nameCodes: ['H5', 'H7', 'N7', 'N7'], at: 5, ...extra });
const file = (arts, extra = {}) => JSON.stringify({ format: 'catworld-move-arts', version: 1, arts, ...extra });

test('addCapture keeps the first capture of a move and ignores the next', () => {
  const first = A.addCapture({}, entry(), 100);
  assert.deepEqual(Object.keys(first), ['牛蛇生死搏/對牛彈琴']);
  assert.equal(first['牛蛇生死搏/對牛彈琴'].at, 100);
  assert.equal(A.addCapture(first, entry(), 200), null);
  assert.equal(Object.keys(A.addCapture(first, entry({ move: '打蛇隨棍' }), 200)).length, 2);
  assert.equal(Object.keys(A.addCapture(undefined, entry(), 1)).length, 1);
});

test('export then import gives the same arts back, nothing else', () => {
  const arts = { '牛蛇生死搏/對牛彈琴': entry() };
  const text = A.exportText(arts, { version: '1.174.0', now: 0 });
  assert.equal(JSON.parse(text).format, 'catworld-move-arts');
  assert.deepEqual(A.checkImport(text), { ok: true, arts });
  assert.deepEqual(A.checkImport(file({ '牛蛇生死搏/對牛彈琴': { ...entry(), extra: 'dropped', at: -1 } })).arts['牛蛇生死搏/對牛彈琴'], entry({ at: 0 }), 'unknown fields are dropped, a bad time becomes 0');
});

test('checkImport rejects the whole file on any bad part and says which', () => {
  const key = '牛蛇生死搏/對牛彈琴';
  const bad = (text, pattern) => { const r = A.checkImport(text); assert.equal(r.ok, false); assert.match(r.error, pattern); };
  bad('', /沒有內容/);
  bad(null, /沒有內容/);
  bad('{oops', /JSON/);
  bad('[]', /不是悟招圖檔/);
  bad(JSON.stringify({ format: 'other', version: 1, arts: {} }), /不是悟招圖檔/);
  bad(file({}, { version: 2 }), /較新的格式/);
  bad(JSON.stringify({ format: 'catworld-move-arts', version: 'x', arts: {} }), /version/);
  bad(JSON.stringify({ format: 'catworld-move-arts', version: 1, arts: [] }), /arts/);
  bad(file({ [key]: 'x' }), /不是物件/);
  bad(file({ 'other/key': entry() }), /鍵要是 skill\/move/);
  bad(file({ [key]: entry({ skill: 5 }) }), /skill、move/);
  bad(file({ '甲/乙/丙': entry({ skill: '甲/乙', move: '丙' }) }), /skill、move/);
  bad(file({ ['長'.repeat(31) + '/x']: entry({ skill: '長'.repeat(31), move: 'x', nameCodes: ['N7'] }) }), /skill、move/);
  bad(file({ [key]: entry({ lines: [] }) }), /lines/);
  bad(file({ [key]: entry({ lines: Array(13).fill([['a', 'H1']]) }) }), /lines/);
  bad(file({ [key]: entry({ lines: [Array(25).fill(['a', 'H1'])] }) }), /每一行/);
  bad(file({ [key]: entry({ lines: [[['a', 'H8']]] }) }), /顏色碼/);
  bad(file({ [key]: entry({ lines: [[['a', 'red']]] }) }), /顏色碼/);
  bad(file({ [key]: entry({ lines: [[['a'.repeat(121), 'H1']]] }) }), /顏色碼/);
  bad(file({ [key]: entry({ lines: [[['a']]] }) }), /顏色碼/);
  bad(file({ [key]: entry({ lines: [['x']] }) }), /顏色碼/);
  bad(file({ [key]: entry({ nameCodes: ['H5'] }) }), /nameCodes/);
  bad(file({ [key]: entry({ nameCodes: ['H5', 'H7', 'N7', 'zz'] }) }), /nameCodes/);
  bad(file({ [key]: entry(), '甲/乙': { skill: '甲' } }), /甲\/乙/);
  bad(`{"format":"catworld-move-arts","version":1,"arts":{"__proto__":${JSON.stringify(entry())}}}`, /鍵要是 skill\/move/);
  const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`s/m${i}`, entry({ skill: 's', move: `m${i}`, nameCodes: [...`m${i}`].map(() => 'N7') })]));
  bad(file(many), /最多 500/);
  bad('x'.repeat(2 * 1024 * 1024 + 1), /太大/);
});

test('mergeArts adds the moves it does not have and skips the ones it has, never replacing', () => {
  const have = { '牛蛇生死搏/對牛彈琴': entry({ at: 1 }) };
  const incoming = { '牛蛇生死搏/對牛彈琴': entry({ at: 99 }), '牛蛇生死搏/打蛇隨棍': entry({ move: '打蛇隨棍', nameCodes: ['H5', 'H2', 'H1', 'N7'] }) };
  const { next, added, skipped } = A.mergeArts(have, incoming);
  assert.deepEqual({ added, skipped }, { added: 1, skipped: 1 });
  assert.equal(next['牛蛇生死搏/對牛彈琴'].at, 1);
  assert.deepEqual(Object.keys(next), ['牛蛇生死搏/對牛彈琴', '牛蛇生死搏/打蛇隨棍']);
  assert.deepEqual(have, { '牛蛇生死搏/對牛彈琴': entry({ at: 1 }) }, 'the input is not changed');
  assert.deepEqual(A.mergeArts(undefined, {}), { next: {}, added: 0, skipped: 0 });
});

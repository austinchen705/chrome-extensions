// 悟招圖：從真實的悟招訊息（tests/fixtures/moves/learn-cow.html）解析出字元圖與招式名顏色，以及匯入的檢查與合併。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../../catworld-auto-command/move-fx.js');
require('../../catworld-auto-command/move-arts.js');
require('../../catworld-auto-command/skill-moves.js');
const A = globalThis.CatworldMoveArts;
const FX = globalThis.CatworldMoveFx;
const S = globalThis.CatworldSkillMoves;
const SKILLS_DATA = new Function(`${fs.readFileSync(path.join(__dirname, '..', '..', 'catworld-auto-command', 'skills-data.js'), 'utf8')}; return SKILLS_DATA;`)();

// 很小的 span 切分器：<span class="H5 X">文字</span>，文字裡的 &lt; &gt; &amp; 換回來
const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const spansFromHtml = html => [...html.matchAll(/<span class="([^"]*)">([\s\S]*?)<\/span>/g)].map(match => ({ classes: match[1].split(/\s+/), text: decode(match[2]) }));
const fixture = name => spansFromHtml(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'moves', `${name}.html`), 'utf8'));
const COW = fixture('learn-cow');
const LIANCHENG_4 = fixture('learn-liancheng-4');
const LIANCHENG_3 = fixture('learn-liancheng-3');
// 整條流程：整塊文字 → 招式比對 → 悟招圖（遊戲頁的做法）
const learn = spans => {
  const text = A.blockText(spans);
  const found = S.findMoveIn(SKILLS_DATA, text, A.quotedIn(text));
  return found && A.buildArt(spans, found.skill, found.move);
};

test('the fixture splits into the 23 spans the game printed', () => {
  assert.equal(COW.length, 23);
  assert.ok(COW.every(span => span.classes.includes('X')));
});

test('findMoveIn names the move from the whole block, whatever the announcement pattern is', () => {
  const find = spans => { const text = A.blockText(spans); return S.findMoveIn(SKILLS_DATA, text, A.quotedIn(text)); };
  assert.deepEqual(find(COW), { skill: '牛蛇生死搏', move: '對牛彈琴' });
  assert.deepEqual(find(LIANCHENG_4), { skill: '連城劍法', move: '每逢佳節近，遊子倍思親' });
  assert.deepEqual(find(LIANCHENG_3), { skill: '連城劍法', move: '案前焚香牘，操琴譜新曲' });
  assert.equal(find([{ text: '有氣質一招一式地揮灑..全新劍意源源湧出...\n', classes: ['X'] }]), null, 'no move name in it');
  assert.equal(find([]), null);
});

test('findMoveIn prefers quoted names, then the longest, and gives null when the longest is ambiguous', () => {
  const data = { skills: [{ name: '甲功', moves: [{ name: '天地' }, { name: '天地同壽' }, { name: '日月' }, { name: '星辰' }, { name: '一' }] }, { name: '乙功', moves: [{ name: '日月' }] }] };
  assert.deepEqual(S.findMoveIn(data, '天地同壽 星辰', []), { skill: '甲功', move: '天地同壽' }, 'longest wins');
  assert.deepEqual(S.findMoveIn(data, '天地同壽 星辰', ['星辰']), { skill: '甲功', move: '星辰' }, 'quoted wins over longer');
  assert.equal(S.findMoveIn(data, '星辰 天地', []), null, 'two different moves of the same length');
  assert.equal(S.findMoveIn(data, '日月', []), null, 'the same name in two skills is ambiguous');
  assert.equal(S.findMoveIn(data, '一', []), null, 'names under 2 characters are never matched');
});

test('buildArt turns the real cow announcement into exactly the art that was hard-coded for 對牛彈琴, with the learner turned into "你"', () => {
  const learned = learn(COW);
  assert.equal(learned.skill, '牛蛇生死搏');
  assert.equal(learned.move, '對牛彈琴');
  assert.deepEqual(learned.lines, FX.MOVE_ART['對牛彈琴']);
  assert.deepEqual(learned.nameCodes, ['H5', 'H7', 'N7', 'N7']);
  assert.ok(!JSON.stringify(learned).includes('穆寇達') && !JSON.stringify(learned).includes('mukoda'), 'the learner name and id are never kept');
});

test('buildArt reads the 連城劍法 announcement: the poem is the move, the learner (no id) is the name two lines start with', () => {
  for (const [spans, move] of [[LIANCHENG_4, '每逢佳節近，遊子倍思親'], [LIANCHENG_3, '案前焚香牘，操琴譜新曲']]) {
    const learned = learn(spans);
    assert.equal(learned.skill, '連城劍法');
    assert.equal(learned.move, move);
    assert.deepEqual(learned.nameCodes, Array(11).fill('H2'));
    const texts = learned.lines.map(line => line.map(segment => segment[0]).join(''));
    assert.equal(texts.length, 7);
    assert.ok(texts.some(text => text.includes('你一招一式地揮灑')));
    assert.ok(texts.some(text => text.includes('你順利地透過連城訣')));
    assert.ok(!JSON.stringify(learned).includes('有氣質'), 'the learner name is not kept');
    assert.ok(texts[0].startsWith('    ◎      ◎     '), 'the art columns are kept as they were');
  }
});

test('buildArt keeps the art as it is when no learner name can be found, and gives null when it cannot be read safely', () => {
  const plain = [{ text: '★ 甲乙丙丁 ★\n', classes: ['H3', 'X'] }, { text: '「天地同壽」\n', classes: ['H5', 'X'] }];
  const learned = A.buildArt(plain, '甲功', '天地同壽');
  assert.deepEqual(learned.lines, [[['★ 甲乙丙丁 ★', 'H3']], [['「天地同壽」', 'H5']]]);
  assert.deepEqual(learned.nameCodes, ['H5', 'H5', 'H5', 'H5']);
  assert.equal(A.buildArt(plain, '甲功', '不在其中'), null, 'the move is not in the block');
  assert.equal(A.buildArt([], '甲功', '天地同壽'), null);
  assert.equal(A.buildArt([{ text: '悟出了新牛蛇生死搏>\n之中的一招:『對牛彈琴』\n', classes: ['H5', 'X'] }], '牛蛇生死搏', '對牛彈琴'), null, 'a 悟出了新 line with no "<" before it: the learner cannot be replaced');
  assert.equal(A.buildArt(Array.from({ length: 13 }, (_, i) => ({ text: `行${i}天地同壽\n`, classes: ['X'] })), '甲功', '天地同壽'), null, 'more than 12 lines');
});

test('buildArt keeps going when the lines arrive with CRLF and a missing colour class', () => {
  const spans = [{ text: 'ab <甲(', classes: ['H1', 'X'] }, { text: 'jia', classes: ['H2', 'X'] }, { text: ')悟出了新甲武功>\r\n', classes: ['H3', 'X'] }, { text: '<之中的一招:『甲乙』>\r\n', classes: ['X'] }];
  const learned = A.buildArt(spans, '甲武功', '甲乙');
  assert.deepEqual(learned.lines, [[['ab ', 'H1'], ['<你悟出了新甲武功>', 'H1']], [['<之中的一招:『甲乙』>', 'N7']]]);
  assert.deepEqual(learned.nameCodes, ['N7', 'N7']);
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

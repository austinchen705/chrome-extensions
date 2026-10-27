// 驗證碼數字的格子模板比對：合成 HTML（已知字形排成 span 方塊、夾雜雜訊文字 span）驗證解析、切字、縮減與模糊比對，
// 再用 tests/fixtures/captcha/ 的真實樣本驗證八種版面（含「圖前面接著整張 sc 狀態卡」的反相圖）：方塊拼數字、反相（整片填色、數字是空洞、span 跨行、片段底部被截斷）、
// 亂碼文字背景加方塊、背景色 span 裡是亂碼文字而數字是空洞、純 @ 符號畫的圖、亂碼裡以背景色標出的字元拼成數字（含時鐘雜訊與前後的一般輸出）、
// 以及 captcha-art 既有的 sprite 樣本。
// 真實樣本的行尾空白是資料的一部分，編輯器不能剝掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cg = require('../catworld-auto-command/captcha-grid');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'captcha', name), 'utf8');

const SIX_5x5 = ['.XXX.', 'X....', 'XXXX.', 'X...X', '.XXX.'];
const EIGHT_5x5 = ['.XXX.', 'X...X', '.XXX.', 'X...X', '.XXX.'];
const THREE_4x7 = ['.XX.', 'X..X', '...X', '.XX.', '...X', 'X..X', '.XX.'];
const ZERO_6x8 = ['.XXXX.', '.X..X.', 'X....X', 'X....X', 'X....X', 'X....X', '.X..X.', '.XXXX.'];

const bits = rows => rows.map(r => r.split('').map(c => c === 'X'));
const span = n => `<span class="H7 B6">${' '.repeat(n)}</span>`;

function asciiRuns(rowText) {
  const out = [];
  let start = null;
  for (let i = 0; i <= rowText.length; i++) {
    const v = i < rowText.length && rowText[i] === 'X';
    if (v && start === null) start = i;
    if (!v && start !== null) { out.push([start, i]); start = null; }
  }
  return out;
}

// 把多個字形矩陣排成終端 HTML：方塊用背景色 span、空格用純空白，字形之間夾一個雜訊文字 span。glyphs：[rows, 放大倍數]
function htmlFromGlyphs(glyphs, gap = 3, indent = 2) {
  const scaled = glyphs.map(([rows, s]) => rows.flatMap(r => Array(s).fill(r.split('').flatMap(c => Array(s).fill(c)).join(''))));
  const height = Math.max(...scaled.map(r => r.length));
  const lines = [];
  for (let j = 0; j < height; j++) {
    let line = ' '.repeat(indent);
    for (const rows of scaled) {
      const r = j < rows.length ? rows[j] : '.'.repeat(rows[0].length);
      let pos = 0;
      for (const [s, e] of asciiRuns(r)) { line += ' '.repeat(s - pos) + span(e - s); pos = e; }
      line += ' '.repeat(r.length - pos) + '<span class="H2">ab</span>' + ' '.repeat(gap - 2);
    }
    lines.push(line);
  }
  return lines.join('\n');
}

test('filledCellsFromHtml：背景色 span 裡的每個字元都算方塊（空白、實體、亂碼文字），顏色文字 span 與外層包住的 span 不算', () => {
  const html = '  <span class="H7 B6">  </span>x&nbsp;<span class="H7 B6">&nbsp;</span><span class="H2">zz</span>';
  assert.deepEqual(cg.filledCellsFromHtml(html), [[false, false, true, true, false, false, true, false, false]]);
  const text = '<span id="message">a<span class="H7 B5">kG z</span> <span class="H2">b</span></span>';
  assert.deepEqual(cg.filledCellsFromHtml(text), [[false, true, true, true, true, false, false]]);
  assert.deepEqual(cg.filledCellsFromHtml('<span class="H7 B5">ab<br>c</span>'), [[true, true], [true, false]]);
  // 沒有 span、直接用符號畫的圖：整行只有同一種符號和空白時符號才是方塊，混著文字或別的符號的行不算
  assert.deepEqual(cg.filledCellsFromHtml(' @@ @'), [[false, true, true, false, true]]);
  assert.deepEqual(cg.filledCellsFromHtml(' @@ a$&amp;#'), [[false, false, false, false, false, false, false, false]]);
});

test('reduceScale：整數倍放大縮回原尺寸，不能縮的原樣回傳', () => {
  const big = bits(EIGHT_5x5).flatMap(r => [r.flatMap(v => [v, v]), r.flatMap(v => [v, v])]);
  assert.deepEqual(cg.reduceScale(big), bits(EIGHT_5x5));
  assert.deepEqual(cg.reduceScale(bits(THREE_4x7)), bits(THREE_4x7));
});

test('decodeHtml：合成樣本含雜訊 span 與 2 倍字形', () => {
  const html = htmlFromGlyphs([[SIX_5x5, 1], [THREE_4x7, 1], [EIGHT_5x5, 2], [ZERO_6x8, 1]]);
  assert.equal(cg.decodeHtml(html).text, '6380');
});

test('decodeHtml：認不出的字形回 ? 並標記沒信心', () => {
  const weird = ['XXX', 'X.X', 'XXX', 'X.X', 'XXX', 'X.X', 'XXX'];
  const result = cg.decodeHtml(htmlFromGlyphs([[SIX_5x5, 1], [weird, 1]]));
  assert.equal(result.text, '6?');
  assert.ok(result.digits.some(d => !d.confident));
});

test('模糊比對：關掉模板庫時，只有很接近標準字型的才認（4x7 的 3），其餘回 ? 而不是亂猜', () => {
  const html = htmlFromGlyphs([[SIX_5x5, 1], [ZERO_6x8, 1], [EIGHT_5x5, 2], [THREE_4x7, 1]]);
  const result = cg.decodeHtml(html, { useLibrary: false });
  assert.equal(result.text, '???3');
  assert.deepEqual(result.digits.map(d => d.confident), [false, false, false, true]);
});

test('一般輸出裡的符號與零星的背景色不會變成數字：只有整行同一種符號才算方塊，圖只取填色最多的那一段連續列', () => {
  // (100%) 的 % 不算方塊；@ 整行才算
  const F = false, T = true;
  assert.deepEqual(cg.filledCellsFromHtml(' 840 (100%)\n  @@ @\n'), [
    [F, F, F, F, F, F, F, F, F, F, F],
    [F, F, T, T, F, T, F, F, F, F, F],
    [F, F, F, F, F, F, F, F, F, F, F],
  ]);
  // 圖上方隔著空列的一個背景色物品名稱：不影響反相判定，也不會變成假的數字
  const stray = '<span class="H7 B5">潛水裝</span>\n\n';
  assert.equal(cg.decodeHtml(stray + fixture('grid-inverted-3608.html')).text, '3608');
  assert.equal(cg.decodeHtml(stray + fixture('sprite-62044.html')).text, '62044');
});

for (const [name, expected] of [
  ['grid-68693.html', '68693'],
  ['grid-inverted-3608.html', '3608'],
  ['grid-noise-663.html', '663'],
  ['grid-reward-text.html', '306'],
  ['symbol-306.html', '306'],
  ['noise-highlight-85410.html', '85410'],
  ['sprite-62044.html', '62044'],
  ['sprite-921.html', '921'],
  ['grid-inverted-after-status.html', '53046'],
  ['noise-highlight-reward-53046.html', '53046'],
  ['grid-reward-after-status-94227.html', '94227'],
  ['noise-highlight-reward-94227.html', '94227'],
  ['grid-inverted-reward-94227.html', '94227'],
]) {
  test(`真實樣本 ${name} 解出 ${expected}`, () => {
    const result = cg.decodeHtml(fixture(name));
    assert.equal(result.text, expected);
    assert.ok(result.digits.every(d => d.confident));
  });
}

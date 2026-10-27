// 驗證碼數字的格子模板比對：合成 HTML（已知字形排成 span 方塊、夾雜雜訊文字 span）驗證解析、切字、縮減與模糊比對，
// 再用 tests/fixtures/captcha/ 的真實樣本驗證四種版面：方塊拼數字、反相（整片填色、數字是空洞、span 跨行、片段底部被截斷）、
// 亂碼文字背景加方塊、以及 captcha-art 既有的 sprite 樣本。真實樣本的行尾空白是資料的一部分，編輯器不能剝掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cg = require('../tools/captcha-grid');

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

test('filledCellsFromHtml：只有 span 內的空白算方塊，文字 span 與實體都處理', () => {
  const html = '  <span class="H7 B6">  </span>x&nbsp;<span class="H7 B6">&nbsp;</span><span class="H2">zz</span>';
  assert.deepEqual(cg.filledCellsFromHtml(html), [[false, false, true, true, false, false, true, false, false]]);
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

test('模糊比對：關掉模板庫也要認得已觀察過的字形', () => {
  const html = htmlFromGlyphs([[SIX_5x5, 1], [ZERO_6x8, 1], [EIGHT_5x5, 2], [THREE_4x7, 1]]);
  assert.equal(cg.decodeHtml(html, { useLibrary: false }).text, '6083');
});

for (const [name, expected] of [
  ['grid-68693.html', '68693'],
  ['grid-inverted-3608.html', '3608'],
  ['grid-noise-663.html', '663'],
  ['sprite-62044.html', '62044'],
]) {
  test(`真實樣本 ${name} 解出 ${expected}`, () => {
    const result = cg.decodeHtml(fixture(name));
    assert.equal(result.text, expected);
    assert.ok(result.digits.every(d => d.confident));
  });
}

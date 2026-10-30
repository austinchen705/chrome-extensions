// 驗證碼數字的格子模板比對：合成 HTML（已知字形排成 span 方塊、夾雜雜訊文字 span）驗證解析、切字、縮減與模糊比對，
// 再用 tests/fixtures/captcha/ 的真實樣本驗證各種版面（含「圖前面接著整張 sc 狀態卡」的反相圖、「圖後面 1 秒內接著整片底色的公告橫幅」的亂碼圖）：方塊拼數字、反相（整片填色、數字是空洞、span 跨行、片段底部被截斷）、
// 亂碼文字背景加方塊、背景色 span 裡是亂碼文字而數字是空洞、純 @ 符號畫的圖、亂碼裡以背景色標出的字元拼成數字（含時鐘雜訊與前後的一般輸出）、
// 同一輪連印兩張反相圖（兩張各自都要讀得出同一個答案），以及 captcha-art 既有的 sprite 樣本。
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

test('一般輸出裡的符號與零星的背景色不會變成數字：只有整行同一種符號才算方塊，圖先取填色最多的那一段連續列', () => {
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

test('圖印完後接著印的公告橫幅填色比圖多：橫幅那段認不出，就往下試填色次多的那段（真正的圖）', () => {
  const html = fixture('noise-highlight-reward-then-banner-381.html');
  const banner = cg.glyphsFromOccupancy(cg.occupancyFromHtml(html)).map(g => cg.classify(g));
  assert.ok(!banner.length || banner.some(d => !d.confident), '填色最多的那段（橫幅）本身讀不出數字');
  assert.equal(cg.decodeHtml(html).text, '381');
});

test('同一輪連印兩張反相圖（B1 再 B2，同一個答案）：合在一起讀得出，只留其中一張也各自讀得出', () => {
  const html = fixture('grid-inverted-twice-reward-after-status-52082.html');
  assert.equal(cg.decodeHtml(html).text, '52082');
  for (const [keep, drop] of [['B1', 'B2'], ['B2', 'B1']]) {
    const one = cg.decodeHtml(html.replace(new RegExp(`H7 ${drop}`, 'g'), 'H7'));
    assert.equal(one.text, '52082', `只留 ${keep} 那張`);
    assert.ok(one.digits.every(d => d.confident));
  }
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
  ['grid-inverted-reward-1595.html', '1595'],
  ['noise-inverted-reward-648.html', '648'],
  ['symbol-reward-after-status-648.html', '648'],
  ['noise-highlight-reward-then-banner-381.html', '381'],
  ['grid-inverted-reward-394.html', '394'],
  ['grid-reward-394.html', '394'],
  ['symbol-reward-394.html', '394'],
  ['grid-b1-reward-394.html', '394'],
  ['grid-058.html', '058'],
  ['grid-inverted-reward-03865.html', '03865'],
  ['symbol-reward-01565.html', '01565'],
  ['grid-reward-42965.html', '42965'],
  ['symbol-reward-after-status-2713.html', '2713'],
  ['grid-inverted-twice-reward-after-status-52082.html', '52082'],
  ['noise-inverted-reward-671.html', '671'],
  ['grid-reward-after-status-9397.html', '9397'],
  ['grid-inverted-reward-2500.html', '2500'],
  ['grid-inverted-reward-7576.html', '7576'],
  ['noise-inverted-reward-after-status-032.html', '032'],
  ['grid-reward-230.html', '230'],
  ['noise-inverted-reward-after-status-473.html', '473'],
  ['noise-inverted-2425.html', '2425'],
  ['symbol-reward-332.html', '332'],
  ['noise-inverted-814.html', '814'],
  ['symbol-reward-after-status-496.html', '496'],
  ['grid-reward-after-status-453.html', '453'],
  ['grid-reward-82705.html', '82705'],
  ['symbol-061.html', '061'],
  ['grid-inverted-reward-6648.html', '6648'],
  ['grid-b1-reward-after-status-133.html', '133'],
  ['noise-inverted-reward-180.html', '180'],
  ['grid-noise-reward-371.html', '371'],
  ['noise-highlight-reward-859.html', '859'],
  ['noise-inverted-reward-6583.html', '6583'],
  ['grid-inverted-reward-425.html', '425'],
  ['noise-highlight-354.html', '354'],
  ['symbol-7429.html', '7429'],
  ['grid-inverted-reward-4446.html', '4446'],
  ['grid-730.html', '730'],
  ['noise-highlight-reward-93920.html', '93920'],
  ['grid-reward-after-status-62746.html', '62746'],
  ['noise-highlight-reward-51301.html', '51301'],
  ['symbol-reward-51301.html', '51301'],
  ['noise-highlight-reward-2679.html', '2679'],
  ['noise-inverted-reward-after-status-02544.html', '02544'],
  ['noise-inverted-reward-367.html', '367'],
  ['symbol-reward-5857.html', '5857'],
  ['noise-highlight-697.html', '697'],
  ['noise-highlight-after-status-656.html', '656'],
  ['symbol-reward-5995.html', '5995'],
  ['noise-highlight-reward-999.html', '999'],
  ['grid-after-status-257.html', '257'],
  ['symbol-sign-after-login-3844.html', '3844'],
  ['noise-highlight-sign-290.html', '290'],
  ['noise-highlight-after-m-81981.html', '81981'],
  ['noise-highlight-reward-952.html', '952'],
  ['symbol-reward-76325.html', '76325'],
  ['symbol-after-m-8715.html', '8715'],
  ['noise-highlight-reward-361.html', '361'],
  ['grid-reward-after-status-3880.html', '3880'],
  ['symbol-after-ps-831.html', '831'],
  ['noise-highlight-reward-after-status-93462.html', '93462'],
  ['noise-highlight-reward-74477.html', '74477'],
  ['noise-highlight-reward-773.html', '773'],
  ['symbol-reward-2154.html', '2154'],
  ['grid-reward-after-status-08482.html', '08482'],
  ['symbol-75392.html', '75392'],
  ['grid-inverted-reward-after-status-955.html', '955'],
  ['grid-after-m-96764.html', '96764'],
  ['grid-reward-12126.html', '12126'],
  ['noise-highlight-reward-2535.html', '2535'],
  ['noise-highlight-reward-984.html', '984'],
  ['grid-reward-after-status-1732.html', '1732'],
  ['grid-reward-05859.html', '05859'],
  ['symbol-reward-9972.html', '9972'],
  ['grid-inverted-after-m-10114.html', '10114'],
  ['noise-highlight-reward-703.html', '703'],
  ['grid-inverted-reward-after-status-874.html', '874'],
  ['noise-inverted-28097.html', '28097'],
  ['grid-reward-after-m-3905.html', '3905'],
  ['grid-reward-88666.html', '88666'],
  ['grid-inverted-after-ex-425.html', '425'],
  ['grid-inverted-after-m-28567.html', '28567'],
  ['noise-highlight-reward-67174.html', '67174'],
  ['symbol-692.html', '692'],
  ['symbol-reward-431.html', '431'],
  ['grid-inverted-reward-after-status-614.html', '614'],
  ['grid-inverted-reward-after-status-30105.html', '30105'],
  ['grid-reward-2800.html', '2800'],
  ['symbol-reward-184.html', '184'],
  ['symbol-143.html', '143'],
  ['grid-inverted-reward-385.html', '385'],
  ['noise-inverted-reward-1879.html', '1879'],
  ['noise-inverted-reward-925.html', '925'],
  ['noise-inverted-reward-00808.html', '00808'],
  ['noise-highlight-reward-327.html', '327'],
  ['noise-inverted-reward-3879.html', '3879'],
  ['noise-inverted-reward-9652.html', '9652'],
  ['grid-reward-198.html', '198'],
  ['noise-highlight-reward-43161.html', '43161'],
  ['symbol-reward-1026.html', '1026'],
  ['symbol-reward-27082.html', '27082'],
  ['grid-reward-606.html', '606'],
  ['noise-highlight-445.html', '445'],
  ['noise-inverted-reward-511.html', '511'],
  ['grid-inverted-reward-01423.html', '01423'],
  ['noise-inverted-reward-096.html', '096'],
  ['noise-highlight-9023.html', '9023'],
  ['symbol-reward-2646.html', '2646'],
  ['noise-highlight-reward-0808.html', '0808'],
  ['noise-highlight-reward-9261.html', '9261'],
  ['noise-highlight-reward-7320.html', '7320'],
]) {
  test(`真實樣本 ${name} 解出 ${expected}`, () => {
    const result = cg.decodeHtml(fixture(name));
    assert.equal(result.text, expected);
    assert.ok(result.digits.every(d => d.confident));
  });
}

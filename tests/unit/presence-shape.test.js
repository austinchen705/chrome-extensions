// 真人驗證圖的形狀比對（tools/presence-shape.js）：用 tests/fixtures/captcha/ 的兩張真實樣本（收集表第 875、876 列）驗證選到的是同形狀的候選。
// presence-875.png 是 RGBA（頁面上 canvas 轉出的）、範例是六邊形，最像的干擾是圓形；presence-876.png 是 RGB（遊戲原圖）、範例是十字。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ps = require('../../tools/presence-shape');

const fixture = name => ps.decodePng(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'captcha', name)));
const near = (actual, expected) => Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) <= 3;

test('decodePng：RGBA 與 RGB 都解成 320x160 的 RGBA', () => {
  for (const name of ['presence-875.png', 'presence-876.png']) {
    const img = fixture(name);
    assert.deepEqual([img.width, img.height, img.data.length], [320, 160, 320 * 160 * 4]);
  }
});

test('範例是六邊形：選青色六邊形，不選圓形', () => {
  const { example, candidates, best } = ps.matchImage(fixture('presence-875.png'));
  assert.ok(near(example.center, [46, 80]), `範例在 ${example.center}`);
  assert.equal(candidates.length, 6);
  assert.ok(near(best.center, [149, 56]), `選到 ${best.center}`);
  assert.ok(near(candidates[1].center, [170, 103]), '次近的是圓形');
  assert.ok(best.distance * 2 < candidates[1].distance, `和次近的差距不夠：${best.distance} / ${candidates[1].distance}`);
});

test('範例是十字：選青色十字（角度與顏色都不同）', () => {
  const { candidates, best } = ps.matchImage(fixture('presence-876.png'));
  assert.equal(candidates.length, 6);
  assert.ok(near(best.center, [288, 63]), `選到 ${best.center}`);
  assert.ok(best.distance * 2 < candidates[1].distance, `和次近的差距不夠：${best.distance} / ${candidates[1].distance}`);
});

test('不是這種驗證圖（沒有範例方框）就丟例外，不亂給座標', () => {
  const blank = { width: 320, height: 160, data: new Uint8ClampedArray(320 * 160 * 4).fill(240) };
  assert.throws(() => ps.matchImage(blank), /找不到範例方框/);
});

test('sheetCsvUrl：編輯網址換成該分頁的 CSV 匯出網址', () => {
  assert.equal(
    ps.sheetCsvUrl('https://docs.google.com/spreadsheets/d/abc-_1/edit?gid=42#gid=42'),
    'https://docs.google.com/spreadsheets/d/abc-_1/export?format=csv&gid=42',
  );
});

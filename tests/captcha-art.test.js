// 驗證碼圖形偵測（jsdom）：用真實記錄裡的兩種驗證碼（一大塊英數亂碼加少數背景色字元、B3 背景空白拼成的數字圖）與一般輸出。
// 遊戲輸出可能分成好幾批新增文字到達，偵測不能只看單一批；需要 jsdom（devDependency），沒裝就跳過。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // 沒裝 jsdom：整批跳過
}
const ui = JSDOM ? test : test.skip;

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'captcha', name), 'utf8').split('\n').filter((line, i, all) => i < all.length - 1 || line);
const NOISE = fixture('noise-block.html');
const SPRITE = fixture('sprite-62044.html');
const ORDINARY = fixture('ordinary-output.html');

let W = null;
function boot() {
  if (!W) {
    W = new JSDOM('<body></body>').window;
    globalThis.Node = W.Node;
    require(path.join(__dirname, '..', 'catworld-auto-command', 'captcha-art.js'));
  }
  return globalThis.CatworldCaptchaArt;
}

// 把一批 HTML 行當成「新增的節點」轉成偵測用的文字（和 content.js 的 MutationObserver 一樣）
function textOf(Art, lines) {
  const holder = W.document.createElement('div');
  holder.innerHTML = `${lines.join('\n')}\n`;
  return Array.from(holder.childNodes, node => Art.artText(node)).join('');
}

// 依批次大小切開，一批一批餵給偵測器；回傳第幾批偵測到（-1＝都沒有）
function detectIn(Art, lines, perBatch, { clock = { at: 0 }, gapMs = 100 } = {}) {
  const watcher = Art.createWatcher({ now: () => clock.at });
  for (let i = 0, batch = 0; i < lines.length; i += perBatch, batch += 1) {
    clock.at += gapMs;
    if (watcher.feed(textOf(Art, lines.slice(i, i + perBatch)))) return batch;
  }
  return -1;
}

ui('the digit picture made of background-coloured spaces is caught when it arrives in one batch', () => {
  const Art = boot();
  assert.equal(detectIn(Art, SPRITE, SPRITE.length), 0);
});

ui('the same picture is caught when it arrives split in small batches (a few lines at a time)', () => {
  const Art = boot();
  [1, 2, 3, 4].forEach(perBatch => assert.notEqual(detectIn(Art, SPRITE, perBatch), -1, `${perBatch} lines per batch`));
});

ui('the block of random letters with a few highlighted characters is caught in one batch and split into small ones', () => {
  const Art = boot();
  [NOISE.length, 5, 3, 1].forEach(perBatch => assert.notEqual(detectIn(Art, NOISE, perBatch), -1, `${perBatch} lines per batch`));
});

ui('it is still caught when ordinary output comes right before the picture in the same batch or an earlier one', () => {
  const Art = boot();
  assert.notEqual(detectIn(Art, [...ORDINARY, ...SPRITE], 7), -1);
  assert.notEqual(detectIn(Art, [...ORDINARY, ...NOISE], 4), -1);
});

ui('ordinary game output, even fed line by line, is never taken for a captcha', () => {
  const Art = boot();
  [ORDINARY.length, 3, 1].forEach(perBatch => assert.equal(detectIn(Art, ORDINARY, perBatch), -1, `${perBatch} lines per batch`));
});

ui('pieces that are far apart in time are not glued together', () => {
  const Art = boot();
  const clock = { at: 0 };
  assert.equal(detectIn(Art, SPRITE, 3, { clock, gapMs: 6000 }), -1, 'three lines every six seconds never add up');
});

ui('after a detection the buffer is empty, so the leftover lines of the same picture do not fire again', () => {
  const Art = boot();
  const watcher = Art.createWatcher({ now: () => 0 });
  assert.equal(watcher.feed(textOf(Art, SPRITE)), true);
  assert.equal(watcher.feed(textOf(Art, SPRITE.slice(0, 2))), false);
});

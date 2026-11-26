// 書生助手開關（整個 content script 在 jsdom 裡跑）：打開時先送 sc、sk（分頁就送 Enter 讀到最後一頁）做開始前檢查，不符合就保持關閉並警告。樣本是遊戲的真實輸出（tests/fixtures/scholar/）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ui, boot, waitFor } = require('../../helpers/game-page');

const sample = name => fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'scholar', `${name}.txt`), 'utf8');
const panelRoot = page => page.hosts()[0].shadowRoot;
const button = page => panelRoot(page).querySelector('.sbtn');
const text = page => panelRoot(page).querySelector('.scholar-text');

// 假遊戲：sc 回固定樣本；sk 是分頁的，第一頁回 sk，之後每個 Enter（送出空白）回 more 的下一頁
function fakeGame(page, { sc, sk, more = [] }) {
  const pages = [...more];
  const say = name => page.output(`<span>${sample(name)}\n</span>`);
  page.w.document.getElementById('f').addEventListener('submit', () => {
    const command = page.w.document.getElementById('input').value;
    if (command === 'sc' && sc) say(sc);
    if (command === 'sk' && sk) say(sk);
    if (command === '' && pages.length) say(pages.shift());
  });
}

ui('turning the helper on sends sc, sk, then Enter for the next page (the last page ends the pager by itself); spirit 31 with 28 skills passes and it shows the success count', async () => {
  const page = await boot({ initialStore: { scholarSuccess: { 山本由伸: 2 } } });
  try {
    page.w.document.title = '山本由伸 - 小貓的世界';
    fakeGame(page, { sc: 'sc-spirit-31', sk: 'sk-28', more: ['sk-page2'] });
    button(page).click();
    assert.ok(await waitFor(() => button(page).classList.contains('on'), 6000), text(page).textContent);
    assert.deepEqual(page.sent, ['sc', 'sk', '']);
    assert.equal(text(page).textContent, '已成功 2／3');
    assert.ok(!text(page).classList.contains('warn'));
  } finally {
    page.close();
  }
});

ui('over the skill limit: warning in the warn colour, the helper stays off and nothing is abandoned', async () => {
  const page = await boot();
  try {
    fakeGame(page, { sc: 'sc-spirit-20', sk: 'sk-28', more: ['sk-page2'] });
    button(page).click();
    assert.ok(await waitFor(() => /abandon/.test(text(page).textContent), 6000), text(page).textContent);
    assert.equal(text(page).textContent, '技能數 28、靈性 20，要先 abandon 8 個技能');
    assert.ok(text(page).classList.contains('warn'));
    assert.ok(!button(page).classList.contains('on'));
    assert.deepEqual(page.sent, ['sc', 'sk', '']);
  } finally {
    page.close();
  }
});

ui('already has six-vein: the limit is spirit + 1', async () => {
  const page = await boot();
  try {
    fakeGame(page, { sc: 'sc-spirit-20', sk: 'sk-29-has-six-vein' });
    button(page).click();
    assert.ok(await waitFor(() => /abandon/.test(text(page).textContent), 6000), text(page).textContent);
    assert.equal(text(page).textContent, '技能數 29、靈性 20，要先 abandon 8 個技能');
    assert.deepEqual(page.sent, ['sc', 'sk']);
  } finally {
    page.close();
  }
});

ui('six-vein-sword is on the second page of sk: it is still counted (limit spirit + 1)', async () => {
  const page = await boot();
  try {
    fakeGame(page, { sc: 'sc-spirit-20', sk: 'sk-28', more: ['sk-page2-six-vein'] });
    button(page).click();
    assert.ok(await waitFor(() => /abandon/.test(text(page).textContent), 6000), text(page).textContent);
    assert.equal(text(page).textContent, '技能數 28、靈性 20，要先 abandon 7 個技能');
    assert.deepEqual(page.sent, ['sc', 'sk', '']);
  } finally {
    page.close();
  }
});

ui('sc gets no reply: stays off with the reason and does not send sk', async () => {
  const page = await boot({ scale: 20 });
  try {
    fakeGame(page, {});
    button(page).click();
    assert.ok(await waitFor(() => /讀不到 sc/.test(text(page).textContent), 6000), text(page).textContent);
    assert.ok(!button(page).classList.contains('on'));
    assert.deepEqual(page.sent, ['sc']);
  } finally {
    page.close();
  }
});

ui('turning it off and on again checks again', async () => {
  const page = await boot();
  try {
    fakeGame(page, { sc: 'sc-spirit-31', sk: 'sk-29-has-six-vein' });
    button(page).click();
    assert.ok(await waitFor(() => button(page).classList.contains('on'), 6000));
    button(page).click();
    assert.ok(await waitFor(() => !button(page).classList.contains('on')));
    button(page).click();
    assert.ok(await waitFor(() => page.sent.length === 4 && button(page).classList.contains('on'), 6000), page.sent.join());
    assert.deepEqual(page.sent, ['sc', 'sk', 'sc', 'sk']);
  } finally {
    page.close();
  }
});

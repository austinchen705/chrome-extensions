// 整個 content script 在 jsdom 裡跑起來（載入 manifest 列的所有檔案、假的 chrome）的行為測試：
// 擴充功能重新載入之後留在頁面上的舊程式（連不上擴充功能的「孤兒」）不能繼續送指令、不能留下第二個面板，
// 連線被取代時一定要停。底座在 tests/helpers/game-page.js，驗證碼自動辨識的行為測試在 tests/captcha-solve.test.js。需要 jsdom（devDependency）；沒裝就跳過。
const test = require('node:test');
const assert = require('node:assert/strict');

const { ui, boot, sleep, waitFor, START } = require('./helpers/game-page');

ui('a running timer stops sending commands once the page is cut off from the extension, and its panel goes away', async () => {
  const page = await boot();
  try {
  await page.ask(START);
  assert.ok(await waitFor(() => page.sent.length >= 1, 4000), 'it sends commands while alive');
  assert.equal(page.hosts().length, 1);
  page.w.chrome.runtime.id = undefined; // 擴充功能重新載入後，舊頁面裡的 chrome.runtime.id 會失效
  await sleep(150);
  const before = page.sent.length;
  await sleep(2500);
  assert.equal(page.sent.length, before, 'no more commands after the context is gone');
  assert.equal(page.hosts().length, 0, 'the orphan panel is removed');
  } finally {
    page.close();
  }
});

ui('being replaced by a connection from elsewhere stops everything and rings once', async () => {
  const page = await boot();
  try {
  await page.ask(START);
  assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
  const alerts = [];
  page.w.chrome.runtime.sendMessage = message => { alerts.push(message); return Promise.resolve({}); };
  page.w.document.getElementById('message').append('有人從別處( 203.0.113.9 )連線取代你所控制的人物。');
  assert.ok(await waitFor(async () => (await page.ask({ type: 'STATUS' }))?.running === false, 2000), 'the timer is stopped');
  const before = page.sent.length;
  await sleep(2200);
  assert.equal(page.sent.length, before, 'and nothing more is sent');
  const takeover = alerts.filter(message => message.type === 'ALERT');
  assert.equal(takeover.length, 1);
  assert.ok(!/驗證/.test(takeover[0].reason), 'not treated as a captcha stop');
  assert.ok(!takeover[0].confirmable, 'rings once, no confirm needed');
  } finally {
    page.close();
  }
});

ui('a new instance injected into the same page replaces the leftover panel instead of adding a second one', async () => {
  const page = await boot();
  try {
  assert.equal(page.hosts().length, 1);
  // 備援注入是新的隔離環境：防重複的旗標是空的，模組全域則是新的環境重新載入的
  delete page.w.__catworldAutoCommandInstalled;
  page.install(['content.js']);
  assert.equal(page.hosts().length, 1, 'exactly one panel');
  } finally {
    page.close();
  }
});

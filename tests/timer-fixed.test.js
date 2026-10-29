// 定時的固定指令每一項各自循環（整個 content script 在 jsdom 裡跑，底座在 tests/helpers/game-page.js，計時器縮小 SCALE 倍）：
// 開始時每一項先送一次，之後各自照自己的秒數重送，彼此不等；STATUS 回每一項的下一次時間；停止後不再送。需要 jsdom；沒裝就跳過
const test = require('node:test');
const assert = require('node:assert/strict');

const { ui, boot, sleep, waitFor } = require('./helpers/game-page');

const SCALE = 10;
const count = (page, command) => page.sent.filter(sent => sent === command).length;

ui('each fixed item runs on its own interval', async () => {
  const page = await boot({ scale: SCALE });
  try {
  await page.ask({ type: 'START', settings: { fixedItems: [
    { command: 'fast', minSeconds: 1, maxSeconds: 1 },
    { command: 'slow', minSeconds: 3, maxSeconds: 3 },
  ], commandDelayMs: 0 } });
  assert.ok(await waitFor(() => count(page, 'fast') >= 1 && count(page, 'slow') >= 1, 1000), 'both are sent once at start');
  const status = await page.ask({ type: 'STATUS' });
  assert.deepEqual(status.fixed.map(entry => entry.command), ['fast', 'slow']);
  assert.ok(status.fixed.every(entry => entry.at > Date.now()), 'each item has its own next time');
  await sleep(6500 / SCALE);
  const fast = count(page, 'fast');
  const slow = count(page, 'slow');
  assert.ok(fast >= 5, `fast repeats every second (sent ${fast})`);
  assert.ok(slow >= 2 && slow <= 4, `slow repeats every three seconds (sent ${slow})`);
  await page.ask({ type: 'STOP' });
  const before = page.sent.length;
  await sleep(3500 / SCALE);
  assert.equal(page.sent.length, before, 'nothing more after stop');
  assert.equal((await page.ask({ type: 'STATUS' })).fixed.length, 0);
  } finally {
    page.close();
  }
});

ui('no fixed item and one random item still runs', async () => {
  const page = await boot({ scale: SCALE });
  try {
  await page.ask({ type: 'START', settings: { fixedItems: [], randomItems: [{ command: 'look', minSeconds: 1, maxSeconds: 1 }], commandDelayMs: 0 } });
  assert.ok(await waitFor(() => count(page, 'look') >= 2, 2000), 'the random item is sent');
  assert.ok(!page.sent.includes('ps'), 'the default fixed command is not sent when the list was emptied');
  assert.equal((await page.ask({ type: 'STATUS' })).fixed.length, 0);
  } finally {
    page.close();
  }
});

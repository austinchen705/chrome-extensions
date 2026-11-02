// 規則的「最優先」（整個 content script 在 jsdom 裡跑，底座在 tests/helpers/game-page.js）：
// 勾了的規則命中時，指令整段（含 @等待）先做完，其他來源已經在 @等待 的巨集暫停、剩餘等待時間凍結，做完才接著算；
// 沒勾的規則維持原本的交錯送出。需要 jsdom；沒裝就跳過
const assert = require('node:assert/strict');

const { ui, boot, sleep, waitFor } = require('./helpers/game-page');

const SCALE = 10;
const keyword = (pattern, commands, extra) => ({ kind: 'keyword', enabled: true, pattern, commands, cooldown: 3, ...extra });
const config = rules => ({ rules, delayMax: 0, requireNormal: false });
// 定時的固定指令：a 送出後等 2 秒再送 b（只送一輪，下一輪在 10 分鐘後）
const TIMER = { fixedItems: [{ command: 'a;@等待 2;b', minSeconds: 600, maxSeconds: 600 }], commandDelayMs: 0 };

async function run(extra) {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask({ type: 'START', settings: TIMER });
    assert.ok(await waitFor(() => page.sent.includes('a'), 1000), 'the timer macro starts and is now waiting');
    await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['p1;@等待 3;p2'], extra)]) });
    page.output('<span>你覺得口渴。</span>');
    assert.ok(await waitFor(() => page.sent.includes('b') && page.sent.includes('p2'), 4000), 'every command is eventually sent');
    return [...page.sent];
  } finally {
    page.close();
  }
}

ui('without the flag the trigger macro and the waiting timer macro interleave', async () => {
  assert.deepEqual(await run({}), ['a', 'p1', 'b', 'p2']);
});

ui('with the flag the trigger commands finish first and the waiting macro resumes afterwards', async () => {
  assert.deepEqual(await run({ priority: true }), ['a', 'p1', 'p2', 'b']);
});

ui('a held macro keeps its remaining wait: it does not send the moment the priority macro ends', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask({ type: 'START', settings: TIMER });
    assert.ok(await waitFor(() => page.sent.includes('a'), 1000));
    await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['p1;@等待 3;p2'], { priority: true })]) });
    page.output('<span>你覺得口渴。</span>');
    assert.ok(await waitFor(() => page.sent.includes('p2'), 4000));
    assert.ok(!page.sent.includes('b'), 'b is still waiting when p2 goes out');
    assert.ok(await waitFor(() => page.sent.includes('b'), 3000), 'and it is sent once the rest of the wait has passed');
    await sleep(50);
  } finally {
    page.close();
  }
});

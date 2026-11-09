// 「送出指令後 8 秒沒有收到遊戲回應」的看門狗：送出的是空白行（Enter，例如指令結尾多了 ; 變成空的一段，或寫了 <enter>）時不啟動，
// 因為遊戲對空白行只回一個「> 」回聲，本來就沒有真正的回應；真的指令沒回應仍然要停。需要 jsdom
// 整個 content script 在 jsdom 裡跑；計時器縮小 SCALE 倍（8 秒 → 0.4 秒）
const assert = require('node:assert/strict');
const { ui, boot, sleep, waitFor } = require('./helpers/game-page');

const SCALE = 20;
const alerts = page => page.messages.filter(message => message.type === 'ALERT').map(message => message.reason);
const noReply = page => alerts(page).filter(reason => /沒有收到遊戲回應/.test(reason));

// 假遊戲：每個非空的指令回一行輸出；空白行只有回聲「> 」
function replyLikeTheGame(page) {
  let replied = 0;
  const timer = setInterval(() => {
    while (replied < page.sent.length) {
      const sent = page.sent[replied++];
      page.output(sent === '' ? '<span>&gt; </span>' : `<span>&gt; ${sent}\n你看了看四周。</span>`);
    }
  }, 5);
  return () => clearInterval(timer);
}

ui('a fixed command that ends in a semicolon sends a blank line and the watchdog does not take it for a missing reply', async () => {
  const page = await boot({ scale: SCALE });
  const stop = replyLikeTheGame(page);
  try {
    await page.ask({ type: 'START', settings: { fixedItems: [{ command: 'run s;', minSeconds: 600, maxSeconds: 600 }], commandDelayMs: 0 } });
    assert.ok(await waitFor(() => page.sent.includes(''), 2000), 'the blank line really goes out');
    await sleep(1000); // 比看門狗（0.4 秒）久很多
    assert.deepEqual(noReply(page), []);
    assert.equal(await page.running(), true, 'still running');
  } finally {
    stop();
    page.close();
  }
});

ui('a lone <enter> does not start the watchdog either', async () => {
  const page = await boot({ scale: SCALE });
  const stop = replyLikeTheGame(page);
  try {
    await page.ask({ type: 'START', settings: { fixedItems: [{ command: 'look;<enter>', minSeconds: 600, maxSeconds: 600 }], commandDelayMs: 0 } });
    assert.ok(await waitFor(() => page.sent.includes(''), 2000));
    await sleep(1000);
    assert.deepEqual(noReply(page), []);
  } finally {
    stop();
    page.close();
  }
});

ui('a real command that gets no reply still stops everything', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask({ type: 'START', settings: { fixedItems: [{ command: 'look', minSeconds: 600, maxSeconds: 600 }], commandDelayMs: 0 } });
    assert.ok(await waitFor(() => noReply(page).length === 1, 2000), 'the watchdog still fires for a real command');
    assert.equal(await page.running(), false);
  } finally {
    page.close();
  }
});

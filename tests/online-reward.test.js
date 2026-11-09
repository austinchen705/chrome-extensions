// 在線獎勵：看到「在線獎勵： N分鐘後可領取」就排 N+1 分鐘後處理，已經排著的忽略；時間到先下 sc，隨機 5～10 秒後才下 reward。需要 jsdom
// 計時器縮小 SCALE 倍（4 分鐘 → 40 毫秒）
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, boot, sleep, waitFor } = require('./helpers/game-page');

const SCALE = 6000;
const rewards = page => page.sent.filter(command => command === 'reward').length;
const scs = page => page.sent.filter(command => command === 'sc').length;
// 記下頁面裡之後每個 setTimeout 的毫秒數（縮小之前的）
function recordDelays(page) {
  const delays = [];
  const inner = page.w.setTimeout;
  page.w.setTimeout = (fn, ms, ...args) => { delays.push(ms); return inner(fn, ms, ...args); };
  return delays;
}

ui('sc showing 3 minutes schedules reward for 3+1 minutes later, not before', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.output('<span>在線獎勵： 3分鐘後可領取</span>');
    await sleep(10);
    assert.equal(rewards(page), 0, 'not sent before the wait is over');
    assert.equal(scs(page), 0, 'nor is sc');
    assert.ok(await waitFor(() => rewards(page) === 1, 2000));
    assert.equal(page.sent[0], 'sc', 'sc goes first');
    assert.equal(page.sent[1], 'reward', 'then reward');
  } finally {
    page.close();
  }
});

ui('a second sc while one is pending is ignored, and a later one schedules again', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.output('<span>在線獎勵： 3分鐘後可領取</span>');
    page.output('<span>在線獎勵： 2分鐘後可領取</span>');
    assert.ok(await waitFor(() => rewards(page) === 1, 2000));
    await sleep(150);
    assert.equal(rewards(page), 1, 'the second line did not schedule another one');
    page.output('<span>在線獎勵： 1分鐘後可領取</span>');
    assert.ok(await waitFor(() => rewards(page) === 2, 2000), 'once the first fired, a new sc schedules again');
  } finally {
    page.close();
  }
});

ui('other text does nothing, and turning the switch off cancels a pending one', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.output('<span>在線獎勵： 可以領取了</span>');
    await sleep(100);
    assert.equal(rewards(page), 0);
    page.output('<span>在線獎勵： 3分鐘後可領取</span>');
    page.changeListeners.forEach(listener => listener({ autoReward: { newValue: false } }, 'local'));
    await sleep(150);
    assert.equal(rewards(page), 0, 'cancelled');
    page.output('<span>在線獎勵： 3分鐘後可領取</span>');
    await sleep(150);
    assert.equal(rewards(page), 0, 'off means no new schedule');
  } finally {
    page.close();
  }
});

ui('the panel shows the countdown while it waits and hides the line once reward was sent', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const line = () => page.hosts()[0]?.shadowRoot.querySelector('.reward-line');
    assert.equal(line().hidden, true, 'no countdown line before anything is scheduled');
    page.output('<span>在線獎勵： 3分鐘後可領取</span>');
    assert.ok(await waitFor(() => line().hidden === false, 2000));
    assert.match(line().querySelector('.reward-text').textContent, /在線獎勵 [34]:\d\d 後自動領取/);
    assert.ok(await waitFor(() => rewards(page) === 1, 2000));
    assert.ok(await waitFor(() => line().hidden === true, 2000));
  } finally {
    page.close();
  }
});

ui('when the time is up sc goes out first and reward follows a random 5 to 10 seconds later', async () => {
  for (const [random, expected] of [[0, 5000], [0.999999, 10000]]) {
    const page = await boot({ scale: SCALE });
    try {
      page.w.Math.random = () => random;
      const delays = recordDelays(page);
      page.output('<span>在線獎勵： 3分鐘後可領取</span>');
      assert.ok(await waitFor(() => scs(page) >= 1, 2000), 'sc is sent when the countdown ends');
      assert.ok(delays.includes(expected), `reward is scheduled ${expected} ms after sc: ${JSON.stringify(delays)}`);
      assert.ok(await waitFor(() => rewards(page) === 1, 2000));
      assert.ok(page.sent.indexOf('sc') < page.sent.indexOf('reward'), 'sc before reward');
    } finally {
      page.close();
    }
  }
});

ui('the sc sent at the end of the countdown does not schedule a second reward, even when its answer still shows minutes left', async () => {
  // 縮小 100 倍：倒數 2 分鐘 → 1.2 秒，sc 之後的 10 秒 → 100 毫秒（要夠長，第二行輸出才趕得上在 reward 送出之前）
  const page = await boot({ scale: 100 });
  try {
    page.w.Math.random = () => 0.999999;
    page.output('<span>在線獎勵： 1分鐘後可領取</span>');
    assert.ok(await waitFor(() => scs(page) === 1, 3000));
    assert.equal(rewards(page), 0, 'reward is still waiting out its 5 to 10 seconds');
    page.output('<span>在線獎勵： 1分鐘後可領取</span>'); // 時間有一點差，遊戲說還有一分鐘
    assert.ok(await waitFor(() => rewards(page) === 1, 2000));
    await sleep(1600); // 比再排一輪（1.2 秒加 0.1 秒）還久
    assert.equal(rewards(page), 1, 'only the one reward that was already waiting');
    assert.equal(scs(page), 2, 'the one at the end of the countdown plus the one that follows the reward');
  } finally {
    page.close();
  }
});

ui('when sc cannot be sent the countdown retries like reward does, gives up after 3 tries, and a later sc schedules again', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const input = page.w.document.getElementById('input');
    const form = input.form;
    form.remove(); // 找不到指令輸入框，sendCommand 會失敗
    page.output('<span>在線獎勵： 3分鐘後可領取</span>');
    await sleep(300);
    assert.equal(page.sent.length, 0, 'nothing could be sent');
    assert.equal(rewards(page), 0);
    page.w.document.body.append(form);
    page.output('<span>在線獎勵： 3分鐘後可領取</span>');
    assert.ok(await waitFor(() => rewards(page) === 1, 2000), 'a later sc schedules again, so the failed round did not leave a stuck timer');
    assert.equal(page.sent[0], 'sc');
  } finally {
    page.close();
  }
});

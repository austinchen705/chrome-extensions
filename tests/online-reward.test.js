// 在線獎勵：看到「在線獎勵： N分鐘後可領取」就排 N+1 分鐘後送 reward，已經排著的忽略。需要 jsdom
// 計時器縮小 SCALE 倍（4 分鐘 → 40 毫秒）
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, boot, sleep, waitFor } = require('./helpers/game-page');

const SCALE = 6000;
const rewards = page => page.sent.filter(command => command === 'reward').length;

ui('sc showing 3 minutes schedules reward for 3+1 minutes later, not before', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.output('<span>在線獎勵： 3分鐘後可領取</span>');
    await sleep(10);
    assert.equal(rewards(page), 0, 'not sent before the wait is over');
    assert.ok(await waitFor(() => rewards(page) === 1, 2000));
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

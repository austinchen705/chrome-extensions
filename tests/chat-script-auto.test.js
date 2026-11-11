// 劇本對話的自動開場：練功組開始後，角色 A 每分鐘擲一次骰子（機率 1÷autoEveryMin），抽中就等於按了「現在開一場」。
// 整個 content script 在 jsdom 裡跑；計時器縮小 SCALE 倍（暖機 5 分鐘＝150 毫秒、每分鐘擲一次＝30 毫秒、兩場至少隔 20 次擲骰＝600 毫秒），
// 隨機數換成固定值，所以「抽中」「沒抽中」是確定的。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, boot, waitFor, sleep } = require('./helpers/game-page');

const SCALE = 2000;
const B = { nick: '緋爾', id: 'fenrir' };
const PLAIN = {
  id: 't4',
  lines: [
    { who: 'A', text: '今天要不要去吃飯' },
    { who: 'B', text: '好啊去哪裡吃' },
  ],
};
const FIRST_TELL = 'tell fenrir 今天要不要去吃飯';
const keyword = (pattern, commands) => ({ kind: 'keyword', enabled: true, pattern, commands, cooldown: 1 });
const PRACTICE = { type: 'START_TRIGGER', group: 'practice', config: { rules: [keyword('口渴', ['drink'])], delayMax: 0, requireNormal: false } };
const tells = page => page.sent.filter(command => command === FIRST_TELL);

// random：頁面裡 Math.random 的固定值（0＝一定抽中，0.999＝只有機率 1 才抽得中）
// fastClock：頁面的 Date.now 也快 SCALE 倍（計時器縮小多少，時鐘就快多少），最小間隔（20 分鐘＝600 毫秒）才測得到；
// 只有要測時鐘的測試開，因為快到幾小時之後跨日會讓每日場數歸零
async function soloA({ autoEveryMin = 1, random = 0, role = 'A', extra = {}, chatScript = {}, fastClock = false, scripts = [PLAIN] } = {}) {
  const page = await boot({
    scale: SCALE,
    respond: message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts } : {}),
    initialStore: { chatScript: { enabled: true, typoRate: 0, role, partner: B.id, partnerName: B.nick, autoEveryMin, ...chatScript }, autoReward: false, ...extra },
  });
  page.w.Math.random = () => random;
  if (fastClock) {
    const realNow = page.w.Date.now.bind(page.w.Date);
    const base = realNow();
    page.w.Date.now = () => base + (realNow() - base) * SCALE;
    page.clockNow = () => page.w.Date.now();
  }
  // 遊戲對送出的每個指令都回一行：沒有回應的話「送出指令 8 秒沒回應」的看門狗（縮小後只有幾毫秒）會把整個練功組停掉，自動開場也跟著停
  page.w.document.getElementById('f').addEventListener('submit', () => setTimeout(() => page.output('<span>遊戲的回應\n</span>'), 1));
  return page;
}

test('the chance of one roll is 1 over the minutes asked for, and 0 when it is off', () => {
  require('../catworld-auto-command/chat-script.js');
  const C = globalThis.CatworldChatScript;
  assert.deepEqual([0, 1, 4, 100].map(C.autoChance), [0, 1, 0.25, 0.01]);
  assert.ok(C.AUTO_MIN_GAP_MS >= C.AUTO_ROLL_MS && C.AUTO_WARMUP_MS > C.AUTO_ROLL_MS);
});

ui('nothing opens by itself while the setting is 0, even with the practice group running and a sure hit', async () => {
  const page = await soloA({ autoEveryMin: 0 });
  try {
    await page.ask(PRACTICE);
    await sleep(900);
    assert.equal(tells(page).length, 0);
  } finally {
    page.close();
  }
});

ui('nothing opens by itself until the practice group is started', async () => {
  const page = await soloA();
  try {
    await sleep(900);
    assert.equal(tells(page).length, 0, 'not running');
    await page.ask(PRACTICE);
    assert.ok(await waitFor(() => tells(page).length >= 1, 4000), 'running');
  } finally {
    page.close();
  }
});

ui('there is a warm-up after the practice group starts, and then the first roll opens a scene', async () => {
  const page = await soloA();
  try {
    await page.ask(PRACTICE);
    await sleep(60); // 暖機 150 毫秒還沒過
    assert.equal(tells(page).length, 0, 'still warming up');
    assert.ok(await waitFor(() => tells(page).length >= 1, 4000), 'then the scene opens');
  } finally {
    page.close();
  }
});

ui('a roll that misses opens nothing, a roll that hits opens a scene; the next roll tries again', async () => {
  const page = await soloA({ autoEveryMin: 2, random: 0.9 }); // 機率 0.5：0.9 沒中
  try {
    await page.ask(PRACTICE);
    await sleep(700);
    assert.equal(tells(page).length, 0, 'every roll missed');
    page.w.Math.random = () => 0.1;
    assert.ok(await waitFor(() => tells(page).length >= 1, 4000), 'the next roll hits');
  } finally {
    page.close();
  }
});

ui('a role of B, a spent daily limit and idle each make a hit give up, and the next roll tries again', async () => {
  const day = new Date();
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const asB = await soloA({ role: 'B' });
  const full = await soloA({ chatScript: { perDay: 1 }, extra: { chatScriptState: { date: key, count: 1, recent: [] } } });
  const idle = await soloA();
  try {
    await asB.ask(PRACTICE);
    await full.ask(PRACTICE);
    await idle.ask(PRACTICE);
    await idle.ask({ type: 'START_IDLE', settings: { everyMin: 60, everyMax: 60, durMin: 60, durMax: 60 } });
    await sleep(900);
    assert.equal(tells(asB).length, 0, 'B never opens');
    assert.equal(tells(full).length, 0, 'the daily limit is spent');
    assert.equal(tells(idle).length, 0, 'idle is quiet');
    await idle.ask({ type: 'STOP_IDLE' });
    assert.ok(await waitFor(() => tells(idle).length >= 1, 4000), 'after idle ends the next roll opens a scene');
  } finally {
    asB.close();
    full.close();
    idle.close();
  }
});

ui('two scenes are at least 20 minutes apart by the clock, so a sure hit does not open scene after scene', async () => {
  const page = await soloA({ fastClock: true });
  try {
    await page.ask(PRACTICE);
    assert.ok(await waitFor(() => tells(page).length >= 1, 4000));
    const firstAt = Date.now();
    assert.ok(await waitFor(() => tells(page).length >= 2, 6000), 'the second scene opens once the gap has passed');
    assert.ok(Date.now() - firstAt >= 450, `the gap is 20 rolls of 30 ms, took ${Date.now() - firstAt} ms`);
  } finally {
    page.close();
  }
});

ui('a scene opened by hand counts as the last scene for the gap, and an automatic scene counts in the daily total', async () => {
  const page = await soloA({ fastClock: true });
  try {
    assert.equal((await page.ask({ type: 'START_CHAT_SCRIPT' })).ok, true);
    assert.ok(await waitFor(() => tells(page).length >= 1, 4000));
    await page.ask(PRACTICE);
    await sleep(500);
    assert.equal(tells(page).length, 1, 'too soon after the hand-opened scene');
    assert.ok(await waitFor(() => tells(page).length >= 2, 6000), 'later the automatic one opens');
    const stored = await page.ask({ type: 'STATUS' });
    assert.ok(stored.chatScript === null || stored.chatScript.scriptId, 'the status still answers');
    assert.equal(page.store.chatScriptState.count, 2, 'both scenes are in the daily count');
  } finally {
    page.close();
  }
});

// ---- 取消 ----
const COMBAT = { ...PRACTICE, group: 'combat' };
const settingsOf = (page, patch) => ({ enabled: true, typoRate: 0, role: 'A', partner: B.id, partnerName: B.nick, autoEveryMin: 1, ...patch });
const changeSettings = (page, patch) => page.changeListeners.forEach(listener => listener({ chatScript: { newValue: settingsOf(page, patch) } }, 'local'));

ui('stopping the practice group ends the automatic scenes, and starting it again warms up again', async () => {
  const page = await soloA({ fastClock: true });
  try {
    await page.ask(PRACTICE);
    assert.ok(await waitFor(() => tells(page).length >= 1, 4000));
    await page.ask({ type: 'STOP_TRIGGER', group: 'practice' });
    const before = tells(page).length;
    await sleep(1200); // 兩場的最小間隔（600 毫秒）早就過了，沒停的話第二場早就開了
    assert.equal(tells(page).length, before, 'no scene while the practice group is off');
    const restartedAt = Date.now();
    await page.ask(PRACTICE);
    assert.ok(await waitFor(() => tells(page).length > before, 4000), 'and it works again after the restart');
    assert.ok(Date.now() - restartedAt >= 150, `the warm-up is counted again from the restart, took ${Date.now() - restartedAt} ms`);
  } finally {
    page.close();
  }
});

ui('stopping everything (here a stop keyword on screen) ends the automatic scenes too', async () => {
  const page = await soloA();
  try {
    await page.ask(PRACTICE);
    assert.ok(await waitFor(() => tells(page).length >= 1, 4000));
    page.output('<span>jrealm\n</span>');
    await sleep(100);
    const before = tells(page).length;
    await sleep(1200);
    assert.equal(tells(page).length, before, 'nothing opens after everything was stopped');
  } finally {
    page.close();
  }
});

ui('turning the feature off, changing the role, clearing the partner or setting the minutes to 0 each end the automatic scenes', async () => {
  const patches = [{ enabled: false }, { role: 'B' }, { partner: '' }, { autoEveryMin: 0 }];
  for (const patch of patches) {
    const page = await soloA();
    try {
      await page.ask(PRACTICE);
      await sleep(60); // 暖機還沒過
      changeSettings(page, patch);
      await sleep(900);
      assert.equal(tells(page).length, 0, `no scene after ${JSON.stringify(patch)}`);
    } finally {
      page.close();
    }
  }
});

ui('the combat group is not a trigger for automatic scenes, and stopping it does not stop the practice group\'s', async () => {
  const combatOnly = await soloA();
  const both = await soloA();
  try {
    await combatOnly.ask(COMBAT);
    await both.ask(PRACTICE);
    await both.ask(COMBAT);
    await both.ask({ type: 'STOP_TRIGGER', group: 'combat' });
    await sleep(900);
    assert.equal(tells(combatOnly).length, 0, 'the combat group alone never opens a scene');
    assert.ok(tells(both).length >= 1, 'the practice group keeps it going');
  } finally {
    combatOnly.close();
    both.close();
  }
});

// ---- 狀態 ----
ui('STATUS says nothing about automatic scenes unless they are scheduled, then warm-up, then rolling, and nothing again once the practice group stops', async () => {
  const page = await soloA({ autoEveryMin: 5, random: 0.999 }); // 機率 0.2：0.999 不會中，只看狀態
  try {
    assert.equal((await page.ask({ type: 'STATUS' })).chatScriptAuto, null, 'practice group is off');
    await page.ask(PRACTICE);
    const warm = (await page.ask({ type: 'STATUS' })).chatScriptAuto;
    assert.equal(warm.phase, 'warmup');
    assert.ok(warm.secondsLeft > 0 && warm.secondsLeft <= 300, 'seconds left of the five minute warm-up: ' + warm.secondsLeft);
    assert.ok(await waitFor(async () => (await page.ask({ type: 'STATUS' })).chatScriptAuto?.phase === 'rolling', 4000));
    await page.ask({ type: 'STOP_TRIGGER', group: 'practice' });
    assert.equal((await page.ask({ type: 'STATUS' })).chatScriptAuto, null);
  } finally {
    page.close();
  }
});

// ---- 最小間隔看時鐘、改對方 ID、放棄的情況 ----
ui('the gap counts the time the practice group was off, so a restart after a long stop is not held back', async () => {
  const page = await soloA({ fastClock: true });
  try {
    await page.ask(PRACTICE);
    assert.ok(await waitFor(() => tells(page).length >= 1, 4000));
    await page.ask({ type: 'STOP_TRIGGER', group: 'practice' });
    await sleep(800); // 快的時鐘走了 800 × 2000 毫秒 ＝ 約 27 分鐘，比最小間隔久
    const before = tells(page).length;
    const restartedAt = Date.now();
    await page.ask(PRACTICE);
    assert.ok(await waitFor(() => tells(page).length > before, 4000));
    assert.ok(Date.now() - restartedAt < 450, `only the warm-up and one roll are needed (about 180 ms), not another 20 rolls: took ` + (Date.now() - restartedAt) + ' ms');
  } finally {
    page.close();
  }
});

ui('a scene another game tab opened a moment ago holds this tab back too', async () => {
  const page = await soloA({ fastClock: true });
  try {
    await page.ask(PRACTICE);
    const today = (d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(new Date(page.clockNow()));
    page.changeListeners.forEach(listener => listener({ chatScriptState: { newValue: { date: today, count: 1, recent: ['other'], lastAt: page.clockNow() } } }, 'local'));
    await sleep(400); // 暖機（150 毫秒）過了、擲過好幾次，但別的分頁剛開了一場
    assert.equal(tells(page).length, 0, 'held back by the scene of the other tab');
    assert.ok(await waitFor(() => tells(page).length >= 1, 4000), 'and opens once 20 minutes of the clock have passed');
  } finally {
    page.close();
  }
});

ui('changing the partner id warms up again, like starting the practice group again', async () => {
  const page = await soloA({ autoEveryMin: 5, random: 0.999 });
  try {
    await page.ask(PRACTICE);
    assert.ok(await waitFor(async () => (await page.ask({ type: 'STATUS' })).chatScriptAuto?.phase === 'rolling', 4000));
    changeSettings(page, { partner: 'akai', autoEveryMin: 5 });
    assert.equal((await page.ask({ type: 'STATUS' })).chatScriptAuto.phase, 'warmup', 'the warm-up starts over for the new partner');
    changeSettings(page, { partner: 'AKAI', autoEveryMin: 5 });
    assert.ok(await waitFor(async () => (await page.ask({ type: 'STATUS' })).chatScriptAuto?.phase === 'rolling', 4000));
    changeSettings(page, { partner: 'akai', autoEveryMin: 5 });
    assert.equal((await page.ask({ type: 'STATUS' })).chatScriptAuto.phase, 'rolling', 'the same id in another case is the same partner');
  } finally {
    page.close();
  }
});

ui('a hit gives up quietly when there is no usable script, and the next roll tries again', async () => {
  const page = await soloA({ scripts: [] });
  try {
    await page.ask(PRACTICE);
    await sleep(900);
    assert.equal(tells(page).length, 0, 'nothing to say');
    assert.equal((await page.ask({ type: 'STATUS' })).chatScriptAuto.phase, 'rolling', 'still rolling, nothing broke');
  } finally {
    page.close();
  }
});

ui('while the real person check is on screen nothing opens by itself', async () => {
  const page = await soloA();
  try {
    await page.ask(PRACTICE);
    await sleep(60);
    page.w.document.getElementById('presence').classList.remove('invisible'); // 真人驗證出現：整個停下來，要玩家自己處理
    await sleep(900);
    assert.equal(tells(page).length, 0);
  } finally {
    page.close();
  }
});

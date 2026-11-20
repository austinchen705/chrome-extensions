// 地圖巡怪：map-hunt-rest（16 組；共用底座在 tests/helpers/map-hunt-world.js，整個 content script 在 jsdom 裡跑）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, sleep, waitFor, fixture } = require('../../helpers/game-page');
const {
  SCALE,
  REQUIRED,
  boot,
  MOB,
  mobsAt,
  mobsLines,
  world,
  pick,
  say,
  FIGHT,
  MOB_LINE,
  MOB_FIGHTING,
  KNOCKED_LINE,
  huntText,
  click,
  alerts,
  setKee,
  hunting,
  countOf,
  at,
  huntLog,
  MINUTE,
  MARK_MS,
  restRun,
  restLines,
  roundsIn,
} = require('../../helpers/map-hunt-world');

ui('rest: after the drawn number of rounds it skips whole rounds, goes home, comes back at the mark that ends the rest, and draws a new count', async () => {
  const { page, game, looks, times, draw } = await restRun({});
  try {
    assert.ok(await waitFor(async () => restLines(await huntLog(page)).length >= 1, 15000), (await huntLog(page)).slice(-600));
    let text = await huntLog(page);
    assert.match(restLines(text)[0], /休息 跳過 1 輪/);
    assert.equal(roundsIn(text.slice(0, text.indexOf(' 休息 '))), 7, 'seven rounds were completed before the first rest, none earlier');
    assert.ok(await waitFor(() => /休息中，約 \d\d:\d\d 回來/.test(huntText(page)), 3000), huntText(page));
    assert.equal(times.back.length, 0, 'the return command is not sent while the rest lasts');
    assert.equal(countOf(game, 'recall'), 1, 'the home command was sent once');
    assert.equal(countOf(game, 'home'), 7, 'the standby command once per finished round');
    draw.value = 0.4; // 下一個要隔幾輪：6 ＋ ⌊0.4×7⌋ = 8，跳過 1 ＋ ⌊0.4×3⌋ = 2
    assert.ok(await waitFor(() => looks.length >= 8, 15000), `round 8 starts after the return (${looks.length} looks)`);
    assert.equal(times.back.length, 1);
    assert.ok(times.back[0] - times.recall[0] >= 10 * MINUTE, `a whole round was skipped (${(times.back[0] - times.recall[0]) / MINUTE} minutes)`);
    assert.ok(times.back[0] % MARK_MS < 5 * MINUTE, `the return command went out right after a respawn mark, not before it (${(times.back[0] % MARK_MS) / 1000} s after)`);
    assert.ok(await waitFor(async () => /輪摘要 第 8 輪：休息回來：跳過 1 輪，回程花了 [\d.]+ 秒/.test(await huntLog(page)), 5000), 'the summary of the round after the rest records the walk back');
    assert.ok(await waitFor(async () => restLines(await huntLog(page)).filter(line => /休息 跳過/.test(line)).length >= 2, 20000), 'a second rest comes');
    text = await huntLog(page);
    const second = text.slice(text.indexOf(' 休息 跳過 1 輪') + 1);
    assert.match(second, /休息 跳過 2 輪/, 'the second rest skips the newly drawn number');
    assert.equal(roundsIn(second.slice(0, second.indexOf(' 休息 跳過 2 輪'))), 8, 'and comes after the newly drawn number of rounds');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rest: with a ride room recorded, the standby command goes at the ride room, then it walks back to the ride room and only there sends the home command', async () => {
  const { page, game } = await restRun({ settings: { restEveryMin: 2, restEveryMax: 2 }, rides: { t: ['t/c'] } });
  try {
    assert.ok(await waitFor(() => game.log.includes('recall'), 15000), game.log.join(','));
    const recall = game.log.indexOf('recall');
    const home = game.log.lastIndexOf('home', recall);
    assert.deepEqual(game.log.slice(home, recall + 1), ['home', 'e', 'e', 'recall'], game.log.join(','));
    assert.equal(countOf(game, 'recall'), 1);
    assert.match(await huntLog(page), /撤退.*為了休息.*t\/c/);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rest: a ride room it cannot reach stops the hunt at the end of the round with an alert, and neither the standby nor the home command is sent', async () => {
  const { page, game } = await restRun({ settings: { restEveryMin: 2, restEveryMax: 2 }, rides: { t: ['t/z'] } });
  try {
    assert.ok(await waitFor(() => alerts(page).length > 0, 15000), game.log.join(','));
    assert.match(alerts(page)[0].reason, /待命.*可 ride/);
    assert.equal(game.log.includes('home'), false);
    assert.equal(game.log.includes('recall'), false);
    assert.equal(await hunting(page), false);
  } finally {
    page.close();
  }
});

ui('rest: the number of rounds between rests is a setting', async () => {
  // 2～3 輪、r 0.2 → 2 ＋ ⌊0.2×2⌋ = 2 輪後休息
  const { page } = await restRun({ settings: { restEveryMin: 2, restEveryMax: 3 } });
  try {
    assert.ok(await waitFor(async () => restLines(await huntLog(page)).length >= 1, 15000), (await huntLog(page)).slice(-600));
    const text = await huntLog(page);
    assert.equal(roundsIn(text.slice(0, text.indexOf(' 休息 '))), 2, 'two rounds were completed before the first rest');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rest: the number of rounds a rest skips is a setting', async () => {
  // 跳過 4～5 輪、r 0.2 → 4 ＋ ⌊0.2×2⌋ = 4 輪
  const { page } = await restRun({ settings: { restEveryMin: 2, restEveryMax: 2, restSkipMin: 4, restSkipMax: 5 } });
  try {
    assert.ok(await waitFor(async () => restLines(await huntLog(page)).length >= 1, 15000), (await huntLog(page)).slice(-600));
    assert.match(restLines(await huntLog(page))[0], /休息 跳過 4 輪/);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rest: a home command equal to the standby command is not sent twice', async () => {
  const { page, game, looks, times } = await restRun({ settings: { homeCommand: 'home' } });
  try {
    assert.ok(await waitFor(() => looks.length >= 8, 20000), `back in the area after the rest (${looks.length} looks)`);
    assert.equal(countOf(game, 'recall'), 0, 'the home command is the standby command');
    assert.equal(times.back.length, 1, 'the return command was still sent once');
    assert.ok(await waitFor(async () => /輪摘要 第 8 輪：休息回來/.test(await huntLog(page)), 5000));
    // 數回程指令之前送了幾個 home（和第 8 輪結束時再送的那個無關）：七輪各一個，休息沒有多送
    const beforeReturn = game.log.slice(0, game.log.indexOf('back'));
    assert.equal(countOf({ log: beforeReturn }, 'home'), 7, 'one standby command per finished round and nothing more for the rest');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rest: with the return command empty, or the switch off, the hunt never rests', async () => {
  for (const settings of [{ restReturnCommand: '' }, { humanize: 'off' }]) {
    const { page, looks, times } = await restRun({ settings });
    try {
      assert.ok(await waitFor(() => looks.length >= 9, 20000), `${JSON.stringify(settings)}: rounds go on (${looks.length})`);
      assert.deepEqual(restLines(await huntLog(page)), [], JSON.stringify(settings));
      assert.equal(times.back.length, 0);
      await page.ask({ type: 'STOP' });
    } finally {
      page.close();
    }
  }
});

ui('rest: the return waits for the qi to reach the resume line, then goes', async () => {
  const { page, times, looks } = await restRun({ settings: { healMode: 'rest', restBelow: 50, restResume: 80 }, onCommand: (command, { page: p }) => { if (command === 'recall') setKee(p, 30); } });
  try {
    assert.ok(await waitFor(() => /等氣回到 80%/.test(huntText(page)), 15000), huntText(page));
    await sleep(300); // 伺服器時間過了好幾分鐘，氣還是低
    assert.equal(times.back.length, 0, 'not sent while the qi is under the resume line');
    setKee(page, 90);
    assert.ok(await waitFor(() => times.back.length === 1, 3000), 'sent once the qi is back');
    assert.ok(await waitFor(() => looks.length >= 8, 8000), 'and the next round goes on');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rest: a qi that never comes back stops the hunt with an alert and the return command is never sent', async () => {
  const { page, times } = await restRun({ settings: { healMode: 'rest', restBelow: 50, restResume: 80 }, onCommand: (command, { page: p }) => { if (command === 'recall') setKee(p, 30); } });
  try {
    assert.ok(await waitFor(() => alerts(page).some(message => /氣一直沒回到/.test(message.reason)), 25000), JSON.stringify(alerts(page)));
    assert.equal(await hunting(page), false);
    assert.equal(times.back.length, 0);
  } finally {
    page.close();
  }
});

ui('rest: the qi to wait for is a line the settings page shows, so a qi between the two lines in rest mode, or above the eat line in eat mode, goes at once', async () => {
  // 自己回：休息線 50、回到 80，氣 70（在兩條線之間，家裡不會有人補氣）；吃藥：回到 % 欄位藏起來，目標是吃藥線
  for (const settings of [{ healMode: 'rest', restBelow: 50, restResume: 80 }, { healMode: 'eat', eatCommand: 'eat', eatBelow: 50, restResume: 95 }]) {
    const { page, times, looks } = await restRun({ settings, onCommand: (command, { page: p }) => { if (command === 'recall') setKee(p, 70); } });
    try {
      assert.ok(await waitFor(() => times.back.length === 1, 25000), `${JSON.stringify(settings)}: the return command went out`);
      assert.ok(await waitFor(() => looks.length >= 8, 8000), 'and the next round goes on');
      assert.equal(alerts(page).length, 0, 'no alert');
      await page.ask({ type: 'STOP' });
    } finally {
      page.close();
    }
  }
});

ui('rest: when the previous round ran longer than a period, the rest still lasts the drawn number of marks after the end of it', async () => {
  // 決定休息的那一輪在 recall 送出後「已經跑了 20 分鐘」：休息要從現在之後的第一個整點起算再跳過 1 輪（至少 35 分鐘），不是馬上回來
  const { page, times } = await restRun({ onCommand: (command, { clock }) => { if (command === 'recall') clock.jump += 20 * MINUTE; } });
  try {
    assert.ok(await waitFor(() => times.back.length === 1, 25000), 'the return command went out');
    assert.ok(times.back[0] - times.recall[0] >= 35 * MINUTE, `the rest was not cut short (${(times.back[0] - times.recall[0]) / MINUTE} minutes)`);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rest: a return command that sends nothing (an unreadable @巨集) stops the hunt with an alert about that, not about the hunting area', async () => {
  const { page, times } = await restRun({ settings: { restReturnCommand: '@巨集 90' } });
  try {
    assert.ok(await waitFor(() => alerts(page).some(message => /沒有送出/.test(message.reason)), 25000), JSON.stringify(alerts(page)));
    assert.equal(await hunting(page), false);
    assert.equal(times.back.length, 0);
  } finally {
    page.close();
  }
});

ui('rest: a return that does not reach the hunting area stops the hunt with an alert and is not retried', async () => {
  const { page, game, times } = await restRun({ keepAway: true });
  try {
    assert.ok(await waitFor(() => alerts(page).some(message => /沒有回到巡怪區/.test(message.reason)), 25000), JSON.stringify(alerts(page)));
    assert.equal(await hunting(page), false);
    await sleep(300);
    assert.equal(times.back.length, 1, 'sent once, no retry');
    assert.equal(countOf(game, 'back'), 1);
  } finally {
    page.close();
  }
});

ui('rest: stopping during a rest sends nothing more, even after the mark has passed', async () => {
  const { page, game, clock } = await restRun({});
  try {
    assert.ok(await waitFor(() => /休息中，約 \d\d:\d\d 回來/.test(huntText(page)), 15000), huntText(page));
    click(page, '.hstop');
    assert.equal(await hunting(page), false);
    const count = game.log.length;
    clock.jump += 60 * MINUTE;
    await sleep(500);
    assert.equal(game.log.length, count, 'no return command and nothing else');
  } finally {
    page.close();
  }
});

ui('rest: a captcha during a rest ends it and stops the hunt like everything else', async () => {
  const { page, times } = await restRun({ swallow: command => /^\d+$/.test(command) });
  try {
    assert.ok(await waitFor(() => /休息中，約 \d\d:\d\d 回來/.test(huntText(page)), 15000), huntText(page));
    page.output(fixture('sprite-62044.html'));
    assert.ok(await waitFor(() => alerts(page).length >= 1, 8000), 'three unanswered tries stop everything');
    assert.equal(await hunting(page), false);
    assert.equal(times.back.length, 0);
  } finally {
    page.close();
  }
});

ui('rest: when what is left is knocked out, it is finished off first even below the rest line, so it does not wake up during the rest', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', restBelow: 50, restResume: 80, dangerBelow: 10, finishKnockedOut: 'on' };
    setKee(page, 90);
    const room = { lines: mobsLines(2) };
    // 使用者貼的真實 log：被打的時候自動戰鬥把另一隻打昏，房間裡只剩昏迷的，氣在休息線以下就原地等回氣，牠會醒過來
    const script = command => {
      if (command === FIGHT) { setKee(page, 40); room.lines = [KNOCKED_LINE]; say(page, '測試怪死了。'); return true; }
      if (command === 'kill 1') { room.lines = []; say(page, '測試怪死了。'); return true; }
      return command === 'gc';
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'kill 1') === 1, 6000), `the knocked-out one is finished without waiting for the qi (${game.log.join(',')})`);
    setKee(page, 90);
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
  } finally {
    page.close();
  }
});

ui('rest: finishing off a knocked-out monster does not go home below the danger line when nobody in the room is fighting you', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', restBelow: 50, restResume: 80, dangerBelow: 10, finishKnockedOut: 'on' };
    setKee(page, 90);
    const room = { lines: mobsLines(2) };
    // 使用者貼的真實 log：三隻一起打，氣掉到危險線以下時剩下的都被打昏了，補刀時危險線回家，昏迷的就留在原地
    const script = command => {
      if (command === FIGHT) { setKee(page, 5); room.lines = [KNOCKED_LINE]; say(page, '測試怪死了。'); return true; }
      if (command === 'kill 1') { say(page, '看起來測試怪想殺死你！'); setTimeout(() => { room.lines = []; say(page, '測試怪死了。'); }, 200); return true; }
      return command === 'gc';
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'kill 1') === 1, 6000), game.log.join(','));
    await sleep(400); // 補刀的死亡字 200 毫秒後才來，期間戰鬥中每秒看一次氣
    assert.deepEqual(alerts(page), [], 'no danger-line retreat while finishing a monster that cannot fight back');
    setKee(page, 90);
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
  } finally {
    page.close();
  }
});

ui('rest: finishing off a knocked-out monster below the danger line still goes home when another one wakes up and attacks', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', restBelow: 50, restResume: 80, dangerBelow: 10, finishKnockedOut: 'on' };
    setKee(page, 90);
    const room = { lines: mobsLines(2) };
    const script = command => {
      if (command === FIGHT) { setKee(page, 5); room.lines = [KNOCKED_LINE, KNOCKED_LINE]; say(page, '測試怪死了。'); return true; }
      if (command === 'kill 1') { say(page, '看起來測試怪想殺死你！'); setTimeout(() => say(page, '看起來測試怪想殺死你！'), 60); return true; }
      return command === 'gc';
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(alert => /戰鬥中氣只剩/.test(alert.reason)), 6000), `${game.log.join(',')} ${huntText(page)}`);
  } finally {
    page.close();
  }
});

ui('rest: a monster that is fighting you is fought even when the qi is below the rest line, and the rest comes once nobody is fighting', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', restBelow: 50, restResume: 80, dangerBelow: 10 };
    setKee(page, 90);
    const room = { lines: mobsLines(3) };
    // 使用者貼的真實 log：第一隻打倒後氣掉到休息線以下，重數時房間裡有一隻 <戰鬥中>，原地休息會一直被打、氣回不來
    const script = command => {
      if (command === FIGHT) {
        const fights = countOf(game, FIGHT);
        if (fights === 1) { setKee(page, 40); room.lines = [MOB_FIGHTING, MOB_LINE]; }
        if (fights === 2) room.lines = [MOB_LINE];
        if (fights === 3) room.lines = [];
        say(page, '測試怪死了。');
        return true;
      }
      return command === 'gc';
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, FIGHT) === 2, 6000), `the monster in <戰鬥中> is fought without resting (${game.log.join(',')})`);
    assert.ok(await waitFor(() => /休息中/.test(huntText(page)), 6000), huntText(page));
    await sleep(300);
    assert.equal(countOf(game, FIGHT), 2, 'nobody is fighting any more, so it rests before the third one');
    setKee(page, 90);
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.equal(countOf(game, FIGHT), 3);
  } finally {
    page.close();
  }
});

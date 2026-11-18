// 地圖巡怪：map-hunt-rounds（20 組；共用底座在 tests/helpers/map-hunt-world.js，整個 content script 在 jsdom 裡跑）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, sleep, waitFor, fixture } = require('../../helpers/game-page');
const {
  MOB,
  world,
  pick,
  huntText,
  click,
  alerts,
  FIGHT,
  mobsLines,
  hunting,
  countOf,
  say,
  fakeClock,
  timeScript,
  at,
  roundPage,
  lookTimer,
  standbyRun,
  screenClock,
  huntLog,
} = require('../../helpers/map-hunt-world');

ui('rounds: it reads the server time at the start, sends the standby command after a round, and starts the next round at the respawn', async () => {
  const page = await roundPage({ standbyCommand: 'home' });
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const looks = [];
    const game = world(page, { at: 'a', looks: { c: { lines: [] } }, script: timeScript(page, clock, lookTimer(clock, looks)) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生 10:15/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log.slice(0, 6), ['time', 'e', 'e', 'l', 'home', 'time']);
    assert.ok(await waitFor(() => looks.length >= 2, 9000), 'the second round starts');
    assert.ok(looks[1] >= at('10:15:00'), `not before the respawn (${new Date(looks[1]).toISOString()})`);
    assert.ok(looks[1] < at('10:15:50'), `and not long after it (${new Date(looks[1]).toISOString()})`);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('round end: it walks to the nearest ride room before the standby command, and after the respawn sends the command back to the hunting area before the next round', async () => {
  const { page, game, looks } = await standbyRun();
  try {
    assert.ok(await waitFor(() => /等下一個重生/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log.slice(game.log.indexOf('l') + 1, game.log.indexOf('ride') + 1), ['w', 'w', 'ride'], 'walked c → a (the ride room), then the standby command');
    assert.ok(await waitFor(() => looks.length >= 2, 9000), 'the second round starts');
    const second = game.log.lastIndexOf('l');
    assert.deepEqual(game.log.slice(game.log.indexOf('ride') + 1, second + 1).filter(command => command !== 'time'), ['back', 'e', 'e', 'l'], 'back to the hunting area first, then the round');
    assert.match(await huntLog(page), /待命 回到巡怪區，回程花了/);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('round end: away from the hunting map at the respawn without the command back, it stops with an alert', async () => {
  const { page, game } = await standbyRun({ settings: { restReturnCommand: '' } });
  try {
    assert.ok(await waitFor(() => alerts(page).length > 0, 9000), game.log.join(','));
    assert.match(alerts(page)[0].reason, /人不在巡怪區.*沒填「回到巡怪區的指令」/);
    assert.equal(await hunting(page), false);
  } finally {
    page.close();
  }
});

ui('round end: with sort after every round on, it sorts from the ride room, skips the sort return command and sends the standby command', async () => {
  const { page, game } = await standbyRun({ settings: { sortAfterRound: 'on', tripCommand: 'go', returnCommand: 'goback', sortKeep: 'none' } });
  try {
    assert.ok(await waitFor(() => /等下一個重生/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log.slice(game.log.indexOf('l') + 1, game.log.indexOf('ride') + 1), ['w', 'w', 'go', 'sell all', 'ride'], 'ride room, trip, sell, then the standby command');
    assert.equal(game.log.includes('goback'), false, 'the sort return command is not sent');
    assert.match(await huntLog(page), /巡完一輪的整理做完/);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('round end: without waiting for the respawn, sort after every round walks to the ride room, sorts without the return or standby command, then stops without an alert', async () => {
  const { page, game } = await standbyRun({ settings: { loopRounds: 'off', sortAfterRound: 'on', tripCommand: 'go', returnCommand: 'goback', sortKeep: 'none' } });
  try {
    assert.ok(await waitFor(() => /巡完、整理完，已停止/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log.slice(game.log.indexOf('l') + 1), ['w', 'w', 'go', 'sell all'], 'ride room, trip, sell, nothing after');
    assert.equal(game.log.includes('goback'), false, 'the sort return command is not sent');
    assert.equal(game.log.includes('ride'), false, 'the standby command is not sent');
    assert.equal(alerts(page).length, 0, 'a normal end, no alert');
    assert.equal(await hunting(page), false);
    assert.match(await huntLog(page), /巡完一輪的整理做完/);
  } finally {
    page.close();
  }
});

ui('round end: without waiting for the respawn and without sort after every round, it just stops', async () => {
  const { page, game } = await standbyRun({ settings: { loopRounds: 'off', sortAfterRound: 'off', tripCommand: 'go' } });
  try {
    assert.ok(await waitFor(() => /這一輪巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.equal(game.log.includes('go'), false);
    assert.equal(game.log.includes('sell all'), false);
    assert.equal(game.log.includes('ride'), false);
    assert.equal(await hunting(page), false);
  } finally {
    page.close();
  }
});

ui('round end: without a ride room recorded the standby command goes where it stands, as before', async () => {
  const { page, game } = await standbyRun({ rides: {} });
  try {
    assert.ok(await waitFor(() => /等下一個重生/.test(huntText(page)), 4000), huntText(page));
    assert.equal(game.log[game.log.indexOf('l') + 1], 'ride');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

for (const mode of ['up', 'down']) {
  ui(`rounds: reading the clock at the bottom left (${mode === 'up' ? 'normal mode' : 'countdown mode'}) it never sends time and the next round still starts at the respawn`, async () => {
    const page = await roundPage({ standbyCommand: 'home', timeSource: 'screen' });
    try {
      const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
      screenClock(page, clock, mode);
      const looks = [];
      const game = world(page, { at: 'a', looks: { c: { lines: [] } }, script: timeScript(page, clock, lookTimer(clock, looks)) });
      await pick(page, MOB);
      click(page, '.hstart');
      assert.ok(await waitFor(() => /等下一個重生 10:15/.test(huntText(page)), 4000), huntText(page));
      assert.ok(await waitFor(() => looks.length >= 2, 9000), 'the second round starts');
      assert.equal(game.log.includes('time'), false, `no time command (${game.log.join()})`);
      assert.ok(looks[1] >= at('10:15:00'), `not before the respawn (${new Date(looks[1]).toISOString()})`);
      assert.ok(looks[1] < at('10:15:50'), `and not long after it (${new Date(looks[1]).toISOString()})`);
      await page.ask({ type: 'STOP' });
    } finally {
      page.close();
    }
  });
}

ui('rounds: when the clock at the bottom left cannot be read (empty before the game syncs) it falls back to the time command', async () => {
  const page = await roundPage({ standbyCommand: 'home', timeSource: 'screen' });
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const element = page.w.document.getElementById('uptime');
    element.className = 'H7';
    element.textContent = '';
    const game = world(page, { at: 'a', looks: { c: { lines: [] } }, script: timeScript(page, clock) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生 10:15/.test(huntText(page)), 4000), huntText(page));
    assert.equal(game.log[0], 'time', game.log.join());
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rounds: with the time offset kept, time is sent once at the start and the next round still starts at the respawn without asking again', async () => {
  const page = await roundPage({ standbyCommand: 'home', timeKeepMin: 60 });
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const looks = [];
    const game = world(page, { at: 'a', looks: { c: { lines: [] } }, script: timeScript(page, clock, lookTimer(clock, looks)) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生 10:15/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log.slice(0, 5), ['time', 'e', 'e', 'l', 'home'], 'no second time after the standby command');
    assert.ok(await waitFor(() => looks.length >= 2, 9000), 'the second round starts');
    assert.equal(game.log.filter(command => command === 'time').length, 1, `time was asked once (${game.log.join()})`);
    assert.ok(looks[1] >= at('10:15:00'), `not before the respawn (${new Date(looks[1]).toISOString()})`);
    assert.ok(looks[1] < at('10:15:50'), `and not long after it (${new Date(looks[1]).toISOString()})`);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rounds: with a stop-before-respawn time it fights no new monster that close to the respawn and goes on after it', async () => {
  const page = await roundPage({ stopBeforeSpawnSec: 120 });
  try {
    const clock = fakeClock(page, '2026-11-04T10:14:00+08:00', { scale: 60 }); // 慢一點：沒停打的話，走到怪那裡還不到 10:14:40
    const fights = [];
    const script = timeScript(page, clock, command => {
      if (command === FIGHT) fights.push(clock.server());
      return false;
    });
    world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => fights.length >= 1, 9000), 'it fights after the respawn');
    assert.ok(fights[0] >= at('10:14:40'), `no fight within two minutes of the 10:15 respawn (${new Date(fights[0]).toISOString()})`);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rounds: each round waits for the next respawn, even when the clock reading is a little off between rounds', async () => {
  const page = await roundPage();
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const looks = [];
    const script = timeScript(page, clock, lookTimer(clock, looks));
    const flaky = (command, ...rest) => {
      if (command === 'time') clock.replyError = clock.times % 2 ? -2000 : 0; // 每次讀到的秒數差一點
      return script(command, ...rest);
    };
    world(page, { at: 'a', looks: { c: { lines: [] } }, script: flaky });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => looks.length >= 3, 14000), `three rounds (${looks.length})`);
    assert.ok(looks[1] >= at('10:15:00') && looks[1] < at('10:15:50'), new Date(looks[1]).toISOString());
    assert.ok(looks[2] >= at('10:30:00') && looks[2] < at('10:30:50'), `the second respawn is not counted twice (${new Date(looks[2]).toISOString()})`);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rounds: a round that took longer than a respawn period starts the next one at once', async () => {
  const page = await roundPage();
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const script = timeScript(page, clock, command => {
      if (command === 'e' && countOf(game, 'e') === 1) clock.jump += 16 * 60 * 1000; // 這一輪走了十六分鐘
      return false;
    });
    const game = world(page, { at: 'a', looks: { c: { lines: [] } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'l') >= 2, 4000), game.log.join(','));
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rounds: started just before a respawn, the next wait is for the one after it', async () => {
  const page = await roundPage();
  try {
    const clock = fakeClock(page, '2026-11-04T10:14:30+08:00');
    const looks = [];
    world(page, { at: 'a', looks: { c: { lines: [] } }, script: timeScript(page, clock, lookTimer(clock, looks)) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生 10:30/.test(huntText(page)), 8000), huntText(page));
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rounds: when the computer clock is changed during the wait it checks the time again before starting', async () => {
  const page = await roundPage();
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const looks = [];
    world(page, { at: 'a', looks: { c: { lines: [] } }, script: timeScript(page, clock, lookTimer(clock, looks)) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生/.test(huntText(page)), 4000), huntText(page));
    clock.drift += 10 * 60 * 1000; // 電腦時鐘突然快了十分鐘：只看它的話現在就會開始
    assert.ok(await waitFor(() => looks.length >= 2, 9000), 'the second round starts');
    assert.ok(looks[1] >= at('10:14:40'), `not at the wrong time (${new Date(looks[1]).toISOString()})`);
    assert.ok(clock.times >= 3, 'it asked for the time again');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rounds: a standby command that is a macro finishes before the time is read', async () => {
  const page = await roundPage({ standbyCommand: 'home;inn' });
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const game = world(page, { at: 'a', looks: { c: { lines: [] } }, script: timeScript(page, clock) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log.slice(3, 7), ['l', 'home', 'inn', 'time']);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('rounds: a time reply that cannot be read at the start means it does not start', async () => {
  const page = await roundPage();
  try {
    const script = command => {
      if (command === 'time') { say(page, '小貓時間為丙寅年八月十八日午時。'); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: [] } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /讀不到伺服器時間/.test(huntText(page)), 5000), huntText(page));
    assert.equal(await hunting(page), false);
    assert.deepEqual(game.log, ['time'], 'nothing was walked');
  } finally {
    page.close();
  }
});

ui('rounds: a time reply that cannot be read after a round stops the hunt with an alert', async () => {
  const page = await roundPage();
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const good = timeScript(page, clock);
    const script = (command, ...rest) => {
      if (command === 'time' && clock.times >= 1) { say(page, '小貓時間為丙寅年八月十八日午時。'); return true; }
      return good(command, ...rest);
    };
    world(page, { at: 'a', looks: { c: { lines: [] } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /讀不到伺服器時間/.test(message.reason)), 5000));
    assert.equal(await hunting(page), false);
  } finally {
    page.close();
  }
});

ui('rounds: stopping while it waits for the respawn sends nothing more, even after the time has passed', async () => {
  const page = await roundPage();
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const game = world(page, { at: 'a', looks: { c: { lines: [] } }, script: timeScript(page, clock) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生/.test(huntText(page)), 4000), huntText(page));
    click(page, '.hstop');
    assert.equal(await hunting(page), false);
    const count = game.log.length;
    clock.jump += 30 * 60 * 1000;
    await sleep(400);
    assert.equal(game.log.length, count);
  } finally {
    page.close();
  }
});

ui('rounds: a captcha while it waits stops the hunt like everything else', async () => {
  const page = await roundPage();
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00', { scale: 100 });
    const script = timeScript(page, clock, command => /^\d+$/.test(command));
    world(page, { at: 'a', looks: { c: { lines: [] } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生/.test(huntText(page)), 4000), huntText(page));
    page.output(fixture('sprite-62044.html'));
    assert.ok(await waitFor(() => alerts(page).length >= 1, 8000), 'three unanswered tries stop everything');
    assert.equal(await hunting(page), false);
  } finally {
    page.close();
  }
});

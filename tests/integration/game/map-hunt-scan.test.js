// 地圖巡怪：map-hunt-scan（32 組；共用底座在 tests/helpers/map-hunt-world.js，整個 content script 在 jsdom 裡跑）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, sleep, waitFor } = require('../../helpers/game-page');
const {
  SCALE,
  REQUIRED,
  boot,
  MOB,
  ROOM,
  MOVES,
  mobsAt,
  MOB_B,
  world,
  panelRoot,
  pick,
  huntText,
  click,
  alerts,
  MOB_LINE,
  setKee,
  hunting,
  countOf,
  say,
  learnPage,
  BAD_B,
  addOtherArea,
  at,
  scanClick,
  seenState,
  SCAN_LOOKS,
  LINE,
} = require('../../helpers/map-hunt-world');

ui('learn: the exits of every room it looks at and the rooms the steps really led to are saved', async () => {
  const page = await learnPage(['c']);
  try {
    const game = world(page, { at: 'a', looks: { a: { exits: 'east' }, b: { exits: 'west 和 east' }, c: { exits: 'west 和 east', lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['l', 'e', 'l', 'e', 'l']);
    assert.deepEqual(JSON.parse(JSON.stringify(page.store.mapHuntExits['t/a'])), { exits: ['e'], to: { e: 't/b' } });
    assert.deepEqual(JSON.parse(JSON.stringify(page.store.mapHuntExits['t/b'])), { exits: ['w', 'e'], to: { e: 't/c' } });
    assert.deepEqual([...page.store.mapHuntExits['t/c'].exits], ['w', 'e']);
  } finally {
    page.close();
  }
});

ui('learn: a measured connection beats the map drawing, and an edge that is already measured is not looked at first', async () => {
  const page = await learnPage(['d']);
  try {
    page.store.mapHuntExits = { 't/a': { exits: ['e', 'eu'], to: { eu: 't/d' } } };
    const game = world(page, { at: 'a', moves: { ...MOVES, a: { e: 'b', eu: 'd' } }, looks: { d: { exits: 'west', lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['eu', 'l'], 'the one-step edge that the map does not even draw');
  } finally {
    page.close();
  }
});

ui('learn: only the edge the route needs is tried, one untried exit at a time, and the other exits are left alone', async () => {
  const page = await learnPage(['c']);
  try {
    const game = world(page, { at: 'a', ...BAD_B });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log, ['l', 'e', 'l', 'w', 'e', 'u', 'l'], 'w is tried first (it only leads back to a), then u gets there; n is never touched');
    assert.equal(page.store.mapHuntExits['t/b'].to.u, 't/c');
    assert.equal(page.store.mapHuntExits['t/b'].to.w, 't/a');
  } finally {
    page.close();
  }
});

ui('learn: nothing is tried while the qi is under the eat line', async () => {
  const page = await learnPage(['c']);
  try {
    setKee(page, 60);
    const script = command => {
      if (command === 'l' && countOf(game, 'l') === 2) setKee(page, 30);
      return false;
    };
    const game = world(page, { at: 'a', script, ...BAD_B });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes('eat pill'), 4000), game.log.join(','));
    await sleep(400);
    assert.equal(game.log.includes('w') || game.log.includes('u'), false, 'waits for the qi first');
    setKee(page, 100);
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.ok(game.log.includes('u'));
  } finally {
    page.close();
  }
});

ui('learn: an exit that leads off the map is remembered as out, walked back with the opposite direction, and the target is given up when nothing else works', async () => {
  const page = await learnPage(['c']);
  try {
    const game = world(page, { at: 'a', moves: { ...MOVES, b: { w: 'a', u: 'out1' }, out1: { d: 'b' } }, looks: { a: { exits: 'east' }, b: { exits: 'up' } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /試不出路/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['l', 'e', 'l', 'u', 'd']);
    assert.equal(page.store.mapHuntExits['t/b'].to.u, 'out');
  } finally {
    page.close();
  }
});

ui('learn: when the way back from outside the map is not known the hunt stops with an alert', async () => {
  const page = await learnPage(['c']);
  try {
    const game = world(page, { at: 'a', moves: { ...MOVES, b: { w: 'a', enter: 'out1' } }, looks: { a: { exits: 'east' }, b: { exits: 'enter' } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /不知道怎麼走回來/.test(message.reason)), 6000));
    assert.equal(await hunting(page), false);
    assert.equal(game.log.at(-1), 'enter');
    const count = game.log.length;
    await sleep(300);
    assert.equal(game.log.length, count);
  } finally {
    page.close();
  }
});

ui('learn: with the setting off nothing is saved and no extra l is sent', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l']);
    assert.equal(page.store.mapHuntExits, undefined);
  } finally {
    page.close();
  }
});

ui('learn: a "left the area" mark from an earlier run is forgotten at the start of the next one', async () => {
  const page = await learnPage(['c']);
  try {
    page.store.mapHuntExits = { 't/a': { exits: ['e'], to: { e: 'out' } } };
    const game = world(page, { at: 'a', looks: { b: { exits: 'west 和 east' }, c: { exits: 'west', lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'l', 'e', 'l'], 'the edge that was marked out is walked again');
  } finally {
    page.close();
  }
});

ui('learn: saved data that is the wrong shape is ignored instead of breaking the hunt', async () => {
  const page = await learnPage(['c']);
  try {
    page.store.mapHuntExits = { 't/a': 'x', 't/b': { exits: 'e', to: { e: 5 } }, 't/z': null };
    world(page, { at: 'a', looks: { c: { lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
  } finally {
    page.close();
  }
});

ui('learn: saving merges into what is stored now, so rooms another tab learned meanwhile are kept', async () => {
  const page = await learnPage(['c']);
  try {
    const script = command => {
      if (command === 'e' && countOf(game, 'e') === 1) page.store.mapHuntExits = { ...page.store.mapHuntExits, 't/z': { exits: ['n'], to: { n: 't/y' } } };
      return false;
    };
    const game = world(page, { at: 'a', script, looks: { c: { lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.ok(await waitFor(() => page.store.mapHuntExits?.['t/b'] && page.store.mapHuntExits['t/z'], 2000), 'both the new and the other tab\'s rooms are there');
    assert.equal(page.store.mapHuntExits['t/z'].to.n, 't/y');
  } finally {
    page.close();
  }
});

ui('learn: a normal step that ends in another area is remembered as out and walked back, and the way through is no longer used', async () => {
  const page = await learnPage(['c']);
  try {
    const game = world(page, { at: 'a', moves: { ...MOVES, a: { e: 'r1' }, r1: { w: 'a' } }, looks: { a: { exits: 'east' } } });
    addOtherArea(page, game);
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /沒有走得到/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['l', 'e', 'w']);
    assert.equal(page.store.mapHuntExits['t/a'].to.e, 'out');
  } finally {
    page.close();
  }
});

ui('learn: an exit that leads somewhere the map cannot read waits twice the usual time before it counts as outside, and a way back that does not work stops the hunt', async () => {
  const page = await learnPage(['c']);
  try {
    const times = {};
    const script = command => {
      if (command === 'u' || command === 'd') times[command] = Date.now();
      return false;
    };
    const game = world(page, { at: 'a', script, moves: { ...MOVES, b: { w: 'a', u: 'out1' } }, looks: { a: { exits: 'east' }, b: { exits: 'up' } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /走不回來/.test(message.reason)), 6000));
    assert.ok(times.d - times.u >= 400, `waited ${times.d - times.u} ms before deciding it was outside`);
    assert.equal(await hunting(page), false);
    assert.equal(game.log.at(-1), 'd');
  } finally {
    page.close();
  }
});

ui('learn: a step that was sent again is not recorded as a connection, because the first one may only have been slow', async () => {
  const page = await learnPage(['c']);
  try {
    page.store.mapHuntExits = { 't/b': { exits: ['w', 'e'], to: {} }, 't/c': { exits: ['w'], to: {} } };
    let late = null;
    const script = command => {
      if (command === 'e' && countOf(game, 'e') === 1) { game.at = 'a'; say(page, '你的腳步一時動不了。'); late = setTimeout(() => { game.at = 'b'; }, 700); return true; }
      if (command === 'e' && countOf(game, 'e') === 2) { game.at = 'a'; say(page, '你的腳步一時動不了。'); return true; } // 重送的也沒走成
      return false;
    };
    const game = world(page, { at: 'a', script, looks: { a: { exits: 'east' }, c: { lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.ok(late !== null);
    assert.deepEqual(Object.keys(page.store.mapHuntExits['t/a'].to), [], 'the late arrival at b is not written down as a step from a');
  } finally {
    page.close();
  }
});

ui('learn: when the qi stays under the eat line it gives up on the target instead of waiting for ever', async () => {
  const page = await learnPage(['c']);
  try {
    setKee(page, 30);
    const game = world(page, { at: 'a', ...BAD_B });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /氣一直太低/.test(huntText(page)), 8000), huntText(page));
    assert.equal(game.log.includes('w') || game.log.includes('u'), false, 'nothing was tried');
  } finally {
    page.close();
  }
});

ui('learn places: a chosen monster that is not in the room stays recorded however many times it is missed (cross-area rounds used to lose rooms), and a monster seen there that was never recorded is added', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: [`  ※${MOB_B}`] } } });
    await pick(page, MOB);
    for (let visit = 1; visit <= 4; visit++) {
      click(page, '.hstart');
      assert.ok(await waitFor(() => /巡完了/.test(huntText(page)) && !panelRoot(page).querySelector('.hstart').disabled, 6000), huntText(page));
      game.at = 'a';
    }
    assert.ok(await waitFor(() => page.store.mapMonsters['t/c'].mobs.includes(MOB_B), 2000), 'the monster that was there is learned');
    assert.ok(page.store.mapMonsters['t/c'].mobs.includes(MOB), 'missed on four visits: still recorded');
  } finally {
    page.close();
  }
});

ui('scan: needs no chosen monster, walks every room of the area, looks at each, and records empty rooms as visited too', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const game = world(page, { at: 'a' });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['l', 'e', 'l', 'e', 'l', 'e', 'l']);
    assert.ok(await waitFor(() => ['a', 'b', 'c', 'd'].every(room => seenState(page, `t/${room}`) === 'seen')), JSON.stringify(page.store.mapVisited));
    assert.equal(await hunting(page), false);
    assert.equal(alerts(page).length, 0, 'finishing a scan is not an alarm');
  } finally {
    page.close();
  }
});

ui('scan: monsters seen in a room are recorded there, and a recorded monster that is not seen there stays recorded', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('b');
    world(page, { at: 'a', looks: { c: { lines: [MOB_LINE] } } });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 6000), huntText(page));
    assert.ok(await waitFor(() => page.store.mapMonsters['t/c']?.mobs.includes(MOB)), 'the monster seen in c is recorded');
    assert.ok(page.store.mapMonsters['t/b'].mobs.includes(MOB), 'not seen in b: still recorded there');
    assert.equal(page.store.mapMonsters['t/b'].miss, undefined, 'no miss counting');
  } finally {
    page.close();
  }
});

ui('scan: rooms already visited are not walked again, and a fully visited area says so without sending anything', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapVisited = { 't/a': { at: 1, state: 'seen' }, 't/b': { at: 1, state: 'seen' } };
    const game = world(page, { at: 'a' });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 6000), huntText(page));
    // 掃描一律照實際出口走：離開沒看過出口的房間之前先 l 一次（a、b 都走過了，但這一次還沒讀過它們的出口）
    assert.deepEqual(game.log, ['l', 'e', 'l', 'e', 'l', 'e', 'l']);
    page.store.mapVisited = Object.fromEntries(['a', 'b', 'c', 'd'].map(room => [`t/${room}`, { at: 1, state: 'seen' }]));
    game.log.length = 0;
    scanClick(page);
    assert.ok(await waitFor(() => /都走過了/.test(huntText(page)), 3000), huntText(page));
    assert.deepEqual(game.log, []);
  } finally {
    page.close();
  }
});

ui('scan: a door that cannot be passed on the second try marks the rooms behind it as blocked straight away (no second round), does not stop the scan and is not an alarm', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const game = world(page, { at: 'a', moves: { a: { e: 'b' }, b: { w: 'a' }, c: { w: 'b', e: 'd' }, d: { w: 'c' } } });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 8000), huntText(page));
    assert.ok(await waitFor(() => seenState(page, 't/d') === 'blocked'), JSON.stringify(page.store.mapVisited));
    assert.equal(seenState(page, 't/a'), 'seen');
    assert.equal(seenState(page, 't/b'), 'seen');
    assert.equal(seenState(page, 't/c'), 'blocked');
    assert.equal(game.log.filter(command => command === 'e').length, 3, 'a to b, then the door tried twice; no second round, and d is never tried because the door edge is dropped');
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('scan: finishes after one pass even when the round loop is on, and never asks for the server time or sends the standby command', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapHuntSettings = { ...REQUIRED, loopRounds: 'on', standbyCommand: 'stand' };
    const game = world(page, { at: 'a' });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 6000), huntText(page));
    assert.ok(!game.log.includes('time') && !game.log.includes('stand'), game.log.join());
    assert.equal(await hunting(page), false);
  } finally {
    page.close();
  }
});

ui('scan: a qi below the danger line while only walking goes home, stops and raises an alert', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapHuntSettings = { ...REQUIRED, dangerBelow: 20, homeCommand: 'recall' };
    setKee(page, 10);
    const game = world(page, { at: 'a' });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => game.log.includes('recall'), 4000), huntText(page));
    assert.equal(await hunting(page), false);
    assert.equal(alerts(page).length, 1);
  } finally {
    page.close();
  }
});

ui('scan: a block that goes away later (for example the fight that held you is over) stays remembered: the next scan does not try those rooms until the visited record is cleared', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const moves = { a: { e: 'b' }, b: { w: 'a' }, c: { w: 'b', e: 'd' }, d: { w: 'c' } };
    const game = world(page, { at: 'a', moves });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 8000), huntText(page));
    assert.ok(await waitFor(() => seenState(page, 't/c') === 'blocked' && seenState(page, 't/d') === 'blocked'), JSON.stringify(page.store.mapVisited));
    moves.b.e = 'c'; // 門開了
    game.at = 'a';
    game.log.length = 0;
    scanClick(page);
    assert.ok(await waitFor(() => /都走過了/.test(huntText(page)), 3000), huntText(page));
    assert.deepEqual(game.log, [], 'blocked rooms are not tried again on their own');
    page.store.mapVisited = {};
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 8000), huntText(page));
    assert.ok(await waitFor(() => ['a', 'b', 'c', 'd'].every(room => seenState(page, `t/${room}`) === 'seen')), JSON.stringify(page.store.mapVisited));
  } finally {
    page.close();
  }
});

ui('scan: when you run away while the look is in flight, what l shows belongs to the other room and is not recorded for the one it was meant for', async () => {
  const page = await boot({ scale: SCALE });
  try {
    let moved = false;
    const script = (command, { game }) => {
      if (command === 'l' && game.at === 'b' && !moved) { moved = true; game.at = 'c'; } // 手動跑到 c
      return false;
    };
    // 掃描照實際出口走，所以假世界每間的出口行要寫對
    const looks = { a: { exits: 'east' }, b: { exits: 'west 和 east' }, c: { exits: 'west 和 east', lines: [MOB_LINE] }, d: { exits: 'west' } };
    world(page, { at: 'a', looks, script });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 10000), huntText(page));
    assert.ok(await waitFor(() => ['a', 'b', 'c', 'd'].every(room => seenState(page, `t/${room}`) === 'seen')), JSON.stringify(page.store.mapVisited));
    assert.ok(page.store.mapMonsters['t/c']?.mobs.includes(MOB), 'the monster is recorded in c, where it was');
    assert.ok(!page.store.mapMonsters['t/b']?.mobs?.includes(MOB), 'and not in b, where you were only supposed to be');
  } finally {
    page.close();
  }
});

// 地圖畫的是 e，實際的出口卻是 eastup（遊戲的上坡出口，圖上看起來一樣是往旁邊）：掃描要靠 l 的出口行找到真正的指令
ui('scan always learns exits (even with the setting off): a link the map draws as e but the game only offers as eastup is found, trying the matching exit before the others', async () => {
  const page = await boot({ scale: SCALE });
  try {
    // 設定頁的「自動學習出口」沒開：掃描一定會碰到圖上畫不準的房間，所以掃描一律照實際出口走
    const moves = { a: { e: 'b' }, b: { w: 'a', eu: 'c' }, c: { w: 'b', e: 'd' }, d: { w: 'c' } };
    const looks = { a: { exits: 'east' }, b: { exits: 'west 和 eastup' }, c: { exits: 'west 和 east' }, d: { exits: 'west' } };
    const game = world(page, { at: 'a', moves, looks });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 12000), huntText(page));
    assert.ok(await waitFor(() => ['a', 'b', 'c', 'd'].every(room => seenState(page, `t/${room}`) === 'seen')), JSON.stringify(page.store.mapVisited));
    assert.ok(game.log.includes('eu'), game.log.join());
    assert.ok(!game.log.includes('w') || game.log.indexOf('eu') < game.log.indexOf('w'), `eu is tried before w: ${game.log.join()}`);
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

// 地圖上的單向箭頭只畫去的方向：掃描要能走回去（反方向當猜的邊，到了再用 l 的出口行找真正的指令）
ui('scan: a one-way arrow on the map does not strand the scan, the way back is found from the real exits', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const row = ['a', 'b', 'c', 'd'].map(ROOM).join('→'); // 圖上全是往東的單向
    const moves = { a: { e: 'b' }, b: { w: 'a', e: 'c' }, c: { w: 'b', e: 'd' }, d: { w: 'c' } };
    const looks = { a: { exits: 'east' }, b: { exits: 'west 和 east' }, c: { exits: 'west 和 east' }, d: { exits: 'west' } };
    world(page, { at: 'd', moves, looks, row });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 12000), huntText(page));
    assert.ok(await waitFor(() => ['a', 'b', 'c', 'd'].every(room => seenState(page, `t/${room}`) === 'seen')), JSON.stringify(page.store.mapVisited));
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('scan: rooms it cannot find an exit toward (try-the-exits ran out) are not a run of failures that stops the scan', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const row = ['a', 'b', 'c', 'd', 'e', 'f'].map(ROOM).join('─');
    // b 的出口行只有 west：圖上往東的路實際上沒有，後面四間（c～f）都找不到出口通過去
    const moves = { a: { e: 'b' }, b: { w: 'a' } };
    const looks = { a: { exits: 'east' }, b: { exits: 'west' } };
    world(page, { at: 'a', moves, looks, row });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 20000), huntText(page));
    assert.equal(alerts(page).length, 0, 'no alarm');
    assert.equal(seenState(page, 't/b'), 'seen');
    assert.equal(seenState(page, 't/f'), 'blocked');
  } finally {
    page.close();
  }
});

// 掃描卡住（例如氣一直沒回復、一直在休息）不能無聲無息地掛著：一段時間沒有任何進展就停下來，把當時的狀態寫在訊息裡
ui('scan: with no progress for a long time (stuck resting) it stops with an alarm and says what it was waiting for', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', restBelow: 50, restResume: 80, dangerBelow: 20 };
    setKee(page, 30); // 低於休息線，而且不會回復
    const game = world(page, { at: 'a' });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /沒有進展/.test(huntText(page)), 20000), huntText(page));
    assert.match(huntText(page), /休息中/, 'the message says what it was waiting for');
    assert.equal(await hunting(page), false);
    assert.equal(alerts(page).length, 1);
    assert.deepEqual(game.log, [], 'nothing was sent while resting');
  } finally {
    page.close();
  }
});

ui('scan: rooms remembered as blocked are not tried on the next scan; only the rooms never visited are walked', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapVisited = { 't/a': { at: 1, state: 'seen' }, 't/b': { at: 1, state: 'seen' }, 't/c': { at: 1, state: 'blocked' } };
    const looks = { a: { exits: 'east' }, b: { exits: 'west 和 east' }, c: { exits: 'west 和 east' }, d: { exits: 'west' } };
    const game = world(page, { at: 'a', looks });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 8000), huntText(page));
    assert.ok(await waitFor(() => seenState(page, 't/d') === 'seen'), JSON.stringify(page.store.mapVisited));
    assert.equal(seenState(page, 't/c'), 'blocked', 'c is only walked through on the way, it stays remembered as blocked');
    assert.ok(game.log.includes('e'), game.log.join());
  } finally {
    page.close();
  }
});

// 之前學到 su → l5 這種實測的邊（存在儲存裡）：路線要用它，不能再挑圖上畫的、實際不存在的那條（圖上往 s、實際是 su）
ui('scan: an exit already learned (map says e, game says eu) is used straight away, not replaced by the map edge it contradicts', async () => {
  const page = await boot({ scale: SCALE });
  try {
    // b 的兩個出口都學過了（沒有沒試過的可以試）；c 的出口學過了（west、eastdown），但通往 d 的 ed 還沒走過：d 只靠「寬鬆」的路線（圖上的猜測）走得到
    page.store.mapHuntExits = { 't/b': { exits: ['w', 'eu'], to: { eu: 't/c', w: 't/a' } }, 't/c': { exits: ['w', 'ed'], to: {} } };
    const moves = { a: { e: 'b' }, b: { w: 'a', eu: 'c' }, c: { w: 'b', ed: 'd' }, d: { w: 'c' } };
    const looks = { a: { exits: 'east' }, b: { exits: 'west 和 eastup' }, c: { exits: 'west 和 eastdown' }, d: { exits: 'west' } };
    // a、b、c 都走過了，只剩 d：從 b 出發，每條通往 d 的路第一步都得過 b→c（圖上畫 e，實際是學過的 eu）
    page.store.mapVisited = Object.fromEntries(['a', 'b', 'c'].map(room => [`t/${room}`, { at: 1, state: 'seen' }]));
    const game = world(page, { at: 'b', moves, looks });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 12000), huntText(page));
    assert.ok(await waitFor(() => seenState(page, 't/d') === 'seen'), JSON.stringify(page.store.mapVisited));
    assert.deepEqual(game.log.filter(command => command !== 'l'), ['eu', 'ed'], game.log.join());
  } finally {
    page.close();
  }
});

ui('prescan: a hunt in an area with rooms never visited first scans them, so a monster only seen during the scan becomes a target', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapHuntSettings = { ...REQUIRED, prescan: 'on' };
    page.store.mapMonsters = mobsAt('c'); // d 沒有記錄，掃描時才看到
    const game = world(page, { at: 'a', looks: SCAN_LOOKS });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 20000), huntText(page));
    assert.ok(['a', 'b', 'c', 'd'].every(room => seenState(page, `t/${room}`) === 'seen'), JSON.stringify(page.store.mapVisited));
    assert.ok(page.store.mapMonsters['t/d']?.mobs.includes(MOB), 'the scan recorded the monster in d');
    assert.equal(countOf(game, 'fight 1'), 2, `fought in c and in d: ${game.log.join()}`);
  } finally {
    page.close();
  }
});

ui('prescan: not done when every room of the area is already known (visited or blocked), and not done when switched off', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapHuntSettings = { ...REQUIRED, prescan: 'on' };
    page.store.mapMonsters = mobsAt('c');
    page.store.mapVisited = { 't/a': { at: 1, state: 'seen' }, 't/b': { at: 1, state: 'seen' }, 't/c': { at: 1, state: 'seen' }, 't/d': { at: 1, state: 'blocked' } };
    const game = world(page, { at: 'a' });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l'], 'goes straight to c: no scan, no extra l');
  } finally {
    page.close();
  }
  const off = await boot({ scale: SCALE });
  try {
    off.store.mapMonsters = mobsAt('c');
    const game = world(off, { at: 'a' });
    await pick(off, MOB);
    click(off, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(off)), 6000), huntText(off));
    assert.deepEqual(game.log, ['e', 'e', 'l'], 'prescan off: the old behaviour');
  } finally {
    off.close();
  }
});

// 巡怪、掃描進行中，手動蒐集的觀察器要暫停：它等 0.6 秒才看地圖捲到哪一間，巡怪走得快時會記錯房間；巡怪自己看過 l 之後的記錄才準
ui('the manual collector pauses while a hunt or scan is running, and works again after it stops', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    world(page, { at: 'a', silentLook: true }); // l 沒回應：巡怪停在等回應的階段，有時間做檢查
    await pick(page, MOB);
    click(page, '.hstart');
    assert.equal(await hunting(page), true);
    say(page, '  ※路人怪(passerby)');
    await sleep(250);
    assert.ok(!Object.values(page.store.mapMonsters).some(row => row.mobs?.includes('路人怪(passerby)')), 'not recorded while hunting');
    click(page, '.hstop');
    assert.ok(await waitFor(async () => !(await hunting(page))), 'stopped');
    say(page, '  ※路人怪(passerby)');
    assert.ok(await waitFor(() => Object.values(page.store.mapMonsters).some(row => row.mobs?.includes('路人怪(passerby)')), 2000), 'recorded again once the hunt has stopped');
  } finally {
    page.close();
  }
});

ui('scan: each looked-at room is stored as outdoor when its description has an indented weather line and indoor when not', async () => {
  const page = await boot({ scale: SCALE });
  try {
    world(page, { at: 'a', looks: { a: { weather: '天空中烏雲密佈，下著大雨。' }, b: {}, c: { weather: '晴空萬里。' }, d: {} } });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 6000), huntText(page));
    assert.ok(await waitFor(() => Object.keys(page.store.mapOutdoor ?? {}).length === 4), JSON.stringify(page.store.mapOutdoor));
    const outdoor = Object.fromEntries(Object.entries(page.store.mapOutdoor).map(([key, row]) => [key, row.outdoor]));
    assert.deepEqual(outdoor, { 't/a': true, 't/b': false, 't/c': true, 't/d': false });
    assert.equal(typeof page.store.mapOutdoor['t/a'].at, 'number');
  } finally {
    page.close();
  }
});

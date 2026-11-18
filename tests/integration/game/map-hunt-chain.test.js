// 地圖巡怪：map-hunt-chain（28 組；共用底座在 tests/helpers/map-hunt-world.js，整個 content script 在 jsdom 裡跑）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, sleep, waitFor } = require('../../helpers/game-page');
const {
  MOB,
  MOVES,
  MOB_B,
  world,
  panelRoot,
  tick,
  pick,
  huntText,
  click,
  alerts,
  MOB_LINE,
  FIGHT,
  setKee,
  hunting,
  countOf,
  say,
  fakeClock,
  timeScript,
  at,
  lookTimer,
  macroSlots,
  huntLog,
  pinRandom,
  LINE,
  roundsIn,
  CHAIN,
  chainWorld,
  chainPage,
  chainSortPage,
  chainSortScript,
  SORT_MOVES,
  trialOf,
} = require('../../helpers/map-hunt-world');

ui('chain: it hunts the first area, walks to the next, hunts only that area\'s picks, goes back to the first and waits for the respawn there; the next round starts in the first area', async () => {
  const page = await chainPage();
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const looks = [];
    const game = chainWorld(page, { script: timeScript(page, clock, lookTimer(clock, looks)) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生 10:15/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log.slice(0, 10), ['time', 'e', 'e', 'l', FIGHT, 'gc', 'go-u', 'e', 'l', 'go-t'], 'the monster in u is not ticked for u, so it is not fought');
    assert.equal(game.area, 't');
    assert.equal(game.at, 'a');
    assert.match(huntText(page), /第 1／2 區/);
    assert.ok(await waitFor(() => looks.length >= 3, 9000), 'the second round starts');
    const second = game.log.slice(game.log.lastIndexOf('time') + 1);
    assert.deepEqual(second.slice(0, 3), ['e', 'e', 'l'], 'the second round starts in the first area');
    const text = await huntLog(page);
    assert.match(text, /換區 t → u，花了 [\d.]+ 秒/);
    assert.match(text, /換區 u → t，花了 [\d.]+ 秒/);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('chain: the panel shows which area of how many it is in', async () => {
  const page = await chainPage();
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    let seen = '';
    let game = null;
    game = chainWorld(page, { script: timeScript(page, clock, command => { if (command === 'l' && game.area === 'u') seen = huntText(page); return false; }) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => seen, 6000), huntText(page));
    assert.match(seen, /第 2／2 區/);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('chain: a move command can be several commands or a game macro, expanded as usual', async () => {
  const page = await chainPage({ chain: { ...CHAIN, moves: ['say hi;@巨集 10'] } });
  try {
    page.w.localStorage.setItem('MACROS', macroSlots(10, 'look;go-u'));
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const game = chainWorld(page, { script: timeScript(page, clock) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes('go-t'), 6000), game.log.join(','));
    const at = game.log.indexOf('say hi');
    assert.deepEqual(game.log.slice(at, at + 3), ['say hi', 'look', 'go-u']);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('chain: a move that does not reach the next area stops the hunt with an alert, and is sent only once', async () => {
  const page = await chainPage();
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const game = chainWorld(page, { script: timeScript(page, clock), move: { 'go-t': ['t', 'a'] } });
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /沒有走到下一區（u）/.test(message.reason)), 8000), JSON.stringify(alerts(page)));
    assert.equal(await hunting(page), false);
    await sleep(300);
    assert.equal(countOf(game, 'go-u'), 1, 'no retry');
    const text = await huntLog(page);
    assert.match(text, /換區 t → u 沒有成功：送出換區指令，\d+ 秒內沒有走到下一區（u）/, 'the log says why the switch failed');
    assert.ok(text.indexOf(' 換區 t → u 沒有成功') < text.indexOf(' 停止 '), 'before the stop line');
  } finally {
    page.close();
  }
});

ui('chain: a move that sends nothing (an unreadable @巨集) alerts that it was not sent', async () => {
  const page = await chainPage({ chain: { ...CHAIN, moves: ['@巨集 90'] } });
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const game = chainWorld(page, { script: timeScript(page, clock) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /沒有送出/.test(message.reason)), 8000), JSON.stringify(alerts(page)));
    assert.equal(await hunting(page), false);
    assert.equal(game.area, 't');
  } finally {
    page.close();
  }
});

ui('chain: with the switch off, or fewer than two areas, it hunts only the visible area as before', async () => {
  for (const [settings, chain] of [[{ chain: 'off' }, CHAIN], [{}, { ...CHAIN, areas: [CHAIN.areas[0]], moves: [] }]]) {
    const page = await chainPage({ settings: { loopRounds: 'off', ...settings }, chain });
    try {
      const game = chainWorld(page);
      click(page, '.hstart');
      assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
      assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc'], JSON.stringify(settings));
      assert.doesNotMatch(huntText(page), /區）/);
    } finally {
      page.close();
    }
  }
});

ui('chain: it does not start when a move command is empty', async () => {
  const page = await chainPage({ chain: { ...CHAIN, back: '' } });
  try {
    const game = chainWorld(page);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /回到第一區的指令沒填/.test(huntText(page)), 3000), huntText(page));
    assert.deepEqual(game.log, []);
  } finally {
    page.close();
  }
});

test('chain: a stored route is checked field by field, and one that cannot be read is no route', () => {
  require('../../../catworld-auto-command/map-hunt.js');
  const { normalizeChain } = globalThis.CatworldMapHunt;
  const none = { areas: [], moves: [], back: '' };
  for (const bad of [undefined, null, 'x', 3, [], { areas: 'x' }, { areas: [1, null, {}] }]) assert.deepEqual(normalizeChain(bad), none, JSON.stringify(bad));
  assert.deepEqual(normalizeChain({
    areas: [{ area: ' t ', sortReturn: 5 }, { area: 'u', sortReturn: ' back ' }, { area: 't' }, { area: 7 }, { area: 'v' }],
    moves: ['go-u', 9],
    back: 'go-t',
  }), {
    areas: [{ area: 't', sortReturn: '' }, { area: 'u', sortReturn: 'back' }, { area: 'v', sortReturn: '' }],
    moves: ['go-u', ''],
    back: 'go-t',
  }, 'repeated and non-text areas are dropped, a non-text command is empty, missing moves are filled');
  assert.deepEqual(normalizeChain({ areas: [{ area: 't' }, { area: 'u' }], moves: ['a', 'b', 'c'] }).moves, ['a'], 'extra moves are dropped');
  assert.equal(normalizeChain({ areas: [{ area: 't' }], back: 7 }).back, '');
});

ui('chain: a broken stored route counts as no route, so the hunt runs in the visible area as before', async () => {
  const page = await chainPage({ settings: { loopRounds: 'off' }, chain: 'broken' });
  try {
    const game = chainWorld(page);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc']);
  } finally {
    page.close();
  }
});

// ---- 跨區巡怪：從哪一區開始、沒資料的區（hunt-chain 03）----
ui('chain: starting in the second area hunts it, goes back to the first area to wait, and the next round starts from the first area', async () => {
  const page = await chainPage();
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const looks = [];
    const game = chainWorld(page, { start: ['u', 'p'], script: timeScript(page, clock, lookTimer(clock, looks)) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生 10:15/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log.slice(0, 5), ['time', 'e', 'l', 'go-t', 'time'], 'only the second area, then back to the first');
    assert.match(huntText(page), /第 1／2 區/);
    assert.ok(await waitFor(() => looks.length >= 3, 9000), 'the second round starts');
    const second = game.log.slice(game.log.lastIndexOf('time') + 1);
    assert.deepEqual(second.slice(0, 5), ['e', 'e', 'l', FIGHT, 'gc'], 'the next round starts in the first area');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('chain: it does not start when the character is in no area of the route, and says why', async () => {
  const page = await chainPage({ chain: { areas: [{ area: 'u' }, { area: 'x' }], moves: ['go-x'], back: 'go-u' } });
  try {
    const game = chainWorld(page);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /目前所在的區域（t）不在跨區路線裡/.test(huntText(page)), 3000), huntText(page));
    assert.ok(panelRoot(page).querySelector('.hunt-text').classList.contains('alert'));
    await sleep(200);
    assert.deepEqual(game.log, [], 'nothing is sent');
  } finally {
    page.close();
  }
});

ui('chain: with prescan on, an area reached for the first time has its unscanned rooms scanned before it is hunted', async () => {
  const page = await chainPage({ settings: { prescan: 'on' } });
  try {
    page.store.mapVisited = Object.fromEntries(['a', 'b', 'c', 'd'].map(room => [`t/${room}`, { at: 1, state: 'seen' }]));
    page.store.mapMonsters['u/q'].mobs = [MOB];
    page.store.mapHuntPicks = { t: [MOB], u: [MOB] };
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const game = chainWorld(page, { looks: { q: { exits: 'west', lines: [MOB_LINE] } }, script: timeScript(page, clock) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes('go-t'), 8000), game.log.join(','));
    const inU = game.log.slice(game.log.indexOf('go-u') + 1, game.log.indexOf('go-t'));
    assert.equal(inU[0], 'l', `the first room of the new area is looked at as a scan (${inU.join(',')})`);
    assert.ok(inU.indexOf(FIGHT) > inU.indexOf('e'), `the scan walks the area first, then the monster is fought (${inU.join(',')})`);
    assert.equal(page.store.mapVisited['u/p']?.state, 'seen');
    assert.equal(page.store.mapVisited['u/q']?.state, 'seen');
    assert.equal(game.log.slice(0, game.log.indexOf('go-u')).filter(command => command === 'l').length, 1, 'the first area was scanned before, so it is not scanned again');
    assert.ok(await waitFor(() => /到過 2 間/.test(huntText(page)), 6000), `the scanned rooms are not counted as visited: ${huntText(page)}`);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('chain: with prescan off, an area without any target room is skipped with a log line and the hunt goes on to the next move', async () => {
  const page = await chainPage();
  try {
    page.store.mapHuntPicks = { t: [MOB], u: [] };
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const game = chainWorld(page, { script: timeScript(page, clock) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log.slice(0, 9), ['time', 'e', 'e', 'l', FIGHT, 'gc', 'go-u', 'go-t', 'time'], 'nothing is sent in u');
    assert.match(await huntLog(page), /u 略過區 這一區沒有勾選的怪的房間/);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('chain: with prescan on, a first area first reached on the way back is scanned when the next round starts, not while waiting for the respawn', async () => {
  const page = await chainPage({ settings: { prescan: 'on' } });
  try {
    page.store.mapVisited = { 'u/p': { at: 1, state: 'seen' }, 'u/q': { at: 1, state: 'seen' } };
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const game = chainWorld(page, { start: ['u', 'p'], script: timeScript(page, clock) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生 10:15/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log.slice(0, 5), ['time', 'e', 'l', 'go-t', 'time'], 'no scan of the first area before waiting');
    assert.ok(await waitFor(() => game.log.includes(FIGHT), 12000), game.log.join(','));
    const round = game.log.slice(game.log.lastIndexOf('time') + 1);
    assert.equal(round[0], 'l', `the next round starts by scanning the first area where it stands (${round.join(',')})`);
    assert.ok(['a', 'b', 'c', 'd'].every(room => page.store.mapVisited[`t/${room}`]?.state === 'seen'), JSON.stringify(page.store.mapVisited));
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('chain: starting in the last area with nothing to hunt there still goes back to the first area and hunts from there at the respawn', async () => {
  const page = await chainPage();
  try {
    page.store.mapHuntPicks = { t: [MOB], u: [] };
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const game = chainWorld(page, { start: ['u', 'p'], script: timeScript(page, clock) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生 10:15/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log.slice(0, 3), ['time', 'go-t', 'time']);
    assert.ok(await waitFor(() => game.log.includes(FIGHT), 9000), game.log.join(','));
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

// ---- 跨區巡怪和其他功能（hunt-chain 04）----
ui('chain: a stop before the respawn in a later area walks back to the first area and waits there; the next round starts in the first area', async () => {
  const page = await chainPage({ settings: { stopBeforeSpawnSec: 120 } });
  try {
    page.store.mapMonsters['u/q'].mobs = [MOB];
    page.store.mapHuntPicks = { t: [MOB], u: [MOB] };
    const clock = fakeClock(page, '2026-11-04T10:14:00+08:00', { scale: 60 });
    const game = chainWorld(page, { start: ['u', 'p'], script: timeScript(page, clock) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes(FIGHT), 12000), game.log.join(','));
    const back = game.log.indexOf('go-t');
    assert.ok(back > 0 && back < game.log.indexOf(FIGHT), `no fight in u that close to the respawn, it went back first (${game.log.join(',')})`);
    assert.equal(game.area, 't', 'the fight after the respawn is in the first area');
    assert.deepEqual(game.log.slice(game.log.lastIndexOf('time') + 1, game.log.lastIndexOf('time') + 4), ['e', 'e', 'l']);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('chain: sorting in the second area comes back with that area\'s own return command and goes on hunting there', async () => {
  const page = await chainSortPage('back-u');
  try {
    const bag = { load: 95 };
    const game = chainWorld(page, { start: ['u', 'p'], move: SORT_MOVES, script: chainSortScript(page, bag) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(game.log, ['e', 'l', FIGHT, 'gc', 'i', 'trip', 'sell all', 'back-u', 'i']);
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('chain: sorting in the second area walks to the ride room of that area first', async () => {
  const page = await chainSortPage('back-u');
  try {
    page.store.mapHuntRideRooms = { t: ['t/c'], u: ['u/p'] };
    const bag = { load: 95 };
    const game = chainWorld(page, { start: ['u', 'p'], move: SORT_MOVES, script: chainSortScript(page, bag) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(game.log, ['e', 'l', FIGHT, 'gc', 'i', 'w', 'trip', 'sell all', 'back-u', 'i']);
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('chain: an area without its own sort return command uses the usual one', async () => {
  const page = await chainSortPage('');
  try {
    const bag = { load: 95 };
    const game = chainWorld(page, { start: ['u', 'p'], move: SORT_MOVES, script: chainSortScript(page, bag) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(game.log.slice(5, 8), ['trip', 'sell all', 'back']);
  } finally {
    page.close();
  }
});

ui('chain: a sort that comes back in another area than the one being hunted stops with an alert', async () => {
  const page = await chainSortPage('back-u');
  try {
    const bag = { load: 95 };
    chainWorld(page, { start: ['u', 'p'], move: { ...SORT_MOVES, 'back-u': ['t', 'a'] }, script: chainSortScript(page, bag) });
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /不在 u 這一區/.test(message.reason)), 12000), JSON.stringify(alerts(page)));
  } finally {
    page.close();
  }
});

ui('chain: a humanized rest counts the whole route as one round, and the round summary names the area of each room', async () => {
  const page = await chainPage({ settings: { humanize: 'on', restEveryMin: 1, restEveryMax: 1, homeCommand: 'recall', restReturnCommand: 'come-back' } });
  try {
    pinRandom(page, 0.99);
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    chainWorld(page, { script: timeScript(page, clock) });
    click(page, '.hstart');
    assert.ok(await waitFor(async () => / 休息 跳過/.test(await huntLog(page)), 8000), (await huntLog(page)).slice(-800));
    const text = await huntLog(page);
    const rest = text.indexOf(' 休息 跳過');
    assert.ok(text.indexOf('換區 u → t') < rest, 'the rest is counted after the whole route');
    assert.equal(roundsIn(text.slice(0, rest)), 1, 'one round for the two areas');
    assert.match(text, /路線 t\/b→t\/c→u\/q/, 'the summary keeps the area of each room');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('chain trial: it sends each move and the way back, only walking: no l and no fight, and stores each leg as a success', async () => {
  const page = await chainPage();
  try {
    const game = chainWorld(page);
    const reply = await page.ask({ type: 'HUNT_CHAIN_TRIAL' });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.ok(await waitFor(() => /試跑完成/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['go-u', 'go-t'], 'nothing but the move commands');
    const results = trialOf(page);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(item => [item.command, item.from, item.to, item.ok]), [['go-u', 't', 'u', true], ['go-t', 'u', 't', true]]);
    assert.ok(results.every(item => Number.isFinite(item.ms)));
    assert.equal(await hunting(page), false);
  } finally {
    page.close();
  }
});

ui('chain trial: the first failure stops it with the reason and where the character was; the later legs have no result', async () => {
  const page = await chainPage();
  try {
    const game = chainWorld(page, { move: { 'go-t': ['t', 'a'] } });
    await page.ask({ type: 'HUNT_CHAIN_TRIAL' });
    assert.ok(await waitFor(() => trialOf(page), 8000), huntText(page));
    const [first, second] = trialOf(page);
    assert.equal(first.ok, false);
    assert.match(first.why, /沒有走到 u/);
    assert.equal(first.where, 't/a');
    assert.equal(second, null);
    assert.deepEqual(game.log, ['go-u'], 'the way back was never sent');
    assert.ok(alerts(page).some(message => /試跑/.test(message.reason)));
  } finally {
    page.close();
  }
});

ui('chain trial: it does not run unless the character is in the first area, nor while the hunt runs', async () => {
  const page = await chainPage({ settings: { loopRounds: 'off' } });
  try {
    const game = chainWorld(page, { start: ['u', 'p'] });
    const away = await page.ask({ type: 'HUNT_CHAIN_TRIAL' });
    assert.equal(away.ok, false);
    assert.match(away.error, /試跑要從第一區（t）開始/);
    assert.deepEqual(game.log, []);
    click(page, '.hstart');
    assert.ok(await waitFor(async () => hunting(page), 3000));
    const busy = await page.ask({ type: 'HUNT_CHAIN_TRIAL' });
    assert.equal(busy.ok, false);
    assert.match(busy.error, /進行中/);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('chain trial: stop ends it, the leg under way gets no result, and the hunt cannot start while it runs', async () => {
  const page = await chainPage();
  try {
    const game = chainWorld(page, { move: { 'go-t': ['t', 'a'] } });
    await page.ask({ type: 'HUNT_CHAIN_TRIAL' });
    assert.ok(await waitFor(() => game.log.includes('go-u'), 3000));
    assert.ok(panelRoot(page).querySelector('.hstart').disabled || await waitFor(() => panelRoot(page).querySelector('.hstart').disabled, 2000), 'start is disabled during the trial');
    assert.match(huntText(page), /試跑/);
    click(page, '.hstop');
    assert.ok(await waitFor(() => trialOf(page), 3000));
    assert.deepEqual(trialOf(page), [null, null]);
    assert.equal(await hunting(page), false);
    await sleep(300);
    assert.deepEqual(game.log, ['go-u']);
  } finally {
    page.close();
  }
});

ui('chain: under the danger line while changing area it goes home right where it is, even with ride rooms recorded', async () => {
  // 第一區沒勾怪：一開始就換區；換區指令沒把人帶走（走在路上），這時氣掉到危險線
  const page = await chainPage({ settings: { loopRounds: 'off', fightMode: 'assist', eatCommand: '', noMedicineKeyword: '', dangerBelow: 20, homeCommand: 'recall' } });
  try {
    page.store.mapHuntPicks = { u: [MOB_B] };
    page.store.mapHuntRideRooms = { t: ['t/b'] };
    const game = chainWorld(page, { move: {} });
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes('go-u'), 3000), `${huntText(page)} | ${game.log.join(',')}`);
    setKee(page, 10);
    assert.ok(await waitFor(() => game.log.includes('recall'), 3000), huntText(page));
    assert.equal(game.log.includes('e'), false, game.log.join(','));
    assert.equal(alerts(page).length, 1);
  } finally {
    page.close();
  }
});

ui('chain trial: falling under the danger line on a leg sends the character home, and that leg is a failure saying why and where', async () => {
  const page = await chainPage();
  try {
    const game = chainWorld(page, { move: { 'go-t': ['t', 'a'] } });
    await page.ask({ type: 'HUNT_CHAIN_TRIAL' });
    assert.ok(await waitFor(() => game.log.includes('go-u'), 3000));
    setKee(page, 10);
    assert.ok(await waitFor(() => trialOf(page), 4000), huntText(page));
    const [first, second] = trialOf(page);
    assert.equal(first.ok, false);
    assert.match(first.why, /試跑中氣只剩 10%/);
    assert.equal(first.where, 't/a');
    assert.equal(second, null);
    assert.ok(await waitFor(() => game.log.includes('recall'), 3000), 'went home');
  } finally {
    page.close();
  }
});

// 面板巡怪列在沒有巡的時候也寫出跨區的狀態（開著與路線、沒開、路線不到兩區），都沒設定就不寫
ui('chain: while idle with the switch on, the panel hunt line shows the route, or that no route is set; with the switch off it says nothing', async () => {
  const cases = [
    [{ chain: 'on' }, CHAIN, /跨區：測試區 → 第二區 → ↺ 測試區/],
    [{ chain: 'on' }, { ...CHAIN, areas: [CHAIN.areas[0]], moves: [] }, /跨區：還沒設定路線（要兩區以上），只巡這一區/],
  ];
  for (const [settings, chain, pattern] of cases) {
    const page = await chainPage({ settings, chain });
    try {
      chainWorld(page);
      assert.ok(await waitFor(() => pattern.test(huntText(page)), 4000), `${JSON.stringify(settings)}: ${huntText(page)}`);
    } finally {
      page.close();
    }
  }
  const page = await chainPage({ settings: { chain: 'off' } });
  try {
    chainWorld(page);
    await sleep(800);
    assert.doesNotMatch(huntText(page), /跨區/, 'nothing about cross-area hunting while the switch is off, even with a route');
  } finally {
    page.close();
  }
});

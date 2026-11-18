// 地圖巡怪：map-hunt-core（60 組；共用底座在 tests/helpers/map-hunt-world.js，整個 content script 在 jsdom 裡跑）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, sleep, waitFor } = require('../../helpers/game-page');
const {
  SCALE,
  REQUIRED,
  boot,
  MOB,
  MOVES,
  mobsIn,
  mobsAt,
  MOB_B,
  world,
  panelRoot,
  pickBoxes,
  openPicker,
  tick,
  pick,
  huntText,
  huntDetail,
  click,
  alerts,
  PLAYER_FINGER,
  NOT_FOUND,
  MOB_LINE,
  PERSON,
  FIGHT,
  mobsLines,
  hunting,
  countOf,
  say,
  OTHER_LINE,
  KNOCKED_LINE,
  at,
  setHuntFeature,
  MEMORY_STORAGE,
  macroSlots,
  lookOut,
  assistPage,
  huntLog,
  LINE,
  ALIAS_LIST,
  verify,
  ALIAS_PAGE_1,
  ALIAS_PAGE_2,
  CHAIN,
  chainWorld,
  chainPage,
} = require('../../helpers/map-hunt-world');

ui('hunt: walks to the room that has the chosen monster, looks at it, and is done when every target room was handled', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a' });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l']);
    assert.equal(game.at, 'c');
    assert.equal((await page.ask({ type: 'STATUS' })).hunt.on, false);
  } finally {
    page.close();
  }
});

ui('hunt: refuses to start without a chosen monster, and says why', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a' });
    await sleep(150);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /請先按「選怪」勾選要巡的怪/.test(huntText(page)), 2000), huntText(page));
    assert.deepEqual(game.log, []);
    assert.ok(panelRoot(page).querySelector('.hunt-text').classList.contains('alert'), 'a refusal is shown as an error');
  } finally {
    page.close();
  }
});

ui('hunt: refuses when the ticked monster has no room on the map, and a stale tick counts as none', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('zz');
    const game = world(page, { at: 'a' });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /沒有蒐集到勾選的怪的房間/.test(huntText(page)), 2000), huntText(page));
    assert.deepEqual(game.log, []);
    // 儲存裡留著、但這個區域已經沒有的怪，視為沒勾
    page.store.mapHuntPicks = { t: ['別的怪(other)'] };
    click(page, '.hstart');
    assert.ok(await waitFor(() => /請先按「選怪」勾選要巡的怪/.test(huntText(page)), 2000), huntText(page));
  } finally {
    page.close();
  }
});

ui('hunt: goes to the nearest of several target rooms, and ignores a collected room that is not on the map', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = { ...mobsAt('c', 'd'), 't/zz': { area: 't', room: 'zz', areaName: '測試區', mobs: [MOB], seen: 1 } };
    const game = world(page, { at: 'a' });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'e', 'l'], 'the nearer room c first, then d');
    assert.equal(game.at, 'd');
    assert.match(huntText(page), /略過 1 間.*zz.*不在地圖上/, 'the room that is not on the map is named in the panel');
  } finally {
    page.close();
  }
});

ui('hunt: while running, the panel line only counts the skipped rooms and the details are in its title', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = { ...mobsAt('c', 'd'), 't/zz': { area: 't', room: 'zz', areaName: '測試區', mobs: [MOB], seen: 1 } };
    const game = world(page, { at: 'a' });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /略過 1 間/.test(huntText(page)) && !/巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.match(huntText(page), /（略過 1 間）/);
    assert.doesNotMatch(huntText(page), /zz|不在地圖上/, 'the line stays short while running');
    assert.match(huntText(page), /^測試怪：/, 'the monster is its name only, without the (id)');
    assert.doesNotMatch(huntText(page), /test mob|t\//, 'no id and no area prefix on the line');
    assert.match(huntDetail(page), /測試怪\(test mob\)/, 'the title keeps the full name');
    assert.match(huntDetail(page), /zz 不在地圖上/, 'the title names the room and why');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000));
    assert.equal(game.at, 'd');
  } finally {
    page.close();
  }
});

ui('hunt: a door that does not open is retried once, then that room is skipped; three skips in a row stop it with an alert', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('b', 'c', 'd');
    const game = world(page, { at: 'a', stuck: true });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).length === 1, 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'e', 'e', 'e', 'e'], 'each of the three rooms: sent, retried once, then skipped');
    assert.match(huntText(page), /連續 3 次走不到目標房間/);
    assert.equal((await page.ask({ type: 'STATUS' })).hunt.on, false);
    await sleep(300);
    assert.equal(game.log.length, 6, 'nothing more is sent after it stopped');
  } finally {
    page.close();
  }
});

ui('hunt: the stop button stops it at once and drops what was queued', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('d');
    const game = world(page, { at: 'a' });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.length >= 1, 2000));
    assert.equal((await page.ask({ type: 'STATUS' })).hunt.on, true);
    click(page, '.hstop');
    const sentAtStop = game.log.length;
    await sleep(400);
    assert.equal(game.log.length, sentAtStop);
    assert.equal((await page.ask({ type: 'STATUS' })).hunt.on, false);
  } finally {
    page.close();
  }
});

ui('hunt: counts as running, so the no-reply watchdog stops it like every other feature', async () => {
  const page = await boot({ scale: SCALE });
  try {
    // 好幾個目標：巡怪自己因為走不過去而放棄要連續略過 3 個才會停（約 30 秒），遠比看門狗的 8 秒慢，整套並行電腦忙時兩個計時器的先後才不會被搶；
    // 只有一個目標時巨集自己先略過、先結束，看門狗就沒機會響了
    page.store.mapMonsters = mobsAt('b', 'c', 'd');
    const game = world(page, { at: 'a', reply: false, stuck: true });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /沒有收到遊戲回應/.test(message.reason)), 4000), 'the watchdog fires for a hunt that gets no reply');
    assert.equal((await page.ask({ type: 'STATUS' })).hunt.on, false, 'and it stops the hunt too');
    const count = game.log.length;
    await sleep(400);
    assert.equal(game.log.length, count);
  } finally {
    page.close();
  }
});

ui('hunt: an orphaned page (extension reloaded) stops hunting and sends nothing more', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('d');
    const game = world(page, { at: 'a', stuck: true });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.length >= 1, 2000));
    page.w.chrome.runtime.id = undefined;
    await sleep(500);
    const count = game.log.length;
    await sleep(400);
    assert.equal(game.log.length, count, 'the orphan sends no more commands');
  } finally {
    page.close();
  }
});

ui('hunt: several monsters can be ticked, and the target rooms are the rooms of any of them', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = { ...mobsIn(MOB, 'd'), ...mobsIn(MOB_B, 'c') };
    const game = world(page, { at: 'a' });
    await pick(page, MOB, MOB_B);
    assert.deepEqual([...page.store.mapHuntPicks.t].sort(), [MOB, MOB_B].sort(), 'the ticks are saved per area');
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'e', 'l'], 'c (only the second monster) is nearer, then d');
    assert.equal(game.at, 'd');
  } finally {
    page.close();
  }
});

ui('hunt: a monster that is not ticked does not make its room a target', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = { ...mobsIn(MOB, 'd'), ...mobsIn(MOB_B, 'c') };
    const game = world(page, { at: 'a' });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'e', 'l']);
    assert.equal(game.at, 'd');
  } finally {
    page.close();
  }
});

ui('hunt: ticks made earlier come back ticked, and an area with no collected monster says so', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntPicks = { t: [MOB] };
    world(page, { at: 'a' });
    await openPicker(page, MOB);
    assert.equal(pickBoxes(page).find(box => box.value === MOB).checked, true);
    tick(page, pickBoxes(page)[0], false);
    assert.ok(await waitFor(() => page.store.mapHuntPicks.t.length === 0), 'unticking is saved too');
  } finally {
    page.close();
  }
  const empty = await boot({ scale: SCALE });
  try {
    world(empty, { at: 'a' });
    click(empty, '.hpick');
    assert.ok(await waitFor(() => /這個區域還沒有蒐集到怪/.test(panelRoot(empty).querySelector('.hunt-pick-list').textContent), 2000));
  } finally {
    empty.close();
  }
});

ui('hunt: stepping into the wrong room is replanned, and a door that keeps sending you back is given up on', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('d');
    // b 的東邊那扇門把人送回 a：路線算出來的下一間是 c，到的卻是 a
    const game = world(page, { at: 'a', moves: { ...MOVES, b: { w: 'a', e: 'a' } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(async () => !(await page.ask({ type: 'STATUS' })).hunt.on, 6000), huntText(page));
    assert.match(huntText(page), /略過 1 間/);
    assert.equal(game.log.length, 6, 'a→b, bounced, a→b, bounced, a→b, bounced: the third wrong room gives the target up');
    assert.match(huntText(page), /d.*走錯房間/);
  } finally {
    page.close();
  }
});

ui('hunt: stopping while it is still reading the saved settings cancels the start', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a' });
    await pick(page, MOB);
    click(page, '.hstart');
    click(page, '.hstop');
    await sleep(500);
    assert.deepEqual(game.log, [], 'nothing was sent');
    assert.equal((await page.ask({ type: 'STATUS' })).hunt.on, false);
  } finally {
    page.close();
  }
});

ui('hunt: the start button is disabled while a hunt is running or starting, so a double click cannot start two', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('d');
    const game = world(page, { at: 'a' });
    await pick(page, MOB);
    click(page, '.hstart');
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.length >= 1, 2000));
    assert.equal(panelRoot(page).querySelector('.hstart').disabled, true);
    await waitFor(() => /巡完了/.test(huntText(page)), 4000);
    assert.deepEqual(game.log, ['e', 'e', 'e', 'l'], 'one walk only');
  } finally {
    page.close();
  }
});

ui('hunt: a few ticks without a readable room are waited out; a room that stays unreadable stops it with an alert', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', moves: { ...MOVES, a: { e: 'nowhere' } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.length === 1, 2000));
    await sleep(60);
    game.at = 'b';
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.equal(alerts(page).length, 0, 'a short gap is not an alarm');
  } finally {
    page.close();
  }
  const lost = await boot({ scale: SCALE });
  try {
    lost.store.mapMonsters = mobsAt('c');
    world(lost, { at: 'a', moves: { ...MOVES, a: { e: 'nowhere' } } });
    await pick(lost, MOB);
    click(lost, '.hstart');
    assert.ok(await waitFor(() => alerts(lost).length === 1, 4000), huntText(lost));
    assert.match(huntText(lost), /讀不到目前所在的房間/);
  } finally {
    lost.close();
  }
});

ui('hunt: a room with a player in it is skipped, and the panel says who', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c', 'd');
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE, PERSON('somebody')] }, d: { lines: [MOB_LINE] } }, fingers: { somebody: PLAYER_FINGER } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 5000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'finger somebody', 'e', 'l', 'fight 1', 'gc'], 'looked at c, asked about the unknown id, left for d and fought there');
    assert.match(huntText(page), /略過 1 間.*t\/c 有別人 somebody/);
    assert.equal(alerts(page).length, 0, 'meeting a player is not an alarm');
  } finally {
    page.close();
  }
});

ui('hunt: an id that finger cannot find is an NPC: remembered, the room is not skipped, and it is not asked about again', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c', 'd');
    const smith = () => ({ lines: [MOB_LINE, PERSON('smith', '鑄造師')] });
    const game = world(page, { at: 'a', looks: { c: smith(), d: smith() }, fingers: { smith: NOT_FOUND } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 5000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'finger smith', 'fight 1', 'gc', 'e', 'l', 'fight 1', 'gc'], 'asked once, at the first room only');
    assert.deepEqual([...page.store.mapHuntNpcs], ['smith']);
    assert.doesNotMatch(huntText(page), /略過/);
  } finally {
    page.close();
  }
});

ui('hunt: a finger that gets no answer is treated as a player, and nothing is learned from silence', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE, PERSON('ghost')] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'finger ghost']);
    assert.match(huntText(page), /略過 1 間.*有別人 ghost/);
    assert.equal(page.store.mapHuntNpcs, undefined);
  } finally {
    page.close();
  }
});

ui('hunt: an id on the whitelist is never asked about and does not count as someone', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, npcWhitelist: 'smith、banker' };
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE, PERSON('smith', '鑄造師')] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight 1', 'gc']);
    assert.doesNotMatch(huntText(page), /略過/);
  } finally {
    page.close();
  }
});

ui('hunt: a room whose look gets no answer is skipped like a door that does not open', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', silentLook: true });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /略過 1 間.*t\/c 讀不到房間/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l']);
  } finally {
    page.close();
  }
});

ui('arrival: a target room is read from the arrival description, so no l is sent for it', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', arrivals: { c: { lines: [MOB_LINE] } }, looks: { c: { lines: [MOB_LINE] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'fight 1', 'gc'], 'no l at all: the look came from the arrival and the only monster needs no recount');
    assert.match(await huntLog(page), /t\/c 看房間 .*來源 抵達描述/);
  } finally {
    page.close();
  }
});

ui('arrival: a person in the arrival description is asked about with finger, as with l', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', arrivals: { c: { lines: [MOB_LINE, PERSON('somebody')] } }, fingers: { somebody: PLAYER_FINGER } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'finger somebody'], 'no l, a player means the room is skipped');
    assert.match(huntText(page), /有別人/);
  } finally {
    page.close();
  }
});

ui('arrival: with no arrival description at all it falls back to one l', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight 1', 'gc']);
    assert.match(await huntLog(page), /t\/c 看房間 .*來源 l/);
  } finally {
    page.close();
  }
});

ui('arrival: a description without an exit line is not used, and one l is sent instead', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', arrivals: { c: { exits: '', lines: [] } }, looks: { c: { lines: [MOB_LINE] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight 1', 'gc'], 'the l shows the monster that the arrival text did not');
  } finally {
    page.close();
  }
});

ui('arrival: when the target is the room the hunt starts in there was no walking in, so the look is an l', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('a');
    const game = world(page, { at: 'a', arrivals: { a: { lines: [MOB_LINE] } }, looks: { a: { lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['l']);
  } finally {
    page.close();
  }
});

ui('arrival: a description that arrives in two packets (the monster lines after the exit line) is judged whole, not by its first half', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', arrivalSplitMs: 12, arrivals: { c: { lines: [MOB_LINE] } }, looks: { c: { lines: [MOB_LINE] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'fight 1', 'gc'], 'the monster that came in the second packet was fought, with no l before the fight');
  } finally {
    page.close();
  }
});

ui('arrival: the only-send-fight mode judges the room from the arrival description too', async () => {
  const page = await assistPage();
  try {
    const game = world(page, { at: 'a', arrivals: { c: { lines: mobsLines(1) } }, looks: { c: { lines: mobsLines(1) } }, script: command => {
      if (command.startsWith('fight ')) { setTimeout(() => lookOut(page), 50); return true; }
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', FIGHT], 'fight right away, without an l first');
  } finally {
    page.close();
  }
});

ui('arrival: the monsters seen in the arrival description are learned for the room', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    world(page, { at: 'a', arrivals: { c: { lines: [MOB_LINE, '  ※另一隻怪(other mob) [fight][kill]'] } }, looks: { c: { lines: [MOB_LINE] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.ok(await waitFor(() => page.store.mapMonsters['t/c'].mobs.includes('另一隻怪(other mob)'), 2000), JSON.stringify(page.store.mapMonsters['t/c']));
  } finally {
    page.close();
  }
});

ui('arrival: a description that comes a little late is still waited for', async () => {
  const late = await boot({ scale: SCALE });
  try {
    late.store.mapMonsters = mobsAt('c');
    const game = world(late, { at: 'a', arrivalDelayMs: 15, arrivals: { c: { lines: [MOB_LINE] } }, looks: { c: { lines: [MOB_LINE] } } });
    await pick(late, MOB);
    click(late, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(late)), 4000), huntText(late));
    assert.deepEqual(game.log, ['e', 'e', 'fight 1', 'gc'], 'a description 15 ms late is within the short wait');
  } finally {
    late.close();
  }
});

ui('arrival: scanning still sends l in every room', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapHuntSettings = { ...REQUIRED, learnExits: 'off' };
    const arrivals = Object.fromEntries(['b', 'c', 'd'].map(id => [id, { lines: [] }]));
    const game = world(page, { at: 'a', arrivals, looks: { a: { lines: [] }, b: { lines: [] }, c: { lines: [] }, d: { lines: [] } } });
    click(page, '.hscan');
    assert.ok(await waitFor(() => !/巡怪中|掃描中/.test(huntText(page)) && game.log.filter(c => c === 'l').length >= 4, 8000), huntText(page));
    assert.ok(game.log.filter(command => command === 'l').length >= 4, 'an l for each of the four rooms (' + JSON.stringify(game.log) + ')');
  } finally {
    page.close();
  }
});

ui('hunt: a room with none of the ticked monsters is left at once, without asking about the people in it', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: [PERSON('somebody')] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l']);
    assert.doesNotMatch(huntText(page), /略過/);
  } finally {
    page.close();
  }
});

ui('hunt: an id with odd characters is treated as a player without being sent to finger, and is not learned', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE, PERSON('evil;quit')] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l'], 'nothing with a semicolon is ever sent');
    assert.match(huntText(page), /略過 1 間.*有別人 evil;quit/);
    assert.equal(page.store.mapHuntNpcs, undefined);
  } finally {
    page.close();
  }
});

ui('hunt: whitelist and learned NPCs match whatever the case, and a learned NPC is not asked about on the next run', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, npcWhitelist: 'Smith' };
    page.store.mapHuntNpcs = ['banker'];
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE, PERSON('smith', '鑄造師'), PERSON('BANKER', '錢莊')] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight 1', 'gc'], 'neither is asked about, neither counts as someone');
  } finally {
    page.close();
  }
});

ui('hunt: stopping while an NPC is being remembered does not send another finger or touch the next run', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE, PERSON('smith', '鑄造師'), PERSON('ghost')] } }, fingers: { smith: NOT_FOUND } });
    // 定時開著：停止後佇列裡若多出一個 finger，它會被送出去（沒有任何功能在跑時佇列不會送）
    await page.ask({ type: 'START', settings: { commands: ['ps'], minSeconds: 1, maxSeconds: 1, commandDelayMs: 0 } });
    // 記 NPC 的儲存很慢，停止剛好落在這段時間
    const set = page.w.chrome.storage.local.set;
    page.w.chrome.storage.local.set = async values => {
      if (values.mapHuntNpcs) await sleep(150);
      return set(values);
    };
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes('finger smith'), 4000));
    await sleep(60);
    click(page, '.hstop');
    await sleep(500);
    assert.equal(game.log.includes('finger ghost'), false, 'no finger after the stop');
    assert.equal((await page.ask({ type: 'STATUS' })).hunt.on, false);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('position: with the position form the fight command is followed by the place among the monster lines of the arrival description, counting unticked and knocked-out ones', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED };
    const lines = [OTHER_LINE, KNOCKED_LINE, MOB_LINE];
    const game = world(page, { at: 'a', arrivals: { c: { lines } }, looks: { c: { lines: [...lines] } }, script: (command, { say: tell }) => {
      if (command === 'fight 3') { tell('測試怪死了。'); return true; }
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'fight 3', 'gc'], 'the ticked monster is the third monster line');
  } finally {
    page.close();
  }
});

ui('position: after a kill the recount gives the next monster its new position', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED };
    const looks = { c: { lines: [MOB_LINE, OTHER_LINE, MOB_LINE] } };
    const game = world(page, { at: 'a', looks, script: (command, { say: tell }) => {
      if (/^fight \d$/.test(command)) {
        looks.c.lines.splice(Number(command.slice(6)) - 1, 1); // 打的那一隻倒下、從房間消失
        tell('測試怪死了。');
        return true;
      }
      return command === 'gc';
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight 1', 'gc', 'l', 'fight 2', 'gc'], 'first at 1; after it is gone the other ticked one moved from 3 to 2');
  } finally {
    page.close();
  }
});

ui('position: the kill command after a refusal and the finishing kill use the position too', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, killCommand: 'k' };
    let kills = 0;
    const game = world(page, { at: 'a', looks: { c: { lines: [OTHER_LINE, MOB_LINE] } }, script: (command, { say: tell }) => {
      if (command === 'fight 2') { tell('看起來測試怪並不想跟你較量。'); return true; }
      if (command === 'k 2') { kills += 1; tell(kills === 1 ? '測試怪一動也不動了。' : '測試怪死了。'); return true; }
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight 2', 'k 2', 'k 2', 'gc'], 'refused: k 2; knocked out: k 2 again to finish it');
  } finally {
    page.close();
  }
});

ui('reward: while the hunt is running the automatic sc and reward wait, and go out once the hunt has stopped', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const doc = page.w.document;
    if (!doc.getElementById('status')) doc.body.insertAdjacentHTML('beforeend', '<span id="status"></span>');
    doc.getElementById('status').textContent = '忙碌:3'; // 巡怪一直開著（忙碌時什麼都不送）
    world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } } });
    await pick(page, MOB);
    click(page, '.hstart');
    page.output('<span>在線獎勵： 0分鐘後可領取</span>'); // 1 分鐘後到期，縮小 20 倍約 3 秒
    await sleep(4500);
    assert.deepEqual(page.sent.filter(command => command === 'sc' || command === 'reward'), [], 'the countdown is over but the hunt is on: nothing goes out');
    const line = page.hosts()[0].shadowRoot.querySelector('.reward-line');
    assert.match(line.textContent, /巡怪/, 'the panel says why it waits');
    click(page, '.hstop');
    assert.ok(await waitFor(async () => !(await hunting(page))), 'stopped');
    assert.ok(await waitFor(() => page.sent.includes('reward'), 4000), `sc then reward after the hunt stopped (${page.sent.join('|')})`);
    assert.equal(page.sent.filter(command => command === 'sc')[0], 'sc');
  } finally {
    page.close();
  }
});

ui('feature switch: the hunt row is hidden until the setting is switched on', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const line = () => panelRoot(page).querySelector('.hunt-line');
    assert.equal(line().hidden, true, 'off by default');
    setHuntFeature(page, true);
    assert.equal(line().hidden, false);
    setHuntFeature(page, false);
    assert.equal(line().hidden, true);
  } finally {
    page.close();
  }
});

ui('feature switch: switching it off stops a hunt that is running and closes the pick list', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: command => command === FIGHT });
    setHuntFeature(page, true);
    await pick(page, MOB);
    assert.equal(panelRoot(page).querySelector('.hunt-pick').hidden, false, 'the list is open');
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes(FIGHT), 4000));
    setHuntFeature(page, false);
    assert.equal(await hunting(page), false);
    assert.equal(panelRoot(page).querySelector('.hunt-pick').hidden, true);
    assert.match(huntText(page), /已在設定頁關閉/);
    const count = game.log.length;
    await sleep(300);
    assert.equal(game.log.length, count, 'nothing more is sent');
  } finally {
    page.close();
  }
});

ui('hunt: its own command gap is added between the commands it sends (walking and looking)', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapHuntSettings = { ...REQUIRED, commandGapMinMs: 3000, commandGapMaxMs: 3000 }; // 縮小 20 倍＝每個指令之間 0.15 秒
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a' });
    await pick(page, MOB);
    const started = Date.now();
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l']);
    assert.ok(Date.now() - started >= 280, `three commands need at least two gaps, took ${Date.now() - started} ms`);
  } finally {
    page.close();
  }
});

test('hunt settings: the gap fields (milliseconds) are checked, the longest gap is never below the shortest, and gapMs stays in range', () => {
  require('../../../catworld-auto-command/map-hunt.js');
  const { normalizeSettings, gapMs } = globalThis.CatworldMapHunt;
  assert.deepEqual([normalizeSettings({}).commandGapMinMs, normalizeSettings({}).commandGapMaxMs], [1000, 2000]);
  const swapped = normalizeSettings({ commandGapMinMs: 3000, commandGapMaxMs: 1000 });
  assert.equal(swapped.commandGapMaxMs, 3000);
  assert.equal(normalizeSettings({ commandGapMinMs: -1, commandGapMaxMs: 'x' }).commandGapMinMs, 1000);
  assert.equal(normalizeSettings({ commandGapMinMs: 250, commandGapMaxMs: 400 }).commandGapMinMs, 250, 'a few hundred milliseconds is allowed');
  assert.equal(normalizeSettings({ commandGapMinMs: 5000, commandGapMaxMs: 5000 }).commandGapMaxMs, 2000, 'over 3000 falls back to the default');
  assert.equal(gapMs({ commandGapMinMs: 1000, commandGapMaxMs: 3000 }, () => 0), 1000);
  assert.equal(gapMs({ commandGapMinMs: 1000, commandGapMaxMs: 3000 }, () => 0.5), 2000);
  assert.equal(gapMs({ commandGapMinMs: 0, commandGapMaxMs: 0 }), 0);
});

test('hunt settings: the old gap in seconds is converted to milliseconds, and the new fields win when both exist', () => {
  require('../../../catworld-auto-command/map-hunt.js');
  const { normalizeSettings } = globalThis.CatworldMapHunt;
  const old = normalizeSettings({ commandGapMinSec: 1, commandGapMaxSec: 2.5 });
  assert.deepEqual([old.commandGapMinMs, old.commandGapMaxMs], [1000, 2500]);
  assert.equal(old.commandGapMinSec, undefined, 'the old key is not kept');
  const zero = normalizeSettings({ commandGapMinSec: 0, commandGapMaxSec: 0 });
  assert.deepEqual([zero.commandGapMinMs, zero.commandGapMaxMs], [0, 0], 'a saved 0 keeps meaning no extra gap');
  const both = normalizeSettings({ commandGapMinSec: 1, commandGapMaxSec: 2, commandGapMinMs: 300, commandGapMaxMs: 500 });
  assert.deepEqual([both.commandGapMinMs, both.commandGapMaxMs], [300, 500]);
  assert.deepEqual([normalizeSettings({ commandGapMinSec: 9, commandGapMaxSec: 9 }).commandGapMinMs], [1000], 'an old value over the limit falls back to the default');
});

// 同一個房間有好幾隻 ID 一樣的怪（襄陽守軍 小隊長(guard)、中隊長(guard)、中隊長(guard)）：fight guard 會打第一隻，所以要用第幾個（guard 2）指定勾選的那一隻
ui('hunt: monsters sharing one id are told apart by their position in the room (fight 2), never by the id', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const CAPTAIN = '襄陽守軍 中隊長(guard)';
    const lines = ['  ※襄陽守軍 小隊長(guard) [fight][kill]', `  ※${CAPTAIN} [fight][kill]`, `  ※${CAPTAIN} [fight][kill]`, '  ※「郭家女婿」耶律齊(ya lu chi) [fight][kill]'];
    page.store.mapMonsters = mobsIn(CAPTAIN, 'c');
    page.store.mapHuntSettings = { ...page.store.mapHuntSettings, afterKillCommand: '' }; // 預設的 gc 在假遊戲裡會清掉第一隻怪，序號就跟著變
    const fights = [];
    world(page, {
      at: 'a',
      looks: { c: { lines } },
      script: (command, { say, looks }) => {
        const match = /^(?:fight|kill) (\d+)$/.exec(command);
        if (!match) return false;
        fights.push(command);
        looks.c.lines.splice(Number(match[1]) - 1, 1); // 第幾個 ※ 行的那一隻倒下
        say('中隊長死了。'); // 遊戲的戰鬥訊息只寫短名稱（不帶「襄陽守軍」）
        return true;
      },
    });
    await pick(page, CAPTAIN);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(fights, ['fight 2', 'fight 2'], 'both captains (the first at 2, then the second moved up to 2), never the squad leader at 1');
  } finally {
    page.close();
  }
});

ui('hunt: @巨集 N in a hunt command field is replaced by that game macro instead of being sent as text', async () => {
  const page = await boot({ scale: SCALE, preload: MEMORY_STORAGE });
  try {
    page.w.localStorage.setItem('MACROS', macroSlots(10, 'sit;stand'));
    page.store.mapHuntSettings = { ...page.store.mapHuntSettings, afterKillCommand: 'ride;@巨集 10' };
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.ok(await waitFor(() => game.log.includes('stand'), 4000), `the macro slot is sent: ${game.log}`);
    assert.ok(game.log.includes('ride') && game.log.includes('sit'), `ride then the slot: ${game.log}`);
    assert.ok(!game.log.some(command => command.includes('@巨集')), 'the reference itself never reaches the game');
    assert.ok(game.log.indexOf('ride') < game.log.indexOf('sit') && game.log.indexOf('sit') < game.log.indexOf('stand'), 'in order');
  } finally {
    page.close();
  }
});

ui('hunt: a @巨集 N that cannot be read is dropped with a note, and the other commands are still sent', async () => {
  const page = await boot({ scale: SCALE, preload: MEMORY_STORAGE });
  try {
    page.w.localStorage.setItem('MACROS', macroSlots(3, 'sit')); // 第 10 列是空的
    page.store.mapHuntSettings = { ...page.store.mapHuntSettings, afterKillCommand: 'ride;@巨集 10' };
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.ok(await waitFor(() => game.log.includes('ride'), 4000));
    assert.ok(!game.log.some(command => command.includes('@巨集')), 'the unreadable reference is not sent as text');
    assert.match(panelRoot(page).querySelector('.macro-text').textContent, /巡怪.*@巨集 10.*沒有指令/, 'the macro row says why');
  } finally {
    page.close();
  }
});

ui('chat: a chat reply in the middle of a hunt is a switch gap away from the hunt commands before and after it', async () => {
  const REPLY = 'reply 對啊出去走走';
  const page = await boot({ scale: SCALE, initialStore: { autoReward: false, chatReply: { enabled: true, threshold: 0.4, cooldownSec: 0, perHour: 100, delayMin: 0, delayMax: 0 }, chatPairs: [{ said: '今天天氣真好', reply: '對啊出去走走', at: 1 }] } });
  const times = [];
  const watcher = setInterval(() => { while (times.length < page.sent.length) times.push({ command: page.sent[times.length], at: Date.now() }); }, 2);
  try {
    page.store.mapMonsters = mobsAt('d');
    world(page, { at: 'a', looks: { d: { lines: [MOB_LINE] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => times.length >= 1, 5000), 'the hunt sends its first command');
    page.output('<span>[P]有氣質回答你：今天天氣不錯\n</span>');
    assert.ok(await waitFor(() => { const i = times.findIndex(item => item.command === REPLY); return i > 0 && i < times.length - 1; }, 15000), 'the reply goes out with a hunt command before and after it');
    const i = times.findIndex(item => item.command === REPLY);
    const min = 1500 / SCALE - 10; // 頁面計時器縮小 SCALE 倍，切換間隔下限的真實時間；計時器只會晚、不會早，所以只扣 10 ms 的誤差（沒有切換間隔時兩個指令只隔約 25～35 ms）
    assert.ok(times[i].at - times[i - 1].at >= min, 'before the reply: ' + (times[i].at - times[i - 1].at) + ' ms');
    assert.ok(times[i + 1].at - times[i].at >= min, 'after the reply: ' + (times[i + 1].at - times[i].at) + ' ms');
    assert.equal(await hunting(page), true, 'the hunt is still running');
    await page.ask({ type: 'STOP' });
  } finally {
    clearInterval(watcher);
    page.close();
  }
});

// ---- 路過的房間：抵達時印出勾選的怪就停下來打 ----
ui('passing: a chosen monster shown on arrival in a room that is not a target is fought there, and the walk goes on', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('d'); // 目標只有 d；b 不是目標，但怪重生在 b
    const game = world(page, { at: 'a', arrivals: { b: { lines: [MOB_LINE] } }, looks: { b: { lines: [MOB_LINE] }, d: { lines: [MOB_LINE] } }, script: (command, { looks }) => {
      if (command.startsWith('fight ')) looks[game.at]?.lines && (looks[game.at].lines = []);
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log.slice(0, 3), ['e', FIGHT, 'gc'], 'fought at b as soon as it arrived there, with no l: the arrival description that made it a target is also its look');
    assert.equal(countOf(game, FIGHT), 2, 'b on the way and d at the end');
    const { text } = await page.ask({ type: 'HUNT_LOG' });
    assert.match(text, /t\/b 路過 看到勾選的怪，加進目標/);
  } finally {
    page.close();
  }
});

ui('passing: a passed room with a player in it is skipped once and not looked at again, and the walk goes on', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('d');
    const game = world(page, { at: 'a', arrivals: { b: { lines: [MOB_LINE, PERSON('somebody')] } }, looks: { b: { lines: [MOB_LINE, PERSON('somebody')] }, d: { lines: [MOB_LINE] } }, fingers: { somebody: PLAYER_FINGER } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.equal(countOf(game, 'finger somebody'), 1, 'asked about the stranger once');
    assert.equal(game.log.filter(command => command === FIGHT).length, 1, 'only d was fought');
    assert.match(huntText(page), /b 有別人 somebody/);
  } finally {
    page.close();
  }
});

ui('passing: nothing changes when the arrival shows another monster, or no monster at all', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('d');
    const game = world(page, { at: 'a', arrivals: { b: { lines: ['  ※另一隻怪(other mob) [fight][kill]'] }, c: { lines: [] } }, looks: { d: { lines: [MOB_LINE] } }, script: (command, { looks }) => {
      if (command.startsWith('fight ')) looks.d.lines = [];
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'e', 'l', FIGHT, 'gc'], 'walked straight to d, looked there only');
  } finally {
    page.close();
  }
});

ui('hunt: a player who shows no status tag (not idle) still makes the room be skipped', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const NO_STATE_PLAYER = '  某某門派第十七代弟子「某某某」某某某(somebody)'; // 真實輸出的格式，名字換成假的
    const game = world(page, { at: 'a', looks: { c: { lines: [NO_STATE_PLAYER, MOB_LINE] } }, fingers: { somebody: PLAYER_FINGER } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.equal(countOf(game, 'finger somebody'), 1, 'asked about the stranger');
    assert.equal(game.log.some(command => command.startsWith('fight ')), false, 'no fight with a player in the room');
    assert.match(huntText(page), /c 有別人 somebody/);
  } finally {
    page.close();
  }
});

ui('verify: pressing verify sends alias once and answers with what the command expands to', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const game = world(page, { at: 'a', script: (command, { say: tell }) => {
      if (command === 'alias') { tell(ALIAS_LIST.split('== 未完')[0].trimEnd()); return true; } // 第一頁就有 f
      return false;
    } });
    const reply = await verify(page, 'f');
    assert.equal(reply.ok, true);
    assert.equal(reply.level, 'info');
    assert.match(reply.text, /「f」＝「fight \$1」/);
    assert.equal(countOf(game, 'alias'), 1, 'sent once');
    const warned = await verify(page, 'ar');
    assert.equal(warned.level, 'warn', 'an alias that is not fight is a warning');
    assert.equal(countOf(game, 'alias'), 2, 'each press reads the list again');
  } finally {
    page.close();
  }
});

ui('verify: no alias output at all gives an error that says the list could not be read', async () => {
  const page = await boot({ scale: SCALE });
  try {
    world(page, { at: 'a', script: command => command === 'alias' });
    const reply = await verify(page, 'f');
    assert.equal(reply.ok, true);
    assert.equal(reply.level, 'error');
    assert.match(reply.text, /讀不到別名列表/);
  } finally {
    page.close();
  }
});

ui('verify: refused while the hunt is running, and nothing is sent', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('d');
    page.store.mapHuntSettings = { ...REQUIRED, commandGapMinMs: 2000, commandGapMaxMs: 2000 };
    const game = world(page, { at: 'a' });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => hunting(page), 2000));
    const reply = await verify(page, 'f');
    assert.equal(reply.ok, false);
    assert.match(reply.error, /巡怪/);
    assert.equal(countOf(game, 'alias'), 0);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('verify paging: a two-page list is read whole with one Enter, and no q after a last page without the prompt', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const game = world(page, { at: 'a', script: (command, { say: tell }) => {
      if (command === 'alias') { tell(ALIAS_PAGE_1); return true; }
      if (command === '') { tell(ALIAS_PAGE_2); return true; }
      return false;
    } });
    const reply = await verify(page, 'wi');
    assert.match(reply.text, /「wi」＝「wield \$1」/, 'an alias from the second page was read');
    assert.deepEqual(game.log, ['alias', ''], 'one Enter and nothing else');
  } finally {
    page.close();
  }
});

ui('verify paging: a one-page list sends neither Enter nor q', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const game = world(page, { at: 'a', script: (command, { say: tell }) => {
      if (command === 'alias') { tell(ALIAS_PAGE_1.split('\n').filter(line => !line.includes('未完繼續')).join('\n')); return true; }
      return false;
    } });
    const reply = await verify(page, 'f');
    assert.match(reply.text, /「f」＝「fight \$1」/);
    assert.deepEqual(game.log, ['alias']);
  } finally {
    page.close();
  }
});

ui('verify paging: a list that never ends stops after 10 pages, sends q once and says why', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const game = world(page, { at: 'a', script: (command, { say: tell }) => {
      if (command === 'alias' || command === '') { tell(ALIAS_PAGE_1); return true; }
      return command === 'q';
    } });
    const reply = await verify(page, 'f');
    assert.match(reply.text, /超過 10 頁/);
    assert.match(reply.text, /「f」＝「fight \$1」/, 'the verdict on what was read is still given');
    assert.ok(await waitFor(() => game.log.includes('q'), 1000), 'q goes out (it is queued, so it may follow the reply)');
    await sleep(100);
    assert.deepEqual(game.log, ['alias', ...Array(9).fill(''), 'q']);
  } finally {
    page.close();
  }
});

ui('verify paging: stop-everything or the human verification during paging sends nothing more', async () => {
  for (const interrupt of ['stop', 'presence']) {
    const page = await boot({ scale: SCALE });
    try {
      const game = world(page, { at: 'a', script: (command, { say: tell }) => {
        if (command === 'alias') { tell(ALIAS_PAGE_1); return true; }
        if (command === '') {
          if (interrupt === 'stop') tell('jrealm 出現了');
          else page.w.document.getElementById('presence').classList.remove('invisible');
          tell(ALIAS_PAGE_1); // 遊戲還在分頁：又是一頁「未完繼續」
          return true;
        }
        return false;
      } });
      const reply = await verify(page, 'f');
      await sleep(300);
      assert.deepEqual(game.log, ['alias', ''], `${interrupt}: no further Enter and no q`);
      assert.equal(reply.ok, true, interrupt);
    } finally {
      page.close();
    }
  }
});

// 警報帶上帳號（角色名，取自分頁標題「角色名 - …」）：前一個警報還在閃標題（標題輪流換成提示字）時，下一個警報仍帶同一個名字
ui('alert: an alert carries the character name from the tab title, and a second one during the title flash still does', async () => {
  const page = await chainPage();
  try {
    page.w.document.title = '小明 - 貓的世界';
    chainWorld(page, { move: { 'go-t': ['t', 'a'] } });
    await page.ask({ type: 'HUNT_CHAIN_TRIAL' });
    assert.ok(await waitFor(() => alerts(page).length === 1, 8000), huntText(page));
    assert.equal(alerts(page)[0].character, '小明');
    page.w.document.title = '⚠ 巡怪已停止'; // 閃標題的那一半
    await page.ask({ type: 'HUNT_CHAIN_TRIAL' });
    assert.ok(await waitFor(() => alerts(page).length === 2, 8000), huntText(page));
    assert.equal(alerts(page)[1].character, '小明');
  } finally {
    page.close();
  }
});

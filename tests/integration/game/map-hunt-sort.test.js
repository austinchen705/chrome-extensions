// 地圖巡怪：map-hunt-sort（43 組；共用底座在 tests/helpers/map-hunt-world.js，整個 content script 在 jsdom 裡跑）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, sleep, waitFor } = require('../../helpers/game-page');
const {
  SCALE,
  REQUIRED,
  boot,
  MOB,
  mobsAt,
  world,
  panelRoot,
  pick,
  huntText,
  click,
  alerts,
  FIGHT,
  mobsLines,
  setKee,
  hunting,
  countOf,
  say,
  fakeClock,
  timeScript,
  at,
  roundPage,
  loadScript,
  loadPage,
  loadIntervalRun,
  scanClick,
  ARMOR,
  blockOf,
  sortPage,
  sortScript,
  sortState,
  herbBag,
  lookOut,
  SORT_GOLDEN,
  rideSort,
  noMedicineRun,
  dangerRun,
  huntLog,
} = require('../../helpers/map-hunt-world');

ui('load: after a fight it looks at i, and under the limit nothing else happens', async () => {
  const page = await loadPage({ tripCommand: 'go' });
  try {
    const state = { load: 40 };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: loadScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'i']);
    assert.match(await huntLog(page), /t\/c 負重 40%（上限 90%），繼續；打完 1 間再看/, 'every load reading is in the hunt log');
  } finally {
    page.close();
  }
});

ui('load: over the limit with no sort command written stops with an alert that says what to set', async () => {
  const page = await loadPage();
  try {
    const state = { load: 95 };
    world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: loadScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /填好「整理：前往整理處」/.test(message.reason)), 6000));
    assert.equal(await hunting(page), false);
    assert.match(await huntLog(page), /t\/c 負重 95%（上限 90%），沒填整理的指令，停止/);
  } finally {
    page.close();
  }
});

ui('load: 0 means it never looks at i, and an i that cannot be read does not stop the hunt', async () => {
  const off = await loadPage({ loadMaxPercent: 0 });
  try {
    const game = world(off, { at: 'a', looks: { c: { lines: mobsLines(1) } } });
    await pick(off, MOB);
    click(off, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(off)), 6000), huntText(off));
    assert.equal(game.log.includes('i'), false);
  } finally {
    off.close();
  }
  const unreadable = await loadPage({ tripCommand: 'sell' });
  try {
    const script = command => {
      if (command === 'i') { say(unreadable, '你身上帶著一些東西。'); return true; }
      return false;
    };
    const game = world(unreadable, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(unreadable, MOB);
    click(unreadable, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(unreadable)), 6000), huntText(unreadable));
    assert.equal(game.log.includes('sell'), false);
  } finally {
    unreadable.close();
  }
});

ui('load interval: it looks after the first room (load not known yet), then only every N rooms', async () => {
  assert.equal(await loadIntervalRun({ load: 40, settings: { loadCheckEveryMin: 3, loadCheckEveryMax: 3 } }), 'FiFFFiFF');
});

ui('load interval: N is drawn in the range each time (random at the top picks the most)', async () => {
  assert.equal(await loadIntervalRun({ load: 40, settings: { loadCheckEveryMin: 2, loadCheckEveryMax: 4 }, random: 0.99 }), 'FiFFFFiF');
});

ui('load interval: 1-1 looks after every room, as before', async () => {
  assert.equal(await loadIntervalRun({ load: 40, settings: { loadCheckEveryMin: 1, loadCheckEveryMax: 1 } }), 'FiFiFiFiFiFi');
});

ui('load interval: when the last load is at or over the safety line it looks after every room; 0 turns the safety line off', async () => {
  assert.equal(await loadIntervalRun({ load: 85, settings: { loadCheckEveryMin: 3, loadCheckEveryMax: 3, loadAlwaysPercent: 80 } }), 'FiFiFiFiFiFi');
  assert.equal(await loadIntervalRun({ load: 85, settings: { loadCheckEveryMin: 3, loadCheckEveryMax: 3, loadAlwaysPercent: 0 } }), 'FiFFFiFF');
});

ui('load interval: a room where nothing was fought does not count', async () => {
  assert.equal(await loadIntervalRun({ load: 40, settings: { loadCheckEveryMin: 2, loadCheckEveryMax: 2 }, mobRooms: ['b', 'd', 'e'], recorded: ['b', 'c', 'd', 'e'] }), 'FiFFi');
});

ui('sort: over the limit it goes, identifies, marks the good armor, sells, comes back and keeps hunting', async () => {
  const page = await sortPage();
  try {
    const state = sortState();
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'i', 'go', 'identify', 'i', 'secure black armor', 'sell all', 'back', 'i']);
    assert.deepEqual(state.secured, ['black armor'], 'only the identified good armor; the marked tea and the worn cloth are left alone, the gloves are sold');
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

// 隔幾間才看負重時，整理回來仍然馬上看一次（不經間數）
ui('sort: with a load check every 3 rooms it still looks at i right after coming back from sorting', async () => {
  const page = await sortPage({ loadCheckEveryMin: 3, loadCheckEveryMax: 3 });
  try {
    const state = sortState();
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(game.log.slice(-2), ['back', 'i']);
  } finally {
    page.close();
  }
});

// 賣完停留（sortLookMinSec～sortLookMaxSec）：sell all 之後先停一會、中間送一次 i，再送回程；測試共用設定是 0～0
ui('sort: after selling it stays a while and checks the inventory once before going back', async () => {
  const page = await sortPage({ sortLookMinSec: 40, sortLookMaxSec: 40 });
  try {
    const state = sortState();
    const times = {};
    const script = sortScript(page, state);
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: (command, ctx) => { (times[command] ??= []).push(Date.now()); return script(command, ctx); } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 15000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'i', 'go', 'identify', 'i', 'secure black armor', 'sell all', 'i', 'back', 'i']);
    const waited = (times.back[0] - times['sell all'][0]) * SCALE;
    assert.ok(waited >= 38000, `stayed about 40 s (scaled) before going back, got ${waited}`);
  } finally {
    page.close();
  }
});

ui('sort: with an alt ID the good armor is given to the alt instead of marked, then everything else is sold', async () => {
  const page = await sortPage({ altId: 'mukoda' });
  try {
    const state = sortState();
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(state.given, ['give black armor to mukoda']);
    assert.deepEqual(state.secured, []);
    assert.ok(game.log.indexOf('give black armor to mukoda') < game.log.indexOf('sell all'), 'given before selling');
  } finally {
    page.close();
  }
});

ui('sort: sell-everything mode skips the inventory and marking and sells right after the trip', async () => {
  const page = await sortPage({ sortKeep: 'none', altId: 'mukoda' });
  try {
    const state = sortState();
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'i', 'go', 'identify', 'sell all', 'back', 'i']);
    assert.deepEqual(state.secured, []);
    assert.deepEqual(state.given, []);
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('sort: items to always give to the alt go one per unit before selling, in keep mode', async () => {
  const page = await sortPage({ altId: 'mukoda', giveItems: 'Unknown Herb、unknown object' });
  try {
    const state = sortState({ bag: herbBag });
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(state.given, ['give black armor to mukoda', 'give Unknown Herb to mukoda', 'give Unknown Herb to mukoda', 'give unknown object to mukoda']);
    assert.ok(game.log.lastIndexOf('give unknown object to mukoda') < game.log.indexOf('sell all'), 'given before selling');
  } finally {
    page.close();
  }
});

ui('sort: sell-everything mode also gives the listed items first, and reads the inventory only for that', async () => {
  const page = await sortPage({ sortKeep: 'none', altId: 'mukoda', giveItems: 'unknown herb、unknown object' });
  try {
    const state = sortState({ bag: herbBag });
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'i', 'go', 'identify', 'i', 'give unknown herb to mukoda', 'give unknown herb to mukoda', 'give unknown object to mukoda', 'sell all', 'back', 'i']);
  } finally {
    page.close();
  }
});

ui('sort: without an alt ID the listed items are secured by line', async () => {
  const page = await sortPage({ sortKeep: 'none', giveItems: 'unknown herb' });
  try {
    const state = sortState({ bag: herbBag });
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(state.secured, ['unknown herb']);
    assert.deepEqual(state.given, []);
  } finally {
    page.close();
  }
});

ui('sort: a give the game does not confirm stops with an alert and sells nothing', async () => {
  const page = await sortPage({ altId: 'mukoda' });
  try {
    const state = sortState({ giveReply: '你身上沒有這樣東西。' });
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /轉給小號 黑羽長風鎧 沒成功/.test(message.reason)), 8000), JSON.stringify(alerts(page)));
    assert.equal(game.log.includes('sell all'), false);
    assert.equal(await hunting(page), false);
  } finally {
    page.close();
  }
});

ui('sort: armor that is worse than what is worn is sold, not kept', async () => {
  const page = await sortPage();
  try {
    page.store.wornEquipment = { 小明: { 盔甲類防具: [{ name: '舊甲', primary: 99, attrs: [], needExp: null, readAt: 1 }] } };
    const state = sortState();
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(state.secured, []);
    assert.ok(game.log.includes('sell all'));
  } finally {
    page.close();
  }
});

ui('sort: armor with no baseline (worn equipment never read) is sold, not kept', async () => {
  const page = await sortPage();
  try {
    delete page.store.wornEquipment;
    const state = sortState();
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(state.secured, []);
    assert.ok(game.log.includes('sell all'));
  } finally {
    page.close();
  }
});

ui('sort: a weapon is kept only when it is the main weapon type', async () => {
  const page = await sortPage();
  try {
    page.store.mainWeapon = '劍';
    const state = sortState({ block: '此物名曰 ：牛皮拳套，拳套類武器\n    傷害力：30/30\n    佩帶條件：經驗 100\n' });
    world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(state.secured, [], 'a glove is not a sword');
  } finally {
    page.close();
  }
});

// 整理留了什麼、為什麼留、送了什麼 secure、遊戲怎麼回，都寫進巡怪紀錄：留錯東西時複製紀錄就看得出是篩選、還是 secure 打到別件
ui('sort: the hunt log says which identified items were kept and why, the main weapon type, and each secure with the game reply', async () => {
  const page = await sortPage();
  try {
    page.store.mainWeapon = '暗器';
    const state = sortState({ block: `${blockOf(ARMOR)}此物名曰 ：牛皮拳套，拳套類武器\n    傷害力：30/30\n    佩帶條件：經驗 100\n` });
    world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    const log = await huntLog(page);
    assert.match(log, /整理 鑑定 2 件，主要武器 暗器；留下：黑羽長風鎧（盔甲類防具，比現在好，建議留下）/);
    assert.match(log, /整理 secure black armor（黑羽長風鎧）→ 標記完成。/);
    assert.ok(!/留下：[^\n]*牛皮拳套/.test(log), 'the glove is not kept');
  } finally {
    page.close();
  }
});

ui('sort: when the over-the-limit choice is stop, it stops with an alert and goes nowhere', async () => {
  const page = await sortPage({ overloadAction: 'stop' });
  try {
    const state = sortState();
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /負重 95%.*已停止/.test(message.reason)), 10000), JSON.stringify(alerts(page)));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'i']);
    assert.equal(countOf(game, 'sell all'), 0);
  } finally {
    page.close();
  }
});

ui('sort: still over the limit after selling stops with an alert instead of going again', async () => {
  const page = await sortPage();
  try {
    const state = sortState();
    const script = sortScript(page, state);
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: (command, env) => { const handled = script(command, env); if (command === 'sell all') state.load = 95; return handled; } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /整理完負重還是 95%/.test(message.reason)), 10000), JSON.stringify(alerts(page)));
    assert.equal(countOf(game, 'sell all'), 1);
  } finally {
    page.close();
  }
});

ui('sort: coming back to a room that is not on this area stops with an alert', async () => {
  const page = await sortPage();
  try {
    const state = sortState({ backTo: 'nowhere' });
    world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /回程後不在 t 這一區/.test(message.reason)), 10000), JSON.stringify(alerts(page)));
  } finally {
    page.close();
  }
});

ui('sort: more sorts than the hourly limit stops with an alert', async () => {
  const page = await sortPage({ sortPerHour: 1 });
  try {
    page.store.mapMonsters = mobsAt('c', 'd');
    const state = sortState({ afterFight: 95 });
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) }, d: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /一小時內已經整理 1 次/.test(message.reason)), 15000), JSON.stringify(alerts(page)));
    assert.equal(countOf(game, 'sell all'), 1);
  } finally {
    page.close();
  }
});

ui('ride: the panel button records the room the character stands in, shows it is recorded, and a second press removes it', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const none = panelRoot(page).querySelector('.hride');
    click(page, '.hride');
    assert.ok(await waitFor(() => /讀不到目前的房間/.test(huntText(page)), 2000), 'no map: says why');
    const game = world(page, { at: 'b' });
    click(page, '.hride');
    assert.ok(await waitFor(() => page.store.mapHuntRideRooms?.t?.includes('t/b'), 2000));
    assert.ok(await waitFor(() => none.textContent === '可 ride ✓', 3000), none.textContent);
    assert.match(huntText(page), /已記 t\/b/);
    game.at = 'c';
    assert.ok(await waitFor(() => none.textContent === '可 ride', 3000), 'another room is not recorded');
    click(page, '.hride');
    assert.ok(await waitFor(() => page.store.mapHuntRideRooms?.t?.join() === 't/b,t/c', 2000), JSON.stringify(page.store.mapHuntRideRooms));
    click(page, '.hride');
    assert.ok(await waitFor(() => page.store.mapHuntRideRooms?.t?.join() === 't/b', 2000), JSON.stringify(page.store.mapHuntRideRooms));
    assert.match(huntText(page), /已取消 t\/c/);
  } finally {
    page.close();
  }
});

ui('ride: over the limit it walks to the nearest ride room of this area before the trip command', async () => {
  const run = await rideSort({ rides: { t: ['t/a', 't/d'] } });
  assert.deepEqual(run.log, ['e', 'e', 'l', FIGHT, 'gc', 'i', 'e', 'go', 'identify', 'i', 'secure black armor', 'sell all', 'back', 'i']);
  assert.match(run.text, /撤退.*t\/d.*整理/);
  assert.equal(run.alerts.length, 0);
});

ui('ride: standing on a ride room, or no ride room in this area, sends the trip command right there as before', async () => {
  assert.deepEqual((await rideSort({ rides: { t: ['t/c'] } })).log, SORT_GOLDEN);
  assert.deepEqual((await rideSort({ rides: { u: ['u/x'] } })).log, SORT_GOLDEN, 'ride rooms of another area do not count');
});

ui('ride: a ride room it cannot reach stops with an alert and sends no trip command', async () => {
  const offMap = await rideSort({ rides: { t: ['t/z'] }, until: page => alerts(page).length > 0 });
  assert.match(offMap.alerts[0].reason, /可 ride/);
  assert.match(offMap.text, /撤退\s+失敗：沒有路線/);
  assert.equal(offMap.log.includes('go'), false);
  const blocked = await rideSort({ rides: { t: ['t/a'] }, moves: { a: { e: 'b' }, b: { w: 'a', e: 'c' }, c: { e: 'd' }, d: { w: 'c' } }, until: page => alerts(page).length > 0 });
  assert.match(blocked.alerts[0].reason, /可 ride/);
  assert.ok(blocked.log.includes('w'), 'it tried to walk');
  assert.equal(blocked.log.includes('go'), false);
});

ui('ride: stopping while it walks to the ride room sends nothing more', async () => {
  const run = await rideSort({
    rides: { t: ['t/a'] },
    moves: { a: { e: 'b' }, b: { w: 'a', e: 'c' }, c: { e: 'd' }, d: { w: 'c' } },
    until: () => true,
    during: async (page, game) => {
      assert.ok(await waitFor(() => game.log.includes('w'), 8000), game.log.join(','));
      click(page, '.hstop');
      await sleep(1500);
      assert.equal(game.log.includes('go'), false);
    },
  });
  assert.equal(run.alerts.length, 0);
});

ui('ride: in fight-only mode the sort also walks to the ride room first', async () => {
  const page = await sortPage({ fightMode: 'assist', eatCommand: '', noMedicineKeyword: '', fightTimeoutSec: 5 });
  try {
    page.store.mapHuntRideRooms = { t: ['t/d'] };
    const state = sortState({ load: 40 });
    const looks = { c: { lines: mobsLines(1) } };
    const base = sortScript(page, state);
    let fights = 0;
    const game = world(page, { at: 'a', looks, script: (command, env) => {
      if (command.startsWith('fight ')) {
        fights += 1;
        if (fights === 1) setTimeout(() => { state.load = 95; say(page, '你身上帶著下列這些東西( 載重 95% ):\n    布條(cloth piece)'); }, 50);
        else { looks.c.lines.length = 0; setTimeout(() => lookOut(page), 50); }
        return true;
      }
      return base(command, env);
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes('go'), 15000), game.log.join(','));
    const go = game.log.indexOf('go');
    assert.deepEqual(game.log.slice(go - 2, go), ['i', 'e'], game.log.join(','));
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('ride: with no medicine it walks back to the ride room, then goes home and stops with one alert', async () => {
  const run = await noMedicineRun({ rides: { t: ['t/a'] } });
  assert.equal(run.recallAt, 'a', run.log.join(','));
  assert.ok(run.log.includes('w'), run.log.join(','));
  assert.match(run.text, /撤退.*為了沒藥回家.*t\/a/);
  assert.equal(run.alerts.length, 1);
  assert.match(run.alerts[0].reason, /沒藥/);
  assert.equal(run.on, false);
});

ui('ride: with no medicine and no ride room in this area it goes home right there as before', async () => {
  const run = await noMedicineRun({ rides: { u: ['u/x'] } });
  assert.ok(run.recallAt === 'c' || run.recallAt === 'd', `home right where it was (${run.recallAt})`);
  assert.equal(run.log.includes('w'), false);
  assert.equal(run.alerts.length, 1);
});

ui('ride: with no medicine and a ride room it cannot reach, it stops with an alert and sends no home command', async () => {
  const run = await noMedicineRun({ rides: { t: ['t/a'] }, moves: { a: { e: 'b' }, b: { w: 'a', e: 'c' }, c: { e: 'd' }, d: { w: 'c' } } });
  assert.match(run.alerts[0].reason, /可 ride/);
  assert.match(run.text, /撤退\s+失敗/);
  assert.equal(run.log.includes('recall'), false);
  assert.equal(run.on, false);
});

ui('ride: a step sent just before no medicine that does not go through is walked around toward the ride room, not taken as a failed retreat', async () => {
  // c 往東走不過去：沒藥時重送的那一步（e）已經送出、會逾時；撤退開始時重送次數歸零，所以逾時後重新規劃、從 c 走回 a，不當成撤退失敗
  let steps = 0; // 第四個 e 是重送的那一步，送出它的同時氣掉下來
  const run = await noMedicineRun({ rides: { t: ['t/a'] }, moves: { a: { e: 'b' }, b: { w: 'a', e: 'c' }, c: { w: 'b' }, d: { w: 'c' } }, dropOn: command => command === 'e' && (steps += 1) === 4 });
  assert.equal(run.recallAt, 'a', run.log.join(','));
  assert.equal(run.alerts.length, 1);
  assert.match(run.alerts[0].reason, /沒藥/);
});

ui('ride: no medicine while waiting for the respawn in the hunting area walks to the ride room before going home', async () => {
  // 待命指令 goc 把人從 ride 格子 a 帶到 c（還在巡怪地圖上）
  const page = await roundPage({ standbyCommand: 'goc' });
  try {
    page.store.mapHuntRideRooms = { t: ['t/a'] };
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    let recallAt = null;
    const game = world(page, { at: 'a', looks: { c: { lines: [] } }, script: timeScript(page, clock, (command, { game: state }) => {
      if (command === 'goc') { state.at = 'c'; return false; }
      if (command === 'eat pill') { say(page, '你身上沒有藥了。'); return true; }
      if (command === 'recall') recallAt = state.at;
      return false;
    }) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /等下一個重生/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log.slice(game.log.indexOf('l') + 1, game.log.indexOf('goc') + 1), ['w', 'w', 'goc'], 'the round end walked to the ride room before the standby command');
    setKee(page, 30);
    assert.ok(await waitFor(() => game.log.includes('recall'), 5000), game.log.join(','));
    assert.equal(recallAt, 'a', game.log.join(','));
    assert.deepEqual(game.log.slice(game.log.indexOf('eat pill')).filter(command => command !== 'eat pill'), ['w', 'w', 'recall']);
    assert.equal(await hunting(page), false);
  } finally {
    page.close();
  }
});

ui('ride: no medicine during a fight stops fighting and walks to the ride room', async () => {
  const run = await noMedicineRun({ rides: { t: ['t/a'] }, fightFirst: true });
  assert.equal(countOf({ log: run.log }, FIGHT), 1, run.log.join(','));
  assert.equal(run.recallAt, 'a', run.log.join(','));
});

ui('ride: under the danger line in a fight it stops fighting, walks to the ride room without resting, then goes home and stops', async () => {
  const run = await dangerRun({ rides: { t: ['t/a'] } });
  assert.equal(run.recallAt, 'a', run.log.join(','));
  assert.deepEqual(run.log.slice(run.log.indexOf(FIGHT)), [FIGHT, 'w', 'w', 'recall'], 'no more fight commands, no rest command on the way');
  assert.equal((run.text.match(/為了危險線回家/g) ?? []).length, 1, 'the qi staying under the line does not start a second retreat');
  assert.equal(run.alerts.length, 1);
  assert.match(run.alerts[0].reason, /戰鬥中氣只剩/);
  assert.equal(run.on, false);
});

ui('ride: under the danger line with a ride room it cannot reach (the game may refuse to move in a fight) it stops with an alert and sends no home command', async () => {
  const run = await dangerRun({ rides: { t: ['t/a'] }, moves: { a: { e: 'b' }, b: { w: 'a', e: 'c' }, c: {}, d: { w: 'c' } } });
  assert.match(run.alerts[0].reason, /可 ride/);
  assert.equal(run.log.includes('recall'), false);
  assert.equal(run.on, false);
});

ui('ride: under the danger line with no ride room in this area it goes home right there as before', async () => {
  const run = await dangerRun({ rides: {} });
  assert.equal(run.recallAt, 'c');
  assert.equal(run.log.includes('w'), false);
});

ui('ride: a kill command still waiting in the queue when the danger line hits in a fight is dropped, not sent on the way', async () => {
  // 拒戰句讓巡怪改送 kill；指令間隔拉長，kill 還在排隊時氣已經掉到危險線
  const run = await dangerRun({ rides: { t: ['t/a'] }, settings: { commandGapMinMs: 3000, commandGapMaxMs: 3000 }, onFight: page => say(page, '測試怪並不想跟你較量。') });
  assert.deepEqual(run.log.slice(run.log.indexOf(FIGHT)), [FIGHT, 'w', 'w', 'recall'], run.log.join(','));
});

ui('ride: in fight-only mode a fight held back by the reaction time is not sent once a retreat has started', async () => {
  // 看完房間、fight 在等反應時間時氣掉到危險線，角色又忙碌（只下 fight 的等待不會被清掉）；反應時間到了也不能送 fight
  const run = await dangerRun({ rides: { t: ['t/a'] }, assist: true, settings: { reactMinMs: 3000, reactMaxMs: 3000 }, onLook: page => setTimeout(() => {
    setKee(page, 10);
    const doc = page.w.document;
    if (!doc.getElementById('status')) doc.body.insertAdjacentHTML('beforeend', '<span id="status"></span>');
    const status = doc.getElementById('status');
    status.textContent = '忙碌';
    setTimeout(() => { status.textContent = '正常'; }, 400);
  }, 30) });
  assert.equal(run.log.includes(FIGHT), false, run.log.join(','));
  assert.equal(run.recallAt, 'a', run.log.join(','));
});

ui('ride: under the danger line in fight-only mode it walks to the ride room first', async () => {
  const run = await dangerRun({ rides: { t: ['t/a'] }, assist: true });
  assert.equal(run.recallAt, 'a', run.log.join(','));
  assert.match(run.alerts[0].reason, /氣只剩/);
});

ui('ride: under the danger line while scanning it walks to the ride room first', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapHuntSettings = { ...REQUIRED, dangerBelow: 20, homeCommand: 'recall' };
    page.store.mapHuntRideRooms = { t: ['t/b'] };
    setKee(page, 10);
    let recallAt = null;
    const game = world(page, { at: 'a', script: (command, { game: state }) => { if (command === 'recall') recallAt = state.at; return false; } });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => game.log.includes('recall'), 4000), huntText(page));
    assert.equal(recallAt, 'b', game.log.join(','));
    assert.equal(await hunting(page), false);
    assert.equal(alerts(page).length, 1);
  } finally {
    page.close();
  }
});

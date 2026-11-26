// 地圖巡怪：找書生模式（start({ scholar: true })，面板「找書生」；共用底座在 tests/helpers/map-hunt-world.js，整個 content script 在 jsdom 裡跑）。
// 書生助手（跟隨、給物品）的流程在 scholar.test.js，這裡只測引擎：戶外格子、時間窗、遇到書生停步、助手關了就停。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ui, sleep, waitFor } = require('../../helpers/game-page');
const {
  SCALE,
  REQUIRED,
  boot,
  world,
  panelRoot,
  huntText,
  click,
  hunting,
  say,
  fakeClock,
  timeScript,
  at,
  lookTimer,
  huntLog,
  pick,
  mobsAt,
  MOB,
  MOB_LINE,
  FIGHT,
  addOtherArea,
  ZOMBIE,
  ZOMBIE_FIGHTING,
  ATTACK_LINE,
} = require('../../helpers/map-hunt-world');

const sample = name => fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'scholar', `${name}.txt`), 'utf8');
const SCHOLAR_LINE = '  ※落魄書生(dire scholar)';
const FOLLOWED = '你決定開始跟隨落魄書生一起行動。';
const VANISH = '落魄書生突然身形一晃，便漸漸消逸了。';
const WEATHER = '晴空萬里。';
const START = '2026-11-04T10:00:00+08:00';
const helperButton = page => panelRoot(page).querySelector('.sbtn');
const helperText = page => panelRoot(page).querySelector('.scholar-text');
const withoutTime = game => game.log.filter(command => command !== 'time');

// outdoor：{ 房間: true|false }，預設的戶外／室內紀錄（mapOutdoor）；a、c、d 是戶外就在 looks 裡帶天氣句，讓巡的時候讀到的和記的一致
async function scholarPage({ outdoor, settings = {} }) {
  const page = await boot({ scale: SCALE });
  page.w.document.title = '山本由伸 - 小貓的世界';
  page.store.mapOutdoor = Object.fromEntries(Object.entries(outdoor).map(([room, flag]) => [`t/${room}`, { outdoor: flag, at: 1 }]));
  page.store.mapHuntSettings = { ...REQUIRED, standbyCommand: 'home', scholarWindowSec: 90, ...settings };
  return page;
}
const looksOf = (outdoor, extra = {}) => Object.fromEntries(Object.keys(outdoor).map(room => [room, { ...(outdoor[room] ? { weather: WEATHER } : {}), ...extra[room] }]));

// 假遊戲的 sc、sk（開始前檢查）與 follow dire（跟隨）
function helperGame(page, { sc = 'sc-spirit-31', sk = 'sk-28' } = {}) {
  const pages = ['sk-page2'];
  page.w.document.getElementById('f').addEventListener('submit', () => {
    const command = page.w.document.getElementById('input').value;
    if (command === 'sc' && sc) say(page, sample(sc));
    if (command === 'sk' && sk) say(page, sample(sk));
    if (command === '' && pages.length) say(page, sample(pages.shift()));
    if (command === 'follow dire') say(page, FOLLOWED);
  });
}
async function helperOn(page) {
  helperGame(page);
  helperButton(page).click();
  assert.ok(await waitFor(() => helperButton(page).classList.contains('on'), 6000), helperText(page).textContent);
}

// 假時鐘要在送出任何指令之前就換上（送出佇列用 Date.now 算間隔），所以先用早一小時的時鐘打開書生助手，再把伺服器時間撥到要的時刻
async function clockedHelper(page, startServer, scale) {
  const clock = fakeClock(page, new Date(Date.parse(startServer) - 3600 * 1000).toISOString(), { scale });
  await helperOn(page);
  clock.jump += Date.parse(startServer) - clock.server();
  return clock;
}

ui('find scholar: a area without any outdoor record is refused with a hint to scan it first, and nothing is walked or sent', async () => {
  const outdoor = { a: false, b: false, c: false, d: false };
  const page = await scholarPage({ outdoor });
  try {
    await helperOn(page);
    const game = world(page, { at: 'a', looks: looksOf(outdoor) });
    click(page, '.hscholar');
    assert.ok(await waitFor(() => /這一區還沒有戶外格子的紀錄，先掃描這一區/.test(huntText(page)), 3000), huntText(page));
    assert.equal(await hunting(page), false);
    assert.deepEqual(game.log, []);
  } finally {
    page.close();
  }
});

ui('find scholar: with the helper off the button runs the helper check (sc, sk) first, then starts', async () => {
  const outdoor = { a: true, b: false, c: true, d: false };
  const page = await scholarPage({ outdoor });
  try {
    helperGame(page);
    const clock = fakeClock(page, START, { scale: 1 });
    const game = world(page, { at: 'a', looks: looksOf(outdoor), script: timeScript(page, clock) });
    click(page, '.hscholar');
    assert.ok(await waitFor(() => game.log.includes('l'), 8000), game.log.join());
    assert.ok(helperButton(page).classList.contains('on'));
    assert.deepEqual(game.log.slice(0, 4), ['sc', 'sk', '', 'time']);
    assert.equal(await hunting(page), true);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('find scholar: when the helper check fails it does not start', async () => {
  const outdoor = { a: true, b: false, c: true, d: false };
  const page = await scholarPage({ outdoor });
  try {
    helperGame(page, { sc: null, sk: null });
    const game = world(page, { at: 'a', looks: looksOf(outdoor) });
    click(page, '.hscholar');
    assert.ok(await waitFor(() => /讀不到 sc/.test(helperText(page).textContent), 8000), helperText(page).textContent);
    assert.equal(await hunting(page), false);
    assert.deepEqual(game.log, ['sc']);
  } finally {
    page.close();
  }
});

ui('find scholar: it walks only the outdoor rooms, reads the description only, and sends the standby command when the window is over', async () => {
  const outdoor = { a: true, b: false, c: true, d: false };
  const page = await scholarPage({ outdoor });
  try {
    const clock = await clockedHelper(page, START, 60);
    const looks = [];
    let homeAt = null;
    const game = world(page, { at: 'a', looks: looksOf(outdoor), script: timeScript(page, clock, command => {
      lookTimer(clock, looks)(command);
      if (command === 'home') homeAt = clock.server();
      return false;
    }) });
    click(page, '.hscholar');
    assert.ok(await waitFor(() => homeAt !== null, 6000), withoutTime(game).join());
    assert.deepEqual(withoutTime(game), ['l', 'e', 'e', 'l', 'home'], 'reads a, walks through the indoor b to c and reads it; no finger, fight or gc; d (indoor) is never visited');
    assert.ok(homeAt >= at('10:01:30'), `standby only after the 90 s window (${new Date(homeAt).toISOString()})`);
    assert.ok(looks[looks.length - 1] < at('10:01:30'));
    assert.ok(await waitFor(() => /等下一個重生 10:15/.test(huntText(page)), 4000), huntText(page));
    const log = await huntLog(page);
    assert.match(log, /找書生 時間窗開始（90 秒.*戶外格子 2 間：t\/a t\/c/);
    assert.match(log, /t\/a 找書生 這間沒有書生/);
    assert.match(log, /t\/c 找書生 這間沒有書生/);
    assert.match(log, /找書生 戶外格子都看過了，等時間窗結束/);
    assert.match(log, /這次重生沒遇到書生/);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('find scholar: started outside a window it waits for the respawn first, then walks', async () => {
  const outdoor = { a: true, b: false, c: true, d: false };
  const page = await scholarPage({ outdoor, settings: { scholarWindowSec: 120 } });
  try {
    const clock = await clockedHelper(page, '2026-11-04T10:14:00+08:00', 120);
    const looks = [];
    const game = world(page, { at: 'a', looks: looksOf(outdoor), script: timeScript(page, clock, lookTimer(clock, looks)) });
    click(page, '.hscholar');
    assert.ok(await waitFor(() => /等下一個重生 10:15/.test(huntText(page)), 3000), huntText(page));
    assert.equal(game.log.includes('l'), false, 'nothing is read before the respawn');
    assert.ok(await waitFor(() => looks.length >= 1, 6000), game.log.join());
    assert.ok(looks[0] >= at('10:15:00'), new Date(looks[0]).toISOString());
    assert.ok(looks[0] < at('10:15:50'), new Date(looks[0]).toISOString());
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('find scholar: a scholar in a room stops the walk until the helper is idle again, then the standby command is sent', async () => {
  const outdoor = { a: true, b: false, c: true, d: true };
  const page = await scholarPage({ outdoor, settings: { scholarWindowSec: 900 } });
  try {
    const clock = await clockedHelper(page, START, 60);
    const game = world(page, { at: 'a', looks: looksOf(outdoor, { c: { lines: [SCHOLAR_LINE] } }), script: timeScript(page, clock) });
    click(page, '.hscholar');
    assert.ok(await waitFor(() => game.log.includes('follow dire'), 6000), game.log.join());
    assert.ok(await waitFor(() => /遇到書生，等書生助手處理完/.test(huntText(page)), 3000), huntText(page));
    await sleep(800);
    assert.deepEqual(withoutTime(game), ['l', 'e', 'e', 'l', 'follow dire'], 'stopped in c: no step towards d and no standby command while the scholar is being followed');
    assert.equal(game.log.includes('home'), false);
    say(page, VANISH);
    assert.ok(await waitFor(() => game.log.includes('home'), 4000), game.log.join());
    assert.deepEqual(withoutTime(game).slice(-2), ['follow none', 'home']);
    assert.equal(game.log.filter(command => command === 'e').length, 2, 'never went on to d');
    const log = await huntLog(page);
    assert.match(log, /t\/c 找書生 遇到書生（/);
    assert.match(log, /這次重生遇到書生，處理完了/);
    assert.ok(await waitFor(() => /等下一個重生 10:15/.test(huntText(page)), 4000), huntText(page));
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('find scholar: the helper turned off while it runs finishes the mode with a clear message', async () => {
  const outdoor = { a: true, b: false, c: true, d: false };
  const page = await scholarPage({ outdoor, settings: { scholarWindowSec: 900 } });
  try {
    const clock = await clockedHelper(page, START, 60);
    world(page, { at: 'a', looks: looksOf(outdoor), script: timeScript(page, clock) });
    click(page, '.hscholar');
    assert.ok(await waitFor(() => /戶外格子都看過了，等時間窗結束/.test(huntText(page)), 6000), huntText(page));
    helperButton(page).click();
    assert.ok(await waitFor(() => /書生助手關了（解滿六脈或手動關閉），已停止找書生/.test(huntText(page)), 3000), huntText(page));
    assert.equal(await hunting(page), false);
  } finally {
    page.close();
  }
});

ui('find scholar: a monster that attacks on the way is fought back as in a normal hunt (special only, no kill), and the walk goes on without fighting anything else', async () => {
  const outdoor = { a: true, b: false, c: true, d: false };
  const page = await scholarPage({ outdoor, settings: { scholarWindowSec: 900, specialCommand: 'sp', specialIntervalSec: 1 } });
  try {
    const clock = await clockedHelper(page, START, 60);
    const base = timeScript(page, clock);
    const game = world(page, { at: 'a', arrivals: { b: { lines: [ZOMBIE, ATTACK_LINE] } }, looks: { ...looksOf(outdoor), b: { lines: [ZOMBIE_FIGHTING] } }, script: (command, ...rest) => {
      const { looks, say: tell } = rest[0];
      if (command === 'sp' && game.at === 'b') { looks.b.lines = ['  腐屍的屍體(corpse) [sac]']; tell('腐屍死了。'); return true; }
      if (command === 'gc') { looks[game.at].lines = (looks[game.at].lines ?? []).filter(line => !line.includes('屍體')); return true; }
      return base(command, ...rest);
    } });
    click(page, '.hscholar');
    assert.ok(await waitFor(() => /戶外格子都看過了，等時間窗結束/.test(huntText(page)), 8000), `${huntText(page)} ${game.log.join()}`);
    assert.ok(game.log.includes('sp'), 'fought back in b ' + game.log.join());
    assert.equal(game.log.filter(command => /^(fight|kill)/.test(command)).length, 0, game.log.join());
    assert.equal(game.at, 'c', 'then walked on to the outdoor target');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

// ---- 一般巡怪中遇到書生（票 08）：助手開著時暫停，助手處理完才接著巡 ----
// 巡 c、d 兩間有怪的房間；走到非目標的 b 時，抵達描述有書生
async function huntWithScholar({ settings = {}, script = () => false } = {}) {
  const page = await scholarPage({ outdoor: {}, settings });
  page.store.mapMonsters = mobsAt('c', 'd');
  await helperOn(page);
  const game = world(page, {
    at: 'a',
    arrivals: { b: { lines: [SCHOLAR_LINE] } },
    looks: { c: { lines: [MOB_LINE] }, d: { lines: [MOB_LINE] } },
    script,
  });
  addOtherArea(page, game);
  await pick(page, MOB);
  click(page, '.hstart');
  return { page, game };
}

ui('hunt with the helper on: a scholar on the way pauses the hunt (no move, fight or loot) until the helper is idle, then the remaining monsters are fought', async () => {
  const { page, game } = await huntWithScholar();
  try {
    assert.ok(await waitFor(() => game.log.includes('follow dire'), 6000), game.log.join());
    await sleep(800);
    assert.deepEqual(game.log, ['e', 'follow dire'], 'stopped in b: no step to c, no l, fight or gc while the scholar is being followed');
    assert.match(await huntLog(page), /書生出現，暫停巡怪/);
    say(page, VANISH);
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), `${huntText(page)} ${game.log.join()}`);
    assert.deepEqual(game.log.slice(0, 5), ['e', 'follow dire', 'follow none', 'e', 'l'], game.log.join());
    assert.equal(game.log.filter(command => command === FIGHT).length >= 2, true, game.log.join());
    assert.equal(game.at, 'd');
    const log = await huntLog(page);
    assert.match(log, /書生出現，暫停巡怪/);
    assert.match(log, /書生處理完，繼續巡怪/);
  } finally {
    page.close();
  }
});

ui('hunt with the helper off: the scholar line changes nothing (the hunt walks on)', async () => {
  const page = await scholarPage({ outdoor: {} });
  page.store.mapMonsters = mobsAt('c', 'd');
  try {
    const game = world(page, { at: 'a', arrivals: { b: { lines: [SCHOLAR_LINE] } }, looks: { c: { lines: [MOB_LINE] }, d: { lines: [MOB_LINE] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), `${huntText(page)} ${game.log.join()}`);
    assert.equal(game.log.includes('follow dire'), false);
    assert.doesNotMatch(await huntLog(page), /暫停巡怪/);
  } finally {
    page.close();
  }
});

ui('hunt with the helper on: taken out of the hunt area by the scholar, the restReturnCommand walks back and the hunt goes on', async () => {
  const { page, game } = await huntWithScholar({ settings: { restReturnCommand: 'back' }, script: command => {
    if (command === 'back') { game.at = 'b'; return false; }
    return false;
  } });
  try {
    assert.ok(await waitFor(() => game.log.includes('follow dire'), 6000), game.log.join());
    game.at = 'r1';
    say(page, VANISH);
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), `${huntText(page)} ${game.log.join()}`);
    assert.ok(game.log.indexOf('back') > game.log.indexOf('follow none'), game.log.join());
    assert.equal(game.log.filter(command => command === FIGHT).length >= 2, true, game.log.join());
    assert.match(await huntLog(page), /書生 回到巡怪區/);
  } finally {
    page.close();
  }
});

ui('hunt with the helper on: taken out of the hunt area without a restReturnCommand, it stops with a clear message', async () => {
  const { page, game } = await huntWithScholar();
  try {
    assert.ok(await waitFor(() => game.log.includes('follow dire'), 6000), game.log.join());
    game.at = 'r1';
    say(page, VANISH);
    assert.ok(await waitFor(() => /跟著書生離開了巡怪區，沒填回到巡怪區的指令，已停止/.test(huntText(page)), 6000), huntText(page));
    assert.equal(await hunting(page), false);
    assert.equal(game.log.includes('back'), false);
  } finally {
    page.close();
  }
});

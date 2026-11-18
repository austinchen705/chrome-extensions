// 地圖巡怪：map-hunt-human（29 組；共用底座在 tests/helpers/map-hunt-world.js，整個 content script 在 jsdom 裡跑）。
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
  pick,
  huntText,
  click,
  PLAYER_FINGER,
  NOT_FOUND,
  MOB_LINE,
  PERSON,
  FIGHT,
  mobsLines,
  say,
  fakeClock,
  timeScript,
  at,
  roundPage,
  lookTimer,
  huntLog,
  summaryLines,
  lineWorld,
  DIAMOND,
  pinRandom,
  visitOrder,
  huntOnce,
  EAT_LOG,
  REST_LOG,
  jitterOf,
  gapBefore,
  PAUSE_MIN_MS,
  NO_PAUSE_MS,
  LINE,
  firstIndex,
  REST,
  verify,
  typeIn,
  manualButton,
  manualLines,
  macroWindow,
  pressKey,
} = require('../../helpers/map-hunt-world');

ui('hunt log: records what each room showed and did, counts other people without naming them, and HUNT_LOG hands it over', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c', 'd');
    world(page, { at: 'a', looks: { c: { lines: [MOB_LINE, PERSON('somebody')] }, d: { lines: [MOB_LINE] } }, fingers: { somebody: PLAYER_FINGER } });
    await pick(page, MOB);
    const before = await page.ask({ type: 'HUNT_LOG' });
    assert.equal(before.ok, true);
    assert.equal(before.text, '', 'nothing before the first start');
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 5000), huntText(page));
    const { ok, text } = await page.ask({ type: 'HUNT_LOG' });
    assert.equal(ok, true);
    assert.match(text, /開始 怪 測試怪\(test mob\)；目標 2 間/);
    assert.match(text, /目標房間 t\/c t\/d/, 'which rooms it meant to visit');
    assert.match(text, /t\/a 走 e → 目標 t\/c（還要 2 步/, 'each step toward a target');
    assert.match(text, /t\/b 走到\n/, 'and where it landed');
    assert.match(text, /t\/c 看房間 看到 測試怪\(test mob\)✓；別人 1 位；出口 \d+/);
    assert.match(text, /t\/c 略過 有別人\n/, 'skipped because of a person, without the id');
    assert.match(text, /t\/d 開打 測試怪\(test mob\)/);
    assert.match(text, /t\/d 打完 ended/);
    assert.match(text, /停止 .*巡完了/);
    assert.ok(!/somebody|某人/.test(text), 'other players are never named in the log');
  } finally {
    page.close();
  }
});

ui('round summary: a finished round writes its route, commands, gaps from the real send times and rooms with monsters, naming no player', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c', 'd');
    // 間隔固定 1 秒、怪倒下後送三個指令的巨集：巨集的每一步都要用「真正送出」的時間算，只記決定送出的時間的話這三步的間隔會是 0
    page.store.mapHuntSettings = { ...REQUIRED, commandGapMinMs: 1000, commandGapMaxMs: 1000, afterKillCommand: 'gc;gc;gc' };
    fakeClock(page, '2026-11-04T10:00:00+08:00', { scale: SCALE });
    world(page, { at: 'a', looks: { c: { lines: [MOB_LINE, PERSON('somebody')] }, d: { lines: [MOB_LINE] } }, fingers: { somebody: PLAYER_FINGER } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    const text = await huntLog(page);
    const lines = summaryLines(text);
    assert.ok(lines.length >= 3, `the summary has lines (${lines.length})\n${text}`);
    assert.match(lines.join('\n'), /輪摘要 第 1 輪：開始時間在整點後 \d+ 秒；路線 b→c.*（共 \d+ 步）；看了 2 間，有怪 2 間/);
    assert.match(lines.join('\n'), /輪摘要 第 1 輪：指令 \d+ 個：.*finger.*gc/, 'the commands are listed (a finger shows no id)');
    const gaps = lines.join('\n').match(/間隔 最短 ([\d.]+)／平均 ([\d.]+)／最長 ([\d.]+) 秒/);
    assert.ok(gaps, 'the gap statistics are there');
    assert.ok(Number(gaps[1]) >= 1, `every gap, macro steps included, is at least the one second between sends (min ${gaps[1]})`);
    assert.ok(Number(gaps[1]) <= Number(gaps[2]) && Number(gaps[2]) <= Number(gaps[3]), 'min <= average <= max');
    assert.ok(!/somebody|某人/.test(text), 'other players are never named');
  } finally {
    page.close();
  }
});

ui('round summary: a round with the same route as the one before says so', async () => {
  const page = await roundPage({ standbyCommand: 'home' });
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const looks = [];
    const base = timeScript(page, clock, lookTimer(clock, looks));
    // 待命指令把角色送回 a，每一輪才都是 a → b → c；角色停在 c 的話，下一輪的目標就在腳下、沒有路線可比
    const script = (command, ...rest) => {
      if (command === 'home') rest[0].game.at = 'a';
      return base(command, ...rest);
    };
    world(page, { at: 'a', looks: { c: { lines: [] } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => looks.length >= 3, 14000), `three rounds (${looks.length})`);
    assert.ok(await waitFor(async () => summaryLines(await huntLog(page)).some(line => /第 2 輪：路線和上一輪相同/.test(line)), 3000), summaryLines(await huntLog(page)).join('\n'));
    const first = summaryLines(await huntLog(page)).filter(line => /第 1 輪/.test(line)).join('\n');
    assert.doesNotMatch(first, /和上一輪/, 'the first round has nothing to compare with');
    const second = summaryLines(await huntLog(page)).find(line => /第 2 輪：開始時間/.test(line));
    const after = Number(second.match(/整點後 (\d+) 秒/)[1]);
    assert.ok(after < 50, `the second round starts right after the respawn mark (${after} seconds)`);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('round summary: names no id from a give command either, and keeps only the command name', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, afterKillCommand: 'give gem to myalt' };
    world(page, { at: 'a', looks: { c: { lines: [MOB_LINE] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    const lines = summaryLines(await huntLog(page)).join('\n');
    assert.match(lines, /指令 \d+ 個：.*give/, 'the give is listed');
    assert.ok(!/myalt|gem/.test(lines), `no id or item in the summary\n${lines}`);
  } finally {
    page.close();
  }
});

ui('round summary: a round cut short by the stop-before-respawn time still gets its summary', async () => {
  const page = await roundPage({ stopBeforeSpawnSec: 120 });
  try {
    const clock = fakeClock(page, '2026-11-04T10:14:00+08:00', { scale: 60 });
    const fights = [];
    const script = timeScript(page, clock, command => {
      if (command === FIGHT) fights.push(clock.server());
      return false;
    });
    world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(async () => summaryLines(await huntLog(page)).some(line => /第 1 輪：指令/.test(line)), 9000), summaryLines(await huntLog(page)).join('\n'));
    assert.equal(fights.length, 0, 'the summary was written at the pause, before any fight');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('round summary: a later round counts its start from the offset just measured, not the one from the start', async () => {
  const page = await roundPage({ standbyCommand: 'home' });
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const looks = [];
    const base = timeScript(page, clock, lookTimer(clock, looks));
    // 第一次對時準確；待命之後遊戲回的時間快了 20 秒（伺服器時間讀數變了）：第二輪開始時新量到的偏差和最開始的差 20 秒
    const script = (command, ...rest) => {
      if (command === 'home') clock.replyError = 20000;
      return base(command, ...rest);
    };
    world(page, { at: 'a', looks: { c: { lines: [] } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => looks.length >= 2, 12000), `two rounds (${looks.length})`);
    assert.ok(await waitFor(async () => summaryLines(await huntLog(page)).some(line => /第 2 輪：開始時間/.test(line)), 3000), summaryLines(await huntLog(page)).join('\n'));
    const second = summaryLines(await huntLog(page)).find(line => /第 2 輪：開始時間/.test(line));
    const after = Number(second.match(/整點後 (\d+) 秒/)[1]);
    assert.ok(after < 50, `counted from the fresh offset, so just after the mark and not nearly a quarter of an hour late (${after} seconds)`);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('round summary: with the switch off the hunt sends exactly the commands it always did (and the same with it on)', async () => {
  const run = async humanize => {
    const page = await boot({ scale: SCALE });
    try {
      page.store.mapMonsters = mobsAt('c', 'd');
      page.store.mapHuntSettings = { ...REQUIRED, humanize };
      const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE] }, d: { lines: [MOB_LINE] } } });
      await pick(page, MOB);
      click(page, '.hstart');
      assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
      return [...game.log];
    } finally {
      page.close();
    }
  };
  // 這一串是開關加進來之前這個情境就送出的指令（對照固定的序列，不是只比開和關的結果）
  const GOLDEN = ['e', 'e', 'l', FIGHT, 'gc', 'e', 'l', FIGHT, 'gc'];
  assert.deepEqual(await run('off'), GOLDEN);
  assert.deepEqual(await run('on'), GOLDEN);
});

ui('humanize: the order of the targets is drawn with the nearer ones favoured, and the switch off keeps nearest first', async () => {
  const map = lineWorld(['q4', 'q3', 'q2', 'q1', 'a', 'p1', 'p2', 'p3']); // 從 a 出發：p3 距離 3、q4 距離 4，兩間之間 7 步
  const first = async options => visitOrder((await huntOnce({ map, at: 'a', targets: ['p3', 'q4'], ...options })).text)[0];
  assert.equal(await first({ r: 0.2 }), 'p3', 'a small draw takes the nearer one');
  assert.equal(await first({ r: 0.5 }), 'p3', 'the nearer one owns the lower part of the draw');
  assert.equal(await first({ r: 0.8 }), 'q4', 'a high draw takes the farther one (11 steps in all, within 120% of the 10 of nearest-first)');
  assert.equal(await first({ r: 0.8, humanize: 'off' }), 'p3', 'with the switch off the draw is not used at all');
});

ui('humanize: an order that needs more than 120% of the steps of nearest-first falls back to nearest-first', async () => {
  // 從 a 出發：p2 距離 2、q4 距離 4，兩間之間 6 步。先 q4 再 p2 要 10 步，最近的先只要 8 步，10 > 9.6
  // （兩條臂分開：先走遠的不會路過近的，不然抽到哪個結果都一樣，測不出上限）
  const map = lineWorld(['q4', 'q3', 'q2', 'q1', 'a', 'p1', 'p2']);
  const firsts = [];
  for (const r of [0.1, 0.9]) firsts.push(visitOrder((await huntOnce({ map, at: 'a', targets: ['p2', 'q4'], r })).text)[0]);
  assert.deepEqual(firsts, ['p2', 'p2'], 'both draws end up nearest first, even the one that drew the far room');
});

ui('humanize: among equally short routes the draw picks one, and the switch off takes the usual one', async () => {
  const first = async options => (await huntOnce({ map: DIAMOND, at: 'a', targets: ['d'], ...options })).commands[0];
  const low = await first({ r: 0 });
  const high = await first({ r: 0.99 });
  assert.ok(['e', 's'].includes(low) && ['e', 's'].includes(high), `both are first steps of a shortest route (${low}, ${high})`);
  assert.notEqual(low, high, 'a different draw takes the other route');
  assert.equal(await first({ humanize: 'off', r: 0.99 }), await first({ humanize: 'off', r: 0 }), 'off: the draw makes no difference');
});

ui('humanize: each round the stop-before-respawn seconds and the line the heal mode uses shift within their bounds', async () => {
  // 吃藥模式：只抖吃藥線，危險線不動
  const eat = { healMode: 'eat', eatBelow: 50, restBelow: 50, dangerBelow: 20 };
  assert.deepEqual(await jitterOf('on', 0, eat, EAT_LOG), [70, 47, 20], 'the lowest draw: 30% less, 3 points lower, the danger line untouched');
  const [highStop, highEat, highDanger] = await jitterOf('on', 0.99, eat, EAT_LOG);
  assert.ok(highStop > 100 && highStop <= 130, `the highest draw: up to 30% more (${highStop})`);
  assert.ok(highEat > 50 && highEat <= 53, `up to 3 points higher (${highEat})`);
  assert.equal(highDanger, 20);
  // 自己回模式：只抖休息線，危險線一定低於它
  const rest = { healMode: 'rest', restBelow: 50, dangerBelow: 49 };
  assert.deepEqual(await jitterOf('on', 0, rest, REST_LOG), [70, 47, 46], 'the danger line is pushed below the lowered rest line');
  const [, highRest, highRestDanger] = await jitterOf('on', 0.99, rest, REST_LOG);
  assert.ok(highRest > 50 && highRest <= 53 && highRestDanger < highRest, `${highRest}, ${highRestDanger}`);
  assert.equal(await jitterOf('off', 0, eat, EAT_LOG), null, 'with the switch off nothing is shifted or logged');
});

ui('humanize: the eat line never drops to the danger line, and a stop time under ten seconds is left alone', async () => {
  const close = { healMode: 'eat', eatBelow: 22, dangerBelow: 20, stopBeforeSpawnSec: 5 };
  assert.deepEqual(await jitterOf('on', 0, close, EAT_LOG), [5, 21, 20], 'the lowest draw would give 19, but the eat line stays above the danger line; 5 seconds is not shifted');
  const [stop, eatLine] = await jitterOf('on', 0.99, close, EAT_LOG);
  assert.equal(stop, 5);
  assert.ok(eatLine > 22 && eatLine <= 25, String(eatLine));
});

// 擬人化的失誤：打錯字（走路、l、finger 先送一個打錯的、隔一下才送正確的）與故意走錯路（走進旁邊不在路線上的房間再走回來）
ui('humanize slips: a typo is sent before each walking step and the look, then the right command; fights and healing are never mistyped', async () => {
  const run = options => huntOnce({ map: lineWorld(['a', 'b', 'c']), at: 'a', targets: ['c'], r: 0.1, worldOptions: { looks: { c: { lines: [] } } }, ...options });
  const typed = await run({ settings: { typoPercent: 20, wrongWayPercent: 0 } });
  assert.deepEqual(typed.commands, ['ee', 'e', 'ee', 'e', 'll', 'l']);
  assert.match(typed.text, /t\/a 擬人化 打錯字 ee → e/);
  assert.deepEqual((await run({ settings: { typoPercent: 20, wrongWayPercent: 20 }, humanize: 'off' })).commands, ['e', 'e', 'l'], 'with the switch off nothing is mistyped or walked wrong');
  assert.deepEqual((await run({ settings: { typoPercent: 0, wrongWayPercent: 0 } })).commands, ['e', 'e', 'l'], 'zero percent means none');
});

ui('humanize slips: finger is mistyped on the verb only, the id stays whole, and the fight and corpse commands are never mistyped', async () => {
  const { commands } = await huntOnce({
    map: lineWorld(['a', 'b', 'c']), at: 'a', targets: ['c'], r: 0.1, settings: { typoPercent: 20, wrongWayPercent: 0 },
    worldOptions: { looks: { c: { lines: [MOB_LINE, PERSON('smith')] } }, fingers: { smith: NOT_FOUND } },
  });
  assert.deepEqual(commands.slice(0, 7), ['ee', 'e', 'ee', 'e', 'll', 'l', 'fingerr smith']);
  assert.equal(commands[7], 'finger smith', 'the id is whole when it is finally sent');
  const rest = commands.slice(8);
  assert.ok(rest.includes(FIGHT), 'the fight starts');
  assert.ok(rest.every(command => command === FIGHT || command === 'gc' || command === 'l' || command === 'll' || command === 'e' || command === 'ee'), `nothing else is mistyped (${rest.join()})`);
  assert.ok(!commands.some(command => command.startsWith('fightt') || command.startsWith('gcc')), 'fight and corpse commands are left alone');
});

ui('humanize slips: a deliberate wrong way steps into a side room that is not on the route and comes straight back, at most twice a round and never on the last step', async () => {
  const { commands, text } = await huntOnce({ map: lineWorld(['a', 'b', 'c', 'd']), at: 'a', targets: ['d'], r: 0.1, settings: { typoPercent: 0, wrongWayPercent: 20 }, worldOptions: { looks: { d: { lines: [] } } } });
  assert.deepEqual(commands, ['e', 'w', 'e', 'w', 'e', 'e', 'e', 'l'], `a at the start has no side exit, b is detoured twice, then it walks on; c is the last step (${commands.join()})`);
  assert.equal([...text.matchAll(/故意走錯 w（進 t\/a），再走回來/g)].length, 2);
  assert.doesNotMatch(text, /不是預期/, 'the deliberate wrong way is not logged as a real wrong room');
  assert.doesNotMatch(text, /略過/, 'and it never counts towards skipping the target');
});

ui('humanize pauses: a drawn pause comes right after arriving (before the look) and after a monster is finished (before the recount), and never in the walk', async () => {
  // 0.01 < 5%：每個可以停的點都停。f 放兩隻怪：打完第一隻還有第二隻，才會重數（只有一隻時打完不重數）
  const { times, text } = await huntOnce({ map: lineWorld(LINE), at: 'a', targets: ['f'], r: 0.01, timed: true, worldOptions: { looks: { f: { lines: [MOB_LINE, MOB_LINE] } } } });
  const commands = times.map(([command]) => command);
  assert.deepEqual(commands, ['e', 'e', 'e', 'e', 'e', 'l', FIGHT, 'gc', 'l', FIGHT, 'gc'], 'the same commands as without pauses');
  for (let i = 1; i <= 4; i += 1) assert.ok(gapBefore(times, i) < NO_PAUSE_MS, `walking step ${i} was not paused (${gapBefore(times, i)} ms)`);
  const look = firstIndex(times, 'l');
  assert.ok(gapBefore(times, look) >= PAUSE_MIN_MS, `the look after arriving waited for the pause (${gapBefore(times, look)} ms)`);
  const recount = firstIndex(times, 'l', look + 1);
  // 停頓和撿屍指令排進佇列同時開始，gc 實際送出還要等一個指令間隔，所以從「怪死前最後一個指令」量起才包含整個停頓
  const killedAt = times[firstIndex(times, FIGHT)][1];
  assert.ok(times[recount][1] - killedAt >= PAUSE_MIN_MS, `the recount after the kill waited for the pause (${times[recount][1] - killedAt} ms after the fight)`);
  assert.ok(gapBefore(times, firstIndex(times, 'gc')) < PAUSE_MIN_MS, 'the corpse command right after the kill is not delayed');
  assert.match(text, /t\/f 停頓 \d\.\d 秒（到房間後）/);
  assert.match(text, /t\/f 停頓 \d\.\d 秒（打完一隻後）/);
  const max = Number(text.match(/間隔 最短 [\d.]+／平均 [\d.]+／最長 ([\d.]+) 秒/)[1]);
  assert.ok(max >= PAUSE_MIN_MS / 1000, `the summary's longest gap includes the pause (${max})`);
});

ui('humanize pauses: even the longest pause ends before the 8-second no-reply watchdog, after a corpse command that prints nothing', async () => {
  // 0.0499 剛好在機率以內：同一個抽籤值縮放成長度，就是最長的那一種。gc 不印任何東西（reply: false），房間描述照印
  const arrivals = Object.fromEntries(LINE.slice(1).map(id => [id, id === 'f' ? { lines: [MOB_LINE] } : {}])); // 目標 f 的抵達描述就是看房間的依據
  const { text } = await huntOnce({ map: lineWorld(LINE), at: 'a', targets: ['f'], r: 0.0499, worldOptions: { reply: false, arrivals } });
  // huntOnce 會等到「巡完了」：看門狗在停頓裡把巡怪停掉的話，這裡就等不到
  const pause = Number(text.match(/停頓 ([\d.]+) 秒（打完一隻後）/)?.[1]);
  assert.ok(pause > 6 && pause < 8, `the longest pause is close to but under the 8 seconds of the watchdog (${pause})`);
});

ui('humanize pauses: a draw above the chance, or the switch off, adds no wait and no log line', async () => {
  for (const options of [{ r: 0.99 }, { r: 0.01, humanize: 'off' }]) {
    const { times, text } = await huntOnce({ map: lineWorld(LINE), at: 'a', targets: ['f'], timed: true, ...options });
    for (let i = 1; i < times.length; i += 1) assert.ok(gapBefore(times, i) < NO_PAUSE_MS, `${JSON.stringify(options)}: no long gap (${times[i][0]}: ${gapBefore(times, i)} ms)`);
    assert.doesNotMatch(text, /停頓/);
  }
});

ui('humanize: the respawn mark itself is never shifted (the next round still starts right after it)', async () => {
  const page = await roundPage({ humanize: 'on', stopBeforeSpawnSec: 100 });
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const looks = [];
    pinRandom(page, 0.99);
    world(page, { at: 'a', looks: { c: { lines: [] } }, script: timeScript(page, clock, lookTimer(clock, looks)) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => looks.length >= 2, 12000), `two rounds (${looks.length})`);
    assert.ok(looks[1] >= at('10:15:00') && looks[1] < at('10:15:50'), new Date(looks[1]).toISOString());
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('humanize: the summary shows the route actually taken each round and flags a round that took a different one', async () => {
  const page = await roundPage({ humanize: 'on', standbyCommand: 'home' });
  try {
    page.store.mapMonsters = mobsAt('d');
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    const looks = [];
    const r = pinRandom(page, 0);
    const base = timeScript(page, clock, lookTimer(clock, looks));
    // 待命指令把角色送回 a；第二輪改用另一個抽籤值，走另一條一樣長的路
    const script = (command, ...rest) => {
      if (command === 'home') { rest[0].game.at = 'a'; r.value = 0.99; }
      return base(command, ...rest);
    };
    world(page, { at: 'a', ...DIAMOND, looks: { d: { lines: [] } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => looks.length >= 2, 12000), `two rounds (${looks.length})`);
    assert.ok(await waitFor(async () => summaryLines(await huntLog(page)).some(line => /第 2 輪：路線和上一輪/.test(line)), 3000), summaryLines(await huntLog(page)).join('\n'));
    const lines = summaryLines(await huntLog(page));
    const route = n => lines.find(line => new RegExp(`第 ${n} 輪：開始時間`).test(line)).match(/路線 ([a-z→]+)/)[1];
    assert.notEqual(route(1), route(2), `the two rounds took different routes (${route(1)}, ${route(2)})`);
    assert.ok(lines.some(line => /第 2 輪：路線和上一輪不同/.test(line)));
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('manual: with the toggle on, what I type is recorded with the route, and turning it off writes a manual summary', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const game = world(page, { at: 'a' });
    await sleep(100);
    click(page, '.hmanual');
    assert.match(manualButton(page).textContent, /記錄中/);
    typeIn(page, 'e');
    await sleep(120);
    typeIn(page, 'e');
    await sleep(120);
    typeIn(page, 'l');
    typeIn(page, 'tell somebody 嗨');
    typeIn(page, '');
    await sleep(120);
    assert.equal(game.at, 'c');
    click(page, '.hmanual');
    assert.doesNotMatch(manualButton(page).textContent, /記錄中/);
    const lines = manualLines(await huntLog(page));
    assert.equal(lines.length, 3, lines.join('\n'));
    assert.match(lines[0], /手動摘要 第 1 段：（伺服器時間沒校準）開始時間在整點後 \d+ 秒；路線 b→c（共 2 步）；l 了 1 次/);
    assert.match(lines[1], /手動摘要 第 1 段：指令 4 個：e×2 l tell somebody 嗨$/, 'chat is kept, the blank line is not a command');
    assert.match(lines[2], /手動摘要 第 1 段：間隔 最短 [\d.]+／平均 [\d.]+／最長 [\d.]+ 秒/);
  } finally {
    page.close();
  }
});

ui('manual: rooms, a printed death line and knockout words become events, and a written segment accumulates into mapHuntProfile', async () => {
  const page = await boot({ scale: SCALE });
  try {
    world(page, { at: 'a' });
    await sleep(100);
    click(page, '.hmanual');
    typeIn(page, 'e');
    await sleep(120);
    typeIn(page, 'k 1');
    page.output('<span>蒙古兵跌在地上一動也不動了。\n</span>');
    await sleep(30);
    typeIn(page, 'k 1');
    page.output('<span>蒙古兵死了。\n</span>');
    await sleep(30);
    typeIn(page, 'gc');
    typeIn(page, 'l');
    await sleep(120);
    typeIn(page, 'e');
    await sleep(120);
    click(page, '.hmanual');
    assert.equal(manualLines(await huntLog(page)).length, 3, 'the manual summary is still written as before');
    assert.ok(await waitFor(() => page.store.mapHuntProfile, 1000), 'the segment was accumulated');
    const profile = JSON.parse(JSON.stringify(page.store.mapHuntProfile));
    assert.equal(profile.segments, 1);
    assert.equal(profile.commands, 6);
    assert.equal(profile.rooms, 2, 'a to b to c');
    assert.equal(profile.downs, 1);
    assert.deepEqual(profile.firstAttack, { k: 1 });
    assert.deepEqual(profile.knockoutAttack, { k: 1 });
    assert.deepEqual(profile.afterDown, { 'gc;l': 1 });
  } finally {
    page.close();
  }
});

ui('manual: commands the extension sends itself (a trigger, the verify button) are not recorded', async () => {
  const page = await boot({ scale: SCALE });
  try {
    world(page, { at: 'a', script: (command, { say: tell }) => {
      if (command === 'alias') { tell('你目前設定的 alias 有：\nf               = fight $1'); return true; }
      return false;
    } });
    await page.ask({ type: 'START_TRIGGER', group: 'practice', config: { rules: [{ kind: 'keyword', enabled: true, pattern: '口渴', commands: ['drink'], cooldown: 0 }], delayMax: 0, requireNormal: false } });
    click(page, '.hmanual');
    typeIn(page, 'l');
    page.output('<span>你覺得口渴。\n</span>');
    assert.ok(await waitFor(() => page.sent.includes('drink'), 2000), 'the trigger sent its command');
    await page.ask({ type: 'HUNT_VERIFY_ALIAS', command: 'f', verb: 'fight' });
    assert.ok(page.sent.includes('alias'));
    click(page, '.hmanual');
    const lines = manualLines(await huntLog(page));
    assert.match(lines[1], /指令 1 個：l$/, lines.join('\n'));
  } finally {
    page.close();
  }
});

ui('manual: nothing typed means no summary, and the record is off until the toggle is pressed', async () => {
  const page = await boot({ scale: SCALE });
  try {
    world(page, { at: 'a' });
    typeIn(page, 'l'); // 還沒開
    click(page, '.hmanual');
    click(page, '.hmanual');
    assert.deepEqual(manualLines(await huntLog(page)), []);
  } finally {
    page.close();
  }
});

ui('manual: switching the hunt feature off stops the record and writes out what was recorded', async () => {
  const page = await boot({ scale: SCALE });
  try {
    world(page, { at: 'a' });
    const features = on => page.changeListeners.forEach(listener => listener({ zapFeatures: { newValue: { hunt: on } } }, 'local'));
    features(true);
    click(page, '.hmanual');
    typeIn(page, 'l');
    features(false);
    assert.ok(await waitFor(async () => manualLines(await huntLog(page)).length === 3, 1000), 'written when the feature goes off');
    assert.doesNotMatch(manualButton(page).textContent, /記錄中/);
  } finally {
    page.close();
  }
});

ui('manual: starting the record reads the server time once (not counted as mine), and a record that crosses a respawn mark is written as two numbered blocks', async () => {
  const page = await boot({ scale: SCALE });
  try {
    // 伺服器 10:14:00 起，1 毫秒＝300 毫秒；電腦時鐘比伺服器慢 7 分鐘（fakeClock 的預設），所以只有用伺服器時間才算得出「整點後 84x 秒」
    const clock = fakeClock(page, '2026-11-04T10:14:00+08:00');
    world(page, { at: 'a', script: timeScript(page, clock) });
    click(page, '.hmanual');
    assert.ok(await waitFor(() => clock.times === 1, 2000), 'time was asked once');
    await sleep(50);
    typeIn(page, 'l');
    assert.ok(await waitFor(() => clock.server() >= at('10:15:30'), 3000), 'past the 10:15 mark');
    typeIn(page, 'e');
    typeIn(page, 'l');
    click(page, '.hmanual');
    const lines = manualLines(await huntLog(page));
    assert.equal(lines.length, 6, lines.join('\n'));
    assert.ok(lines.every(line => !/沒校準/.test(line)), 'calibrated');
    const seconds = line => Number(line.match(/開始時間在整點後 (\d+) 秒/)[1]);
    assert.match(lines[0], /第 1 段：/);
    assert.ok(seconds(lines[0]) >= 840 && seconds(lines[0]) < 900, `the first block started at 10:14:xx server time (${lines[0]})`);
    assert.match(lines[1], /第 1 段：指令 1 個：l$/, 'time is not one of my commands');
    assert.match(lines[3], /第 2 段：/);
    // 假時鐘放大 300 倍，校準時 time 回應的等待也被放大成好幾秒的誤差，所以只要在 10:15 整點之後不久就算對
    assert.ok(seconds(lines[3]) < 120, `the second block started shortly after the 10:15 mark (${lines[3]})`);
    assert.match(lines[4], /第 2 段：指令 2 個：e l$/);
  } finally {
    page.close();
  }
});

ui('manual: a respawn mark with nothing typed in between writes no empty block', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const clock = fakeClock(page, '2026-11-04T10:14:50+08:00');
    world(page, { at: 'a', script: timeScript(page, clock) });
    click(page, '.hmanual');
    assert.ok(await waitFor(() => clock.times === 1, 2000));
    await sleep(50);
    typeIn(page, 'l');
    assert.ok(await waitFor(() => clock.server() >= at('10:30:30'), 6000), 'two marks later');
    typeIn(page, 'l');
    click(page, '.hmanual');
    const lines = manualLines(await huntLog(page));
    assert.deepEqual(lines.map(line => line.match(/第 (\d+) 段/)[1]), ['1', '1', '1', '2', '2', '2'], 'the empty 10:15 block is skipped and the numbering goes on');
  } finally {
    page.close();
  }
});

ui('manual: pressing a game macro key records each part of that macro at the moment of the press, and leaves the sending to the game', async () => {
  const page = await boot({ scale: SCALE });
  try {
    world(page, { at: 'a' });
    macroWindow(page, [[112, 'l;hp;;sc'], [113, '']]);
    click(page, '.hmanual');
    pressKey(page, 112);
    pressKey(page, 113); // 空的格子
    pressKey(page, 114); // 沒有設定的鍵
    const other = page.w.document.createElement('input');
    page.w.document.body.append(other);
    pressKey(page, 112, other); // 焦點在別的輸入框：遊戲也不會送
    await sleep(50);
    assert.deepEqual(page.sent.filter(command => command !== 'time'), [], 'the extension does not send the macro, the game does');
    click(page, '.hmanual');
    const lines = manualLines(await huntLog(page));
    assert.match(lines[1], /指令 3 個：l hp sc$/, lines.join('\n'));
    assert.match(lines[2], /間隔 最短 0\.0／平均 0\.0／最長 0\.0 秒/, 'all parts at the moment of the press');
  } finally {
    page.close();
  }
});

ui('manual: a game macro with @等待 that I press is recorded step by step at the moment each step is sent', async () => {
  const page = await boot({ scale: SCALE });
  try {
    world(page, { at: 'a' });
    macroWindow(page, [[112, 'p1;@等待 2;p2']]);
    click(page, '.hmanual');
    pressKey(page, 112);
    assert.ok(await waitFor(() => page.sent.includes('p2'), 2000), 'the extension runs the @等待 macro');
    click(page, '.hmanual');
    const lines = manualLines(await huntLog(page));
    assert.match(lines[1], /指令 2 個：p1 p2$/, lines.join('\n'));
    const gap = Number(lines[2].match(/最短 ([\d.]+)/)[1]);
    assert.ok(gap >= 0.05, `the second step was recorded when it was sent, after the wait (${gap} s)`);
  } finally {
    page.close();
  }
});

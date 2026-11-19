// 地圖巡怪：map-hunt-fight（78 組；共用底座在 tests/helpers/map-hunt-world.js，整個 content script 在 jsdom 裡跑）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, sleep, waitFor, fixture } = require('../../helpers/game-page');
const {
  SCALE,
  REQUIRED,
  boot,
  MOB,
  mobsAt,
  world,
  tick,
  pick,
  huntText,
  click,
  alerts,
  MOB_LINE,
  FIGHT,
  KO_LINE,
  mobsLines,
  setKee,
  hunting,
  countOf,
  say,
  OTHER_LINE,
  at,
  sortPage,
  sortScript,
  sortState,
  lookOut,
  assistPage,
  MOB_FIGHTING,
  huntLog,
  LINE,
  REST,
  endsAfterFight,
  dropsAtFirstLook,
  ZOMBIE,
  ZOMBIE_FIGHTING,
  ATTACK_LINE,
  ambushWorld,
  CORPSE_LINE,
  NOT_ALIVE_LINE,
  ALIAS_LIST,
  DOG_LINE,
} = require('../../helpers/map-hunt-world');

ui('fight: three monsters with the same name are fought one at a time, each followed by gc, with a fresh l only before the next one', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(3) } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'l', FIGHT, 'gc', 'l', FIGHT, 'gc']);
    assert.equal(await hunting(page), false);
  } finally {
    page.close();
  }
});

ui('fight: the command that starts a fight is a setting, so f is sent with the monster ID, and the retry after a timeout uses it too', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, fightCommand: 'f', fightTimeoutSec: 5 };
    let starts = 0;
    const script = (command, { say: tell }) => {
      if (command !== 'f 1') return false;
      starts += 1;
      // 第一次沒有結束句（只印一句話，免得機器慢時撞上 8 秒無回應的看門狗）：逾時後看一眼，怪還在、沒在打，就再送一次
      tell(starts === 2 ? '測試怪死了。' : '你對著測試怪說道：請指教。');
      return true;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.equal(countOf(game, 'f 1'), 2, `started with f and retried with f (${game.log.join(',')})`);
    assert.equal(game.log.filter(command => command.startsWith('fight ')).length, 0, 'fight itself is never sent');
  } finally {
    page.close();
  }
});

ui('fight: the kill command is a setting, so a refusal gets k when the user set that', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, killCommand: 'k' };
    const script = (command, { say: tell }) => {
      if (command === FIGHT) { tell('看起來測試怪並不想跟你較量。'); return true; }
      if (command === 'k 1') { tell('測試怪死了。'); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'k 1', 'gc']);
  } finally {
    page.close();
  }
});

ui('fight: a monster that does not want to fight gets kill after the refusal; when that only knocks it out it gets one more kill, and the corpse is taken only after the death sentence', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const script = (command, { say: tell }) => {
      if (command === FIGHT) { tell('看起來測試怪並不想跟你較量。'); return true; }
      if (command === 'kill 1') { tell(countOf(game, 'kill 1') === 1 ? KO_LINE : '測試怪死了。'); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'kill 1', 'kill 1', 'gc']);
  } finally {
    page.close();
  }
});

ui('fight: the after-kill command can be several commands and is the one from the settings', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, afterKillCommand: 'get corpse;gc' };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'get corpse', 'gc']);
  } finally {
    page.close();
  }
});

ui('fight: no end sentence for a long time means an l: a monster that is knocked out gets a kill to finish it, then counts as over', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, fightTimeoutSec: 5 };
    const room = { lines: mobsLines(1) };
    const script = command => {
      if (command === FIGHT) { room.lines[0] = '  ※測試怪(test mob) <昏迷不醒> [fight][kill]'; return true; }
      if (command === 'kill 1') { say(page, '測試怪死了。'); room.lines.splice(0, 1); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'l', 'kill 1', 'gc']);
  } finally {
    page.close();
  }
});

ui('fight: a monster still in <戰鬥中> after the wait keeps the fight going', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, fightTimeoutSec: 5 };
    const room = { lines: ['  ※測試怪(test mob) <戰鬥中> [fight][kill]'] };
    const script = command => command === FIGHT;
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'l') >= 3, 4000), 'it looked more than once and kept waiting');
    assert.equal(await hunting(page), true);
    assert.equal(countOf(game, FIGHT), 1, 'it did not start the fight again');
    say(page, '測試怪死了。');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
  } finally {
    page.close();
  }
});

ui('fight: when gc does not make a monster go away three times in a row the room is given up (a recount happens only while a second monster is left to fight)', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const script = command => {
      if (command === 'gc') { return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(2) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(async () => !(await hunting(page)), 8000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'l', FIGHT, 'gc', 'l', FIGHT, 'gc', 'l']);
    assert.match(huntText(page), /略過 1 間.*t\/c 打不動/);
  } finally {
    page.close();
  }
});

ui('vitals: low jing sends its command and an empty shen command is skipped', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, ginBelow: 50, ginCommand: 'eatgin', senBelow: 50, senCommand: '' };
    const doc = page.w.document;
    doc.body.insertAdjacentHTML('beforeend', '<span id="gin">20</span><span id="eff_gin">100</span><span id="sen">20</span><span id="eff_sen">100</span>');
    const game = world(page, { at: 'a', looks: { c: { lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'eatgin') >= 1, 4000), game.log.join('|'));
    assert.equal(game.log.some(command => /sen/.test(command)), false, 'nothing is sent for shen without a command');
  } finally {
    page.close();
  }
});

for (const how of ['status', 'bar']) {
  ui(`busy: while the character is busy (${how === 'status' ? 'the status says 忙碌' : 'the busy cooldown bar runs'}) the hunt neither walks nor fights`, async () => {
    const page = await boot({ scale: SCALE });
    try {
      page.store.mapMonsters = mobsAt('c');
      page.store.mapHuntSettings = { ...REQUIRED };
      const doc = page.w.document;
      let busy = true;
      if (how === 'status') {
        if (!doc.getElementById('status')) doc.body.insertAdjacentHTML('beforeend', '<span id="status"></span>');
        doc.getElementById('status').textContent = '忙碌:3';
      } else {
        doc.body.insertAdjacentHTML('beforeend', '<div class="cooldown" id="busy"><div></div></div>');
        doc.getElementById('busy').firstElementChild.getAnimations = () => [{ playState: busy ? 'running' : 'finished' }];
      }
      const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } } });
      await pick(page, MOB);
      click(page, '.hstart');
      await sleep(600);
      assert.equal(game.log.length, 0, `nothing is sent while busy (${game.log.join('|')})`);
      busy = false;
      if (how === 'status') doc.getElementById('status').textContent = '正常';
      assert.ok(await waitFor(() => countOf(game, FIGHT) >= 1, 4000), game.log.join('|'));
    } finally {
      page.close();
    }
  });
}

ui('vitals: an injury below its line sends its own command, while a full current value and an empty injury command send nothing', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, ginBelow: 50, ginCommand: 'eatgin', ginHurtBelow: 100, ginHurtCommand: 'healgin', keeHurtBelow: 100, keeHurtCommand: '' };
    const doc = page.w.document;
    // 精目前值滿的（100/100），傷勢 80%；氣傷勢 70% 但沒填指令
    doc.body.insertAdjacentHTML('beforeend', '<span id="gin">100</span><span id="eff_gin">100</span><span id="max_gin">80</span><span id="max_kee">70</span>');
    const game = world(page, { at: 'a', looks: { c: { lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'healgin') >= 1, 4000), game.log.join('|'));
    assert.equal(countOf(game, 'eatgin'), 0, 'the current jing is full');
  } finally {
    page.close();
  }
});

ui('fight: the special attack waits until the game cooldown bar (#perform) has finished', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, specialCommand: 'pt', specialIntervalSec: 1 };
    // 遊戲的冷卻條：#perform 裡一個子 div，CSS 動畫在跑＝冷卻中（jsdom 沒有 CSS 動畫，用 getAnimations 模擬）
    const doc = page.w.document;
    const bar = doc.createElement('div');
    bar.id = 'perform';
    const inner = doc.createElement('div');
    let running = true;
    inner.getAnimations = () => (running ? [{ playState: 'running' }] : [{ playState: 'finished' }]);
    bar.appendChild(inner);
    doc.body.appendChild(bar);
    const script = command => {
      if (command === FIGHT || command === 'pt') { say(page, '你揮拳打中測試怪。'); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, FIGHT) >= 1, 4000), 'the fight starts');
    await sleep(600);
    assert.equal(countOf(game, 'pt'), 0, 'no special attack while the cooldown bar is running');
    running = false;
    assert.ok(await waitFor(() => countOf(game, 'pt') >= 1, 4000), 'the special attack goes once the bar has finished');
  } finally {
    page.close();
  }
});

ui('fight: the special attack repeats while the monster lives, a busy refusal is just waited out, and it stops with the end sentence', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, specialCommand: 'pt', specialIntervalSec: 1 };
    const script = command => {
      if (command === FIGHT) return true;
      if (command === 'pt') { say(page, '( 你上一個動作還沒有完成，不能施用外功。 )'); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'pt') >= 3, 4000), 'it keeps trying after being told it is busy');
    say(page, '測試怪死了。');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    const total = countOf(game, 'pt');
    await sleep(300);
    assert.equal(countOf(game, 'pt'), total, 'no special attack after the monster is gone');
  } finally {
    page.close();
  }
});

ui('fight: "who do you want to use this on" stops the special attack for that fight', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, specialCommand: 'pt', specialIntervalSec: 1 };
    const script = command => {
      if (command === FIGHT) return true;
      if (command === 'pt') { say(page, '你要對誰施展這個招式?'); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'pt') >= 1, 3000));
    await sleep(500);
    assert.equal(countOf(game, 'pt'), 1, 'sent once, then never again in this fight');
    say(page, '測試怪死了。');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
  } finally {
    page.close();
  }
});

ui('fight: in eat mode the eat command is sent when the qi is low, not more often than every 5 seconds', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, eatBelow: 50, eatCommand: 'eat pill' };
    setKee(page, 30);
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: command => command === FIGHT });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'eat pill') >= 1 && game.log.includes(FIGHT), 3000));
    await sleep(120);
    assert.equal(countOf(game, 'eat pill'), 1, 'not again before the 5 seconds (scaled) are over');
    say(page, '測試怪死了。');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
  } finally {
    page.close();
  }
});

ui('fight: in rest mode a qi below the danger line goes home, stops the hunt and raises an alert', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', dangerBelow: 20, homeCommand: 'recall' };
    setKee(page, 60);
    const script = command => {
      if (command !== FIGHT) return false;
      setKee(page, 10);
      return true;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes('recall'), 4000), huntText(page));
    assert.equal(await hunting(page), false);
    assert.equal(alerts(page).length, 1);
    const count = game.log.length;
    await sleep(300);
    assert.equal(game.log.length, count, 'nothing is sent after going home');
  } finally {
    page.close();
  }
});

ui('fight: a fight that gets no reply at all is stopped by the no-reply watchdog like every other feature', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: command => command === FIGHT });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /沒有收到遊戲回應/.test(message.reason)), 6000));
    assert.equal(await hunting(page), false);
    const count = game.log.length;
    await sleep(300);
    assert.equal(game.log.length, count);
  } finally {
    page.close();
  }
});

ui('fight: while a captcha is pending only its answer is sent, and when the answer fails the hunt is stopped with the rest', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: command => command === FIGHT || command === '62044' });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes(FIGHT), 3000));
    const before = game.log.length;
    page.output(fixture('sprite-62044.html'));
    assert.ok(await waitFor(() => alerts(page).length >= 1, 8000), 'three unanswered tries stop everything');
    assert.equal(await hunting(page), false);
    assert.ok(game.log.slice(before).every(command => command === '62044'), game.log.slice(before).join(','));
    const count = game.log.length;
    await sleep(400);
    assert.equal(game.log.length, count, 'nothing more after the stop');
  } finally {
    page.close();
  }
});

ui('fight: in rest mode a qi between the danger line and the resume line does not stop the fight', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', dangerBelow: 20, restResume: 80, homeCommand: 'recall' };
    setKee(page, 55);
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.equal(game.log.includes('recall'), false);
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('fight: in eat mode the eat command is sent again once the 5 seconds are over', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, eatBelow: 50, eatCommand: 'eat pill' };
    setKee(page, 30);
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: command => command === FIGHT });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'eat pill') >= 2 && game.log.includes(FIGHT), 3000), 'the second one follows the gap');
    say(page, '測試怪死了。');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
  } finally {
    page.close();
  }
});

ui('fight: after the wait, a monster that was told kill is sent kill again, not fight', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, fightTimeoutSec: 5 };
    const script = command => {
      if (command === FIGHT) { say(page, '看起來測試怪並不想跟你較量。'); return true; }
      return command === 'kill 1';
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'kill 1') >= 2, 4000), game.log.join(','));
    assert.equal(countOf(game, FIGHT), 1, 'fight is not sent again after the refusal');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('fight: a refusal that follows a special attack with no target does not end the special attacks', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, specialCommand: 'pt', specialIntervalSec: 1 };
    let asked = 0;
    const script = command => {
      if (command === FIGHT) return true;
      if (command === 'pt') {
        asked += 1;
        if (asked === 1) say(page, '你要對誰施展這個招式?\n看起來測試怪並不想跟你較量。');
        return true;
      }
      return command === 'kill 1';
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'pt') >= 3, 4000), 'special attacks continue once the fight really starts');
    assert.equal(countOf(game, 'kill 1'), 1);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('fight: a knocked-out monster is not a target, and a room with only knocked-out ticked monsters counts as done', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const other = '另一隻怪(other mob)';
    page.store.mapMonsters = { 't/c': { area: 't', room: 'c', areaName: '測試區', mobs: [MOB, other], seen: 1 } };
    const room = { lines: ['  ※另一隻怪(other mob) <昏迷不醒> [fight][kill]', MOB_LINE] };
    const script = command => {
      if (command === 'fight 2') { say(page, '測試怪死了。'); room.lines.splice(1, 1); return true; }
      return command === 'gc';
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB, other);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight 2', 'gc'], 'the knocked-out one at 1 is never fought; the ticked one is the second monster line');
  } finally {
    page.close();
  }
});

// ---- 票 06：補氣、必填欄位、氣讀不到 ----
ui('heal: eat mode without the eat command, the no-medicine keyword and the home command cannot start, and the panel says which', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = {};
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /吃藥指令、沒藥時遊戲回的字、回家指令/.test(huntText(page)), 3000), huntText(page));
    assert.equal(await hunting(page), false);
    await sleep(200);
    assert.deepEqual(game.log, [], 'nothing was sent');
  } finally {
    page.close();
  }
});

ui('heal: rest mode only needs the home command', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { healMode: 'rest', loopRounds: 'off', prescan: 'off' };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /填：回家指令/.test(huntText(page)), 3000), huntText(page));
    assert.equal(/吃藥指令|沒藥時遊戲回的字/.test(huntText(page)), false);
    page.store.mapHuntSettings = { healMode: 'rest', homeCommand: 'recall', loopRounds: 'off', prescan: 'off' };
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.equal(game.log[0], 'e', 'it walks: nothing makes it rest or eat');
  } finally {
    page.close();
  }
});

ui('heal: in eat mode a low qi while walking sends the eat command before the next step, and not again within 5 seconds', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    setKee(page, 30);
    const game = world(page, { at: 'a', looks: { c: { lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.length >= 1, 3000));
    assert.equal(game.log[0], 'eat pill', 'eaten before the first step');
    await sleep(100);
    assert.equal(countOf(game, 'eat pill'), 1, 'not queued again within the 5 seconds (scaled)');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('heal: when the game says there is no medicine, it goes home, stops and raises one alert', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    setKee(page, 30);
    const script = command => {
      if (command === 'eat pill') { say(page, '你身上沒有藥可以吃了。'); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes('recall'), 4000), game.log.join(','));
    assert.equal(await hunting(page), false);
    assert.equal(alerts(page).length, 1);
    const count = game.log.length;
    await sleep(300);
    assert.equal(game.log.length, count, 'nothing is sent after going home');
  } finally {
    page.close();
  }
});

ui('heal: in rest mode a qi below the rest line waits in place (sending the rest command once) until the qi is back to the resume line', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', restBelow: 50, restResume: 80, restCommand: 'dazuo' };
    setKee(page, 30);
    const game = world(page, { at: 'a', looks: { c: { lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'dazuo') >= 1, 3000), 'the rest command is sent');
    await sleep(600); // 12 秒（縮小後）
    assert.equal(countOf(game, 'dazuo'), 1, 'only once while resting');
    assert.ok(/休息中 30%→80%/.test(huntText(page)), huntText(page));
    assert.equal(game.log.some(command => command === 'e'), false, 'no step while resting');
    setKee(page, 70);
    await sleep(150);
    assert.equal(game.log.some(command => command === 'e'), false, 'still resting below the resume line');
    setKee(page, 90);
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.ok(game.log.includes('e'));
    const log = await huntLog(page);
    assert.match(log, /t\/a 休息 氣 30% 低於休息線 50%，停下來等回到 80%/, 'the hunt log says when and why it rested');
    assert.match(log, /t\/a 休息 送 dazuo/);
    assert.match(log, /t\/a 休息結束 氣回到 90%（要 80%）/);
  } finally {
    page.close();
  }
});

ui('heal: the rest command waits while the character is busy, then goes once', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', restBelow: 50, restResume: 80, restCommand: 'dazuo' };
    setKee(page, 30);
    const doc = page.w.document;
    if (!doc.getElementById('status')) doc.body.insertAdjacentHTML('beforeend', '<span id="status"></span>');
    doc.getElementById('status').textContent = '忙碌';
    const game = world(page, { at: 'a', looks: { c: { lines: [] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    await sleep(400);
    assert.equal(countOf(game, 'dazuo'), 0, 'nothing while busy');
    doc.getElementById('status').textContent = '正常';
    assert.ok(await waitFor(() => countOf(game, 'dazuo') === 1, 3000), game.log.join('|'));
    await sleep(400);
    assert.equal(countOf(game, 'dazuo'), 1, 'and only once');
  } finally {
    page.close();
  }
});

ui('heal: in rest mode the monster being fought is finished, then it rests before the next one', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', restBelow: 50, restResume: 80, dangerBelow: 20 };
    setKee(page, 60);
    const room = { lines: mobsLines(2) };
    const script = command => {
      if (command === FIGHT) { if (countOf(game, FIGHT) === 1) setKee(page, 30); say(page, '測試怪死了。'); return true; }
      if (command === 'gc') { room.lines.shift(); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, FIGHT) === 1 && game.log.at(-1) === 'l', 4000), game.log.join(','));
    await sleep(300);
    assert.equal(countOf(game, FIGHT), 1, 'waits for the qi before the second one');
    assert.ok(/休息中/.test(huntText(page)), huntText(page));
    setKee(page, 90);
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.equal(countOf(game, FIGHT), 2);
  } finally {
    page.close();
  }
});

ui('heal: a qi that cannot be read stops the hunt with an alert before any step', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } } });
    page.w.document.getElementById('kee').remove();
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /讀不到氣/.test(message.reason)), 3000));
    assert.equal(await hunting(page), false);
    assert.deepEqual(game.log, []);
  } finally {
    page.close();
  }
});

ui('heal: a qi that stops being readable in the middle of a fight stops the hunt with an alert', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const script = command => {
      if (command !== FIGHT) return false;
      page.w.document.getElementById('kee').remove();
      return true;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).some(message => /讀不到氣/.test(message.reason)), 4000));
    assert.equal(await hunting(page), false);
    assert.equal(game.log.includes('recall'), false, 'no home command: the qi is simply unknown');
  } finally {
    page.close();
  }
});

ui('heal: the qi dropping while walking makes it rest after that step, and it goes on when the qi is back', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', restBelow: 50, restResume: 80, dangerBelow: 20 };
    setKee(page, 60);
    const script = command => {
      if (command === 'e' && countOf(game, 'e') === 1) setKee(page, 30);
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: [] } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /休息中/.test(huntText(page)), 3000), huntText(page));
    await sleep(300);
    assert.equal(countOf(game, 'e'), 1, 'the step that was under way finishes, no further step while resting');
    setKee(page, 90);
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.equal(countOf(game, 'e'), 2);
  } finally {
    page.close();
  }
});

ui('heal: stopping while it waits for the qi between two monsters sends nothing more, even when the qi comes back', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', restBelow: 50, restResume: 80, dangerBelow: 20 };
    setKee(page, 60);
    const room = { lines: mobsLines(2) };
    const script = command => {
      if (command === FIGHT) { setKee(page, 30); say(page, '測試怪死了。'); return true; }
      if (command === 'gc') { room.lines.shift(); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /休息中/.test(huntText(page)), 4000), huntText(page));
    click(page, '.hstop');
    const count = game.log.length;
    setKee(page, 95);
    await sleep(400);
    assert.equal(game.log.length, count, 'the stopped hunt does not wake up');
    assert.equal(await hunting(page), false);
  } finally {
    page.close();
  }
});

ui('heal: a no-medicine sentence long after the eat command went out is not taken as the answer', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    setKee(page, 30);
    const script = command => {
      if (command === 'eat pill') { setKee(page, 100); return true; }
      return command === FIGHT;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    const keepAlive = page.w.setInterval(() => say(page, '…'), 100);
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes('eat pill') && game.log.includes(FIGHT), 3000));
    await sleep(800); // 10 秒縮小 20 倍 = 500 毫秒
    say(page, '你身上沒有藥了。');
    await sleep(200);
    assert.equal(game.log.includes('recall'), false);
    assert.equal(await hunting(page), true, 'still fighting');
    page.w.clearInterval(keepAlive);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('heal: a danger line at or above the rest line is brought below it', async () => {
  require('../../../catworld-auto-command/map-hunt.js');
  const normalized = globalThis.CatworldMapHunt.normalizeSettings({ restBelow: 30, dangerBelow: 40 });
  assert.equal(normalized.restBelow, 30);
  assert.equal(normalized.dangerBelow, 20, 'the default 20 is already below 30');
  assert.equal(globalThis.CatworldMapHunt.normalizeSettings({ restBelow: 10, dangerBelow: 40 }).dangerBelow, 9);
  assert.equal(globalThis.CatworldMapHunt.normalizeSettings({ restBelow: 2, dangerBelow: 50 }).dangerBelow, 1);
});

ui('fight: a monster that is only knocked out is finished with kill before the corpse is taken; a monster that dies straight away gets no extra kill', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const room = { lines: mobsLines(2) };
    let knocked = false;
    const script = command => {
      if (command === FIGHT) { say(page, knocked ? '測試怪死了。' : KO_LINE); knocked = true; return true; }
      if (command === 'kill 1') { say(page, '測試怪死了。'); return true; }
      if (command === 'gc') { room.lines.shift(); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'kill 1', 'gc', 'l', FIGHT, 'gc'], 'knocked out: kill, then gc; the second one died at once: no kill');
  } finally {
    page.close();
  }
});

ui('fight: with the finishing switched off a knocked-out monster goes straight to the after-kill command', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, finishKnockedOut: 'off' };
    const script = command => {
      if (command === FIGHT) { say(page, KO_LINE); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc']);
  } finally {
    page.close();
  }
});

ui('fight: the finishing kill does not send the special attack, and a knocked-out sentence does not end it, only the death sentence does', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, specialCommand: 'pt', specialIntervalSec: 1 };
    let kills = 0;
    const script = command => {
      if (command === FIGHT) { say(page, KO_LINE); return true; }
      if (command === 'kill 1') {
        kills += 1;
        setTimeout(() => say(page, kills === 1 ? KO_LINE : '測試怪死了。'), 0);
        return true;
      }
      return command === 'pt';
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes('kill 1'), 4000));
    const ptBefore = countOf(game, 'pt');
    await sleep(300);
    assert.equal(countOf(game, 'pt'), ptBefore, 'no special attack while finishing');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

ui('assist: the position form is used there too', async () => {
  const page = await assistPage();
  try {
    const game = world(page, { at: 'a', looks: { c: { lines: ['  ※另一隻怪(other mob) [fight][kill]', MOB_LINE] } }, script: command => {
      if (command === 'fight 2') { setTimeout(() => lookOut(page), 50); return true; }
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight 2']);
  } finally {
    page.close();
  }
});

ui('assist: the command that starts a fight is the setting there too', async () => {
  const page = await assistPage({ fightCommand: 'f' });
  try {
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: command => {
      if (command === 'f 1') { setTimeout(() => lookOut(page), 50); return true; }
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'f 1']);
  } finally {
    page.close();
  }
});

ui('assist: it sends fight once, nothing else about the fight, and moves on when an l it sees has no monster left', async () => {
  const page = await assistPage();
  try {
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: command => {
      if (command.startsWith('fight ')) { setTimeout(() => lookOut(page), 50); return true; }
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT], 'no gc, no special, no kill, no eating');
    const { text } = await page.ask({ type: 'HUNT_LOG' });
    assert.match(text, /只下fight 剛到房間或逾時自己看：看到 .*✓.*→ 送 fight/, 'the log says what the first l showed and why fight was sent');
    assert.match(text, /只下fight 被動看到：看到 沒有怪.*→ 沒有可打的怪，換格/, 'and what the l after the kill showed');
  } finally {
    page.close();
  }
});

ui('assist: a second monster in the room gets another fight, but not while one is fighting', async () => {
  const page = await assistPage();
  try {
    let fights = 0;
    let idleLookShown = false;
    let earlySecondFight = false;
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(2) } }, script: command => {
      if (!command.startsWith('fight ')) return false;
      fights += 1;
      if (fights === 1) setTimeout(() => lookOut(page, [MOB_FIGHTING, MOB_LINE]), 50);
      if (fights === 1) setTimeout(() => { idleLookShown = true; say(page, '測試怪死了。'); lookOut(page, [MOB_LINE]); }, 200);
      if (fights === 2) { earlySecondFight = !idleLookShown; setTimeout(() => lookOut(page), 50); }
      return true;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.equal(countOf(game, FIGHT), 2, 'one fight per monster');
    assert.equal(earlySecondFight, false, 'the second fight waits until nobody is fighting');
  } finally {
    page.close();
  }
});

ui('assist: a monster that is knocked out but not dead yet is waited for, so the next one is not fought before it dies', async () => {
  const page = await assistPage();
  try {
    const KO_MOB = '  ※測試怪(test mob) <昏迷不醒> [fight][kill]';
    let fights = 0;
    let deadLookShown = false;
    let earlySecondFight = false;
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(2) } }, script: command => {
      if (!command.startsWith('fight ')) return false;
      fights += 1;
      if (fights === 1) setTimeout(() => lookOut(page, [KO_MOB, MOB_LINE]), 50);
      if (fights === 1) setTimeout(() => { deadLookShown = true; say(page, '測試怪死了。'); lookOut(page, [MOB_LINE]); }, 200);
      if (fights === 2) { earlySecondFight = !deadLookShown; setTimeout(() => lookOut(page), 50); }
      return true;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.equal(countOf(game, FIGHT), 2);
    assert.equal(earlySecondFight, false, 'the second fight waited until the knocked-out one was gone');
  } finally {
    page.close();
  }
});

ui('assist: after a fight the next one waits for the death sentence, even when the l shows nobody fighting and nobody knocked out', async () => {
  const page = await assistPage();
  try {
    let fights = 0;
    let deadSaid = false;
    let earlySecondFight = false;
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(2) } }, script: command => {
      if (!command.startsWith('fight ')) return false;
      fights += 1;
      if (fights === 1) {
        setTimeout(() => lookOut(page, ['  ※測試怪(test mob) <忙碌中> [fight][kill]', MOB_LINE]), 50); // 第一隻標「忙碌中」、第二隻沒標狀態：只看 l 會以為沒人在打
        setTimeout(() => { deadSaid = true; say(page, '測試怪死了。'); }, 150);
        setTimeout(() => lookOut(page, [MOB_LINE]), 200);
      }
      if (fights === 2) { earlySecondFight = !deadSaid; setTimeout(() => lookOut(page), 50); }
      return true;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.equal(countOf(game, FIGHT), 2);
    assert.equal(earlySecondFight, false, 'no second fight before the death sentence');
  } finally {
    page.close();
  }
});

ui('assist: when the death sentence comes and the triggers send no l, it looks by itself a few seconds later and goes on to the next monster', async () => {
  const page = await assistPage({ fightTimeoutSec: 30 });
  try {
    const looks = { c: { lines: mobsLines(2) } };
    let fights = 0;
    const game = world(page, { at: 'a', looks, script: command => {
      if (!command.startsWith('fight ')) return false;
      fights += 1;
      if (fights === 1) setTimeout(() => { looks.c.lines.splice(0, 1); say(page, '測試怪死了。'); }, 100);
      else { looks.c.lines.length = 0; say(page, '你出手了。'); }
      return true;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.equal(countOf(game, FIGHT), 2);
    assert.ok(countOf(game, 'l') >= 2, 'it looked by itself after the death sentence, not after the whole 30 second timeout');
  } finally {
    page.close();
  }
});

ui('assist: when no l shows up it looks by itself after the timeout and moves on if the room is empty', async () => {
  const page = await assistPage();
  try {
    const looks = { c: { lines: mobsLines(1) } };
    const game = world(page, { at: 'a', looks, script: command => {
      if (command.startsWith('fight ')) looks.c.lines.length = 0; // 觸發規則打死了，但沒有人送 l
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'l'], 'it looked once by itself');
  } finally {
    page.close();
  }
});

for (const spam of [false, true]) {
ui(`assist: an i the user triggers that is over the limit sends the hunt to the sort, then it fights on${spam ? ' (even when fight output keeps coming and never goes quiet)' : ''}`, async () => {
  const page = await sortPage({ fightMode: 'assist', eatCommand: '', noMedicineKeyword: '', fightTimeoutSec: 5 });
  try {
    const state = sortState({ load: 40 });
    const looks = { c: { lines: mobsLines(1) } };
    const base = sortScript(page, state);
    let fights = 0;
    const game = world(page, { at: 'a', looks, script: (command, env) => {
      if (command.startsWith('fight ')) {
        fights += 1;
        if (fights === 1) setTimeout(() => {
          state.load = 95;
          say(page, '你身上帶著下列這些東西( 載重 95% ):\n    布條(cloth piece)');
          // 載重行之後戰鬥輸出一直來、超過緩衝大小也不靜止：不能等靜止才看載重
          if (spam) { let n = 0; const timer = setInterval(() => { say(page, `${'你揮拳打中怪物，'.repeat(12)}\n`); if ((n += 1) >= 120) clearInterval(timer); }, 5); }
        }, 50);
        else { looks.c.lines.length = 0; setTimeout(() => lookOut(page), 50); }
        return true;
      }
      return base(command, env);
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 15000), huntText(page));
    assert.equal(countOf(game, FIGHT), 2);
    assert.ok(game.log.indexOf('sell all') > game.log.indexOf(FIGHT) && game.log.lastIndexOf(FIGHT) > game.log.indexOf('sell all'), game.log.join(','));
    assert.deepEqual(state.secured, ['black armor']);
  } finally {
    page.close();
  }
});
}

ui('assist: low qi eats when an eat command is set (and not when it is blank), and under the danger line it goes home and stops', async () => {
  const low = await assistPage({ eatCommand: 'eat pill', noMedicineKeyword: '沒有藥' });
  try {
    setKee(low, 40);
    const game = world(low, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: command => { if (command.startsWith('fight ')) { setTimeout(() => lookOut(low), 50); return true; } return false; } });
    await pick(low, MOB);
    click(low, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(low)), 8000), huntText(low));
    assert.ok(game.log.includes('eat pill'), 'it eats even though the fight itself is the triggers business');
  } finally {
    low.close();
  }
  const blank = await assistPage();
  try {
    setKee(blank, 40);
    const game = world(blank, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: command => { if (command.startsWith('fight ')) { setTimeout(() => lookOut(blank), 50); return true; } return false; } });
    await pick(blank, MOB);
    click(blank, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(blank)), 8000), huntText(blank));
    assert.equal(game.log.some(command => /eat/.test(command)), false, 'no eat command set, nothing to send');
  } finally {
    blank.close();
  }
  const danger = await assistPage();
  try {
    setKee(danger, 10);
    const game = world(danger, { at: 'a', looks: { c: { lines: mobsLines(1) } } });
    await pick(danger, MOB);
    click(danger, '.hstart');
    assert.ok(await waitFor(() => alerts(danger).some(message => /氣只剩 10%/.test(message.reason)), 5000), JSON.stringify(alerts(danger)));
    assert.ok(await waitFor(() => game.log.includes('recall'), 3000));
    assert.equal(game.log.includes(FIGHT), false);
  } finally {
    danger.close();
  }
});

ui('assist rest: a qi below the rest line is waited out before the fight goes out (rest command once), and the fight goes out once the qi is back', async () => {
  const page = await assistPage(REST);
  try {
    setKee(page, 100);
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: dropsAtFirstLook(page, endsAfterFight(page)) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'dazuo') >= 1, 4000), 'the rest command is sent');
    await sleep(600);
    assert.equal(countOf(game, 'dazuo'), 1, 'only once while resting');
    assert.equal(countOf(game, FIGHT), 0, 'no fight while the qi is low');
    assert.equal(countOf(game, 'l'), 1, 'and no looking around while it rests');
    setKee(page, 70);
    await sleep(600);
    assert.equal(countOf(game, FIGHT), 0, 'still below the resume line');
    setKee(page, 90);
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.equal(countOf(game, FIGHT), 1, 'the fight goes out once the qi is back');
  } finally {
    page.close();
  }
});

ui('assist rest: the qi is judged again before the next monster, after the first one died', async () => {
  const page = await assistPage(REST);
  try {
    setKee(page, 90);
    let fights = 0;
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(2) } }, script: command => {
      if (!command.startsWith('fight ')) return false;
      fights += 1;
      if (fights === 1) setTimeout(() => { setKee(page, 20); say(page, '測試怪死了。'); lookOut(page, [MOB_LINE]); }, 80); // 打第一隻時氣掉到 20，死了之後還有一隻
      if (fights === 2) setTimeout(() => lookOut(page), 50);
      return true;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'dazuo') >= 1, 6000), 'it rests before the second monster');
    assert.equal(countOf(game, FIGHT), 1, 'the second fight is held back');
    setKee(page, 95);
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.equal(countOf(game, FIGHT), 2);
  } finally {
    page.close();
  }
});

ui('assist rest: a monster that is fighting is not a reason to rest, the rest waits until nobody is fighting', async () => {
  const page = await assistPage(REST);
  try {
    setKee(page, 100);
    let fightOver = false; // 戰鬥結束之後，引擎自己送的 l 也要看到怪沒在戰鬥中（真實遊戲不會一直回「戰鬥中」）
    const dropped = dropsAtFirstLook(page, command => {
      if (command === 'l' && fightOver) { setTimeout(() => lookOut(page, [MOB_LINE]), 20); return true; }
      return false;
    });
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_FIGHTING] } }, script: dropped });
    await pick(page, MOB);
    click(page, '.hstart');
    await sleep(900);
    assert.equal(countOf(game, 'dazuo'), 0, 'no rest command while a monster is fighting');
    assert.equal(countOf(game, FIGHT), 0);
    fightOver = true;
    lookOut(page, [MOB_LINE]); // 戰鬥結束、怪還在
    assert.ok(await waitFor(() => countOf(game, 'dazuo') >= 1, 4000), 'now it can rest');
    assert.equal(countOf(game, FIGHT), 0);
  } finally {
    page.close();
  }
});

ui('assist rest: with enough qi nothing changes, and in eat mode the qi never holds the fight back', async () => {
  const full = await assistPage(REST);
  const eat = await assistPage({ healMode: 'eat', eatCommand: '', noMedicineKeyword: '' });
  try {
    setKee(full, 100);
    setKee(eat, 20);
    const a = world(full, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: endsAfterFight(full) });
    const b = world(eat, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: endsAfterFight(eat) });
    await pick(full, MOB);
    await pick(eat, MOB);
    click(full, '.hstart');
    click(eat, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(full)) && /巡完了/.test(huntText(eat)), 8000), huntText(full) + ' / ' + huntText(eat));
    assert.deepEqual([countOf(a, 'dazuo'), countOf(a, FIGHT)], [0, 1]);
    assert.deepEqual([countOf(b, 'dazuo'), countOf(b, FIGHT)], [0, 1]);
  } finally {
    full.close();
    eat.close();
  }
});

ui('counter: a monster that attacks on the way is fought back with the kill command, then the walk goes on', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('d');
    const game = ambushWorld(page);
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log.slice(0, 4), ['e', 'l', 'kill 1', 'gc'], 'stopped in b, looked, killed the monster marked <戰鬥中> by its position, looted');
    assert.equal(game.at, 'd', 'then walked on to the target');
    assert.equal(countOf(game, FIGHT), 1, 'and fought the chosen monster there');
    const { text } = await page.ask({ type: 'HUNT_LOG' });
    assert.match(text, /t\/b 被攻擊 腐屍/);
    assert.match(text, /t\/b 反擊 腐屍\(zombie\)/);
  } finally {
    page.close();
  }
});

ui('counter: when several monsters attack in a target room, gc waits until l shows none in <戰鬥中>, and the one knocked out meanwhile is finished', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const FIGHTING = '  ※測試怪(test mob) <戰鬥中> [fight][kill]';
    const OUT = '  ※測試怪(test mob) <昏迷不醒> [fight][kill]';
    const ATTACK = '看起來測試怪想殺死你！';
    let fights = 0;
    // 使用者貼的工具室：三隻同名的怪一進門就打你；打死第一隻時另一隻被自動戰鬥打昏、第三隻還在打你
    const game = world(page, { at: 'a', arrivals: { c: { lines: [MOB_LINE, MOB_LINE, MOB_LINE, ATTACK, ATTACK, ATTACK] } }, looks: { c: { lines: [] } }, script: (command, { say, looks }) => {
      if (command === FIGHT) {
        fights += 1;
        looks.c.lines = fights === 1 ? [FIGHTING, OUT] : [OUT];
        say('測試怪死了。');
        return true;
      }
      if (command === 'kill 1') { looks.c.lines = []; say('測試怪死了。'); return true; }
      return command === 'gc';
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log.slice(2), [FIGHT, 'l', FIGHT, 'l', 'gc', 'gc', 'kill 1', 'gc'], 'no gc while one is still fighting; both corpses taken once l shows nobody fighting; the knocked-out one finished with kill');
  } finally {
    page.close();
  }
});

ui('corpse: when the position hits a corpse, the hunt counts the corpses from then on, finishes the knocked-out one and loots every corpse', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const FIGHTING = '  ※測試怪(test mob) <戰鬥中> [fight][kill]';
    const OUT = '  ※測試怪(test mob) <昏迷不醒> [fight][kill]';
    const ATTACK = '看起來測試怪想殺死你！';
    const game = world(page, { at: 'a', arrivals: { c: { lines: [MOB_LINE, MOB_LINE, MOB_LINE, ATTACK, ATTACK, ATTACK] } }, looks: { c: { lines: [] } }, script: (command, { say, looks }) => {
      const lines = looks.c.lines;
      const at = Number(command.split(' ')[1]); // 遊戲連屍體一起數
      if (/^(fight|kill) \d+$/.test(command) && game.at === 'c') {
        if (!lines.length) { looks.c.lines = [CORPSE_LINE, FIGHTING, OUT]; say('測試怪死了。'); return true; }
        if (lines[at - 1] === CORPSE_LINE) { say(NOT_ALIVE_LINE); return true; }
        lines[at - 1] = CORPSE_LINE;
        say('測試怪死了。');
        return true;
      }
      return command === 'gc';
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log.slice(2), [FIGHT, 'l', FIGHT, 'l', 'fight 2', 'l', 'gc', 'gc', 'kill 1', 'l', 'kill 3', 'gc'],
      'fight 1 on the corpse → looks again and fights 2; kill 1 on the corpse → kill 3; three corpses, three gc');
    const { text } = await page.ask({ type: 'HUNT_LOG' });
    assert.match(text, /順位數到屍體 fight 之後連屍體一起數/);
    assert.match(text, /順位數到屍體 kill 之後連屍體一起數/);
  } finally {
    page.close();
  }
});

ui('corpse: a gc refused because a fight is still on is sent again after the room is looked at again', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const ATTACK = '看起來測試怪想殺死你！';
    let gcs = 0;
    const game = world(page, { at: 'a', arrivals: { c: { lines: [MOB_LINE, ATTACK, ATTACK] } }, looks: { c: { lines: [] } }, script: (command, { say, looks }) => {
      if (command === FIGHT) { looks.c.lines = [CORPSE_LINE]; say('測試怪死了。'); return true; }
      if (command === 'gc') { gcs += 1; say(gcs === 1 ? '你還在戰鬥中！只能一次拿一樣。' : '你從屍體上拿到東西。'); return true; }
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log.slice(2), [FIGHT, 'l', 'gc', 'l', 'gc']);
    const { text } = await page.ask({ type: 'HUNT_LOG' });
    assert.match(text, /撿屍被拒 1 次/);
  } finally {
    page.close();
  }
});

ui('counter: with the setting off, an attack on the way is not answered', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapHuntSettings.counterAttack = 'off';
    page.store.mapMonsters = mobsAt('d');
    const game = ambushWorld(page);
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.equal(countOf(game, 'kill 1'), 0);
    assert.deepEqual(game.log.slice(0, 3), ['e', 'e', 'e'], 'walked straight through b');
  } finally {
    page.close();
  }
});

ui('counter: the monster being fought saying it wants to kill you is not an ambush, and costs no extra l', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE] } }, script: (command, { say, looks }) => {
      if (!command.startsWith('fight ')) return false;
      looks.c.lines = [];
      say('看起來測試怪想殺死你！');
      say('測試怪死了。');
      return true;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc']);
  } finally {
    page.close();
  }
});

ui('suggest: idle answers with the suggested aliases of the verb, and nothing is suggested for kill', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const game = world(page, { at: 'a', script: (command, { say: tell }) => {
      if (command === 'alias') { tell(ALIAS_LIST.split('== 未完')[0].trimEnd()); return true; }
      return false;
    } });
    const reply = await page.ask({ type: 'HUNT_SUGGEST_ALIAS', verb: 'fight' });
    assert.equal(reply.ok, true);
    assert.equal(reply.empty, false);
    assert.ok(reply.items.some(item => item.name === 'f' && item.rank === 'ok'));
    assert.equal(countOf(game, 'alias'), 1);
    const none = await page.ask({ type: 'HUNT_SUGGEST_ALIAS', verb: 'kill' });
    assert.equal(none.items.length, 0);
  } finally {
    page.close();
  }
});

ui('suggest: refused while the hunt is running, and nothing is sent', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('d');
    page.store.mapHuntSettings = { ...REQUIRED, commandGapMinMs: 2000, commandGapMaxMs: 2000 };
    const game = world(page, { at: 'a' });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => hunting(page), 2000));
    const reply = await page.ask({ type: 'HUNT_SUGGEST_ALIAS', verb: 'fight' });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /巡怪/);
    assert.equal(countOf(game, 'alias'), 0);
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

// ---- 結束的字要和這隻怪的名字在同一行：同房間別的怪（或別人的戰鬥）「死了」不能當成我這隻死了 ----
ui('fight: another monster dying in the room does not end the fight with mine; only a line with my monster\'s name does', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    let mineDead = false;
    let corpseAfterDeath = null;
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE, '  ※另一隻怪(other mob) [fight][kill]'] } }, script: (command, { say: tell }) => {
      if (command === 'fight 1') {
        tell('另一隻怪死了。'); // 別人打的那一隻
        setTimeout(() => { mineDead = true; say(page, '測試怪腳下一個不穩，跌在地上死了。'); }, 150);
        return true;
      }
      if (command === 'gc') { corpseAfterDeath = mineDead; return false; }
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.equal(corpseAfterDeath, true, 'the corpse command waited for my monster\'s own death line');
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight 1', 'gc']);
  } finally {
    page.close();
  }
});

ui('fight: something leaving right after the room was read makes it look again before the fight, so the position is not stale', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    let looked = 0;
    const game = world(page, { at: 'a', looks: { c: { lines: [DOG_LINE, MOB_LINE] } }, script: (command, { say: tell, looks }) => {
      if (command !== 'l' || (looked += 1) > 1) return false;
      tell(['測試房間 - ', '    這裡明顯的出口是 east。', DOG_LINE, MOB_LINE].join('\n'));
      tell('> 野狗往北離開。'); // 和使用者貼的真實輸出一樣，緊接在描述後面
      looks.c.lines = [MOB_LINE];
      return true;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'l', 'fight 1', 'gc'], 'looked again and fought my monster at its new position');
  } finally {
    page.close();
  }
});

ui('fight: something leaving while waiting to react makes it look again before the fight', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, reactMinMs: 4000, reactMaxMs: 4000 };
    let looked = 0;
    const game = world(page, { at: 'a', looks: { c: { lines: [DOG_LINE, MOB_LINE] } }, script: (command, { looks }) => {
      if (command === 'l' && (looked += 1) === 1) setTimeout(() => { looks.c.lines = [MOB_LINE]; say(page, '> 野狗往北離開。'); }, 40);
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'l', 'fight 1', 'gc']);
  } finally {
    page.close();
  }
});

ui('fight: when the fight lands on another monster, it waits for that one to fall, then looks again and fights mine', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, specialCommand: 'ps', specialIntervalSec: 1 };
    let fights = 0;
    const game = world(page, { at: 'a', looks: { c: { lines: [DOG_LINE, MOB_LINE] } }, script: (command, { say: tell, looks }) => {
      if (!command.startsWith('fight ')) return command === 'ps';
      if ((fights += 1) === 1) {
        tell('你對著野狗說道：領教高招！'); // 順位偏了，打到野狗
        setTimeout(() => { looks.c.lines = ['  ※野狗(dog) <昏迷不醒> [fight][kill]', MOB_LINE]; say(page, '野狗腳下一個不穩，跌在地上一動也不動了。'); }, 30);
      } else {
        tell('你對著測試怪說道：領教高招！');
        setTimeout(() => say(page, '測試怪死了。'), 30);
      }
      return true;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    const after = game.log.slice(game.log.indexOf('fight 2'));
    assert.deepEqual(after.filter(command => command !== 'ps'), ['fight 2', 'l', 'fight 2', 'gc'], game.log.join(' '));
    assert.match(await huntLog(page), /打到別隻 野狗/);
  } finally {
    page.close();
  }
});

ui('fight: a special refused because nobody is fighting is not sent again in that fight', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, specialCommand: 'ps', specialIntervalSec: 1, fightTimeoutSec: 600 };
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE] } }, script: (command, { say: tell }) => {
      if (command === 'fight 1') { setTimeout(() => say(page, '測試怪死了。'), 800); return true; }
      if (command === 'ps') { tell('「牛蛇奧義擊」只能對戰鬥中的對手使用。'); return true; }
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.equal(game.log.filter(command => command === 'ps').length, 1, game.log.join(' '));
  } finally {
    page.close();
  }
});

ui('assist: another monster dying in the room is not taken as mine dying', async () => {
  const page = await assistPage({ fightTimeoutSec: 60 });
  try {
    const game = world(page, { at: 'a', looks: { c: { lines: [MOB_LINE, '  ※另一隻怪(other mob) [fight][kill]'] } }, script: (command, { say: tell }) => {
      if (command === 'fight 1') { tell('另一隻怪死了。'); return true; }
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes('fight 1'), 4000));
    await sleep(400); // 誤判成死了的話，3 秒（縮小後 150 ms）就會自己送 l 再看一次
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight 1'], 'still waiting for my monster');
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});

// ---- 看完房間到開打的反應時間（reactMinMs～reactMaxMs）：完整模式與只下 fight 模式都用；測試共用設定是 0～0 ----
ui('react: in full mode the fight starts a reaction time after the room was read, while walking keeps the plain command gap', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, reactMinMs: 3000, reactMaxMs: 3000 };
    const times = {};
    world(page, { at: 'a', looks: { c: { lines: [MOB_LINE] } }, script: command => { (times[command] ??= []).push(Date.now()); return false; } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    const wait = times['fight 1'][0] - times.l[0];
    assert.ok(wait >= 3000 / SCALE - 10, `the fight waited for the reaction time after the look (${wait} ms)`);
    assert.ok(times.e[1] - times.e[0] < 3000 / SCALE - 10, 'walking is not slowed by it');
  } finally {
    page.close();
  }
});

ui('react: in only-send-fight mode the fight also waits the reaction time after the look', async () => {
  const page = await assistPage({ reactMinMs: 3000, reactMaxMs: 3000 });
  try {
    const times = {};
    world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: command => {
      (times[command] ??= []).push(Date.now());
      if (command === 'fight 1') { setTimeout(() => lookOut(page), 50); return true; }
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    const wait = times['fight 1'][0] - times.l[0];
    assert.ok(wait >= 3000 / SCALE - 10, `the fight waited for the reaction time (${wait} ms)`);
    assert.equal(times['fight 1'].length, 1, 'one fight, not two while waiting');
  } finally {
    page.close();
  }
});

// 順位過期：遊戲回「你想攻擊誰？」（那個順位沒有東西）就馬上重看房間再打，不等逾時；休息回氣之後開打前也先重看（休息時房間可能變了）

ui('fight: when the game answers 你想攻擊誰 the position is stale, so it looks again at once and fights the new position', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const looks = { c: { lines: [OTHER_LINE, MOB_LINE] } };
    const times = {};
    const game = world(page, {
      at: 'a', looks,
      script: (command, { say: tell }) => {
        (times[command] ??= []).push(Date.now());
        if (command === 'fight 2') { looks.c.lines = [MOB_LINE]; tell('你想攻擊誰？'); return true; }
        return false;
      },
    });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    const at = game.log.indexOf('fight 2');
    assert.deepEqual(game.log.slice(at, at + 3), ['fight 2', 'l', 'fight 1'], game.log.join(','));
    assert.ok(times['fight 1'][0] - times['fight 2'][0] < 1500, 'did not wait for the fight timeout');
    assert.match(await huntLog(page), /順位沒有東西/);
  } finally {
    page.close();
  }
});

ui('fight: kill answering 你想殺誰 is a stale position too, so it looks again at once and does not wait for the fight timeout', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...page.store.mapHuntSettings, killCommand: 'k', refuseKeyword: '不想和你打' };
    const looks = { c: { lines: [OTHER_LINE, MOB_LINE] } };
    const times = {};
    const game = world(page, {
      at: 'a', looks,
      script: (command, { say: tell }) => {
        (times[command] ??= []).push(Date.now());
        if (command === 'fight 2') { tell('測試怪不想和你打。'); return true; }
        if (command === 'k 2') { looks.c.lines = [MOB_LINE]; tell('你想殺誰？'); return true; }
        return false;
      },
    });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    const at = game.log.indexOf('k 2');
    assert.ok(at >= 0, game.log.join(','));
    assert.deepEqual(game.log.slice(at, at + 3), ['k 2', 'l', 'fight 1'], game.log.join(','));
    assert.ok(times['fight 1'][0] - times['k 2'][0] < 1500, 'did not wait for the fight timeout');
    assert.match(await huntLog(page), /順位沒有東西/);
  } finally {
    page.close();
  }
});

ui('fight: finishing a knocked-out monster that was not picked sends the kill again when the first one never landed', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('d');
    const OUT = '  ※腐屍(zombie) <昏迷不醒> [fight][kill]';
    let kills = 0;
    const game = world(page, { at: 'a', arrivals: { b: { lines: [ZOMBIE, ATTACK_LINE] } }, looks: { b: { lines: [ZOMBIE_FIGHTING] }, d: { lines: [MOB_LINE] } }, script: (command, { say, looks }) => {
      if (command === 'kill 1' && game.at === 'b') {
        kills += 1;
        if (kills === 1) { looks.b.lines = [OUT]; say('腐屍一動也不動了。'); } // 打昏
        else if (kills === 3) { looks.b.lines = []; say('腐屍死了。'); } // 第二次補刀才打到
        else say('你的攻擊落了空。'); // 第一次補刀沒打到：怪還躺著（有回應，看門狗才不會停）
        return true;
      }
      if (command.startsWith('fight ')) looks[game.at].lines = [];
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    assert.equal(kills, 3, `kill sent again until the monster died: ${game.log.join(',')}`);
    assert.equal(game.at, 'd');
  } finally {
    page.close();
  }
});

ui('fight: 你想攻擊誰 three times in a row skips the room instead of looping', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, {
      at: 'a', looks: { c: { lines: [OTHER_LINE, MOB_LINE] } },
      script: (command, { say: tell }) => { if (command === 'fight 2') { tell('你想攻擊誰？'); return true; } return false; },
    });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => !/走向|看房間|打/.test(huntText(page)) || /巡完了|略過/.test(huntText(page)), 8000), huntText(page));
    assert.ok(await waitFor(async () => /略過 打不到/.test(await huntLog(page)), 8000), (await huntLog(page)).slice(-600));
    assert.equal(game.log.filter(command => command === 'fight 2').length, 3);
  } finally {
    page.close();
  }
});

ui('fight: after resting before a fight, it looks again first, since the room may have changed while it rested', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...page.store.mapHuntSettings, healMode: 'rest', restBelow: 50, restResume: 80, dangerBelow: 10 };
    const looks = { c: { lines: [OTHER_LINE, MOB_LINE] } };
    let looked = 0;
    const game = world(page, {
      at: 'a', looks,
      script: command => { if (command === 'l' && (looked += 1) === 1) setKee(page, 40); return false; },
    });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /休息中/.test(huntText(page)), 6000), huntText(page));
    looks.c.lines = [MOB_LINE]; // 休息的時候前面那隻被別人打死了
    setKee(page, 100);
    assert.ok(await waitFor(() => game.log.some(command => command.startsWith('fight ')), 6000), game.log.join(','));
    const fightAt = game.log.findIndex(command => command.startsWith('fight '));
    assert.equal(game.log[fightAt], 'fight 1', game.log.join(','));
    assert.equal(game.log[fightAt - 1], 'l', 'looked again after the rest');
    assert.match(await huntLog(page), /重數 休息過/);
  } finally {
    page.close();
  }
});

ui('fight: a knocked-out monster that wakes up while being finished is fought normally, with the special attack, and knocked out again it is finished again', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, specialCommand: 'pt', specialIntervalSec: 1 };
    let kills = 0;
    // 使用者貼的真實輸出：被補刀的怪「慢慢睜開眼睛，清醒了過來」，又被打昏時是「跌在地上一動也不動了」
    const script = command => {
      if (command === FIGHT) { say(page, KO_LINE); return true; }
      if (command === 'kill 1') {
        kills += 1;
        setTimeout(() => say(page, kills === 1 ? '測試怪慢慢睜開眼睛，清醒了過來。' : '測試怪死了。'), 0);
        return true;
      }
      if (command === 'pt') { setTimeout(() => say(page, KO_LINE), 0); return true; }
      return command === 'gc';
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), `${huntText(page)} ${game.log.join(',')}`);
    assert.deepEqual(game.log.slice(game.log.indexOf(FIGHT)), [FIGHT, 'kill 1', 'pt', 'kill 1', 'gc'], 'woke: special attack after the interval; knocked out again: finished again; then the corpse');
  } finally {
    page.close();
  }
});

ui('fight: a monster knocked out again while being finished (no wake-up seen) gets the kill again at once, not after the fight timeout', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, fightTimeoutSec: 600 }; // 逾時要 30 秒（SCALE 之後），測試只等 8 秒
    let kills = 0;
    const script = command => {
      if (command === FIGHT) { say(page, KO_LINE); return true; }
      if (command === 'kill 1') {
        kills += 1;
        setTimeout(() => say(page, kills === 1 ? KO_LINE : '測試怪死了。'), 0);
        return true;
      }
      return command === 'gc';
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), `${huntText(page)} ${game.log.join(',')}`);
    assert.deepEqual(game.log.slice(game.log.indexOf(FIGHT)), [FIGHT, 'kill 1', 'kill 1', 'gc']);
  } finally {
    page.close();
  }
});

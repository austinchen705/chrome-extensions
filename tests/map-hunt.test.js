// 地圖巡怪：整個 content script 在 jsdom 裡跑（假的地圖 DOM、假的遊戲：照表移動、每個指令回一行輸出），檢查送出的指令與停止條件。
// 房間的位置靠 #map_anchor 蓋住哪一格判斷（jsdom 算不出排版，所以假的 getBoundingClientRect 依「現在在哪」回傳）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, boot: bootPage, sleep, waitFor, fixture } = require('./helpers/game-page');

const SCALE = 20;
// 開始前必填的欄位（吃藥指令、沒藥關鍵字、回家指令）：各測試預設都填好，要測缺欄位的自己清掉
const REQUIRED = { eatCommand: 'eat pill', noMedicineKeyword: '沒有藥', homeCommand: 'recall', loopRounds: 'off', loadMaxPercent: 0, commandGapMinMs: 0, commandGapMaxMs: 0, reactMinMs: 0, reactMaxMs: 0, sortLookMinSec: 0, sortLookMaxSec: 0, prescan: 'off' };
const boot = async options => {
  const page = await bootPage(options);
  page.store.mapHuntSettings = { ...REQUIRED };
  return page;
};
const MOB = '測試怪(test mob)';
const ROOM = id => `<a class="H7" id="m-t-${id}">□</a>`;
// a─b─c─d 一排
const ROW = ['a', 'b', 'c', 'd'].map(ROOM).join('─');
const MOVES = { a: { e: 'b' }, b: { w: 'a', e: 'c' }, c: { w: 'b', e: 'd' }, d: { w: 'c' } };
const mobsIn = (mob, ...rooms) => Object.fromEntries(rooms.map(room => [`t/${room}`, { area: 't', room, areaName: '測試區', mobs: [mob], seen: 1 }]));
const mobsAt = (...rooms) => mobsIn(MOB, ...rooms);
const MOB_B = '另一隻怪(other mob)';

// 假遊戲：moves[現在][指令] = 下一間（沒有就留在原地）；reply 為 false 時不回任何輸出（看門狗會因為沒回應而停）
// looks[房間] = { exits, lines }：l 的輸出（出口行與後面的怪物、人物行）；silentLook 為 true 時 l 不回應；
// fingers[ID] = finger 的輸出，沒寫就不回應
function world(page, { at, moves = MOVES, reply = true, stuck = false, looks = {}, fingers = {}, silentLook = false, arrivals = {}, arrivalDelayMs = 0, lookDelayMs = 0, script = null, row = ROW, arrivalSplitMs = 0 } = {}) {
  const doc = page.w.document;
  doc.body.insertAdjacentHTML('beforeend', `<div id="map_table"><span id="map_header">地圖 (<span data-default-grid="□">測試區</span>)</span><div id="map_wrapper"><div id="m-t">${row}</div></div><div id="map_anchor"></div></div>`);
  if (!doc.getElementById('kee')) setKee(page, 100); // 氣讀不到會停，預設滿的
  const state = { at, log: [] };
  const rect = (left, top) => ({ left, top, width: 20, height: 20, right: left + 20, bottom: top + 20 });
  doc.getElementById('map_anchor').getBoundingClientRect = () => rect(100, 100);
  doc.querySelectorAll('#map_wrapper a[id]').forEach(node => {
    node.getBoundingClientRect = () => (node.id === `m-t-${state.at}` ? rect(100, 100) : rect(-1000, -1000));
  });
  doc.getElementById('f').addEventListener('submit', () => {
    const command = doc.getElementById('input').value;
    state.log.push(command);
    const next = stuck ? undefined : moves[state.at]?.[command];
    if (next) state.at = next;
    const tell = text => page.output(`<span>${text}\n</span>`);
    if (script?.(command, { game: state, say: tell, looks })) return;
    if (command === 'l') {
      const info = looks[state.at] || {};
      const show = () => page.output(`<span>${['測試房間 - ', '    這裡是房間。', `    這裡明顯的出口是 ${info.exits ?? 'east'}。`, ...(info.lines || [])].join('\n')}\n</span>`);
      if (!silentLook) {
        if (lookDelayMs) setTimeout(show, lookDelayMs);
        else show();
      }
    } else if (command.startsWith('finger ')) {
      if (fingers[command.slice(7)] !== undefined) page.output(`<span>${fingers[command.slice(7)]}\n</span>`);
    } else if (command.startsWith('fight ') || command.startsWith('kill ')) {
      tell('測試怪死了。');
    } else if (command === 'gc') {
      const lines = looks[state.at]?.lines;
      const index = lines ? lines.findIndex(line => line.includes('※')) : -1;
      if (index >= 0) lines.splice(index, 1);
      if (reply) tell('…');
    } else if (next && arrivals[state.at]) {
      const info = arrivals[state.at];
      const head = ['測試房間 - ', '    這裡是房間。', `    這裡明顯的出口是 ${info.exits ?? 'east'}。`];
      // arrivalSplitMs：出口行先到，怪物行等一下才到（描述分成兩個封包）
      const show = () => {
        if (!arrivalSplitMs) { page.output(`<span>${[...head, ...(info.lines || [])].join('\n')}\n</span>`); return; }
        page.output(`<span>${head.join('\n')}\n</span>`);
        setTimeout(() => page.output(`<span>${(info.lines || []).join('\n')}\n</span>`), arrivalSplitMs);
      };
      if (arrivalDelayMs) setTimeout(show, arrivalDelayMs);
      else show();
    } else if (reply) page.output('<span>…\n</span>');
  });
  return state;
}
const panelRoot = page => page.hosts()[0].shadowRoot;
const pickBoxes = page => [...panelRoot(page).querySelectorAll('.hunt-pick-list input')];
// 面板「選怪」展開勾選清單，勾選指定的怪
const openPicker = async (page, ...names) => {
  click(page, '.hpick');
  assert.ok(await waitFor(() => names.every(name => pickBoxes(page).some(box => box.value === name)), 3000), 'the list shows the monsters collected in the visible area');
};
const tick = (page, box, checked) => {
  box.checked = checked;
  box.dispatchEvent(new page.w.Event('change', { bubbles: true }));
};
const pick = async (page, ...names) => {
  await openPicker(page, ...names);
  names.forEach(name => tick(page, pickBoxes(page).find(box => box.value === name), true));
  assert.ok(await waitFor(() => names.every(name => page.store.mapHuntPicks?.t?.includes(name))), 'the ticks are saved');
};
const huntText = page => panelRoot(page).querySelector('.hunt-text').textContent;
// 進行中的那一行只寫「略過 N 間」，哪幾間、為什麼放在那一行的 title
const huntDetail = page => panelRoot(page).querySelector('.hunt-text').title;
const click = (page, selector) => panelRoot(page).querySelector(selector).click();
const alerts = page => page.messages.filter(message => message.type === 'ALERT');

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

const PLAYER_FINGER = '英文代號：    somebody\n姓    名：    某人\n權限等級：    (player)\n';
const NOT_FOUND = '找不到這個人。';
const MOB_LINE = '  ※測試怪(test mob) [fight][kill]';
const PERSON = (id, name = '某人') => `  普通百姓 ${name}(${id}) <發呆中>`;

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

// ---- 票 05：打怪 ----
// 假遊戲預設：fight／kill 立刻印「測試怪死了。」，gc 把房間裡的一隻怪（第一個 ※ 行）清掉；要改行為用 world 的 script
const FIGHT = 'fight 1';
const KO_LINE = '測試怪腳下一個不穩，跌在地上一動也不動了。';
const mobsLines = count => Array.from({ length: count }, () => MOB_LINE);
const setKee = (page, value, max = 100) => {
  const doc = page.w.document;
  if (!doc.getElementById('kee')) doc.body.insertAdjacentHTML('beforeend', '<span id="kee"></span><span id="eff_kee"></span>');
  doc.getElementById('kee').textContent = value;
  doc.getElementById('eff_kee').textContent = max;
};
const hunting = async page => (await page.ask({ type: 'STATUS' })).hunt.on;
const countOf = (game, command) => game.log.filter(item => item === command).length;
const say = (page, text) => page.output(`<span>${text}\n</span>`);

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

const OTHER_LINE = '  ※另一隻怪(other mob) [fight][kill]';
const KNOCKED_LINE = '  ※測試怪(test mob) <昏迷不醒> [fight][kill]';

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
  require('../catworld-auto-command/map-hunt.js');
  const normalized = globalThis.CatworldMapHunt.normalizeSettings({ restBelow: 30, dangerBelow: 40 });
  assert.equal(normalized.restBelow, 30);
  assert.equal(normalized.dangerBelow, 20, 'the default 20 is already below 30');
  assert.equal(globalThis.CatworldMapHunt.normalizeSettings({ restBelow: 10, dangerBelow: 40 }).dangerBelow, 9);
  assert.equal(globalThis.CatworldMapHunt.normalizeSettings({ restBelow: 2, dangerBelow: 50 }).dangerBelow, 1);
});

// ---- 票 07：自動學習出口 ----
const LEARN = { learnExits: 'on' };
const learnPage = async (rooms = ['c']) => {
  const page = await boot({ scale: SCALE });
  page.store.mapMonsters = mobsAt(...rooms);
  page.store.mapHuntSettings = { ...REQUIRED, ...LEARN };
  return page;
};

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

// b 的圖示出口 e 其實不通：真正的路是 u。b 的出口有 west、up、north
const BAD_B = { moves: { ...MOVES, b: { w: 'a', u: 'c' } }, looks: { a: { exits: 'east' }, b: { exits: 'west, up 和 north' }, c: { exits: 'down', lines: [] } } };

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

// 另一個區域的房間（地圖上有，但不是巡怪的區域）
const addOtherArea = (page, game) => {
  const doc = page.w.document;
  doc.getElementById('map_wrapper').insertAdjacentHTML('beforeend', '<div id="m-u"><a class="H7" id="m-u-r1">□</a></div>');
  doc.getElementById('m-u-r1').getBoundingClientRect = () => (game.at === 'r1' ? { left: 100, top: 100, width: 20, height: 20, right: 120, bottom: 120 } : { left: -1000, top: -1000, width: 20, height: 20, right: -980, bottom: -960 });
};

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

// ---- 票 08：輪與輪之間 ----
// 假時鐘：電腦時鐘 = 真正的伺服器時間 − skew + drift，每過一毫秒走 scale 毫秒（等一刻鐘才不用真的等）；
// jump 把兩邊一起往後撥（模擬一輪走了很久），drift 只撥電腦時鐘（模擬時鐘被校正或調整），replyError 是 time 回的秒數誤差
const taipei = ms => {
  const date = new Date(ms + 8 * 3600 * 1000);
  return `小貓時間為丙寅年八月十八日午時。\n台北時間為西元${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${date.getUTCHours()}點${date.getUTCMinutes()}分${date.getUTCSeconds()}秒 (星期三)。`;
};
const fakeClock = (page, startServer, { skewMs = 7 * 60 * 1000, scale = 300 } = {}) => {
  const real0 = Date.now();
  const start = Date.parse(startServer);
  const clock = { jump: 0, drift: 0, replyError: 0, times: 0 };
  clock.server = () => start + (Date.now() - real0) * scale + clock.jump;
  clock.computer = () => clock.server() - skewMs + clock.drift;
  page.w.Date.now = clock.computer;
  return clock;
};
const timeScript = (page, clock, next = () => false) => (command, ...rest) => {
  if (command === 'time') {
    clock.times += 1;
    say(page, taipei(clock.server() + clock.replyError));
    return true;
  }
  return next(command, ...rest);
};
const at = text => Date.parse(`2026-11-04T${text}+08:00`);
const roundPage = async (settings = {}) => {
  const page = await boot({ scale: SCALE });
  page.store.mapMonsters = mobsAt('c');
  page.store.mapHuntSettings = { ...REQUIRED, loopRounds: 'on', ...settings };
  return page;
};
const lookTimer = (clock, times) => command => {
  if (command === 'l') times.push(clock.server());
  return false;
};

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

// ---- 功能開關：預設關閉，設定頁「輔助功能」勾了才出現 ----
const setHuntFeature = (page, on) => {
  page.store.zapFeatures = { hunt: on };
  page.changeListeners.forEach(listener => listener({ zapFeatures: { newValue: page.store.zapFeatures } }, 'local'));
};

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

// ---- 負重：打完怪看 i，超過就執行使用者自己寫的整理指令 ----
const loadScript = (page, state, extra = () => false) => command => {
  if (command === 'i') { say(page, `你身上帶著下列這些東西( 載重 ${state.load}% ):\n    布條(cloth piece)`); return true; }
  return extra(command);
};
const loadPage = async (settings = {}) => {
  const page = await boot({ scale: SCALE });
  page.store.mapMonsters = mobsAt('c');
  page.store.mapHuntSettings = { ...REQUIRED, loadMaxPercent: 90, ...settings };
  return page;
};

ui('load: after a fight it looks at i, and under the limit nothing else happens', async () => {
  const page = await loadPage({ tripCommand: 'go' });
  try {
    const state = { load: 40 };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script: loadScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'i']);
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

ui('learn places: a chosen monster that is not in the room on three visits is dropped from it, and a monster seen there that was never recorded is added', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: [`  ※${MOB_B}`] } } });
    await pick(page, MOB);
    for (let visit = 1; visit <= 3; visit++) {
      assert.deepEqual(page.store.mapMonsters['t/c'].mobs.includes(MOB), true, `still recorded before visit ${visit}`);
      click(page, '.hstart');
      assert.ok(await waitFor(() => /巡完了/.test(huntText(page)) && !panelRoot(page).querySelector('.hstart').disabled, 6000), huntText(page));
      game.at = 'a';
    }
    assert.ok(await waitFor(() => !page.store.mapMonsters['t/c'].mobs.includes(MOB), 2000), 'dropped after the third visit');
    assert.ok(page.store.mapMonsters['t/c'].mobs.includes(MOB_B), 'the monster that was there is learned');
    assert.match(huntText(page), /修正位置/);
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
  require('../catworld-auto-command/map-hunt.js');
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
  require('../catworld-auto-command/map-hunt.js');
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

// 巡怪的指令欄（打完後、回家、吃藥、待命…）也可以寫「@巨集 N」：用到的當下讀遊戲存的那一格換成它的指令，不然 @巨集 10 會原樣送給遊戲，遊戲回「什麼﹖」
const MEMORY_STORAGE = "const mem = {}; Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: key => (key in mem ? mem[key] : null), setItem: (key, value) => { mem[key] = String(value); } } });";
const macroSlots = (row, text) => JSON.stringify(Array.from({ length: 90 }, (_, i) => (i === row - 1 ? ['', text] : 0)));

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

// ---- 街景模式（掃描）：不需要勾怪，走完這一區沒走過的每一間，每間 l 一次並記下走過 ----
const scanClick = page => click(page, '.hscan');
const seenState = (page, key) => page.store.mapVisited?.[key]?.state;

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

ui('scan: monsters seen in a room are recorded there, and a recorded monster that is not seen there starts counting misses', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('b');
    world(page, { at: 'a', looks: { c: { lines: [MOB_LINE] } } });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 6000), huntText(page));
    assert.ok(await waitFor(() => page.store.mapMonsters['t/c']?.mobs.includes(MOB)), 'the monster seen in c is recorded');
    assert.equal(page.store.mapMonsters['t/b']?.miss?.[MOB], 1, 'the monster recorded in b but not seen there has one miss (removed only after three)');
    assert.ok(page.store.mapMonsters['t/b'].mobs.includes(MOB), 'one miss does not remove it');
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

ui('scan: a door that still cannot be passed on the second try marks the rooms behind it as blocked, does not stop the scan and is not an alarm', async () => {
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
    assert.equal(game.log.filter(command => command === 'e').length, 5, 'a to b, then the door tried twice, and once more (twice) at the end; d is never tried because the door edge is dropped');
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

ui('scan: a block that goes away (for example the fight that held you is over) is not remembered, because the failed rooms get a second try at the end', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const moves = { a: { e: 'b' }, b: { w: 'a' }, c: { w: 'b', e: 'd' }, d: { w: 'c' } };
    let attempts = 0;
    const script = (command, { game }) => {
      // a 走到 b 的那一個 e 也算一次（world 先移動才呼叫 script，game.at 已經是 b），所以第 3 次（門的第二次嘗試）之後才打開
      if (command === 'e' && game.at === 'b') { attempts += 1; if (attempts >= 3) moves.b.e = 'c'; }
      return false;
    };
    world(page, { at: 'a', moves, script });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 10000), huntText(page));
    assert.ok(await waitFor(() => ['a', 'b', 'c', 'd'].every(room => seenState(page, `t/${room}`) === 'seen')), JSON.stringify(page.store.mapVisited));
    assert.ok(!Object.values(page.store.mapVisited).some(row => row.state === 'blocked'), 'nothing is remembered as blocked');
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

ui('scan: rooms remembered as blocked are tried again on the next scan (no need to clear anything), and become visited once they work', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapVisited = { 't/a': { at: 1, state: 'seen' }, 't/b': { at: 1, state: 'seen' }, 't/c': { at: 1, state: 'blocked' }, 't/d': { at: 1, state: 'blocked' } };
    const looks = { a: { exits: 'east' }, b: { exits: 'west 和 east' }, c: { exits: 'west 和 east' }, d: { exits: 'west' } };
    const game = world(page, { at: 'a', looks });
    await sleep(150);
    scanClick(page);
    assert.ok(await waitFor(() => /掃描完成/.test(huntText(page)), 8000), huntText(page));
    assert.ok(await waitFor(() => seenState(page, 't/c') === 'seen' && seenState(page, 't/d') === 'seen'), JSON.stringify(page.store.mapVisited));
    assert.ok(game.log.filter(command => command === 'l').length >= 2, game.log.join());
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

// ---- 打怪前補掃：這一區還有沒走過、沒有圖資的房間，先掃一輪（看到的怪補進資料）再開始打 ----
const SCAN_LOOKS = { a: { exits: 'east' }, b: { exits: 'west 和 east' }, c: { exits: 'west 和 east', lines: [MOB_LINE] }, d: { exits: 'west', lines: [MOB_LINE] } };

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

// ---- 自動整理（永動機）：負重超標 → 前往 → 鑑定 → i → secure／give → sell all → 回程 → 繼續巡怪 ----
const ARMOR = '黑羽長風鎧';
const blockOf = (name, primary = 50) => `此物名曰 ：${name}，盔甲類防具\n    防禦力：${primary}/${primary}\n    佩帶條件：經驗 100\n`;
const bagLines = [
  '    牛皮拳套(leather gloves) [view][wield]',
  `    ${ARMOR}(black armor) [view][wear]`,
  ' *  一瓶普洱茶(puer tea)',
  '  ˇ布衣(cloth) [view][remove]',
];
const sortPage = async (settings = {}) => {
  const page = await loadPage({ tripCommand: 'go;identify', returnCommand: 'back', ...settings });
  page.w.document.title = '小明 - 貓的世界';
  return page;
};
// 假背包與商店：i 列出背包；identify 印鑑定區塊；secure／give 回成功字樣（記下對象）；sell all 之後負重降到 20
const sortScript = (page, state) => (command, { game }) => {
  if (command === 'gc') state.load = state.afterFight ?? state.load;
  if (command === 'i') { say(page, `你身上帶著下列這些東西( 載重 ${state.load}% ):\n${bagLines.join('\n')}`); return true; }
  if (command === 'identify') { say(page, state.block ?? blockOf(ARMOR)); return true; }
  if (command.startsWith('secure ')) { state.secured.push(command.slice(7)); say(page, '標記完成。'); return true; }
  if (command.startsWith('give ')) { state.given.push(command); say(page, state.giveReply ?? '你給某人一件黑羽長風鎧。'); return true; }
  if (command === 'sell all') { state.load = 20; say(page, '你把牛皮拳套賣掉，獲得了一兩銀子。'); return true; }
  if (command === 'back' && state.backTo !== undefined) game.at = state.backTo;
  return false;
};
const sortState = extra => ({ load: 95, secured: [], given: [], ...extra });

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

// ---- 只下 fight 模式（fightMode: assist）：戰鬥交給玩家的觸發，巡怪只下第一次 fight、被動看 l 與 i ----
const lookOut = (page, lines = []) => say(page, ['測試房間 - ', '    這裡是房間。', '    這裡明顯的出口是 east。', ...lines].join('\n'));
const assistPage = async (settings = {}) => {
  const page = await boot({ scale: SCALE });
  page.store.mapMonsters = mobsAt('c');
  page.store.mapHuntSettings = { ...REQUIRED, fightMode: 'assist', eatCommand: '', noMedicineKeyword: '', fightTimeoutSec: 5, ...settings };
  return page;
};
const MOB_FIGHTING = '  ※測試怪(test mob) <戰鬥中> [fight][kill]';

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

// ---- 每輪摘要：每一輪結束時寫進巡怪紀錄（路線、指令、用真正送出時間算的間隔、看了幾間有怪幾間、是否和上一輪相同）----
const huntLog = async page => (await page.ask({ type: 'HUNT_LOG' })).text;
const summaryLines = text => text.split('\n').filter(line => /輪摘要/.test(line));

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

// ---- 擬人化：每輪路線隨機與抖動（隨機數固定成 r.value，測試可以指定要哪個分支）----
const lineWorld = ids => ({
  row: ids.map(ROOM).join('─'),
  moves: Object.fromEntries(ids.map((id, i) => [id, { ...(i > 0 && { w: ids[i - 1] }), ...(i < ids.length - 1 && { e: ids[i + 1] }) }])),
});
const DIAMOND = {
  row: `${ROOM('a')}─${ROOM('b')}\n│　│\n${ROOM('c')}─${ROOM('d')}`,
  moves: { a: { e: 'b', s: 'c' }, b: { w: 'a', s: 'd' }, c: { n: 'a', e: 'd' }, d: { n: 'b', w: 'c' } },
};
const pinRandom = (page, value) => {
  const r = { value };
  page.w.Math.random = () => r.value;
  return r;
};
const visitOrder = text => [...text.matchAll(/t\/(\w+) 看房間/g)].map(match => match[1]);
// 在 map（lineWorld 或 DIAMOND）上從 at 出發，目標房間各有一隻怪，跑完一輪；回傳巡怪紀錄與送出的指令
const huntOnce = async ({ map, at, targets, humanize = 'on', r = 0.5, settings = {}, timed = false, worldOptions = {} }) => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt(...targets);
    page.store.mapHuntSettings = { ...REQUIRED, humanize, ...settings };
    // timed：假時鐘和計時器同一個倍率，times 記下遊戲真正收到每個指令的時間（伺服器時間毫秒）
    const clock = timed ? fakeClock(page, '2026-11-04T10:00:00+08:00', { scale: SCALE }) : null;
    const times = [];
    pinRandom(page, r);
    const game = world(page, {
      at,
      ...map,
      looks: Object.fromEntries(targets.map(id => [id, { lines: [MOB_LINE] }])),
      ...worldOptions,
      ...(timed && { script: command => { times.push([command, clock.server()]); return false; } }),
    });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 10000), huntText(page));
    return { text: await huntLog(page), commands: [...game.log], times };
  } finally {
    page.close();
  }
};

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

const EAT_LOG = /擬人化 本輪：.*重生前停打 (\d+) 秒；吃藥線 (\d+)%；危險線 (\d+)%/;
const REST_LOG = /擬人化 本輪：.*重生前停打 (\d+) 秒；休息線 (\d+)%；危險線 (\d+)%/;
// 開始一輪，回傳那一行「擬人化」紀錄裡的三個數字（沒有這一行回 null）
const jitterOf = async (humanize, r, settings, pattern) => {
  const page = await roundPage({ humanize, stopBeforeSpawnSec: 100, ...settings });
  try {
    const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
    pinRandom(page, r);
    world(page, { at: 'a', looks: { c: { lines: [] } }, script: timeScript(page, clock) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(async () => /開始 /.test(await huntLog(page)), 4000));
    const text = await huntLog(page);
    await page.ask({ type: 'STOP' });
    return text.match(pattern)?.slice(1).map(Number) ?? null;
  } finally {
    page.close();
  }
};

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

// 擬人化的長停頓：用 huntOnce 的 timed 選項量遊戲真正收到每個指令的時間
// 第 n 個指令和前一個指令之間隔了幾毫秒
const gapBefore = (times, index) => times[index][1] - times[index - 1][1];
const PAUSE_MIN_MS = 3000; // 停頓最短 3 秒（引擎的 PAUSE_MIN_MS）
const NO_PAUSE_MS = 2800; // 走路本來就隔 1.6～1.9 秒（共用的指令間隔、等房間換過去）：停頓至少 3 秒再加上這些，所以 2.8 秒以下就是沒停
const LINE = ['a', 'b', 'c', 'd', 'e2', 'f']; // 從 a 走到 f 要 5 步
const firstIndex = (times, command, from = 0) => times.findIndex(([cmd], i) => i >= from && cmd === command);

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

// ---- 擬人化：掛機休息（跳過整輪、回家、整點回程）----
// 待命指令 home 把角色送回 a（每一輪都是 a → b → c）；回家指令 recall 把角色送到地圖外（zz）；回程指令 back 送回 a。
// 一般的一輪結束時把時鐘撥快 16 分鐘（下一輪馬上開始，不用真的等一刻鐘）；決定休息的那一輪（看到 recall）不撥，才會真的等到跳過的整點。
// r 是固定亂數：r.value 可以改。0.2 → 7 輪後休息（6 ＋ ⌊0.2×7⌋）、跳過 1 輪（1 ＋ ⌊0.2×3⌋），而且不會抽中停頓
const MINUTE = 60 * 1000;
const MARK_MS = 15 * MINUTE;
const restRun = async ({ settings = {}, r = 0.2, onCommand = null, swallow = null, keepAway = false }) => {
  const page = await roundPage({ humanize: 'on', standbyCommand: 'home', homeCommand: 'recall', restReturnCommand: 'back', ...settings });
  const clock = fakeClock(page, '2026-11-04T10:00:00+08:00', { scale: 600 });
  const looks = [];
  const times = { recall: [], back: [] };
  const draw = pinRandom(page, r);
  const base = timeScript(page, clock, lookTimer(clock, looks));
  let pendingJump = false;
  let recalled = false;
  const game = world(page, {
    at: 'a',
    looks: { c: { lines: [] } },
    script: (command, ...rest) => {
      const state = rest[0].game;
      if (command === 'home') { state.at = 'a'; pendingJump = true; recalled = false; }
      if (command === 'recall') { state.at = 'zz'; recalled = true; times.recall.push(clock.server()); }
      if (command === 'back') { times.back.push(clock.server()); if (!keepAway) state.at = 'a'; }
      if (command === 'time' && pendingJump) { pendingJump = false; if (!recalled) clock.jump += 16 * MINUTE; }
      onCommand?.(command, { page, clock, times });
      return swallow?.(command) || base(command, ...rest);
    },
  });
  await pick(page, MOB);
  click(page, '.hstart');
  return { page, clock, game, looks, times, draw };
};
const restLines = text => text.split('\n').filter(line => / 休息 /.test(line));
const roundsIn = text => (text.match(/輪摘要 第 \d+ 輪：開始時間/g) ?? []).length;

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

// ---- 只下 fight 模式的「自己回」：每次要下 fight 之前先看氣 ----
const REST = { healMode: 'rest', restBelow: 50, restResume: 80, restCommand: 'dazuo' };
const endsAfterFight = page => command => {
  if (command.startsWith('fight ')) { setTimeout(() => lookOut(page), 50); return true; }
  return false;
};
// 氣一開始就低的話，走路階段就先休息了（原本的行為）；這裡要測的是「到了房間、要下 fight 的時候氣太低」，所以送第一個 l 時氣才掉下去
const dropsAtFirstLook = (page, next = () => false) => {
  let dropped = false;
  return command => {
    if (command === 'l' && !dropped) { dropped = true; setKee(page, 30); }
    return next(command);
  };
};

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

// ---- 驗證按鈕：設定頁送 HUNT_VERIFY_ALIAS，遊戲頁送 alias、讀別名列表、回判斷 ----
const ALIAS_LIST = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'hunt', 'alias-list.txt'), 'utf8');
const verify = (page, command, extra = {}) => page.ask({ type: 'HUNT_VERIFY_ALIAS', command, verb: 'fight', ...extra });

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

// 分頁：第一頁（到「未完繼續」那一行為止）送 alias 時印，之後每次空白行（Enter）印下一頁
const [ALIAS_PAGE_1, ALIAS_PAGE_2] = (() => {
  const at = ALIAS_LIST.indexOf('\nrunto11'); // 第二頁的第一個別名
  return [ALIAS_LIST.slice(0, at).trimEnd(), ALIAS_LIST.slice(at + 1).trimEnd()];
})();

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

// ---- 手動紀錄：面板「● 記錄手動」開著時，記下玩家自己從輸入框送出的指令，關掉時寫一段「手動摘要」 ----
// 玩家在輸入框打字按 Enter：填輸入框、送出表單（和遊戲收到 Enter 一樣會觸發 submit）
const typeIn = (page, text) => {
  const input = page.w.document.getElementById('input');
  input.value = text;
  input.form.requestSubmit();
};
const manualButton = page => panelRoot(page).querySelector('.hmanual');
const manualLines = text => text.split('\n').filter(line => / 手動摘要 /.test(line));

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

// 遊戲的巨集視窗：每一列是按鍵值的 input.key 後面接指令的 input.command；按鍵用 F1（112）、F2（113）
const macroWindow = (page, rows) => {
  const list = page.w.document.createElement('div');
  list.id = 'macro_list';
  rows.forEach(([key, command]) => {
    const keyBox = page.w.document.createElement('input');
    keyBox.className = 'key';
    keyBox.name = String(key);
    const commandBox = page.w.document.createElement('input');
    commandBox.className = 'command';
    commandBox.value = command;
    list.append(keyBox, commandBox);
  });
  page.w.document.body.append(list);
};
const pressKey = (page, which, target = page.w.document.getElementById('input')) => {
  const event = new page.w.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'which', { value: which });
  target.dispatchEvent(event);
};

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

// ---- 順位會變：看完房間到開打之間有東西離開房間，順位要重數；打到別隻要認得出來；特攻被拒就不再送 ----
const DOG_LINE = '  ※野狗(dog) [fight][kill]';
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

// ---- 跨區巡怪（hunt-chain 02）----
// 兩區：t（a─b─c─d）與 u（p─q）。go-u 把角色送到 u/p、go-t 送回 t/a；地圖只顯示角色所在的那一區（另一區加 invisible）。
// t/c 有勾的測試怪；u 那份勾選是另一隻怪（記在 u/q），q 的 l 雖然印出測試怪，在 u 沒勾所以不打
const ROOM_U = id => `<a class="H7" id="m-u-${id}">□</a>`;
const CHAIN = { areas: [{ area: 't', sortReturn: '' }, { area: 'u', sortReturn: '' }], moves: ['go-u'], back: 'go-t' };
const chainWorld = (page, { looks = {}, script = null, move = { 'go-u': ['u', 'p'], 'go-t': ['t', 'a'] }, start = null, ...options } = {}) => {
  const doc = page.w.document;
  let game = null;
  const go = (area, room) => {
    game.area = area;
    game.at = room;
    doc.getElementById('m-t').classList.toggle('invisible', area !== 't');
    doc.getElementById('m-u').classList.toggle('invisible', area !== 'u');
  };
  game = world(page, {
    at: 'a',
    moves: { ...MOVES, p: { e: 'q' }, q: { w: 'p' } },
    looks: { c: { lines: [MOB_LINE] }, q: { lines: [MOB_LINE] }, ...looks },
    ...options,
    script: (command, ...rest) => {
      if (move[command]) { go(...move[command]); say(page, '你走了好一段路。'); return true; }
      return script?.(command, ...rest) ?? false;
    },
  });
  game.area = 't';
  doc.getElementById('map_wrapper').insertAdjacentHTML('beforeend', `<div id="m-u" class="invisible">${['p', 'q'].map(ROOM_U).join('─')}</div>`);
  const rect = (left, top) => ({ left, top, width: 20, height: 20, right: left + 20, bottom: top + 20 });
  doc.querySelectorAll('#map_wrapper a[id]').forEach(node => {
    node.getBoundingClientRect = () => (node.id === `m-${game.area}-${game.at}` ? rect(100, 100) : rect(-1000, -1000));
  });
  if (start) go(...start); // 角色一開始在哪一區、哪一間（地圖顯示那一區）
  return game;
};
const chainPage = async ({ settings = {}, chain = CHAIN } = {}) => {
  const page = await boot({ scale: SCALE, preload: MEMORY_STORAGE });
  page.store.mapMonsters = { ...mobsAt('c'), 'u/q': { area: 'u', room: 'q', areaName: '第二區', mobs: [MOB_B], seen: 1 } };
  page.store.mapHuntPicks = { t: [MOB], u: [MOB_B] };
  page.store.mapHuntChain = chain;
  page.store.mapHuntSettings = { ...REQUIRED, loopRounds: 'on', chain: 'on', ...settings };
  await sleep(150);
  return page;
};

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
  require('../catworld-auto-command/map-hunt.js');
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

const chainSortPage = async sortReturn => {
  const page = await chainPage({ settings: { loopRounds: 'off', loadMaxPercent: 90, tripCommand: 'trip', returnCommand: 'back', sortKeep: 'none' }, chain: { ...CHAIN, areas: [CHAIN.areas[0], { area: 'u', sortReturn }] } });
  page.store.mapMonsters['u/q'].mobs = [MOB];
  page.store.mapHuntPicks = { t: [MOB], u: [MOB] };
  return page;
};
const chainSortScript = (page, bag) => command => {
  if (command === 'i') { say(page, `你身上帶著下列這些東西( 載重 ${bag.load}% ):
`); return true; }
  if (command === 'sell all') { bag.load = 20; say(page, '你把牛皮拳套賣掉，獲得了一兩銀子。'); return true; }
  return false;
};
const SORT_MOVES = { 'go-u': ['u', 'p'], 'go-t': ['t', 'a'], trip: ['t', 'd'], back: ['u', 'p'], 'back-u': ['u', 'p'] };

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

// ---- 跨區路線的試跑（hunt-chain 06）----
// 儲存裡的值是 jsdom 那邊建的陣列，deepEqual 比不了原型，先轉成 JSON 再比
const trialOf = page => (page.store.mapHuntChainTrial === undefined ? undefined : JSON.parse(JSON.stringify(page.store.mapHuntChainTrial)));

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

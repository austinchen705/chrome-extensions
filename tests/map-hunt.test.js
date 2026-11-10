// 地圖巡怪：整個 content script 在 jsdom 裡跑（假的地圖 DOM、假的遊戲：照表移動、每個指令回一行輸出），檢查送出的指令與停止條件。
// 房間的位置靠 #map_anchor 蓋住哪一格判斷（jsdom 算不出排版，所以假的 getBoundingClientRect 依「現在在哪」回傳）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, boot: bootPage, sleep, waitFor, fixture } = require('./helpers/game-page');

const SCALE = 20;
// 開始前必填的欄位（吃藥指令、沒藥關鍵字、回家指令）：各測試預設都填好，要測缺欄位的自己清掉
const REQUIRED = { eatCommand: 'eat pill', noMedicineKeyword: '沒有藥', homeCommand: 'recall', loopRounds: 'off', loadMaxPercent: 0, commandGapMinMs: 0, commandGapMaxMs: 0, prescan: 'off' };
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
function world(page, { at, moves = MOVES, reply = true, stuck = false, looks = {}, fingers = {}, silentLook = false, arrivals = {}, arrivalDelayMs = 0, lookDelayMs = 0, script = null, row = ROW } = {}) {
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
      const show = () => page.output(`<span>${['測試房間 - ', '    這裡是房間。', `    這裡明顯的出口是 ${info.exits ?? 'east'}。`, ...(info.lines || [])].join('\n')}\n</span>`);
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
    assert.deepEqual(game.log, ['e', 'e', 'l', 'finger somebody', 'e', 'l', 'fight test mob', 'gc', 'l'], 'looked at c, asked about the unknown id, left for d and fought there');
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
    assert.deepEqual(game.log, ['e', 'e', 'l', 'finger smith', 'fight test mob', 'gc', 'l', 'e', 'l', 'fight test mob', 'gc', 'l'], 'asked once, at the first room only');
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
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight test mob', 'gc', 'l']);
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

ui('hunt: what the move itself printed on arrival is not the answer to l (a player who is in the arrival text but gone from l does not count)', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    // 抵達描述比 l 的回應早到（l 還在佇列裡等指令間隔）：它有人、l 沒有人
    const game = world(page, { at: 'a', arrivalDelayMs: 15, lookDelayMs: 120, arrivals: { c: { lines: [MOB_LINE, PERSON('somebody')] } }, looks: { c: { lines: [MOB_LINE] } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 4000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight test mob', 'gc', 'l'], 'no finger: the answer to l says the room is empty');
    assert.doesNotMatch(huntText(page), /略過/);
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
    assert.deepEqual(game.log, ['e', 'e', 'l', 'fight test mob', 'gc', 'l'], 'neither is asked about, neither counts as someone');
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
const FIGHT = 'fight test mob';
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

ui('fight: three monsters with the same name are fought one at a time, each followed by gc and a fresh l', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(3) } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'l', FIGHT, 'gc', 'l', FIGHT, 'gc', 'l']);
    assert.equal(await hunting(page), false);
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
      if (command === 'kill test mob') { tell(countOf(game, 'kill test mob') === 1 ? KO_LINE : '測試怪死了。'); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'kill test mob', 'kill test mob', 'gc', 'l']);
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
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'get corpse', 'gc', 'l']);
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
      if (command === 'kill test mob') { say(page, '測試怪死了。'); room.lines.splice(0, 1); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'l', 'kill test mob', 'gc', 'l']);
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

ui('fight: when gc does not make a monster go away three times in a row the room is given up', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const script = command => {
      if (command === 'gc') { return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(async () => !(await hunting(page)), 8000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'l', FIGHT, 'gc', 'l', FIGHT, 'gc', 'l']);
    assert.match(huntText(page), /略過 1 間.*t\/c 打不動/);
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
      return command === 'kill test mob';
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'kill test mob') >= 2, 4000), game.log.join(','));
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
      return command === 'kill test mob';
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'pt') >= 3, 4000), 'special attacks continue once the fight really starts');
    assert.equal(countOf(game, 'kill test mob'), 1);
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
      if (command === FIGHT) { say(page, '測試怪死了。'); room.lines.splice(1, 1); return true; }
      return command === 'gc';
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB, other);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.equal(game.log.includes('fight other mob'), false);
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'l']);
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
    assert.ok(await waitFor(() => /吃藥指令、沒藥關鍵字、回家指令/.test(huntText(page)), 3000), huntText(page));
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
    assert.equal(/吃藥指令|沒藥關鍵字/.test(huntText(page)), false);
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

ui('heal: in rest mode a qi below the rest line waits in place (sending the rest command every 5 seconds) until the qi is back to the resume line', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', restBelow: 50, restResume: 80, restCommand: 'dazuo' };
    setKee(page, 30);
    const times = [];
    const script = command => {
      if (command === 'dazuo') times.push(Date.now());
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: [] } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => countOf(game, 'dazuo') >= 3, 3000), 'the rest command repeats');
    assert.ok(times[1] - times[0] >= 200 && times[2] - times[1] >= 200, `5 seconds (scaled to 250 ms) apart: ${times[1] - times[0]}, ${times[2] - times[1]}`);
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

ui('rounds: it reads the server time at the start, sends the standby command after a round, and starts the next round at the respawn minus the head start', async () => {
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
    assert.ok(looks[1] >= at('10:14:40'), `not before the head start (${new Date(looks[1]).toISOString()})`);
    assert.ok(looks[1] < at('10:15:50'), `and not long after it (${new Date(looks[1]).toISOString()})`);
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
    assert.ok(looks[1] >= at('10:14:40') && looks[1] < at('10:15:50'), new Date(looks[1]).toISOString());
    assert.ok(looks[2] >= at('10:29:40') && looks[2] < at('10:30:50'), `the second respawn is not counted twice (${new Date(looks[2]).toISOString()})`);
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
      if (command === 'kill test mob') { say(page, '測試怪死了。'); return true; }
      if (command === 'gc') { room.lines.shift(); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 8000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'kill test mob', 'gc', 'l', FIGHT, 'gc', 'l'], 'knocked out: kill, then gc; the second one died at once: no kill');
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
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'l']);
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
      if (command === 'kill test mob') {
        kills += 1;
        setTimeout(() => say(page, kills === 1 ? KO_LINE : '測試怪死了。'), 0);
        return true;
      }
      return command === 'pt';
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => game.log.includes('kill test mob'), 4000));
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
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'l', 'i']);
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
ui('hunt: monsters sharing one id are told apart by their place in the room (fight guard 2, not fight guard)', async () => {
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
        const match = /^(?:fight|kill) (guard)(?: (\d+))?$/.exec(command);
        if (!match) return false;
        fights.push(command);
        const nth = Number(match[2] || 1);
        const index = looks.c.lines.map((line, i) => [line, i]).filter(([line]) => line.includes('(guard)'))[nth - 1][1];
        looks.c.lines.splice(index, 1); // 被打的那一隻倒下
        say('守軍死了。');
        return true;
      },
    });
    await pick(page, CAPTAIN);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(fights, ['fight guard 2', 'fight guard 2'], 'both captains, never the first guard (the squad leader)');
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
    assert.equal(countOf(game, 'fight test mob'), 2, `fought in c and in d: ${game.log.join()}`);
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
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'gc', 'l', 'i', 'go', 'identify', 'i', 'secure black armor', 'sell all', 'back', 'i']);
    assert.deepEqual(state.secured, ['black armor'], 'only the identified good armor; the marked tea and the worn cloth are left alone, the gloves are sold');
    assert.equal(alerts(page).length, 0);
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

// 地圖巡怪：整個 content script 在 jsdom 裡跑（假的地圖 DOM、假的遊戲：照表移動、每個指令回一行輸出），檢查送出的指令與停止條件。
// 房間的位置靠 #map_anchor 蓋住哪一格判斷（jsdom 算不出排版，所以假的 getBoundingClientRect 依「現在在哪」回傳）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, boot: bootPage, sleep, waitFor, fixture } = require('./helpers/game-page');

const SCALE = 20;
// 開始前必填的欄位（吃藥指令、沒藥關鍵字、回家指令）：各測試預設都填好，要測缺欄位的自己清掉
const REQUIRED = { eatCommand: 'eat pill', noMedicineKeyword: '沒有藥', homeCommand: 'recall' };
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
function world(page, { at, moves = MOVES, reply = true, stuck = false, looks = {}, fingers = {}, silentLook = false, arrivals = {}, arrivalDelayMs = 0, lookDelayMs = 0, script = null } = {}) {
  const doc = page.w.document;
  doc.body.insertAdjacentHTML('beforeend', `<div id="map_table"><span id="map_header">地圖 (<span data-default-grid="□">測試區</span>)</span><div id="map_wrapper"><div id="m-t">${ROW}</div></div><div id="map_anchor"></div></div>`);
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
    page.store.mapMonsters = mobsAt('d');
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

ui('fight: a monster that does not want to fight gets kill after the refusal, and the knocked-out sentence ends the fight too', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    const script = (command, { say: tell }) => {
      if (command === FIGHT) { tell('看起來測試怪並不想跟你較量。'); return true; }
      if (command === 'kill test mob') { tell(KO_LINE); return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'kill test mob', 'gc', 'l']);
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

ui('fight: no end sentence for a long time means an l: a monster that is knocked out counts as over', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntSettings = { ...REQUIRED, fightTimeoutSec: 5 };
    const room = { lines: mobsLines(1) };
    const script = command => {
      if (command === FIGHT) { room.lines[0] = '  ※測試怪(test mob) <昏迷不醒> [fight][kill]'; return true; }
      return false;
    };
    const game = world(page, { at: 'a', looks: { c: room }, script });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 6000), huntText(page));
    assert.deepEqual(game.log, ['e', 'e', 'l', FIGHT, 'l', 'gc', 'l']);
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
    page.store.mapHuntSettings = { healMode: 'rest' };
    const game = world(page, { at: 'a', looks: { c: { lines: mobsLines(1) } } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /填：回家指令/.test(huntText(page)), 3000), huntText(page));
    assert.equal(/吃藥指令|沒藥關鍵字/.test(huntText(page)), false);
    page.store.mapHuntSettings = { healMode: 'rest', homeCommand: 'recall' };
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

// 地圖巡怪的整合測試共用底座（tests/integration/game/map-hunt-*.test.js 用）：假地圖、假遊戲 world、設定頁選怪的小工具，以及各主題共用的情境。
const assert = require('node:assert/strict');
const { boot: bootPage, sleep, waitFor, fixture } = require('./game-page');

const SCALE = 20;

// 開始前必填的欄位（吃藥指令、沒藥關鍵字、回家指令）：各測試預設都填好，要測缺欄位的自己清掉
const REQUIRED = { loadCheckEveryMin: 1, loadCheckEveryMax: 1, eatCommand: 'eat pill', noMedicineKeyword: '沒有藥', homeCommand: 'recall', loopRounds: 'off', loadMaxPercent: 0, typoPercent: 0, wrongWayPercent: 0, timeSource: 'command', timeKeepMin: 0, commandGapMinMs: 0, commandGapMaxMs: 0, reactMinMs: 0, reactMaxMs: 0, sortLookMinSec: 0, sortLookMaxSec: 0, prescan: 'off' };

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

const PLAYER_FINGER = '英文代號：    somebody\n姓    名：    某人\n權限等級：    (player)\n';

const NOT_FOUND = '找不到這個人。';

const MOB_LINE = '  ※測試怪(test mob) [fight][kill]';

const PERSON = (id, name = '某人') => `  普通百姓 ${name}(${id}) <發呆中>`;

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

const OTHER_LINE = '  ※另一隻怪(other mob) [fight][kill]';

const KNOCKED_LINE = '  ※測試怪(test mob) <昏迷不醒> [fight][kill]';

// ---- 票 07：自動學習出口 ----
const LEARN = { learnExits: 'on' };

const learnPage = async (rooms = ['c']) => {
  const page = await boot({ scale: SCALE });
  page.store.mapMonsters = mobsAt(...rooms);
  page.store.mapHuntSettings = { ...REQUIRED, ...LEARN };
  return page;
};

// b 的圖示出口 e 其實不通：真正的路是 u。b 的出口有 west、up、north
const BAD_B = { moves: { ...MOVES, b: { w: 'a', u: 'c' } }, looks: { a: { exits: 'east' }, b: { exits: 'west, up 和 north' }, c: { exits: 'down', lines: [] } } };

// 另一個區域的房間（地圖上有，但不是巡怪的區域）
const addOtherArea = (page, game) => {
  const doc = page.w.document;
  doc.getElementById('map_wrapper').insertAdjacentHTML('beforeend', '<div id="m-u"><a class="H7" id="m-u-r1">□</a></div>');
  doc.getElementById('m-u-r1').getBoundingClientRect = () => (game.at === 'r1' ? { left: 100, top: 100, width: 20, height: 20, right: 120, bottom: 120 } : { left: -1000, top: -1000, width: 20, height: 20, right: -980, bottom: -960 });
};

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

// ---- 巡完一輪：先走到可 ride 的格子才送待命指令；巡完就整理；待命把人帶離巡怪地圖時，等完重生先送回到巡怪區的指令 ----
// 待命指令 ride 把人送到地圖外（town），回到巡怪區的指令 back 送回 a；r 只用在 a 是可 ride 的格子
const standbyRun = async ({ settings = {}, rides = { t: ['t/a'] }, back = true } = {}) => {
  const page = await roundPage({ standbyCommand: 'ride', restReturnCommand: 'back', ...settings });
  page.store.mapHuntRideRooms = rides;
  const clock = fakeClock(page, '2026-11-04T10:00:00+08:00');
  const looks = [];
  const game = world(page, { at: 'a', looks: { c: { lines: [] } }, script: timeScript(page, clock, (command, { game: state }) => {
    if (command === 'l') looks.push(clock.server());
    if (command === 'ride') state.at = 'town';
    if (command === 'back' && back) state.at = 'a';
    if (command === 'sell all') { say(page, '你把牛皮拳套賣掉，獲得了一兩銀子。'); return true; }
    return false;
  }) });
  await pick(page, MOB);
  click(page, '.hstart');
  return { page, game, looks };
};

// 左下角的 #uptime（遊戲的計時器）：H7 一般模式顯示開機時間的「分:秒」（除以一小時的餘數），H1 倒數模式顯示距下一個 15 分鐘整點的倒數
// （使用者貼的真實樣本：class H1「13:06」、class H7「32:41」）。文字隨假的伺服器時鐘走，假設伺服器在整點開機
const screenClock = (page, clock, mode) => {
  const element = page.w.document.getElementById('uptime');
  element.className = mode === 'down' ? 'H1' : 'H7';
  const two = number => String(number).padStart(2, '0');
  Object.defineProperty(element, 'textContent', {
    configurable: true,
    get: () => {
      const uptime = Math.floor(clock.server() / 1000);
      const seconds = mode === 'down' ? 900 - (uptime % 900) : uptime % 3600;
      return `${two(Math.floor(seconds / 60))}:${two(seconds % 60)}`;
    },
  });
};

// ---- 功能開關：預設關閉，設定頁「輔助功能」勾了才出現 ----
const setHuntFeature = (page, on) => {
  page.store.zapFeatures = { hunt: on };
  page.changeListeners.forEach(listener => listener({ zapFeatures: { newValue: page.store.zapFeatures } }, 'local'));
};

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

// 隔幾間才看負重：打完的房間（倒下至少一隻）數到 N 才送 i；還不知道負重時打完第一間就看；上次負重到保險線以上每間都看
const loadRow = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

const fightsAndLooks = game => game.log.filter(command => command === FIGHT || command === 'i').map(command => (command === 'i' ? 'i' : 'F')).join('');

const loadIntervalRun = async ({ load, settings, mobRooms = ['b', 'c', 'd', 'e', 'f', 'g'], recorded = mobRooms, random = null }) => {
  const page = await loadPage(settings);
  try {
    if (random !== null) pinRandom(page, random);
    page.store.mapMonsters = mobsAt(...recorded);
    const line = lineWorld(loadRow);
    const looks = Object.fromEntries(recorded.map(room => [room, { lines: mobRooms.includes(room) ? mobsLines(1) : [] }]));
    const game = world(page, { at: 'a', row: line.row, moves: line.moves, looks, script: loadScript(page, { load }) });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => /巡完了/.test(huntText(page)), 12000), huntText(page));
    return fightsAndLooks(game);
  } finally {
    page.close();
  }
};

// 巡怪的指令欄（打完後、回家、吃藥、待命…）也可以寫「@巨集 N」：用到的當下讀遊戲存的那一格換成它的指令，不然 @巨集 10 會原樣送給遊戲，遊戲回「什麼﹖」
const MEMORY_STORAGE = "const mem = {}; Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: key => (key in mem ? mem[key] : null), setItem: (key, value) => { mem[key] = String(value); } } });";

const macroSlots = (row, text) => JSON.stringify(Array.from({ length: 90 }, (_, i) => (i === row - 1 ? ['', text] : 0)));

// ---- 街景模式（掃描）：不需要勾怪，走完這一區沒走過的每一間，每間 l 一次並記下走過 ----
const scanClick = page => click(page, '.hscan');

const seenState = (page, key) => page.store.mapVisited?.[key]?.state;

// ---- 打怪前補掃：這一區還有沒走過、沒有圖資的房間，先掃一輪（看到的怪補進資料）再開始打 ----
const SCAN_LOOKS = { a: { exits: 'east' }, b: { exits: 'west 和 east' }, c: { exits: 'west 和 east', lines: [MOB_LINE] }, d: { exits: 'west', lines: [MOB_LINE] } };

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
  // 現在穿著一件防禦 10 的舊甲：沒有基準可比的裝備不會被留下，預設的鑑定結果（防禦 50）才有東西可比而被留
  page.store.wornEquipment = { 小明: { 盔甲類防具: [{ name: '舊甲', primary: 10, attrs: [], needExp: null, readAt: 1 }] } };
  return page;
};

// 假背包與商店：i 列出背包；identify 印鑑定區塊；secure／give 回成功字樣（記下對象）；sell all 之後負重降到 20
const sortScript = (page, state) => (command, { game }) => {
  if (command === 'gc') state.load = state.afterFight ?? state.load;
  if (command === 'i') { say(page, `你身上帶著下列這些東西( 載重 ${state.load}% ):\n${(state.bag ?? bagLines).join('\n')}`); return true; }
  if (command === 'identify') { say(page, state.block ?? blockOf(ARMOR)); return true; }
  if (command.startsWith('secure ')) { state.secured.push(command.slice(7)); say(page, '標記完成。'); return true; }
  if (command.startsWith('give ')) { state.given.push(command); say(page, state.giveReply ?? '你給某人一件黑羽長風鎧。'); return true; }
  if (command === 'sell all') { state.load = 20; say(page, '你把牛皮拳套賣掉，獲得了一兩銀子。'); return true; }
  if (command === 'back' && state.backTo !== undefined) game.at = state.backTo;
  return false;
};

const sortState = extra => ({ load: 95, secured: [], given: [], ...extra });

const herbBag = [...bagLines, '    二株不知名藥草(unknown herb)', '    不知名物品(unknown object)', '  ˇ三株不知名藥草(unknown herb 3)'];

// ---- 只下 fight 模式（fightMode: assist）：戰鬥交給玩家的觸發，巡怪只下第一次 fight、被動看 l 與 i ----
const lookOut = (page, lines = []) => say(page, ['測試房間 - ', '    這裡是房間。', '    這裡明顯的出口是 east。', ...lines].join('\n'));

const assistPage = async (settings = {}) => {
  const page = await boot({ scale: SCALE });
  page.store.mapMonsters = mobsAt('c');
  page.store.mapHuntSettings = { ...REQUIRED, fightMode: 'assist', eatCommand: '', noMedicineKeyword: '', fightTimeoutSec: 5, ...settings };
  return page;
};

const MOB_FIGHTING = '  ※測試怪(test mob) <戰鬥中> [fight][kill]';

// ---- 可 ride 的格子：負重超標要整理時，先走到這一區最近的可 ride 格子再送前往指令 ----
const SORT_GOLDEN = ['e', 'e', 'l', FIGHT, 'gc', 'i', 'go', 'identify', 'i', 'secure black armor', 'sell all', 'back', 'i'];

const rideSort = async ({ rides, moves, settings = {}, until = page => /巡完了/.test(huntText(page)), during = null }) => {
  const page = await sortPage(settings);
  try {
    page.store.mapHuntRideRooms = rides;
    const state = sortState();
    const game = world(page, { at: 'a', moves, looks: { c: { lines: mobsLines(1) } }, script: sortScript(page, state) });
    await pick(page, MOB);
    click(page, '.hstart');
    if (during) await during(page, game);
    assert.ok(await waitFor(() => until(page), 10000), huntText(page));
    return { log: game.log, alerts: alerts(page), text: await huntLog(page) };
  } finally {
    page.close();
  }
};

// 沒藥：走到 c 時氣掉到 30，吃藥，遊戲回沒藥；recallAt 記下送回家指令時人在哪一間
const noMedicineRun = async ({ rides, moves = MOVES, until = page => alerts(page).length > 0, fightFirst = false, dropOn = (command, state) => command === 'e' && state.at === 'c' }) => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('d');
    page.store.mapHuntRideRooms = rides;
    const run = { recallAt: null };
    let fights = 0;
    const game = world(page, { at: 'a', moves, looks: { d: { lines: mobsLines(2) } }, script: (command, { game: state }) => {
      if (!fightFirst && dropOn(command, state)) setKee(page, 30);
      if (command === 'eat pill') { say(page, '你身上沒有藥了。'); return true; }
      if (command === 'recall') run.recallAt = state.at;
      // fightFirst：第一隻打到一半氣掉下來、沒藥（那一隻晚一點才死，撤退不等它）
      if (fightFirst && command === FIGHT && (fights += 1) === 1) { setKee(page, 30); setTimeout(() => say(page, '測試怪死了。'), 300); return true; }
      return false;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => until(page), 10000), `${huntText(page)} | ${game.log.join(',')}`);
    await sleep(200);
    return { ...run, log: game.log, alerts: alerts(page), text: await huntLog(page), on: await hunting(page) };
  } finally {
    page.close();
  }
};

// 危險線：自己回模式，在 c 打第一隻時氣掉到 10（怪不死）；recallAt 記下送回家指令時人在哪一間
const dangerRun = async ({ rides, moves = MOVES, settings = {}, assist = false, onFight = null, onLook = null }) => {
  const page = await boot({ scale: SCALE });
  try {
    page.store.mapMonsters = mobsAt('c');
    page.store.mapHuntRideRooms = rides;
    page.store.mapHuntSettings = { ...REQUIRED, healMode: 'rest', dangerBelow: 20, restCommand: 'dazuo', homeCommand: 'recall', ...(assist ? { fightMode: 'assist', eatCommand: '', noMedicineKeyword: '', fightTimeoutSec: 5 } : {}), ...settings };
    setKee(page, 60);
    const run = { recallAt: null };
    const game = world(page, { at: 'a', moves, looks: { c: { lines: mobsLines(2) } }, script: (command, { game: state }) => {
      if (command === 'recall') run.recallAt = state.at;
      if (command === 'l' && state.at === 'c') onLook?.(page);
      if (command !== FIGHT) return false;
      setKee(page, 10);
      onFight?.(page);
      return true;
    } });
    await pick(page, MOB);
    click(page, '.hstart');
    assert.ok(await waitFor(() => alerts(page).length > 0, 10000), `${huntText(page)} | ${game.log.join(',')}`);
    await sleep(300);
    return { ...run, log: game.log, alerts: alerts(page), text: await huntLog(page), on: await hunting(page) };
  } finally {
    page.close();
  }
};

// ---- 每輪摘要：每一輪結束時寫進巡怪紀錄（路線、指令、用真正送出時間算的間隔、看了幾間有怪幾間、是否和上一輪相同）----
const huntLog = async page => (await page.ask({ type: 'HUNT_LOG' })).text;

const summaryLines = text => text.split('\n').filter(line => /輪摘要/.test(line));

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

// 擬人化的長停頓：用 huntOnce 的 timed 選項量遊戲真正收到每個指令的時間
// 第 n 個指令和前一個指令之間隔了幾毫秒
const gapBefore = (times, index) => times[index][1] - times[index - 1][1];

const PAUSE_MIN_MS = 3000; // 停頓最短 3 秒（引擎的 PAUSE_MIN_MS）

const NO_PAUSE_MS = 2800; // 走路本來就隔 1.6～1.9 秒（共用的指令間隔、等房間換過去）：停頓至少 3 秒再加上這些，所以 2.8 秒以下就是沒停

const LINE = ['a', 'b', 'c', 'd', 'e2', 'f']; // 從 a 走到 f 要 5 步

const firstIndex = (times, command, from = 0) => times.findIndex(([cmd], i) => i >= from && cmd === command);

// ---- 擬人化：掛機休息（跳過整輪、回家、整點回程）----
// 待命指令 home 把角色送回 a（每一輪都是 a → b → c）；回家指令 recall 把角色送到地圖外（zz）；回程指令 back 送回 a。
// 一般的一輪結束時把時鐘撥快 16 分鐘（下一輪馬上開始，不用真的等一刻鐘）；決定休息的那一輪（看到 recall）不撥，才會真的等到跳過的整點。
// r 是固定亂數：r.value 可以改。0.2 → 7 輪後休息（6 ＋ ⌊0.2×7⌋）、跳過 1 輪（1 ＋ ⌊0.2×3⌋），而且不會抽中停頓
const MINUTE = 60 * 1000;

const MARK_MS = 15 * MINUTE;

const restRun = async ({ settings = {}, r = 0.2, onCommand = null, swallow = null, keepAway = false, rides = null }) => {
  const page = await roundPage({ humanize: 'on', standbyCommand: 'home', homeCommand: 'recall', restReturnCommand: 'back', ...settings });
  if (rides) page.store.mapHuntRideRooms = rides;
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
      if (command === 'recall') { times.recallAt = state.at; state.at = 'zz'; recalled = true; times.recall.push(clock.server()); }
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

// ---- 被怪主動攻擊：停下來反擊 ----
const ZOMBIE = '  ※腐屍(zombie) [fight][kill]';

const ZOMBIE_FIGHTING = '  ※腐屍(zombie) <戰鬥中> [fight][kill]';

const ATTACK_LINE = '看起來腐屍想殺死你！'; // 使用者貼的真實輸出

// b 有會主動攻擊的腐屍（沒勾選），目標是 d：走進 b 時抵達描述後面接著「看起來腐屍想殺死你！」
const ambushWorld = page => {
  const game = world(page, { at: 'a', arrivals: { b: { lines: [ZOMBIE, ATTACK_LINE] } }, looks: { b: { lines: [ZOMBIE_FIGHTING] }, d: { lines: [MOB_LINE] } }, script: (command, { say, looks }) => {
    if (command === 'kill 1' && game.at === 'b') { looks.b.lines = []; say('腐屍死了。'); return true; }
    if (command.startsWith('fight ')) looks[game.at].lines = [];
    return false;
  } });
  return game;
};

// 使用者貼的礦坑甬道：三隻會主動攻擊的同名怪，打死第一隻後屍體排在最前面，「fight 1」「kill 1」都打到屍體
const CORPSE_LINE = '  測試怪的屍體(corpse) [sac]';

const NOT_ALIVE_LINE = '看清楚一點，測試怪的屍體並不是活物。';

// ---- 驗證按鈕：設定頁送 HUNT_VERIFY_ALIAS，遊戲頁送 alias、讀別名列表、回判斷 ----
const ALIAS_LIST = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'fixtures', 'hunt', 'alias-list.txt'), 'utf8');

const verify = (page, command, extra = {}) => page.ask({ type: 'HUNT_VERIFY_ALIAS', command, verb: 'fight', ...extra });

// 分頁：第一頁（到「未完繼續」那一行為止）送 alias 時印，之後每次空白行（Enter）印下一頁
const [ALIAS_PAGE_1, ALIAS_PAGE_2] = (() => {
  const at = ALIAS_LIST.indexOf('\nrunto11'); // 第二頁的第一個別名
  return [ALIAS_LIST.slice(0, at).trimEnd(), ALIAS_LIST.slice(at + 1).trimEnd()];
})();

// ---- 手動紀錄：面板「● 記錄手動」開著時，記下玩家自己從輸入框送出的指令，關掉時寫一段「手動摘要」 ----
// 玩家在輸入框打字按 Enter：填輸入框、送出表單（和遊戲收到 Enter 一樣會觸發 submit）
const typeIn = (page, text) => {
  const input = page.w.document.getElementById('input');
  input.value = text;
  input.form.requestSubmit();
};

const manualButton = page => panelRoot(page).querySelector('.hmanual');

const manualLines = text => text.split('\n').filter(line => / 手動摘要 /.test(line));

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

// ---- 順位會變：看完房間到開打之間有東西離開房間，順位要重數；打到別隻要認得出來；特攻被拒就不再送 ----
const DOG_LINE = '  ※野狗(dog) [fight][kill]';

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

// ---- 跨區路線的試跑（hunt-chain 06）----
// 儲存裡的值是 jsdom 那邊建的陣列，deepEqual 比不了原型，先轉成 JSON 再比
const trialOf = page => (page.store.mapHuntChainTrial === undefined ? undefined : JSON.parse(JSON.stringify(page.store.mapHuntChainTrial)));

module.exports = {
  SCALE,
  REQUIRED,
  boot,
  MOB,
  ROOM,
  ROW,
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
  KO_LINE,
  mobsLines,
  setKee,
  hunting,
  countOf,
  say,
  OTHER_LINE,
  KNOCKED_LINE,
  LEARN,
  learnPage,
  BAD_B,
  addOtherArea,
  taipei,
  fakeClock,
  timeScript,
  at,
  roundPage,
  lookTimer,
  standbyRun,
  screenClock,
  setHuntFeature,
  loadScript,
  loadPage,
  loadRow,
  fightsAndLooks,
  loadIntervalRun,
  MEMORY_STORAGE,
  macroSlots,
  scanClick,
  seenState,
  SCAN_LOOKS,
  ARMOR,
  blockOf,
  bagLines,
  sortPage,
  sortScript,
  sortState,
  herbBag,
  lookOut,
  assistPage,
  MOB_FIGHTING,
  SORT_GOLDEN,
  rideSort,
  noMedicineRun,
  dangerRun,
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
  MINUTE,
  MARK_MS,
  restRun,
  restLines,
  roundsIn,
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
  verify,
  ALIAS_PAGE_1,
  ALIAS_PAGE_2,
  typeIn,
  manualButton,
  manualLines,
  macroWindow,
  pressKey,
  DOG_LINE,
  ROOM_U,
  CHAIN,
  chainWorld,
  chainPage,
  chainSortPage,
  chainSortScript,
  SORT_MOVES,
  trialOf,
};

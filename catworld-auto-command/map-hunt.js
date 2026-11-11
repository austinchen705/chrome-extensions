// 地圖巡怪：把面板「選怪」勾選的怪（可以多隻），在目前顯示的區域裡蒐集到的房間一間一間走過去。
// 引擎不碰 DOM 與 chrome.*（路線用 map-route.js，蒐集資料用 map-collect.js 的 locate），讀房間、送指令、讀儲存都由呼叫端（content.js）傳入，
// 送出的指令走共用送出佇列，所以遵守指令間隔、驗證碼偵測與看門狗。
// 每一步：送一個方向指令 → 等目前房間（#map_anchor 蓋住的那一格）變成別間（逾時以 tick 數算，約 5 秒）；逾時沒變就重送一次，仍沒變就略過這間目標，連續略過 MAX_SKIPS 次停止並警報。
(() => {
if (globalThis.CatworldMapHunt) return;

const SETTINGS_KEY = 'mapHuntSettings';
// 自動學到的 NPC（finger 找不到的 ID，名稱陣列）；白名單是設定頁的 npcWhitelist（手動填）
const NPCS_KEY = 'mapHuntNpcs';
// 自動學習的出口與實測連線：{ "區域/房間": { exits: [指令…]|null, to: { 指令: "區域/房間" | "out" } } }，out＝走出這個區域（或到地圖上找不到的房間）
const EXITS_KEY = 'mapHuntExits';
const VISITED_KEY = 'mapVisited'; // 掃描走過的房間：{ "區域/房間": { at, state: 'seen' | 'blocked' } }
const OPPOSITE = { n: 's', s: 'n', e: 'w', w: 'e', ne: 'sw', sw: 'ne', nw: 'se', se: 'nw', u: 'd', d: 'u', eu: 'wd', wd: 'eu', ed: 'wu', wu: 'ed', nu: 'sd', sd: 'nu', nd: 'su', su: 'nd' };
const splitIds = text => String(text ?? '').split(/[、,，;；\s]+/).filter(Boolean);
const TICK_MS = 200;
const MOVE_TIMEOUT_TICKS = 25; // 5 秒
const MAX_SKIPS = 3;
const MAX_WRONG = 3; // 同一個目標走錯房間幾次就略過
const SAFE_ID = /^[A-Za-z][A-Za-z0-9 _.'-]*$/;
const MAX_STUCK = 3; // 連續幾次打完指令後怪的數量沒減少就略過這間
const LOG_MAX = 600; // 巡怪紀錄最多留幾行
const TICKS_PER_SEC = 1000 / TICK_MS;
const EAT_GAP_TICKS = 5 * TICKS_PER_SEC; // 吃藥指令至少間隔 5 秒
const NO_TARGET = /你要對誰施展這個招式/;
const KNOCKED_OUT = '昏迷不醒';
const RESPAWN_MS = 15 * 60 * 1000; // 怪在伺服器時間的每小時 00、15、30、45 分重生
const RECALIBRATE_LEAD_MS = 30 * 1000; // 距開始時間不到這麼久（或估計已經到了），而上次校準已經超過 RECALIBRATE_GAP_MS，就重新校準
const RECALIBRATE_GAP_MS = 20 * 1000;
const FRESH_MS = 60 * 1000; // 開始下一輪前，最近一次校準不能比這更舊
const QI_WAIT_TICKS = 60 * TICKS_PER_SEC; // 試出口前等氣回復最多等這麼久，等不到就略過這個目標
const SCAN_STALL_TICKS = 180 * TICKS_PER_SEC; // 掃描這麼久沒換過房間、沒處理完任何一間，就當成卡住，停下來並說明在等什麼
const SORT_STEP_TICKS = 120 * TICKS_PER_SEC; // 整理的單一步驟（走一趟、鑑定、回程）最久等這麼久
const SORT_QUIET_MS = 1000; // 鑑定的指令送完後，再等這麼久沒有新輸出才當成鑑定結束
const ASSIST_QUIET_TICKS = 2; // 只下 fight 模式：輸出靜止這麼多個 tick 才解析一次（一份 l 或 i 的輸出可能分批到）
const NO_MEDICINE_WINDOW_TICKS = 10 * TICKS_PER_SEC; // 吃藥指令真的送出後，這麼久內出現沒藥關鍵字才算

// 設定頁的欄位（也決定預設值與檢查）：type 是 text、number 或 select；label 是短標籤、hint 是標籤下的小字說明；
// group 是設定頁的分組（GROUPS），同一個 row 的欄位排在同一列；show(設定) 為 false 時設定頁藏起來（值照樣保留、照樣存）；
// required(設定) 為 true 而沒填時，開始巡怪會被擋下、設定頁用琥珀色標出來
const ON_OFF = [['on', '開'], ['off', '關']];
const full = s => s.fightMode === 'full';
const eatMode = s => s.healMode === 'eat';
const sorting = s => s.loadMaxPercent > 0;
const FIELDS = [
  { key: 'commandGapMinMs', group: 'move', row: 'gap', label: '指令間隔最短（毫秒）', hint: '走路、看房間、打怪、補氣都算；和「指令間隔」取較大的，想更快兩個都要調小', type: 'number', default: 1000, min: 0, max: 3000 },
  { key: 'commandGapMaxMs', group: 'move', row: 'gap', label: '最長（毫秒）', hint: '每次在最短與最長之間隨機', type: 'number', default: 2000, min: 0, max: 3000 },
  { key: 'learnExits', group: 'move', label: '自動學習出口', hint: '記下看到的出口與實際走到的房間；路線不通時才試出口', type: 'select', options: [['off', '關'], ['on', '開']], default: 'off' },
  { key: 'prescan', group: 'move', label: '打怪前先補掃沒走過的房間', hint: '沒有圖資的房間才掃，走過的、走不到的不再掃；掃完再開始打', type: 'select', options: ON_OFF, default: 'on' },
  { key: 'fightMode', group: 'fight', label: '戰鬥方式', hint: '只下 fight：戰鬥、補氣、撿屍交給你的觸發規則，巡怪只看 i 與 l 的輸出；吃藥模式照樣吃藥，氣低於危險線回家', type: 'select', options: [['full', '完整（巡怪自己打、補氣、撿屍）'], ['assist', '只下 fight（交給你的觸發規則）']], default: 'full' },
  { key: 'killCommand', group: 'fight', show: full, label: '打死用的指令', hint: '怪不想打、或補刀時送「這個指令 怪的ID」；可以填你的別名，例如 k', type: 'text', default: 'kill' },
  { key: 'afterKillCommand', group: 'fight', show: full, label: '怪倒下後送的指令', hint: '可多個，用 ; 分隔', type: 'text', default: 'gc' },
  { key: 'fightTimeoutSec', group: 'fight', label: '等怪倒下最久（秒）', hint: '逾時就用 l 看一眼', type: 'number', default: 60, min: 5, max: 600 },
  { key: 'endKeywords', group: 'fight', label: '怪倒下的字', hint: '用、分隔', type: 'text', default: '一動也不動了、死了' },
  { key: 'knockoutKeywords', group: 'fight', label: '其中代表只是昏迷的字', hint: '用、分隔；昏迷的怪會再補打死', type: 'text', default: '一動也不動了' },
  { key: 'finishKnockedOut', group: 'fight', show: full, label: '怪昏迷了就補打死再撿屍', type: 'select', options: ON_OFF, default: 'on' },
  { key: 'refuseKeyword', group: 'fight', show: full, label: '怪不想打時遊戲回的字', hint: 'fight 被拒就改送「打死用的指令」', type: 'text', default: '並不想跟你較量' },
  { key: 'specialCommand', group: 'special', show: full, row: 'special', label: '特攻指令', hint: '可空，可以是你的別名；等特攻冷卻條跑完、角色不忙碌才送', type: 'text', default: '' },
  { key: 'specialIntervalSec', group: 'special', show: full, row: 'special', label: '最小間隔（秒）', type: 'number', default: 10, min: 1, max: 600 },
  { key: 'healMode', group: 'heal', label: '補氣方式', type: 'select', options: [['eat', '吃藥'], ['rest', '自己回']], default: 'eat' },
  { key: 'ginBelow', group: 'heal', row: 'gin', label: '精低於 %', hint: '0＝不看', type: 'number', default: 0, min: 0, max: 99 },
  { key: 'ginCommand', group: 'heal', row: 'gin', label: '精低時的指令', hint: '空白＝不看', type: 'text', default: '' },
  { key: 'ginHurtBelow', group: 'heal', row: 'ginHurt', label: '精內傷低於 %', hint: '狀態區的傷勢 %（有效÷最大），不到 100% 就是內傷；0＝不看', type: 'number', default: 0, min: 0, max: 100 },
  { key: 'ginHurtCommand', group: 'heal', row: 'ginHurt', label: '精內傷時的指令', hint: '空白＝不看', type: 'text', default: '' },
  { key: 'eatBelow', group: 'heal', show: eatMode, row: 'eat', label: '氣低於 %', type: 'number', default: 50, min: 1, max: 99 },
  { key: 'eatCommand', group: 'heal', show: eatMode, row: 'eat', label: '吃藥指令', hint: '可多個，用 ; 分隔', type: 'text', default: '', required: s => eatMode(s) && full(s) },
  { key: 'restBelow', group: 'heal', show: s => !eatMode(s), row: 'rest', label: '氣低於 % 休息', type: 'number', default: 50, min: 2, max: 99 },
  { key: 'restResume', group: 'heal', show: s => !eatMode(s), row: 'rest', label: '回到 % 才繼續', type: 'number', default: 80, min: 1, max: 100 },
  { key: 'keeHurtBelow', group: 'heal', row: 'keeHurt', label: '氣內傷低於 %', hint: '0＝不看', type: 'number', default: 0, min: 0, max: 100 },
  { key: 'keeHurtCommand', group: 'heal', row: 'keeHurt', label: '氣內傷時的指令', hint: '空白＝不看', type: 'text', default: '' },
  { key: 'senBelow', group: 'heal', row: 'sen', label: '神低於 %', hint: '0＝不看', type: 'number', default: 0, min: 0, max: 99 },
  { key: 'senCommand', group: 'heal', row: 'sen', label: '神低時的指令', hint: '空白＝不看', type: 'text', default: '' },
  { key: 'senHurtBelow', group: 'heal', row: 'senHurt', label: '神內傷低於 %', hint: '0＝不看', type: 'number', default: 0, min: 0, max: 100 },
  { key: 'senHurtCommand', group: 'heal', row: 'senHurt', label: '神內傷時的指令', hint: '空白＝不看', type: 'text', default: '' },
  { key: 'restCommand', group: 'heal', show: s => !eatMode(s), label: '休息時送的指令', hint: '可空；每次休息只送一次，角色忙碌時等忙碌結束才送', type: 'text', default: '' },
  { key: 'noMedicineKeyword', group: 'heal', show: s => eatMode(s) || TOP_UPS.some(item => s[`${item.key}Command`]), label: '沒藥時遊戲回的字', hint: '吃藥、精神、內傷的指令送出後看到這個字就回家停止', type: 'text', default: '', required: s => eatMode(s) && full(s) },
  { key: 'dangerBelow', group: 'heal', label: '危險線：氣低於 % 回家停止', hint: '自己回模式的戰鬥中、只下 fight 模式、掃描時都看；要小於「氣低於 % 休息」，否則自動改小', type: 'number', default: 20, min: 1, max: 99 },
  { key: 'homeCommand', group: 'heal', label: '回家指令', type: 'text', default: '', required: () => true },
  { key: 'loadMaxPercent', group: 'sort', label: '負重超過 % 就去整理', hint: 'i 的「載重」；0＝不檢查', type: 'number', default: 90, min: 0, max: 100 },
  { key: 'tripCommand', group: 'sort', show: sorting, label: '前往整理處的指令／巨集', hint: '路線、鑑定全寫在這裡，最後停在能 sell all 的地方；不要自己寫 sell all。前往與回程至少填一個才走自動整理；可用 ; 與 @等待', type: 'text', default: '' },
  { key: 'sortKeep', group: 'sort', show: sorting, label: '鑑定完留不留好裝備', hint: '留＝好的 secure 或 give 給小號再賣其餘；全賣＝不看背包直接 sell all，只有你自己 secure 過的不會賣', type: 'select', options: [['keep', '留好裝備'], ['none', '全賣，不留']], default: 'keep' },
  { key: 'altId', group: 'sort', show: s => sorting(s) && s.sortKeep !== 'none', label: '小號的英文 ID', hint: '好東西 give 給它；不填就只用 secure 標記留在身上', type: 'text', default: '' },
  { key: 'returnCommand', group: 'sort', show: sorting, label: '回到巡怪地圖的指令／巨集', hint: '回來後要在原本這一區才會繼續', type: 'text', default: '' },
  { key: 'sortPerHour', group: 'sort', show: sorting, label: '每小時最多整理幾次', hint: '超過就停止並警報', type: 'number', default: 6, min: 1, max: 60 },
  { key: 'loopRounds', group: 'rounds', label: '巡完一輪後等下一個重生', hint: '關＝巡完就停', type: 'select', options: ON_OFF, default: 'on' },
  { key: 'standbyCommand', group: 'rounds', show: s => s.loopRounds === 'on', label: '巡完一輪後的待命指令', hint: '可空', type: 'text', default: '' },
  { key: 'aheadSec', group: 'rounds', show: s => s.loopRounds === 'on', label: '提早幾秒開始下一輪', type: 'number', default: 20, min: 0, max: 600 },
  { key: 'stopBeforeSpawnSec', group: 'rounds', label: '重生前幾秒停打', hint: '0＝不停；到了就不再開打新的一隻，打到一半的打完，等重生後接著巡；要比「提早幾秒」大才有用；沒開「等下一個重生」就直接停', type: 'number', default: 0, min: 0, max: 600 },
  { key: 'npcWhitelist', group: 'advanced', label: 'NPC 白名單', hint: '英文 ID，用、分隔', type: 'text', default: '' },
];
// 精、神（目前值）與精氣神內傷（傷勢 %）的補充：比照吃藥，各自一組「低於 %」與指令（設定鍵是 key＋Below／Command），沒填就不看。
// read 是讀哪個百分比：目前＝目前值÷有效值（deps.percent），傷勢＝有效值÷最大值（deps.injury，狀態區 #max_gin 等那格的數字，不到 100% 是內傷）
const TOP_UPS = [
  { key: 'gin', name: '精', read: deps => deps.percent('精') },
  { key: 'sen', name: '神', read: deps => deps.percent('神') },
  { key: 'ginHurt', name: '精內傷', read: deps => deps.injury('精') },
  { key: 'keeHurt', name: '氣內傷', read: deps => deps.injury('氣') },
  { key: 'senHurt', name: '神內傷', read: deps => deps.injury('神') },
];
// 設定頁的分組；summary 是收起時標題後面的重點
const gapText = s => `${s.commandGapMinMs}～${s.commandGapMaxMs}ms`;
const GROUPS = [
  { id: 'move', title: '走路與速度', summary: s => `${gapText(s)}｜學出口 ${s.learnExits === 'on' ? '開' : '關'}｜補掃 ${s.prescan === 'on' ? '開' : '關'}` },
  { id: 'fight', title: '戰鬥', summary: s => (full(s) ? `完整｜打死用 ${s.killCommand}｜逾時 ${s.fightTimeoutSec} 秒` : `只下 fight｜逾時 ${s.fightTimeoutSec} 秒`) },
  { id: 'special', title: '特攻', summary: s => (s.specialCommand ? `${s.specialCommand}，至少隔 ${s.specialIntervalSec} 秒` : '沒填') },
  { id: 'heal', title: '補氣與安全', summary: s => [eatMode(s) ? `吃藥 ${s.eatCommand || '（沒填）'} <${s.eatBelow}%` : `自己回 <${s.restBelow}%`, `回家 ${s.homeCommand || '（沒填）'}`, ...TOP_UPS.map(item => (s[`${item.key}Command`] && s[`${item.key}Below`] > 0 ? `${item.name} <${s[`${item.key}Below`]}%` : ''))].filter(Boolean).join('｜') },
  { id: 'sort', title: '負重與自動整理', summary: s => (sorting(s) ? `>${s.loadMaxPercent}% 整理｜${s.sortKeep === 'none' ? '全賣' : '留好裝備'}` : '不檢查') },
  { id: 'rounds', title: '輪與重生', summary: s => [s.loopRounds === 'on' ? `等重生｜提早 ${s.aheadSec} 秒` : '巡完就停', s.stopBeforeSpawnSec > 0 ? `重生前 ${s.stopBeforeSpawnSec} 秒停打` : ''].filter(Boolean).join('｜') },
  { id: 'advanced', title: '進階', summary: s => (s.npcWhitelist ? `白名單 ${s.npcWhitelist}` : '') },
];
const fieldShown = (field, settings) => !field.show || field.show(settings);
const missingFields = settings => FIELDS.filter(field => field.required?.(settings) && !settings[field.key]);

// 儲存的設定可能缺欄位或被改壞：每個欄位都檢查，不合法用預設
function normalizeSettings(rawSettings) {
  // 舊版的巡怪間隔單位是秒（commandGapMinSec／commandGapMaxSec），沒有新欄位時換算成毫秒
  const raw = rawSettings && typeof rawSettings === 'object' ? { ...rawSettings } : rawSettings;
  ['Min', 'Max'].forEach(which => {
    const old = raw?.[`commandGap${which}Sec`];
    if (raw && raw[`commandGap${which}Ms`] === undefined && old !== undefined && old !== '' && old !== null && Number.isFinite(Number(old))) raw[`commandGap${which}Ms`] = Number(old) * 1000;
  });
  const out = {};
  FIELDS.forEach(field => {
    const value = raw?.[field.key];
    if (field.type === 'number') {
      const number = Number(value);
      out[field.key] = Number.isFinite(number) && value !== '' && value !== null && number >= field.min && number <= field.max ? number : field.default;
    } else if (field.type === 'select') {
      out[field.key] = field.options.some(([id]) => id === value) ? value : field.default;
    } else {
      out[field.key] = typeof value === 'string' ? value.trim() : field.default;
    }
  });
  // 危險線要比休息線低，不然休息時永遠碰不到危險線
  if (out.dangerBelow >= out.restBelow) out.dangerBelow = Math.min(FIELDS.find(field => field.key === 'dangerBelow').default, out.restBelow - 1);
  if (out.commandGapMaxMs < out.commandGapMinMs) out.commandGapMaxMs = out.commandGapMinMs;
  return out;
}

// 巡怪送出的指令之間，除了共用的「指令間隔」，還要再隔最短～最長毫秒之間的隨機一段；random 可注入
function gapMs(settings, random = Math.random) {
  const min = settings.commandGapMinMs;
  const max = settings.commandGapMaxMs;
  return min + random() * (max - min);
}

// 讀回「走過的房間」：形狀不對的丟掉。seen＝走進去 l 看過；blocked＝試過但走不到（鎖著的門、要解謎的地方），掃描不會再試
function normalizeVisited(raw) {
  const out = {};
  Object.entries(raw && typeof raw === 'object' ? raw : {}).forEach(([key, row]) => {
    if (key.includes('/') && row && typeof row === 'object' && Number.isFinite(row.at) && (row.state === 'seen' || row.state === 'blocked')) out[key] = { at: row.at, state: row.state };
  });
  return out;
}

// 讀回儲存的學習結果：形狀不對的丟掉
function normalizeLearned(raw) {
  const out = {};
  Object.entries(raw && typeof raw === 'object' ? raw : {}).forEach(([key, room]) => {
    const to = {};
    Object.entries(room?.to && typeof room.to === 'object' ? room.to : {}).forEach(([cmd, dest]) => { if (typeof dest === 'string') to[cmd] = dest; });
    out[key] = { exits: Array.isArray(room?.exits) ? room.exits.filter(cmd => typeof cmd === 'string') : null, to };
  });
  return out;
}

// out（走出本區）只在記下它的那一輪有效：誤判或有時失敗的門，下一輪重新來過
function forgetOut(learned) {
  Object.values(learned).forEach(room => {
    Object.keys(room.to).forEach(cmd => { if (room.to[cmd] === 'out') delete room.to[cmd]; });
  });
  return learned;
}

// 掃描用：地圖上的單向箭頭（→ ↓ 等）只畫去的方向，回來的路圖上沒有，但實際上多半走得回去（往下的 s 對應回來的 nu 之類）。
// 把每條邊的反方向也當成「猜的」邊補上（只補圖上沒有的；猜的邊走到時由試出口去找真正的指令）
function withReverse(graph) {
  const rooms = {};
  Object.entries(graph.rooms).forEach(([key, room]) => { rooms[key] = { ...room, exits: { ...room.exits } }; });
  Object.entries(graph.rooms).forEach(([key, room]) => Object.entries(room.exits).forEach(([cmd, to]) => {
    const back = OPPOSITE[cmd];
    // 那間已經有通往這裡的邊（不管用哪個指令，例如學到的 nu）就不再補猜的
    if (back && rooms[to] && rooms[to].exits[back] === undefined && !Object.values(rooms[to].exits).includes(key)) rooms[to].exits[back] = key;
  }));
  return { ...graph, rooms };
}

// 把走不通的邊（"房間|指令"）從圖裡拿掉（不改輸入）
function dropEdges(graph, bad) {
  const rooms = {};
  Object.entries(graph.rooms).forEach(([key, room]) => {
    rooms[key] = { ...room, exits: Object.fromEntries(Object.entries(room.exits).filter(([cmd]) => !bad.has(`${key}|${cmd}`))) };
  });
  return { ...graph, rooms };
}

function create(deps) {
  const Route = globalThis.CatworldMapRoute;
  const Collect = globalThis.CatworldMapCollect;
  const Parse = globalThis.CatworldHuntParse;
  let state = null;
  let timer = null;
  let unwatch = null; // 取消「看遊戲輸出」的訂閱
  let note = '';
  let noteAlert = false;
  // 按下「開始」到讀完儲存、建好狀態之間（有 await）：這段時間算「在跑」，再按開始會被擋、按停止會取消這次開始
  let starting = false;
  let cancelled = false;

  // 巡怪紀錄：每間房一行（看到什麼、做了什麼、為什麼略過），只放記憶體、最多 LOG_MAX 行，設定頁「複製巡怪紀錄」用；
  // 別人的 ID 一律不記（只記人數），貼給別人看才不會洩漏其他玩家
  const logLines = [];
  const record = (where, event, text = '') => {
    const at = new Date(deps.now?.() ?? Date.now());
    const pad = n => String(n).padStart(2, '0');
    logLines.push(`${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${where || '-'} ${event}${text ? ' ' + text : ''}`);
    if (logLines.length > LOG_MAX) logLines.shift();
  };
  const lookText = info => `看到 ${info.monsters.length ? info.monsters.map(mob => `${mob.full}${mob.state ? `<${mob.state}>` : ''}${state.mobs.includes(mob.full) ? '✓' : ''}`).join('、') : '沒有怪'}；別人 ${info.people.length} 位；出口 ${info.exits.length}`;

  const skippedNote = list => {
    if (!list.length) return '';
    return `（略過 ${list.length} 間：${list.slice(0, 3).map(item => `${item.key} ${item.why}`).join('、')}${list.length > 3 ? '…' : ''}）`;
  };

  // 巡怪進行中面板那一行用的短版：只有間數，細節放在 detail（滑鼠移上去看）
  const skippedShort = list => (list.length ? `（略過 ${list.length} 間）` : '');
  const skippedDetail = list => list.map(item => `${item.key} ${item.why}`).join('\n');

  // 巡怪時修正了哪些怪的位置（learnVisit 的結果）：只在停止時提一句
  const fixedNote = list => (list.length ? `（修正位置：${list.slice(0, 3).join('、')}${list.length > 3 ? '…' : ''}）` : '');

  const finish = (reason, { alert = false } = {}) => {
    noteAlert = alert;
    clearInterval(timer);
    timer = null;
    const was = state;
    if (was) record('-', '停止', reason);
    state = null;
    unwatch?.();
    unwatch = null;
    was?.fight?.resolve('stopped');
    was?.wake?.();
    note = reason + skippedNote(was?.skipped ?? []) + fixedNote(was?.fixed ?? []);
    deps.dropQueue();
    if (alert && was) deps.alert(reason);
    deps.notify();
  };

  // 掃描模式：記下這間走不到（下次掃描不再試）；讀不到房間可能只是慢，不記
  const markScan = (key, kind) => {
    if (!state?.scan || !deps.markVisited) return;
    Promise.resolve().then(() => deps.markVisited(key, kind)).catch(() => {});
  };

  // 掃描時走不到的房間：第一輪先不記（可能只是被怪纏住、被別人擋住，之後就走得過了），放進 deferred，掃完一輪後再試一次（endRound）；
  // 第二輪還走不到才記成走不到
  const blockScan = key => {
    if (!state?.scan) return;
    if (state.retried) markScan(key, 'blocked');
    else state.deferred.add(key);
  };

  const skipTarget = (key, why) => {
    state.progressAt = state.ticks;
    record(key, '略過', why);
    // 診斷：目標、原因、現在在哪、上一步指令、這間讀到的出口（卡住時請把 console 這幾行貼出來）
    if (state.scan) console.warn('[catworld] 掃描略過', key, why, '現在在', deps.room(), '上一步', state.cmd, '出口', JSON.stringify(state.learned?.[deps.room()]?.exits ?? null));
    // 掃描時走不過去的那一步（鎖著的門）從圖裡拿掉，門後面的房間一下子就判定走不到，不必一間一間等逾時
    if (state.scan) {
      if ((why === '走不過去' || why === '走錯房間') && state.from && state.cmd) state.badEdges.add(`${state.from}|${state.cmd}`);
      if (why !== '讀不到房間') blockScan(key);
    }
    state.targets.delete(key);
    state.skipped.push({ key, why });
    state.skips += 1;
    state.tries = 0;
    state.wrong = 0;
    state.phase = 'plan';
    // 掃描時「試不出路」只是從這裡找不到出口通往目標（第二輪再試），不算連續走不到
    if (state.skips >= MAX_SKIPS && !(state.scan && why === '試不出路')) finish(`連續 ${MAX_SKIPS} 次走不到目標房間，已停止（最後一間 ${key}）`, { alert: true });
  };

  // 這間目標處理完了（不管有沒有打）：從目標拿掉，接著走向下一間
  const doneWith = (key, visit) => {
    state.progressAt = state.ticks;
    record(key, '處理完');
    state.targets.delete(key);
    state.handled += 1;
    if (visit) state.visited.push(visit);
    state.phase = 'plan';
  };

  // 走進房間看過 l：房間裡有哪些怪就是這間的實際情形，交給 deps.learnVisit 修正蒐集到的位置（補上沒記過的、
  // 勾選的怪連續幾次到訪都沒看到就拿掉），修正了就記進 state.fixed。存不進去不影響巡怪
  async function learnPlaces(token, here, info) {
    if (!deps.learnVisit) return;
    try {
      const result = await deps.learnVisit(here, info.monsters.map(mob => mob.full), token.scan ? null : token.mobs);
      if (state !== token || !result) return;
      [...(result.removed || []).map(mob => `${here} 沒有 ${mob}`), ...(result.added || []).map(mob => `${here} 有 ${mob}`)].forEach(text => state.fixed.push(text));
    } catch {
      // 讀寫儲存失敗（例如孤兒程式）：只是沒學到
    }
  }

  // 到了目標房間：送 l 看房間。沒有勾選的怪就直接換下一間（不必問人）；有別人就略過這間；沒見過的 ID 用 finger 分辨
  // 玩家與 NPC（NPC 記下來，下次不再問）；看不到房間（l 沒回應或讀不懂）當成走不過去；其餘進 fightRoom 打怪。
  // 每個 await 之後都要確認這一次巡怪還在（停止或重新開始後，舊的檢查不能再動新的狀態、也不能再送指令）
  async function inspect(token, here) {
    const info = Parse.parseLook(await deps.ask('l', 'look'));
    if (state !== token) return;
    // 回應回來時人已經不在這間了（例如自己手動跑掉）：這份輸出是別間的，不能記給這間，丟掉、重新規劃
    const now = deps.room();
    if (now && now !== here) { state.phase = 'plan'; return; }
    if (!info.exits.length) { skipTarget(here, '讀不到房間'); return; }
    record(here, '看房間', lookText(info));
    learnExits(here, info.exits);
    await learnPlaces(token, here, info);
    if (state !== token) return;
    if (token.scan) {
      try { await deps.markVisited?.(here, 'seen'); } catch { /* 存不進去只是下次還會再走一次 */ }
      if (state !== token) return;
      state.skips = 0;
      doneWith(here, here);
      return;
    }
    if (!info.monsters.some(mob => token.mobs.includes(mob.full))) { state.skips = 0; doneWith(here, here); return; }
    const npcs = await deps.npcs();
    if (state !== token) return;
    const unknown = [...new Set(info.people.map(person => person.id))].filter(id => !npcs.has(id.toLowerCase()));
    for (const id of unknown) {
      // ID 會被放進 finger 指令：不是普通英數的（可能夾帶指令）不送，直接當玩家
      const kind = SAFE_ID.test(id) ? Parse.parseFinger(await deps.ask(`finger ${id}`, 'finger')) : 'player';
      if (state !== token) return;
      if (kind === 'npc') {
        await deps.learnNpc(id);
        if (state !== token) return;
        continue;
      }
      // 玩家，或 finger 沒回應、讀不懂（一律當玩家）
      state.skipped.push({ key: here, why: `有別人 ${id}` });
      record(here, '略過', '有別人');
      doneWith(here);
      return;
    }
    state.skips = 0;
    if (state.settings.fightMode === 'assist') { assistStart(here, info); return; }
    await fightRoom(token, here, info);
  }

  // ---- 只下 fight 模式（fightMode 為 assist）----
  // 戰鬥、補氣、撿屍都由玩家自己的觸發規則處理，這裡只：到房間有勾選的怪就送一次 fight，之後被動看遊戲輸出——
  // 看到 i 的輸出且負重超標就去整理；看到 l 的輸出沒怪了就換格、還有怪而且沒人在戰鬥中就再送一次 fight。逾時沒看到 l 就自己送一次
  // 只下 fight 模式要等的「死了」：結束字扣掉代表昏迷的（昏迷不算死，你的觸發會去補刀）
  const deathWords = () => {
    const knockout = splitIds(state.settings.knockoutKeywords);
    return splitIds(state.settings.endKeywords).filter(word => !knockout.includes(word));
  };
  function assistStart(here, info) {
    state.assist = { here, buffer: '', quietTicks: 0, waited: 0, asking: false, stuck: 0, count: Infinity, silent: 0, sent: false, dead: false, tail: '', loadTail: '' };
    state.phase = 'assist';
    assistJudge(info, true);
  }
  // 依一份 l 的內容決定下一步（輪到第一次、被動看到、逾時自己看都用這個）。fresh＝第一次看到、或逾時自己看的：
  // 這種情況不再等昏迷的怪（沒有人在補刀就不會有下一份 l，等下去會卡到逾時）
  function assistJudge(info, fresh = false) {
    const a = state.assist;
    const picked = info.monsters.filter(mob => state.mobs.includes(mob.full));
    const mine = picked.filter(mob => mob.state !== KNOCKED_OUT);
    // 診斷：每次決定都印一行，使用者回報「怪還沒死就下 fight」時看這行就知道當時看到什麼、為什麼送
    const trace = action => record(a.here, '只下fight', `${fresh ? '剛到房間或逾時自己看' : '被動看到'}：${lookText(info)} → ${action}`) || console.log('[catworld] 只下 fight：', a.here, `看到 ${picked.length} 隻、昏迷 ${picked.length - mine.length}、戰鬥中 ${mine.filter(mob => mob.state === '戰鬥中').length}`, fresh ? '〔剛到房間或逾時自己看的 l〕' : '〔被動看到的 l〕', '→', action);
    const leave = why => {
      state.assist = null;
      if (why) { state.skipped.push({ key: a.here, why }); record(a.here, '略過', why); }
      doneWith(a.here, why ? undefined : a.here);
    };
    // 下過 fight 之後要看到死亡的字才再對下一隻下（只靠 l 的狀態判斷，怪沒標 <戰鬥中>、或在逃時，會變成第一隻還沒死就打第二隻）；剛到房間、逾時自己看的不等（沒有死亡的字可等）
    if (a.sent && !a.dead && !fresh && picked.length) { trace('等死亡的字'); return; }
    // 勾選的怪有昏迷但還沒死的：玩家的觸發規則會去補刀（k），這時對別隻下 fight 會變成第一隻還沒死就打第二隻，先等它死了
    if (picked.length > mine.length && !fresh) { a.waited = 0; trace('等昏迷的怪死掉'); return; }
    if (!mine.length) { trace('沒有可打的怪，換格'); leave(); return; }
    a.waited = 0;
    if (mine.some(mob => mob.state === '戰鬥中')) { trace('有怪在戰鬥中，繼續等'); return; } // 在打，繼續等
    a.stuck = mine.length < a.count ? 0 : a.stuck + 1;
    a.count = mine.length;
    if (a.stuck >= MAX_STUCK) { trace('怪數一直沒減少，略過這間'); leave('打不動'); return; }
    const target = mine.find(mob => SAFE_ID.test(mob.id));
    if (!target) { leave('怪的 ID 不能用'); return; }
    if (spawnPause()) { trace('重生前停打'); return; }
    trace(`送 fight ${target.ref ?? target.id}`);
    a.sent = true;
    a.dead = false;
    a.tail = '';
    if (!deps.send(`fight ${target.ref ?? target.id}`)) finish('指令送不出去，已停止', { alert: true });
  }
  // 玩家的觸發送了 i 而且負重超標：結束這間的等待，下一次規劃時走既有的負重檢查與整理
  function assistOverweight(load) {
    if (load === null || !(state.settings.loadMaxPercent > 0) || load < state.settings.loadMaxPercent) return false;
    console.log(`[catworld] 只下 fight：看到 i 的載重 ${load}%，達到 ${state.settings.loadMaxPercent}%，結束這間的等待去整理`);
    state.load = load;
    state.assist = null;
    state.loadDue = true;
    state.phase = 'plan';
    deps.notify();
    return true;
  }
  function assistTick() {
    const a = state.assist;
    if (a.asking) return;
    const room = deps.room();
    if (room && room !== a.here) { state.assist = null; state.phase = 'plan'; return; } // 人已經不在這間（手動走掉了）：重新規劃
    a.waited += 1;
    if (a.buffer) {
      a.quietTicks += 1;
      if (a.quietTicks >= ASSIST_QUIET_TICKS) {
        const text = a.buffer;
        a.buffer = '';
        a.quietTicks = 0;
        if (assistOverweight(Parse.parseLoad(text))) return;
        const info = Parse.parseLook(text);
        if (info.exits.length) { assistJudge(info); return; }
      }
    }
    if (a.waited >= state.settings.fightTimeoutSec * TICKS_PER_SEC) assistCheck(a);
  }
  // 等太久沒看到 l：自己送一次 l（期間不收被動輸出，免得同一份處理兩次）
  function assistCheck(a) {
    const token = state;
    a.asking = true;
    deps.ask('l', 'look').then(text => {
      if (state !== token || state.assist !== a) return;
      a.asking = false;
      a.waited = 0;
      a.buffer = '';
      const info = Parse.parseLook(text);
      if (!info.exits.length) {
        if ((a.silent += 1) >= MAX_STUCK) { state.assist = null; skipTarget(a.here, '讀不到房間'); }
        return;
      }
      assistJudge(info, true);
    }).catch(() => { if (state === token) finish('看房間時出錯，已停止', { alert: true }); });
  }

  // 把房間裡勾選的怪一隻一隻打完：fight（被拒就 kill）→ 倒下就送打完指令 → 再 l 重數；連續 MAX_STUCK 次數量沒減少就略過這間
  async function fightRoom(token, here, first) {
    let info = first;
    let stuck = 0;
    for (;;) {
      // 昏迷的怪打不了，不當目標也不算還沒打完
      const mine = info.monsters.filter(mob => token.mobs.includes(mob.full) && mob.state !== KNOCKED_OUT);
      if (!mine.length) { doneWith(here, here); return; }
      // ID 會被放進 fight 指令，和 finger 一樣只收普通英數
      const target = mine.find(mob => SAFE_ID.test(mob.id));
      if (!target) { state.skipped.push({ key: here, why: '怪的 ID 不能用' }); record(here, '略過', '怪的 ID 不能用'); doneWith(here); return; }
      if (spawnPause()) return;
      if (!(await restGate(token))) return;
      if (!(await notBusy(token))) return;
      record(here, '開打', target.full);
      let outcome = await fightOne(token, target);
      if (state !== token || outcome === 'stopped') return;
      record(here, '打完', outcome);
      // 打到昏迷（不是死）：補一個 kill 確實打死，出現死亡的字才算數；然後才撿屍
      if (outcome === 'knockedOut' && state.settings.finishKnockedOut === 'on') {
        outcome = await fightOne(token, target, { finishing: true });
        if (state !== token || outcome === 'stopped') return;
      }
      if (!(await notBusy(token))) return;
      if (state.settings.afterKillCommand) deps.send(state.settings.afterKillCommand);
      if (state.settings.loadMaxPercent > 0) state.loadDue = true;
      info = Parse.parseLook(await deps.ask('l', 'look'));
      if (state !== token) return;
      if (!info.exits.length) { skipTarget(here, '讀不到房間'); return; }
      const left = info.monsters.filter(mob => token.mobs.includes(mob.full) && mob.state !== KNOCKED_OUT).length;
      stuck = left < mine.length ? 0 : stuck + 1;
      if (stuck >= MAX_STUCK) { state.skipped.push({ key: here, why: '打不動' }); record(here, '略過', '打不動'); doneWith(here); return; }
      record(here, '重數', lookText(info));
    }
  }

  // 角色忙碌（狀態欄「忙碌」或忙碌冷卻條在跑）就等到不忙；巡怪停了或換了一次回 false
  async function notBusy(token) {
    while (deps.busy?.()) {
      await new Promise(resolve => setTimeout(resolve, TICK_MS));
      if (state !== token) return false;
    }
    return true;
  }

  // 打一隻：送 fight，之後由 onText（拒戰句、結束句）與 fightTick（特攻、補氣、逾時看 l）推進；結束時回 'ended'，被停止回 'stopped'
  // finishing 為真＝補刀：直接送 kill，只認死亡的字（結束字裡扣掉代表昏迷的），不送特攻；結束時回 'ended'、昏迷結束回 'knockedOut'
  const killCmd = () => state.settings.killCommand || 'kill';
  function fightOne(token, mob, { finishing = false } = {}) {
    return new Promise(resolve => {
      const knockout = splitIds(state.settings.knockoutKeywords);
      const endWords = splitIds(state.settings.endKeywords).filter(word => !finishing || !knockout.includes(word));
      // 特攻從開打算起隔一個間隔才送第一次，免得緊跟在 fight 後面被拒戰時得到「你要對誰施展這個招式」
      state.fight = { mob, resolve, finishing, knockout, knockedOut: false, killSent: finishing, buffer: '', noTarget: false, waited: 0, lastSpecial: state.ticks, checking: false, silentChecks: 0, endWords };
      deps.notify();
      if (!deps.send(`${finishing ? killCmd() : 'fight'} ${mob.ref ?? mob.id}`)) finish('指令送不出去，已停止', { alert: true });
    });
  }
  const endFight = fight => {
    if (state?.fight !== fight) return;
    state.fight = null;
    fight.resolve(fight.knockedOut ? 'knockedOut' : 'ended');
  };

  // 遊戲新增的輸出（content.js 以 deps.watch 餵進來）：只在打的時候看。拒戰句→改送 kill；結束句（怪死、昏迷）→這一隻打完；
  // 「你要對誰施展這個招式」→這場不再送特攻。忙碌拒絕句不用處理：被拒的特攻不重排，等下一次間隔
  function onText(text) {
    const eating = state?.eating;
    if (eating?.sent && state.ticks <= eating.until && state.settings.noMedicineKeyword) {
      eating.buffer = (eating.buffer + text).slice(-500);
      if (eating.buffer.includes(state.settings.noMedicineKeyword)) { goHomeAndStop('沒藥了'); return; }
    }
    const assist = state?.assist;
    if (assist && !assist.asking) {
      assist.buffer = (assist.buffer + text).slice(-6000);
      assist.quietTicks = 0;
      // 載重行一出現就判斷，不等輸出靜止：戰鬥中觸發送 i，輸出一直來、永遠不會靜止，等的話這行早被擠出緩衝
      assist.loadTail = (assist.loadTail + text).slice(-200);
      if (assistOverweight(Parse.parseLoad(assist.loadTail))) return;
    }
    if (assist?.sent && !assist.dead) {
      assist.tail = (assist.tail + text).slice(-500);
      if (deathWords().some(word => assist.tail.includes(word))) {
        assist.dead = true;
        // 死了之後如果一直沒有新的 l（你的觸發沒送），過幾秒自己看一次，才不會等到整個逾時
        assist.waited = Math.max(assist.waited, state.settings.fightTimeoutSec * TICKS_PER_SEC - 3 * TICKS_PER_SEC);
      }
    }
    const fight = state?.fight;
    if (!fight) return;
    fight.buffer = (fight.buffer + text).slice(-500);
    const settings = state.settings;
    if (NO_TARGET.test(fight.buffer)) fight.noTarget = true;
    if (!fight.killSent && settings.refuseKeyword && fight.buffer.includes(settings.refuseKeyword)) {
      fight.killSent = true;
      fight.noTarget = false; // 前面的特攻對著還沒開打的怪，不算這場沒有目標
      fight.buffer = '';
      deps.send(`${killCmd()} ${fight.mob.ref ?? fight.mob.id}`);
      return;
    }
    const hit = fight.endWords.find(word => fight.buffer.includes(word));
    if (hit) {
      fight.knockedOut = !fight.finishing && fight.knockout.includes(hit);
      fight.buffer = '';
      endFight(fight);
    }
  }

  // 等太久沒看到結束句：送 l 看一眼。還有怪在 <戰鬥中> 就繼續等；怪昏迷或不見了就當結束；怪還在但沒在打（指令沒送到？）重送 fight（已改 kill 就重送 kill），最多 3 次
  function lookCheck(fight) {
    const token = state;
    fight.checking = true;
    deps.ask('l', 'look').then(text => {
      if (state !== token || state.fight !== fight) return;
      fight.checking = false;
      fight.waited = 0;
      const info = Parse.parseLook(text);
      if (!info.exits.length) { if ((fight.silentChecks += 1) >= MAX_STUCK) endFight(fight); return; }
      const mine = info.monsters.filter(mob => token.mobs.includes(mob.full));
      if (mine.some(mob => mob.state === '戰鬥中')) return;
      // 重送時用這次 l 看到的位置（前面的怪倒下後，第幾個會變）
      const again = mine.find(mob => mob.state !== KNOCKED_OUT && SAFE_ID.test(mob.id));
      if (again && (fight.silentChecks += 1) < MAX_STUCK) { deps.send(`${fight.killSent ? killCmd() : 'fight'} ${again.ref}`); return; }
      fight.knockedOut = !fight.finishing && mine.some(mob => mob.id === fight.mob.id && mob.state === KNOCKED_OUT);
      endFight(fight);
    }).catch(() => { if (state === token) finish('看房間時出錯，已停止', { alert: true }); });
  }

  // 送吃藥指令，並開始聽「沒藥」關鍵字
  // 窗口從指令真的送出才開始算（佇列可能塞住），不然慢送出時遊戲的回應會落在窗口外
  function eat() {
    state.lastEat = state.ticks;
    swallow(state.settings.eatCommand);
  }
  function swallow(command) {
    const eating = { sent: false, until: 0, buffer: '' };
    state.eating = eating;
    deps.send(command, () => {
      if (state?.eating !== eating) return;
      eating.sent = true;
      eating.until = state.ticks + NO_MEDICINE_WINDOW_TICKS;
    });
  }
  // 精、神、內傷（TOP_UPS）：比照吃藥，低於門檻送指令（同一項至少隔 5 秒），送出後一樣聽「沒藥關鍵字」；沒填、讀不到都不看（選填的，不能因此停）
  function topUp() {
    for (const { key, read } of TOP_UPS) {
      const below = state.settings[`${key}Below`];
      const command = state.settings[`${key}Command`];
      if (!command || !(below > 0)) continue;
      const percent = read(deps);
      if (!Number.isFinite(percent) || percent >= below || state.ticks - (state.lastTopUp[key] ?? -Infinity) < EAT_GAP_TICKS) continue;
      state.lastTopUp[key] = state.ticks;
      swallow(command);
    }
  }
  // 吃藥後遊戲回「沒藥」：回家（停止後才送，不會被取消）、停止、警報
  function goHomeAndStop(reason) {
    const home = state.settings.homeCommand;
    finish(`${reason}，${home ? '已回家並' : ''}停止`, { alert: true });
    if (home) deps.sendAfterStop(home);
  }
  // 自己回模式：低於「開始休息 %」就閒置，等回到「繼續 %」；每次休息只送一次休息指令（例如打坐，一次就會坐到被打斷）
  function restStep(percent) {
    const settings = state.settings;
    state.restPercent = percent;
    if (!state.resting && percent < settings.restBelow) {
      state.resting = true;
      state.restSent = false;
    } else if (state.resting && percent >= settings.restResume) {
      state.resting = false;
      state.wake?.();
    }
    // 看房間（l、finger 在等回應）時不送，免得休息指令的輸出混進回應；角色忙碌時也先不送（會被遊戲拒絕），等忙碌結束；
    // 走路時與 restGate 等待時才送
    if (state.resting && settings.restCommand && !state.restSent && (state.phase !== 'look' || state.gate) && !deps.busy?.()) {
      state.restSent = true;
      deps.send(settings.restCommand);
    }
  }
  // 走路與看房間時每秒補氣：讀不到氣就停（不能在不知道氣的情況下亂走）
  function vitals() {
    topUp();
    const percent = deps.kee();
    if (!Number.isFinite(percent)) { finish('讀不到氣，已停止', { alert: true }); return; }
    // 掃描時整區走動，被主動攻擊的怪打到的機會比巡怪多：氣掉到危險線就回家停止（不管補氣方式，沒有在打架也一樣）
    if (state.scan && percent < state.settings.dangerBelow) { goHomeAndStop(`掃描中氣只剩 ${Math.round(percent)}%（低於 ${state.settings.dangerBelow}%）`); return; }
    // 只下 fight：休息是玩家的觸發規則的事；危險線照樣回家停止，吃藥模式有填吃藥指令時照樣吃（戰鬥中也每秒看，因為這個模式沒有 fightTick）
    if (state.settings.fightMode === 'assist') {
      if (percent < state.settings.dangerBelow) { goHomeAndStop(`氣只剩 ${Math.round(percent)}%（低於 ${state.settings.dangerBelow}%）`); return; }
      if (state.settings.healMode === 'eat' && state.settings.eatCommand && percent < state.settings.eatBelow && state.ticks - state.lastEat >= EAT_GAP_TICKS) eat();
      return;
    }
    if (state.settings.healMode === 'rest') { restStep(percent); return; }
    if (percent < state.settings.eatBelow && state.ticks - state.lastEat >= EAT_GAP_TICKS) eat();
  }
  // 打下一隻之前：自己回模式氣太低就在這裡等到回復（打完這一隻再休息）
  async function restGate(token) {
    if (state.settings.healMode === 'rest' && state.settings.fightMode === 'full') {
      const percent = deps.kee();
      if (Number.isFinite(percent)) restStep(percent);
    }
    state.gate = state.resting;
    while (state.resting) {
      await new Promise(resolve => { state.wake = resolve; });
      if (state !== token) return false;
    }
    state.gate = false;
    return true;
  }

  // 戰鬥中補氣（每秒看一次）：吃藥模式低於門檻就送吃藥指令（至少間隔 5 秒）；自己回模式戰鬥中沒辦法閒置，掉到危險線就回家、停止、警報
  function healInFight() {
    topUp();
    const settings = state.settings;
    const percent = deps.kee();
    if (!Number.isFinite(percent)) { finish('讀不到氣，已停止', { alert: true }); return; }
    if (settings.healMode === 'rest') {
      if (percent < settings.dangerBelow) goHomeAndStop(`戰鬥中氣只剩 ${Math.round(percent)}%（低於 ${settings.dangerBelow}%）`);
      return;
    }
    if (percent < settings.eatBelow && settings.eatCommand && state.ticks - state.lastEat >= EAT_GAP_TICKS) eat();
  }

  function fightTick() {
    const fight = state.fight;
    const settings = state.settings;
    if (state.ticks % TICKS_PER_SEC === 0) {
      healInFight();
      if (!state || state.fight !== fight) return;
    }
    // 角色忙碌時不送特攻，等候逾時也不算（忙碌中送的會被遊戲拒絕）；補氣照常
    if (deps.busy?.()) return;
    fight.waited += 1;
    // 特攻：怪還活著、這場沒被告知沒有目標、距離上次已過最小間隔、而且遊戲的特攻冷卻條（#perform）跑完了才送
    if (settings.specialCommand && !fight.finishing && !fight.noTarget && state.ticks - fight.lastSpecial >= settings.specialIntervalSec * TICKS_PER_SEC && !deps.cooling?.('perform')) {
      fight.lastSpecial = state.ticks;
      deps.send(settings.specialCommand);
    }
    if (!fight.checking && fight.waited >= settings.fightTimeoutSec * TICKS_PER_SEC) lookCheck(fight);
  }

  function arrive(here) {
    const token = state;
    state.phase = 'look';
    state.goal = here;
    deps.notify();
    inspect(token, here).catch(() => { if (state === token) finish('看房間時出錯，已停止', { alert: true }); });
  }

  // ---- 自動學習出口（設定 learnExits 開著才作用）----
  // 存檔：重讀儲存、只把這一輪改過的房間合併進去（多個分頁同時巡怪不會互相蓋掉）；一個接一個排隊
  const save = key => {
    state.dirty.add(key);
    const learned = state.learned;
    const dirty = state.dirty;
    state.saving = state.saving.then(async () => {
      const keys = [...dirty];
      dirty.clear();
      const merged = normalizeLearned(await deps.exits());
      keys.forEach(room => {
        const mine = learned[room];
        merged[room] = { exits: mine.exits ?? merged[room]?.exits ?? null, to: { ...merged[room]?.to, ...mine.to } };
      });
      await deps.saveExits(merged);
    }).catch(() => {});
  };
  const learnedAt = key => (state.learned[key] ??= { exits: null, to: {} });
  // 送指令；送不出去就停止並警報
  function sendOrStop(command) {
    if (deps.send(command)) return true;
    finish('指令送不出去，已停止', { alert: true });
    return false;
  }
  function learnExits(key, exits) {
    if (!state.learn || !exits.length) return;
    state.looked.add(key);
    const room = learnedAt(key);
    if (JSON.stringify(room.exits) === JSON.stringify(exits)) return;
    room.exits = exits;
    save(key);
  }
  function learnEdge(from, cmd, to) {
    const room = learnedAt(from);
    if (room.to[cmd] === to) return;
    room.to[cmd] = to;
    save(from);
  }
  // 路線用的圖：地圖圖示的邊，加上學到的。strict 時，已知出口的房間只留出口裡有的指令；實測的邊一律優先（覆蓋圖示、可以是圖示上沒有的 eu／ed），走出區域的邊拿掉
  function buildGraph(strict) {
    const rooms = {};
    Object.entries(state.graph.rooms).forEach(([key, room]) => {
      const learned = state.learned[key];
      const exits = {};
      Object.entries(room.exits).forEach(([cmd, to]) => {
        if (learned?.to[cmd] === 'out') return;
        if (strict && learned?.exits && !learned.exits.includes(cmd)) return;
        exits[cmd] = to;
      });
      Object.entries(learned?.to ?? {}).forEach(([cmd, to]) => { if (to !== 'out' && state.graph.rooms[to]) exits[cmd] = to; });
      // 實測的邊取代圖上畫的、通往同一間卻不在出口裡的邊（圖上往 s、實際是 su）：兩條都留著，路線會挑到走不通的 s
      if (learned?.exits) {
        Object.entries(room.exits).forEach(([cmd, to]) => {
          if (!(cmd in learned.to) && !learned.exits.includes(cmd) && Object.values(learned.to).includes(to)) delete exits[cmd];
        });
      }
      rooms[key] = { ...room, exits };
    });
    return { rooms };
  }
  // 要走的邊還沒驗證、房間的出口也沒讀過：先 l 看一次（每個房間每次最多一次）
  function learnHere(here) {
    const token = state;
    state.looked.add(here);
    state.phase = 'look';
    state.learning = true;
    deps.notify();
    deps.ask('l', 'look').then(text => {
      if (state !== token) return;
      state.learning = false;
      learnExits(here, Parse.parseLook(text).exits);
      state.phase = 'plan';
      deps.notify();
    }).catch(() => { if (state === token) finish('看房間時出錯，已停止', { alert: true }); });
  }
  // 路線需要的邊在這個房間的出口裡找不到：把沒試過的出口一個一個試（每個房間每個指令只試一次）
  // want＝路線要走、但出口裡沒有的那個指令（圖上畫的方向）：試出口時先試和它相符的（圖上往 s，實際是 su／sd 這種上下坡）
  function startTrial(here, want) {
    state.trial = { room: here, cmd: null, want, stage: 'pick', waited: 0 };
    state.phase = 'trial';
    deps.notify();
  }
  // 氣夠才試：吃藥模式看吃藥門檻，自己回模式看有沒有在休息
  const enoughQi = () => (state.settings.healMode === 'rest' ? !state.resting : deps.kee() >= state.settings.eatBelow);
  // 走到地圖外：記成 out，用反方向走回來（走回來之前也要氣夠）；不知道反方向就停止並警報。
  // exploring 為真＝是試出口走出去的，走回來之後接著試下一個；否則走回來就結束
  function backOut(room, cmd, { exploring }) {
    learnEdge(room, cmd, 'out');
    const back = OPPOSITE[cmd];
    if (!back) { finish(`走到地圖外的房間，而且不知道怎麼走回來（${cmd}），已停止`, { alert: true }); return; }
    state.trial = { room, cmd, back, stage: 'back-send', waited: 0, exploring };
    state.phase = 'trial';
    deps.notify();
  }
  function trialTick() {
    const trial = state.trial;
    const here = deps.room();
    trial.waited += 1;
    if (trial.stage === 'pick') {
      if (!enoughQi()) {
        if (trial.waited > QI_WAIT_TICKS) { state.trial = null; skipTarget(state.goal, '氣一直太低，沒辦法試出口'); }
        return;
      }
      const learned = state.learned[trial.room];
      const tried = (state.tried[trial.room] ??= new Set());
      const fresh = (learned?.exits ?? []).filter(exit => !tried.has(exit) && !learned.to[exit]);
      const rank = exit => (trial.want && exit.startsWith(trial.want) ? (/^[ud]$/.test(exit.slice(trial.want.length)) ? 2 : 1) : 0);
      const cmd = [...fresh].sort((a, b) => rank(b) - rank(a))[0]; // 穩定排序：同級照 l 印的順序
      if (!cmd) { state.trial = null; skipTarget(state.goal, '試不出路'); return; }
      tried.add(cmd);
      trial.cmd = cmd;
      trial.stage = 'moving';
      trial.waited = 0;
      sendOrStop(cmd);
    } else if (trial.stage === 'moving') {
      if (here && here !== trial.room) {
        if (!state.graph.rooms[here]) { backOut(trial.room, trial.cmd, { exploring: true }); return; }
        learnEdge(trial.room, trial.cmd, here);
        state.trial = null; // 不論是不是預期的那一間，都用學到的邊重算
        state.phase = 'plan';
      } else if (here === trial.room) {
        if (trial.waited > MOVE_TIMEOUT_TICKS) { trial.stage = 'pick'; trial.waited = 0; } // 沒走成，換下一個
      } else if (trial.waited > 2 * MOVE_TIMEOUT_TICKS) {
        backOut(trial.room, trial.cmd, { exploring: true }); // 一直讀不到房間：多等一倍的時間才當成走進地圖上沒有的房間（地圖捲動可能慢）
      }
    } else if (trial.stage === 'back-send') {
      if (!enoughQi()) return;
      if (!sendOrStop(trial.back)) return;
      trial.stage = 'back';
      trial.waited = 0;
    } else if (here === trial.room) {
      if (trial.exploring) { trial.stage = 'pick'; trial.waited = 0; } else { state.trial = null; state.phase = 'plan'; }
    } else if (trial.waited > MOVE_TIMEOUT_TICKS) {
      finish('走到地圖外之後走不回來，已停止', { alert: true });
    }
  }

  // ---- 負重 ----
  // 打完怪撿了東西，下一次規劃前先用 i 看負重（loadMaxPercent，0＝不檢查）；超過就自動整理（sortOut）；前往與回程指令都沒填就停止並提醒去填
  function checkLoad(here) {
    const token = state;
    state.phase = 'look';
    state.checkingLoad = true;
    deps.notify();
    deps.ask('i', 'inventory').then(text => {
      if (state !== token) return;
      state.checkingLoad = false;
      const percent = Parse.parseLoad(text);
      if (percent === null) { console.warn('[catworld] 巡怪：讀不到負重（i 的輸出沒有「載重 N%」），這次不檢查'); state.phase = 'plan'; deps.notify(); return; }
      state.load = percent;
      const settings = state.settings;
      if (percent < settings.loadMaxPercent) { state.sorted = false; state.phase = 'plan'; deps.notify(); return; }
      if (sortConfigured(settings)) {
        if (state.sorted) { finish(`整理完負重還是 ${percent}%（要小於 ${settings.loadMaxPercent}%），已停止`, { alert: true }); return; }
        sortOut(here, token);
        return;
      }
      finish(`負重 ${percent}% 已經超過 ${settings.loadMaxPercent}%，請先到設定頁「地圖巡怪」填好「整理：前往整理處」與「整理：回程」的指令`, { alert: true });
    }).catch(() => { if (state === token) finish('讀取負重時出錯，已停止', { alert: true }); });
  }
  // ---- 自動整理（永動機）----
  // 前往（路線與鑑定都寫在裡面，抓輸出裡的裝備區塊）、回程兩個指令只要填了任何一個就走這條：前往 → i → 把好東西 secure 標記或 give 給小號 → sell all → 回程 →
  // 確認還在這一區 → 回去繼續巡怪（下一次 plan 會再看一次負重）。任何一步沒成功就停止並警報，不賣東西
  const sortConfigured = settings => Boolean(settings.tripCommand || settings.returnCommand);
  const SORT_PHASE_TEXT = { trip: '前往整理處與鑑定', inventory: '看背包', keep: '標記或轉給小號', sell: '賣東西', back: '回到巡怪地圖' };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const SORT_REPLY = { secure: /標記完成/, give: /你給/ };
  // 送一個指令／巨集並等它送完；null＝巡怪已經停了或換了一次，false＝等太久
  function runStep(command, token) {
    return new Promise(resolve => {
      if (!command) { resolve(true); return; }
      let sent = false;
      let waited = 0;
      deps.send(command, () => { sent = true; });
      const poll = () => {
        if (state !== token) { resolve(null); return; }
        if (sent && !deps.macroRunning()) { resolve(true); return; }
        if ((waited += 1) > SORT_STEP_TICKS) { resolve(false); return; }
        setTimeout(poll, TICK_MS);
      };
      poll();
    });
  }
  async function sortOut(here, token) {
    const settings = state.settings;
    const stage = name => { if (state === token) { state.phase = 'sort'; state.sortStage = name; deps.notify(); } };
    const fail = reason => { if (state === token) finish(reason, { alert: true }); };
    const now = deps.now();
    state.sortTimes = state.sortTimes.filter(at => now - at < 3600 * 1000);
    if (state.sortTimes.length >= settings.sortPerHour) { fail(`一小時內已經整理 ${state.sortTimes.length} 次，超過上限 ${settings.sortPerHour}，已停止`); return; }
    if (settings.altId && !SAFE_ID.test(settings.altId)) { fail(`小號 ID「${settings.altId}」不合法（只能英文、數字、空白、底線、點、單引號、連字號），已停止`); return; }
    state.sortTimes.push(now);
    try {
      // 前往指令跑完前印出的輸出都抓下來（鑑定的裝備區塊在裡面）：好幾個地方要鑑定時，路線與鑑定指令全寫在前往指令裡
      let captured = '';
      const unwatchOut = deps.watch(text => { captured += text; });
      let ok;
      try {
        stage('trip');
        ok = await runStep(settings.tripCommand, token);
        if (ok === null) return;
        if (!ok) { fail('前往整理處的指令沒有送完，已停止'); return; }
        await pause(SORT_QUIET_MS);
      } finally { unwatchOut(); }
      if (ok === null || state !== token) return;
      // 全賣模式：不看背包、不標記、不轉給小號，鑑定完直接 sell all（已手動標記的仍不會賣）
      let keep = [];
      if (settings.sortKeep !== 'none') {
        stage('inventory');
        const items = Parse.parseInventory(await deps.ask('i', 'inventory'));
        if (state !== token) return;
        if (!items.length) { fail('讀不到背包（i 的輸出沒有物品），已停止，沒有賣東西'); return; }
        const keepers = new Set((await deps.keepers(captured)).map(name => name.replace(/\s+/g, '')));
        if (state !== token) return;
        // 要留的：名稱對得上鑑定出的好裝備，而且還沒標記、不是穿著中的
        keep = items.filter(item => !item.marked && !item.worn && keepers.has(item.name.replace(/\s+/g, '')));
        stage('keep');
      }
      for (const item of keep) {
        if (!SAFE_ID.test(item.id)) { fail(`物品 ID「${item.id}」不能放進指令，已停止，沒有賣東西`); return; }
        const kind = settings.altId ? 'give' : 'secure';
        const reply = await deps.ask(settings.altId ? `give ${item.ref} to ${settings.altId}` : `secure ${item.ref}`, kind);
        if (state !== token) return;
        if (!SORT_REPLY[kind].test(reply)) { fail(`${kind === 'give' ? '轉給小號' : '標記'} ${item.name} 沒成功（遊戲回：${reply.trim().slice(0, 40) || '沒有回應'}），已停止，沒有賣東西`); return; }
      }
      stage('sell');
      await deps.ask('sell all', 'sell');
      if (state !== token) return;
      stage('back');
      ok = await runStep(settings.returnCommand, token);
      if (ok === null) return;
      if (!ok) { fail('回程的指令沒有送完，已停止'); return; }
      // 回到這一區才繼續（地圖捲動可能慢，多等一會）
      const inArea = () => deps.room()?.startsWith(`${state.area}/`);
      for (let waited = 0; waited <= 2 * MOVE_TIMEOUT_TICKS && !inArea(); waited += 1) {
        await pause(TICK_MS);
        if (state !== token) return;
      }
      if (!inArea()) { fail(`整理完回程後不在 ${state.area} 這一區（目前 ${deps.room() ?? '讀不到房間'}），已停止`); return; }
      state.sorted = true;
      state.loadDue = true;
      state.phase = 'plan';
      state.sortCount += 1;
      deps.notify();
    } catch {
      fail('整理時出錯，已停止');
    }
  }

  // ---- 輪與輪之間 ----
  // 時間都用伺服器時間（毫秒）：deps.now()＋偏差。state.after 是「這一輪打下來的怪從什麼時候起重生」：
  // 等待之後開始的那一輪＝它等的那個重生本身（精確的整點，不能用算出來的時間，否則偏差差一點就會把同一個重生又算一次）；
  // 馬上開始的（按開始、或掃描太久而已過）＝現在加提早秒數。下一個重生＝after 之後的第一個 15 分鐘整點
  const nextSpawn = after => (Math.floor(after / RESPAWN_MS) + 1) * RESPAWN_MS;
  const hhmm = ms => {
    const date = new Date(ms + 8 * 3600 * 1000);
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  };
  // 用 time 讀伺服器時間，回偏差（伺服器時間 − 電腦時鐘）；讀不到回 null
  async function readOffset() {
    const server = Parse.parseTime(await deps.ask('time', 'time'));
    return server === null ? null : server - deps.now();
  }
  // 勾選的怪在這個區域記錄的房間（要在地圖上）；不在地圖上的列進略過清單
  function huntTargets(store, mobs, area, graph) {
    const places = mobs.flatMap(mob => Collect.locate(store, mob)).filter(place => place.area === area);
    const rooms = [...new Set(places.flatMap(place => place.rooms.map(room => `${place.area}/${room}`)))];
    return { targets: new Set(rooms.filter(key => graph.rooms[key])), baseSkipped: rooms.filter(key => !graph.rooms[key]).map(key => ({ key, why: '不在地圖上' })) };
  }
  // 打怪前的補掃做完：用補掃之後的資料重新算目標房間，轉成一般的巡怪
  async function startHuntAfterPrescan() {
    const token = state;
    state.phase = 'look'; // 重讀資料的這一下不規劃路線
    deps.notify();
    let store;
    try { store = await deps.readStore(); } catch { if (state === token) finish('讀不到蒐集的怪物資料，已停止', { alert: true }); return; }
    if (state !== token) return;
    const { targets, baseSkipped } = huntTargets(store, state.mobs, state.area, state.graph);
    if (!targets.size) { finish(`掃描完成（走過 ${state.visited.length} 間），但這一區沒有勾選的怪的房間`); return; }
    Object.assign(state, {
      scan: false, prescan: false, learn: state.settings.learnExits === 'on', progressAt: state.ticks,
      targets, allTargets: new Set(targets), baseSkipped, skipped: [...baseSkipped], badEdges: new Set(), deferred: new Set(), retried: false,
      round: 1, after: deps.now() + state.offset + state.settings.aheadSec * 1000, waiting: null, ...roundFields(),
    });
    state.phase = 'plan';
    deps.notify();
  }
  const roundFields = () => ({ skips: 0, tries: 0, wrong: 0, blind: 0, handled: 0, visited: [] });
  // 每個目標房間都處理過一次＝一輪。沒開「等下一個重生」或這一輪什麼都沒處理（沒有走得到的目標）就停（第 2 輪以後警報）；
  // 否則送待命指令（是巨集的話等它跑完），用 time 校準，等到下一個重生減「提早秒數」再開始下一輪
  function endRound() {
    // 第一輪走不到的房間再試一次（門還是過不去才記成走不到）
    if (state.scan && !state.retried && state.deferred.size) {
      state.retried = true;
      state.badEdges.clear();
      state.skipped = state.skipped.filter(item => !state.deferred.has(item.key));
      state.targets = new Set(state.deferred);
      state.deferred.clear();
      Object.assign(state, { skips: 0, tries: 0, wrong: 0 });
      state.phase = 'plan';
      deps.notify();
      return;
    }
    if (state.scan && state.prescan) { startHuntAfterPrescan(); return; }
    if (state.scan) { finish(state.handled ? `掃描完成（走過 ${state.visited.length} 間）` : '沒有走得到的房間了'); return; }
    const message = state.handled ? `這一輪巡完了（到過 ${state.visited.length} 間）` : '沒有走得到的目標房間了';
    if (state.settings.loopRounds !== 'on' || !state.handled) { finish(message, { alert: !state.handled && state.round > 1 }); return; }
    if (state.settings.standbyCommand && !sendOrStop(state.settings.standbyCommand)) return;
    state.phase = 'standby';
    deps.notify();
  }
  // 重生前停打：離下一個重生（伺服器時間每 15 分鐘）不到設定的秒數，就不再開打新的一隻（打到一半的由呼叫端打完才會走到這裡）；
  // 這一輪已經算進那個重生（after ≥ 它，例如等完重生才開始的這一輪）就不停，否則會一直停。停了之後和一輪結束一樣待命、等那個重生
  function spawnPause() {
    const sec = state.settings.stopBeforeSpawnSec;
    if (!(sec > 0) || state.scan) return false;
    const now = deps.now() + state.offset;
    const spawn = nextSpawn(now);
    if (state.after >= spawn || spawn - now > sec * 1000) return false;
    state.assist = null;
    if (state.settings.loopRounds !== 'on') { finish(`重生前 ${sec} 秒停打（${hhmm(spawn)} 重生），已停止`); return true; }
    console.log(`[catworld] 巡怪：重生前 ${sec} 秒停打，等 ${hhmm(spawn)} 的重生`);
    state.after = spawn - 1; // calibrate 用 nextSpawn(after) 決定等哪一個重生
    if (state.settings.standbyCommand && !sendOrStop(state.settings.standbyCommand)) return true;
    state.phase = 'standby';
    deps.notify();
    return true;
  }
  function calibrate() {
    const token = state;
    state.phase = 'wait';
    state.calibrating = true;
    deps.notify();
    readOffset().then(offset => {
      if (state !== token) return;
      state.calibrating = false;
      if (offset === null) { finish('讀不到伺服器時間（time 的輸出），已停止', { alert: true }); return; }
      const ahead = state.settings.aheadSec * 1000;
      const spawn = nextSpawn(state.after);
      const now = deps.now() + offset;
      if (now >= spawn - ahead) { beginRound(now + ahead, offset); return; }
      state.waiting = { startAt: spawn - ahead, spawn, offset, calibratedAt: deps.now(), asking: false, rounds: state.round, visited: state.visited.length };
      deps.notify();
    }).catch(() => { if (state === token) finish('讀取伺服器時間時出錯，已停止', { alert: true }); });
  }
  function beginRound(after) {
    state.round += 1;
    state.waiting = null;
    state.after = after;
    state.targets = new Set(state.allTargets);
    state.skipped = [...state.baseSkipped];
    Object.assign(state, roundFields());
    state.phase = 'plan';
    deps.notify();
  }
  // 等待中：快到時（或電腦時鐘被調過、估計已經到了）先重新校準，確認剛校準過（一分鐘內）才開始；校準讀不到也停止
  function waitTick() {
    if (state.phase === 'standby') {
      if (!deps.macroRunning()) calibrate();
      return;
    }
    const waiting = state.waiting;
    if (!waiting || waiting.asking) return;
    const now = deps.now();
    const estimate = now + waiting.offset;
    if (estimate >= waiting.startAt - RECALIBRATE_LEAD_MS && now - waiting.calibratedAt > RECALIBRATE_GAP_MS) {
      const token = state;
      waiting.asking = true;
      readOffset().then(offset => {
        if (state !== token) return;
        if (offset === null) { finish('讀不到伺服器時間（time 的輸出），已停止', { alert: true }); return; }
        waiting.offset = offset;
        waiting.calibratedAt = deps.now();
        waiting.asking = false;
      }).catch(() => { if (state === token) finish('讀取伺服器時間時出錯，已停止', { alert: true }); });
      return;
    }
    if (estimate >= waiting.startAt && now - waiting.calibratedAt <= FRESH_MS) beginRound(waiting.spawn);
  }

  // 規劃下一步：到了目標就看房間；否則挑路線最短的目標，送出路線的第一個指令
  // 學習開著時分兩張圖：嚴格圖（已知出口的房間只走出口裡有的）優先；只有寬鬆圖（純地圖圖示）走得到時，圖示的猜測可能走不通
  function plan(here) {
    if (state.loadDue) { state.loadDue = false; checkLoad(here); return; }
    if (state.targets.has(here)) { arrive(here); return; }
    const clean = graph => (state.badEdges.size ? dropEdges(graph, state.badEdges) : graph);
    const strictGraph = clean(state.learn ? buildGraph(true) : state.graph);
    // 先補猜的反方向，再拿掉走不通的邊（順序反過來，剛拿掉的邊會被另一頭的反方向補回來）
    const looseBase = state.learn ? buildGraph(false) : state.graph;
    const looseGraph = clean(state.scan ? withReverse(looseBase) : looseBase);
    if (state.learn && !looseGraph.rooms[here]) { finish('走到地圖外的房間，已停止', { alert: true }); return; }
    let best = null;
    let guess = null;
    [...state.targets].forEach(key => {
      const way = Route.route(strictGraph, here, key);
      const loose = way ?? Route.route(looseGraph, here, key);
      if (!loose) { state.targets.delete(key); state.skipped.push({ key, why: '走不到' }); record(key, '略過', '走不到'); blockScan(key); return; }
      if (way) { if (!best || way.length < best.way.length) best = { key, way, graph: strictGraph }; }
      else if (!guess || loose.length < guess.way.length) guess = { key, way: loose, graph: looseGraph };
    });
    const chosen = best ?? guess;
    if (!chosen) { endRound(); return; }
    const cmd = chosen.way[0];
    state.goal = chosen.key;
    state.expected = chosen.graph.rooms[here].exits[cmd];
    if (state.learn) {
      const learned = state.learned[here];
      if (!state.looked.has(here) && !learned?.exits && !learned?.to[cmd]) { learnHere(here); return; }
      if (strictGraph.rooms[here].exits[cmd] === undefined) { startTrial(here, cmd); return; }
    }
    if (!sendOrStop(cmd)) return;
    record(here, '走', `${cmd} → 目標 ${chosen.key}（還要 ${chosen.way.length} 步，剩 ${state.targets.size} 間）`);
    state.cmd = cmd;
    state.phase = 'move';
    state.from = here;
    state.waited = 0;
    deps.notify();
  }

  function tick() {
    if (!state) return;
    state.ticks += 1;
    // 掃描的卡住偵測：房間沒換、也沒處理完或略過任何一間，超過 SCAN_STALL_TICKS 就停下來（不管卡在哪個階段，包括一直在休息）
    if (state.scan) {
      const room = deps.room();
      if (room !== state.lastRoom) { state.lastRoom = room; state.progressAt = state.ticks; }
      else if (state.ticks - state.progressAt > SCAN_STALL_TICKS) {
        finish(`掃描 ${SCAN_STALL_TICKS / TICKS_PER_SEC} 秒沒有進展，已停止（${describe().text}）`, { alert: true });
        return;
      }
    }
    if (state.fight) { fightTick(); return; }
    if ((state.ticks - 1) % TICKS_PER_SEC === 0) {
      vitals();
      if (!state) return;
    }
    // 角色忙碌時（狀態欄「忙碌」或忙碌冷卻條在跑）走路、看房間、下 fight 都先停，逾時也不算；補氣（上面的 vitals）照常
    if (deps.busy?.() && state.phase !== 'wait' && state.phase !== 'standby' && state.phase !== 'sort') return;
    if (state.assist) { assistTick(); return; }
    if (state.phase === 'wait' || state.phase === 'standby') { waitTick(); return; }
    if (state.phase === 'sort') return;
    if (state.trial) { trialTick(); return; }
    if (state.phase === 'look') return;
    const here = deps.room();
    state.waited += 1;
    if (state.phase === 'move') {
      if (here && here !== state.from) {
        record(here, '走到', here === state.expected ? '' : `不是預期的 ${state.expected ?? '?'}`);
        state.phase = 'plan';
        if (state.learn) {
          // 走到地圖上沒有的區域：記下來、走回來；走到地圖上的房間：記下實測的連線
          if (!state.graph.rooms[here]) { backOut(state.from, state.cmd, { exploring: false }); return; }
          // 重送過的移動，第一次可能只是慢到：到的房間不一定是這一步的結果，不記
          if (state.tries === 0) learnEdge(state.from, state.cmd, here);
        }
        if (here === state.expected) { state.skips = 0; state.tries = 0; }
        // 走到的不是路線上的下一間：重算；同一個目標一直走錯（門把人送回去）就略過它，不然會在兩間之間來回
        else if ((state.wrong += 1) >= MAX_WRONG) { skipTarget(state.goal, '走錯房間'); return; }
      } else if (state.waited > MOVE_TIMEOUT_TICKS) {
        // 第一次沒走成就重送一次，再沒走成就略過這間目標
        if (state.tries < 1) { state.tries += 1; record(state.from, '重送', `${state.cmd} 沒走成`); state.phase = 'plan'; } else { skipTarget(state.goal, '走不過去'); return; }
      } else return;
    }
    if (!here) {
      // 地圖捲動中的一兩個 tick 讀不到不算：連續讀不到超過逾時才停
      state.blind += 1;
      if (state.blind > MOVE_TIMEOUT_TICKS) finish('讀不到目前所在的房間，已停止', { alert: true });
      return;
    }
    state.blind = 0;
    // 每走下一步之前都再看一次氣（每秒一次的檢查可能晚一步）；休息中不走路
    if (state.settings.healMode === 'rest') {
      const percent = deps.kee();
      if (Number.isFinite(percent)) restStep(percent);
    }
    if (state.resting) return;
    plan(here);
  }

  // 按「開始」：把勾選的怪與目前顯示的區域固定下來；回傳 { ok, error }
  // options.scan＝街景模式：不用勾怪，走這一區還沒走過的每一間，每間 l 一次記下怪與走過（不打、不問人、不等重生）
  async function start(options = {}) {
    const scan = options.scan === true;
    if (state || starting) return { ok: false, error: '已經在巡怪' };
    starting = true;
    cancelled = false;
    note = '準備中…';
    noteAlert = false;
    deps.notify();
    try {
      const target = await deps.target();
      if (scan && !target?.area) return fail('讀不到地圖目前顯示的區域（地圖視窗沒有開？）');
      if (!scan && !target?.mobs?.length) return fail('請先按「選怪」勾選要巡的怪');
      const here = deps.room();
      if (!here) return fail('讀不到目前所在的房間（地圖視窗沒開，或房間不在地圖上）');
      if (!here.startsWith(`${target.area}/`)) return fail('目前所在的房間不在地圖顯示的區域，請先把地圖切到你所在的區域');
      const graph = Route.parseArea(deps.areaHtml(target.area));
      if (!Object.keys(graph.rooms).length) return fail('讀不到這個區域的地圖');
      const store = await deps.readStore();
      const settings = scan ? { ...await deps.settings(), loopRounds: 'off' } : await deps.settings();
      if (cancelled) return fail('已取消', false);
      const missing = missingFields(settings).map(field => field.label);
      if (missing.length) return fail(`請先到設定頁「地圖巡怪」填：${missing.join('、')}`);
      const learn = settings.learnExits === 'on' || scan; // 掃描一定會碰到圖上畫不準的房間（圖上往 s、實際是 su），所以一律照 l 的出口行走
      const learned = learn || settings.prescan === 'on' ? forgetOut(normalizeLearned(await deps.exits())) : {};
      if (cancelled) return fail('已取消', false);
      let offset = 0;
      if (settings.loopRounds === 'on' || (!scan && settings.stopBeforeSpawnSec > 0)) {
        const read = await readOffset();
        if (cancelled) return fail('已取消', false);
        if (read === null) return fail('讀不到伺服器時間（time 的輸出），沒有開始');
        offset = read;
      }
      let targets;
      let baseSkipped = [];
      let prescan = false;
      if (scan) {
        const visited = normalizeVisited(await deps.visited?.());
        if (cancelled) return fail('已取消', false);
        // 走過（seen）的不再走；上次走不到（blocked）的每次掃描都再試一次（門可能開了、怪散了），不必清掉紀錄
        targets = new Set(Object.keys(graph.rooms).filter(key => visited[key]?.state !== 'seen'));
        if (!targets.size) return fail('這一區的房間都走過了（要全部重掃，請到設定頁清除「已走過的房間」）', false);
      } else {
        ({ targets, baseSkipped } = huntTargets(store, target.mobs, target.area, graph));
        // 這一區有還沒走過、也沒記成走不到的房間＝沒有圖資：先掃它們，掃完再用補好的資料打（資料還沒補，勾選的怪可能一間都找不到，所以先不擋）
        if (settings.prescan === 'on') {
          const known = normalizeVisited(await deps.visited?.());
          if (cancelled) return fail('已取消', false);
          const missing = Object.keys(graph.rooms).filter(key => !known[key]);
          if (missing.length) { prescan = true; targets = new Set(missing); baseSkipped = []; }
        }
        if (!prescan && !targets.size) return fail('這個區域沒有蒐集到勾選的怪的房間（或那些房間不在地圖上）');
      }
      state = {
        round: 1, after: deps.now() + offset + settings.aheadSec * 1000, allTargets: new Set(targets), baseSkipped, waiting: null, calibrating: false,
        mobs: scan ? [] : target.mobs, area: target.area, offset, scan: scan || prescan, prescan, progressAt: 0, lastRoom: null, badEdges: new Set(), deferred: new Set(), retried: false, graph, targets, skipped: [...baseSkipped], fixed: [],
        settings, loadDue: false, load: null, assist: null, sorted: false, sortTimes: [], sortCount: 0, sortStage: null, checkingLoad: false, learn: learn || prescan, learned, dirty: new Set(), saving: Promise.resolve(), looked: new Set(), tried: {}, trial: null, cmd: null, learning: false, ticks: 0, lastEat: -Infinity, lastTopUp: {}, restSent: false, resting: false, restPercent: NaN, wake: null, gate: false, eating: null, fight: null,
        ...roundFields(), phase: 'plan', goal: null, expected: null, from: null, waited: 0,
      };
      note = '';
      record(target.area, '目標房間', `${[...targets].join(' ') || '（沒有）'}`);
      baseSkipped.forEach(item => record(item.key, '略過', item.why));
      record(target.area, prescan ? '開始（打怪前補掃）' : scan ? '開始（掃描）' : '開始', `怪 ${scan ? '-' : target.mobs.join('、')}；目標 ${targets.size} 間；從 ${here}；${['fightMode', 'loopRounds', 'stopBeforeSpawnSec', 'healMode', 'prescan', 'learnExits', 'finishKnockedOut'].map(key => `${key}=${settings[key]}`).join(' ')}`);
      unwatch = deps.watch(onText);
      timer = setInterval(tick, TICK_MS);
      tick();
      deps.notify();
      return { ok: true };
    } finally {
      starting = false;
      deps.notify(); // 失敗時 fail() 通知的當下還算「在跑」，開始鈕會停用到下一次重畫，這裡再通知一次
    }
  }
  function fail(error, alert = true) {
    note = error;
    noteAlert = alert;
    deps.notify();
    return { ok: false, error };
  }

  function stop(reason = '已停止') {
    if (starting) cancelled = true;
    if (state) finish(reason);
    else if (starting) fail('已取消', false);
  }

  const on = () => starting || state !== null;
  const describe = () => {
    if (!state) return { text: note || '未啟動', alert: noteAlert };
    // 面板那一行要短：怪只寫名稱（拿掉括號 ID），房間只寫房間代號（區域在地圖上看得到）；完整的放在 title
    const who = state.prescan ? '打怪前先掃描' : state.scan ? '掃描' : state.mobs.length === 1 ? state.mobs[0].replace(/\s*\([^()]*\)\s*$/, '') : `${state.mobs.length} 種怪`;
    const room = key => (typeof key === 'string' ? key.split('/').pop() : key);
    if (state.resting) return { text: `${who}：休息中 ${Math.round(state.restPercent)}%→${state.settings.restResume}%${skippedShort(state.skipped)}`, alert: noteAlert };
    if (state.waiting) return { text: `${who}：等下一個重生 ${hhmm(state.waiting.spawn)}（第 ${state.waiting.rounds} 輪到過 ${state.waiting.visited} 間）${skippedShort(state.skipped)}`, alert: noteAlert };
    if (state.phase === 'sort') return { text: `${who}：負重 ${state.load}%，整理中（${SORT_PHASE_TEXT[state.sortStage] ?? '…'}，第 ${state.sortCount + 1} 次）${skippedShort(state.skipped)}`, alert: noteAlert };
    if (state.checkingLoad) return { text: `${who}：看負重…${skippedShort(state.skipped)}`, alert: noteAlert };
    if (state.phase === 'standby') return { text: `${who}：等待指令送完，再校準伺服器時間…${skippedShort(state.skipped)}`, alert: noteAlert };
    if (state.calibrating) return { text: `${who}：校準伺服器時間…${skippedShort(state.skipped)}`, alert: noteAlert };
    if (state.trial) return { text: `${who}：在 ${room(state.trial.room)} 試出口${skippedShort(state.skipped)}`, alert: noteAlert };
    if (state.learning) return { text: `${who}：看 ${room(state.goal) ?? '房間'} 的出口…${skippedShort(state.skipped)}`, alert: noteAlert };
    if (state.assist) return { text: `${who}：在 ${room(state.assist.here)} 已下 fight，等你的觸發規則打完（看 l 與 i 的輸出）${skippedShort(state.skipped)}`, alert: noteAlert };
    if (state.fight) return { text: `${who}：在 ${room(state.goal)} 打 ${state.fight.mob.name}${skippedShort(state.skipped)}`, alert: noteAlert };
    if (state.phase === 'look') return { text: `${who}：到了 ${room(state.goal)}，看房間…${skippedShort(state.skipped)}`, alert: noteAlert };
    return { text: `${who}：走向 ${room(state.goal) ?? '…'}（剩 ${state.targets.size} 間）${skippedShort(state.skipped)}`, alert: noteAlert };
  };
  // 面板那一行只寫略過幾間（要看是哪幾間、為什麼，滑鼠移到那一行；停止時的訊息也會列）
  const summary = () => {
    const info = describe();
    return state ? { ...info, detail: [state.mobs.join('、'), state.goal ? `目標房間 ${state.goal}` : '', skippedDetail(state.skipped)].filter(Boolean).join('\n') } : info;
  };
  const snapshot = () => ({ on: on(), note, targets: state ? [...state.targets] : [], skipped: state ? state.skipped : [] });

  const exportLog = () => logLines.join('\n');

  return { start, stop, on, summary, snapshot, exportLog };
}

globalThis.CatworldMapHunt = { SETTINGS_KEY, NPCS_KEY, EXITS_KEY, VISITED_KEY, FIELDS, GROUPS, fieldShown, missingFields, normalizeSettings, normalizeVisited, gapMs, splitIds, create };
})();

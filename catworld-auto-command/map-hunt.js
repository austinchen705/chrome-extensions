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
const OPPOSITE = { n: 's', s: 'n', e: 'w', w: 'e', ne: 'sw', sw: 'ne', nw: 'se', se: 'nw', u: 'd', d: 'u', eu: 'wd', wd: 'eu', ed: 'wu', wu: 'ed', nu: 'sd', sd: 'nu', nd: 'su', su: 'nd' };
const splitIds = text => String(text ?? '').split(/[、,，;；\s]+/).filter(Boolean);
const TICK_MS = 200;
const MOVE_TIMEOUT_TICKS = 25; // 5 秒
const MAX_SKIPS = 3;
const MAX_WRONG = 3; // 同一個目標走錯房間幾次就略過
const SAFE_ID = /^[A-Za-z][A-Za-z0-9 _.'-]*$/;
const MAX_STUCK = 3; // 連續幾次打完指令後怪的數量沒減少就略過這間
const TICKS_PER_SEC = 1000 / TICK_MS;
const EAT_GAP_TICKS = 5 * TICKS_PER_SEC; // 吃藥指令至少間隔 5 秒
const NO_TARGET = /你要對誰施展這個招式/;
const KNOCKED_OUT = '昏迷不醒';
const QI_WAIT_TICKS = 60 * TICKS_PER_SEC; // 試出口前等氣回復最多等這麼久，等不到就略過這個目標
const NO_MEDICINE_WINDOW_TICKS = 10 * TICKS_PER_SEC; // 吃藥指令真的送出後，這麼久內出現沒藥關鍵字才算

// 設定頁的欄位（也決定預設值與檢查）：type 是 text、number 或 select
const FIELDS = [
  { key: 'healMode', label: '補氣方式', type: 'select', options: [['eat', '吃藥'], ['rest', '自己回']], default: 'eat' },
  { key: 'eatBelow', label: '氣低於幾 % 就吃藥', type: 'number', default: 50, min: 1, max: 99 },
  { key: 'eatCommand', label: '吃藥指令（可多個，用 ; 分隔）', type: 'text', default: '' },
  { key: 'noMedicineKeyword', label: '沒藥時遊戲回的字（吃藥模式）', type: 'text', default: '' },
  { key: 'homeCommand', label: '回家指令', type: 'text', default: '' },
  { key: 'restBelow', label: '自己回：氣低於幾 % 就休息', type: 'number', default: 50, min: 2, max: 99 },
  { key: 'restResume', label: '自己回：氣回到幾 % 才繼續', type: 'number', default: 80, min: 1, max: 100 },
  { key: 'restCommand', label: '自己回：休息時送的指令（可空）', type: 'text', default: '' },
  { key: 'dangerBelow', label: '自己回：戰鬥中氣低於幾 % 就回家停止（要小於「氣低於幾 % 就休息」，否則自動改小）', type: 'number', default: 20, min: 1, max: 99 },
  { key: 'learnExits', label: '自動學習出口（記下看到的出口與實際走到的房間；路線不通時才試出口）', type: 'select', options: [['off', '關'], ['on', '開']], default: 'off' },
  { key: 'afterKillCommand', label: '怪倒下後送的指令（可多個，用 ; 分隔）', type: 'text', default: 'gc' },
  { key: 'specialCommand', label: '特攻指令（可空，可以是你的別名）', type: 'text', default: '' },
  { key: 'specialIntervalSec', label: '特攻最小間隔（秒）', type: 'number', default: 10, min: 1, max: 600 },
  { key: 'refuseKeyword', label: '怪不想打時遊戲回的字（fight 被拒就改 kill）', type: 'text', default: '並不想跟你較量' },
  { key: 'endKeywords', label: '怪倒下的字（用、分隔）', type: 'text', default: '一動也不動了、死了' },
  { key: 'fightTimeoutSec', label: '等怪倒下最久幾秒（逾時就用 l 看一眼）', type: 'number', default: 60, min: 5, max: 600 },
  { key: 'npcWhitelist', label: 'NPC 白名單（英文 ID，用、分隔）', type: 'text', default: '' },
  { key: 'standbyCommand', label: '巡完一輪後送的待命指令（可空）', type: 'text', default: '' },
  { key: 'aheadSec', label: '提早幾秒開始下一輪', type: 'number', default: 20, min: 0, max: 600 },
];

// 儲存的設定可能缺欄位或被改壞：每個欄位都檢查，不合法用預設
function normalizeSettings(raw) {
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

  const skippedNote = list => {
    if (!list.length) return '';
    return `（略過 ${list.length} 間：${list.slice(0, 3).map(item => `${item.key} ${item.why}`).join('、')}${list.length > 3 ? '…' : ''}）`;
  };

  const finish = (reason, { alert = false } = {}) => {
    noteAlert = alert;
    clearInterval(timer);
    timer = null;
    const was = state;
    state = null;
    unwatch?.();
    unwatch = null;
    was?.fight?.resolve('stopped');
    was?.wake?.();
    note = reason + skippedNote(was?.skipped ?? []);
    deps.dropQueue();
    if (alert && was) deps.alert(reason);
    deps.notify();
  };

  const skipTarget = (key, why) => {
    state.targets.delete(key);
    state.skipped.push({ key, why });
    state.skips += 1;
    state.tries = 0;
    state.wrong = 0;
    state.phase = 'plan';
    if (state.skips >= MAX_SKIPS) finish(`連續 ${MAX_SKIPS} 次走不到目標房間，已停止（最後一間 ${key}）`, { alert: true });
  };

  // 這間目標處理完了（不管有沒有打）：從目標拿掉，接著走向下一間
  const doneWith = (key, visit) => {
    state.targets.delete(key);
    state.handled += 1;
    if (visit) state.visited.push(visit);
    state.phase = 'plan';
  };

  // 到了目標房間：送 l 看房間。沒有勾選的怪就直接換下一間（不必問人）；有別人就略過這間；沒見過的 ID 用 finger 分辨
  // 玩家與 NPC（NPC 記下來，下次不再問）；看不到房間（l 沒回應或讀不懂）當成走不過去；其餘進 fightRoom 打怪。
  // 每個 await 之後都要確認這一次巡怪還在（停止或重新開始後，舊的檢查不能再動新的狀態、也不能再送指令）
  async function inspect(token, here) {
    const info = Parse.parseLook(await deps.ask('l', 'look'));
    if (state !== token) return;
    if (!info.exits.length) { skipTarget(here, '讀不到房間'); return; }
    learnExits(here, info.exits);
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
      doneWith(here);
      return;
    }
    state.skips = 0;
    await fightRoom(token, here, info);
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
      if (!target) { state.skipped.push({ key: here, why: '怪的 ID 不能用' }); doneWith(here); return; }
      if (!(await restGate(token))) return;
      const outcome = await fightOne(token, target);
      if (state !== token || outcome === 'stopped') return;
      if (state.settings.afterKillCommand) deps.send(state.settings.afterKillCommand);
      info = Parse.parseLook(await deps.ask('l', 'look'));
      if (state !== token) return;
      if (!info.exits.length) { skipTarget(here, '讀不到房間'); return; }
      const left = info.monsters.filter(mob => token.mobs.includes(mob.full) && mob.state !== KNOCKED_OUT).length;
      stuck = left < mine.length ? 0 : stuck + 1;
      if (stuck >= MAX_STUCK) { state.skipped.push({ key: here, why: '打不動' }); doneWith(here); return; }
    }
  }

  // 打一隻：送 fight，之後由 onText（拒戰句、結束句）與 fightTick（特攻、補氣、逾時看 l）推進；結束時回 'ended'，被停止回 'stopped'
  function fightOne(token, mob) {
    return new Promise(resolve => {
      // 特攻從開打算起隔一個間隔才送第一次，免得緊跟在 fight 後面被拒戰時得到「你要對誰施展這個招式」
      state.fight = { mob, resolve, killSent: false, buffer: '', noTarget: false, waited: 0, lastSpecial: state.ticks, checking: false, silentChecks: 0, endWords: splitIds(state.settings.endKeywords) };
      deps.notify();
      if (!deps.send(`fight ${mob.id}`)) finish('指令送不出去，已停止', { alert: true });
    });
  }
  const endFight = fight => {
    if (state?.fight !== fight) return;
    state.fight = null;
    fight.resolve('ended');
  };

  // 遊戲新增的輸出（content.js 以 deps.watch 餵進來）：只在打的時候看。拒戰句→改送 kill；結束句（怪死、昏迷）→這一隻打完；
  // 「你要對誰施展這個招式」→這場不再送特攻。忙碌拒絕句不用處理：被拒的特攻不重排，等下一次間隔
  function onText(text) {
    const eating = state?.eating;
    if (eating?.sent && state.ticks <= eating.until && state.settings.noMedicineKeyword) {
      eating.buffer = (eating.buffer + text).slice(-500);
      if (eating.buffer.includes(state.settings.noMedicineKeyword)) { goHomeAndStop('沒藥了'); return; }
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
      deps.send(`kill ${fight.mob.id}`);
      return;
    }
    if (fight.endWords.some(word => fight.buffer.includes(word))) {
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
      if (mine.some(mob => mob.state !== KNOCKED_OUT) && (fight.silentChecks += 1) < MAX_STUCK) { deps.send(`${fight.killSent ? 'kill' : 'fight'} ${fight.mob.id}`); return; }
      endFight(fight);
    }).catch(() => { if (state === token) finish('看房間時出錯，已停止', { alert: true }); });
  }

  // 送吃藥指令，並開始聽「沒藥」關鍵字
  // 窗口從指令真的送出才開始算（佇列可能塞住），不然慢送出時遊戲的回應會落在窗口外
  function eat() {
    state.lastEat = state.ticks;
    const eating = { sent: false, until: 0, buffer: '' };
    state.eating = eating;
    deps.send(state.settings.eatCommand, () => {
      if (state?.eating !== eating) return;
      eating.sent = true;
      eating.until = state.ticks + NO_MEDICINE_WINDOW_TICKS;
    });
  }
  // 吃藥後遊戲回「沒藥」：回家（停止後才送，不會被取消）、停止、警報
  function goHomeAndStop(reason) {
    const home = state.settings.homeCommand;
    finish(`${reason}，${home ? '已回家並' : ''}停止`, { alert: true });
    if (home) deps.sendAfterStop(home);
  }
  // 自己回模式：低於「開始休息 %」就閒置，等回到「繼續 %」；閒置時隔 5 秒送一次休息指令
  function restStep(percent) {
    const settings = state.settings;
    state.restPercent = percent;
    if (!state.resting && percent < settings.restBelow) state.resting = true;
    else if (state.resting && percent >= settings.restResume) {
      state.resting = false;
      state.wake?.();
    }
    // 看房間（l、finger 在等回應）時不送，免得休息指令的輸出混進回應；走路時與 restGate 等待時才送
    if (state.resting && settings.restCommand && (state.phase !== 'look' || state.gate) && state.ticks - state.lastRest >= EAT_GAP_TICKS) {
      state.lastRest = state.ticks;
      deps.send(settings.restCommand);
    }
  }
  // 走路與看房間時每秒補氣：讀不到氣就停（不能在不知道氣的情況下亂走）
  function vitals() {
    const percent = deps.kee();
    if (!Number.isFinite(percent)) { finish('讀不到氣，已停止', { alert: true }); return; }
    if (state.settings.healMode === 'rest') { restStep(percent); return; }
    if (percent < state.settings.eatBelow && state.ticks - state.lastEat >= EAT_GAP_TICKS) eat();
  }
  // 打下一隻之前：自己回模式氣太低就在這裡等到回復（打完這一隻再休息）
  async function restGate(token) {
    if (state.settings.healMode === 'rest') {
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
    fight.waited += 1;
    if (state.ticks % TICKS_PER_SEC === 0) {
      healInFight();
      if (!state || state.fight !== fight) return;
    }
    // 特攻：怪還活著、這場沒被告知沒有目標、距離上次已過最小間隔才送（#busy 還沒有樣本，不看狀態列）
    if (settings.specialCommand && !fight.noTarget && state.ticks - fight.lastSpecial >= settings.specialIntervalSec * TICKS_PER_SEC) {
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
  function startTrial(here) {
    state.trial = { room: here, cmd: null, stage: 'pick', waited: 0 };
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
      const cmd = (learned?.exits ?? []).find(exit => !tried.has(exit) && !learned.to[exit]);
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

  // 規劃下一步：到了目標就看房間；否則挑路線最短的目標，送出路線的第一個指令
  // 學習開著時分兩張圖：嚴格圖（已知出口的房間只走出口裡有的）優先；只有寬鬆圖（純地圖圖示）走得到時，圖示的猜測可能走不通
  function plan(here) {
    if (state.targets.has(here)) { arrive(here); return; }
    const strictGraph = state.learn ? buildGraph(true) : state.graph;
    const looseGraph = state.learn ? buildGraph(false) : state.graph;
    if (state.learn && !looseGraph.rooms[here]) { finish('走到地圖外的房間，已停止', { alert: true }); return; }
    let best = null;
    let guess = null;
    [...state.targets].forEach(key => {
      const way = Route.route(strictGraph, here, key);
      const loose = way ?? Route.route(looseGraph, here, key);
      if (!loose) { state.targets.delete(key); state.skipped.push({ key, why: '走不到' }); return; }
      if (way) { if (!best || way.length < best.way.length) best = { key, way, graph: strictGraph }; }
      else if (!guess || loose.length < guess.way.length) guess = { key, way: loose, graph: looseGraph };
    });
    const chosen = best ?? guess;
    if (!chosen) { finish(state.handled ? `這一輪巡完了（到過 ${state.visited.length} 間）` : '沒有走得到的目標房間了'); return; }
    const cmd = chosen.way[0];
    state.goal = chosen.key;
    state.expected = chosen.graph.rooms[here].exits[cmd];
    if (state.learn) {
      const learned = state.learned[here];
      if (!state.looked.has(here) && !learned?.exits && !learned?.to[cmd]) { learnHere(here); return; }
      if (strictGraph.rooms[here].exits[cmd] === undefined) { startTrial(here); return; }
    }
    if (!sendOrStop(cmd)) return;
    state.cmd = cmd;
    state.phase = 'move';
    state.from = here;
    state.waited = 0;
    deps.notify();
  }

  function tick() {
    if (!state) return;
    state.ticks += 1;
    if (state.fight) { fightTick(); return; }
    if ((state.ticks - 1) % TICKS_PER_SEC === 0) {
      vitals();
      if (!state) return;
    }
    if (state.trial) { trialTick(); return; }
    if (state.phase === 'look') return;
    const here = deps.room();
    state.waited += 1;
    if (state.phase === 'move') {
      if (here && here !== state.from) {
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
        if (state.tries < 1) { state.tries += 1; state.phase = 'plan'; } else { skipTarget(state.goal, '走不過去'); return; }
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
  async function start() {
    if (state || starting) return { ok: false, error: '已經在巡怪' };
    starting = true;
    cancelled = false;
    note = '準備中…';
    noteAlert = false;
    deps.notify();
    try {
      const target = await deps.target();
      if (!target?.mobs?.length) return fail('請先按「選怪」勾選要巡的怪');
      const here = deps.room();
      if (!here) return fail('讀不到目前所在的房間（地圖視窗沒開，或房間不在地圖上）');
      if (!here.startsWith(`${target.area}/`)) return fail('目前所在的房間不在地圖顯示的區域，請先把地圖切到你所在的區域');
      const graph = Route.parseArea(deps.areaHtml(target.area));
      if (!Object.keys(graph.rooms).length) return fail('讀不到這個區域的地圖');
      const store = await deps.readStore();
      const settings = await deps.settings();
      if (cancelled) return fail('已取消', false);
      const missing = [];
      if (settings.healMode === 'eat') {
        if (!settings.eatCommand) missing.push('吃藥指令');
        if (!settings.noMedicineKeyword) missing.push('沒藥關鍵字');
      }
      if (!settings.homeCommand) missing.push('回家指令');
      if (missing.length) return fail(`請先到設定頁「地圖巡怪」填：${missing.join('、')}`);
      const learn = settings.learnExits === 'on';
      const learned = learn ? forgetOut(normalizeLearned(await deps.exits())) : {};
      if (cancelled) return fail('已取消', false);
      const places = target.mobs.flatMap(mob => Collect.locate(store, mob)).filter(place => place.area === target.area);
      const rooms = [...new Set(places.flatMap(place => place.rooms.map(room => `${place.area}/${room}`)))];
      const targets = new Set(rooms.filter(key => graph.rooms[key]));
      if (!targets.size) return fail('這個區域沒有蒐集到勾選的怪的房間（或那些房間不在地圖上）');
      state = {
        mobs: target.mobs, graph, targets, skipped: rooms.filter(key => !graph.rooms[key]).map(key => ({ key, why: '不在地圖上' })),
        settings, learn, learned, dirty: new Set(), saving: Promise.resolve(), looked: new Set(), tried: {}, trial: null, cmd: null, learning: false, ticks: 0, lastEat: -Infinity, lastRest: -Infinity, resting: false, restPercent: NaN, wake: null, gate: false, eating: null, fight: null,
        skips: 0, tries: 0, wrong: 0, blind: 0, handled: 0, visited: [], phase: 'plan', goal: null, expected: null, from: null, waited: 0,
      };
      note = '';
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
  const summary = () => {
    if (!state) return { text: note || '未啟動', alert: noteAlert };
    const who = state.mobs.length === 1 ? state.mobs[0] : `${state.mobs.length} 種怪`;
    if (state.resting) return { text: `${who}：休息中 ${Math.round(state.restPercent)}%→${state.settings.restResume}%${skippedNote(state.skipped)}`, alert: noteAlert };
    if (state.trial) return { text: `${who}：在 ${state.trial.room} 試出口${skippedNote(state.skipped)}`, alert: noteAlert };
    if (state.learning) return { text: `${who}：看 ${state.goal ?? '房間'} 的出口…${skippedNote(state.skipped)}`, alert: noteAlert };
    if (state.fight) return { text: `${who}：在 ${state.goal} 打 ${state.fight.mob.name}${skippedNote(state.skipped)}`, alert: noteAlert };
    if (state.phase === 'look') return { text: `${who}：到了 ${state.goal}，看房間…${skippedNote(state.skipped)}`, alert: noteAlert };
    return { text: `${who}：走向 ${state.goal ?? '…'}（目標剩 ${state.targets.size} 間）${skippedNote(state.skipped)}`, alert: noteAlert };
  };
  const snapshot = () => ({ on: on(), note, targets: state ? [...state.targets] : [], skipped: state ? state.skipped : [] });

  return { start, stop, on, summary, snapshot };
}

globalThis.CatworldMapHunt = { SETTINGS_KEY, NPCS_KEY, EXITS_KEY, FIELDS, normalizeSettings, splitIds, create };
})();

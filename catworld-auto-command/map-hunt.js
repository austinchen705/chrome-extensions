// 地圖巡怪：把面板「選怪」勾選的怪（可以多隻），在目前顯示的區域裡蒐集到的房間一間一間走過去。
// 引擎不碰 DOM 與 chrome.*（路線用 map-route.js，蒐集資料用 map-collect.js 的 locate），讀房間、送指令、讀儲存都由呼叫端（content.js）傳入，
// 送出的指令走共用送出佇列，所以遵守指令間隔、驗證碼偵測與看門狗。
// 每一步：送一個方向指令 → 等目前房間（#map_anchor 蓋住的那一格）變成別間（逾時以 tick 數算，約 5 秒）；逾時沒變就重送一次，仍沒變就略過這間目標，連續略過 MAX_SKIPS 次停止並警報。
(() => {
if (globalThis.CatworldMapHunt) return;

const SETTINGS_KEY = 'mapHuntSettings';
// 自動學到的 NPC（finger 找不到的 ID，名稱陣列）；白名單是設定頁的 npcWhitelist（手動填）
const NPCS_KEY = 'mapHuntNpcs';
const splitIds = text => String(text ?? '').split(/[、,，;；\s]+/).filter(Boolean);
const TICK_MS = 200;
const MOVE_TIMEOUT_TICKS = 25; // 5 秒
const MAX_SKIPS = 3;
const MAX_WRONG = 3; // 同一個目標走錯房間幾次就略過
const SAFE_ID = /^[A-Za-z][A-Za-z0-9 _.'-]*$/;

// 設定頁的欄位（也決定預設值與檢查）：type 是 text、number 或 select
const FIELDS = [
  { key: 'healMode', label: '補氣方式', type: 'select', options: [['eat', '吃藥'], ['rest', '自己回']], default: 'eat' },
  { key: 'eatBelow', label: '氣低於幾 % 就吃藥', type: 'number', default: 50, min: 1, max: 99 },
  { key: 'eatCommand', label: '吃藥指令（可多個，用 ; 分隔）', type: 'text', default: '' },
  { key: 'noMedicineKeyword', label: '沒藥時遊戲回的字（吃藥模式）', type: 'text', default: '' },
  { key: 'homeCommand', label: '回家指令', type: 'text', default: '' },
  { key: 'restBelow', label: '自己回：氣低於幾 % 就休息', type: 'number', default: 50, min: 1, max: 99 },
  { key: 'restResume', label: '自己回：氣回到幾 % 才繼續', type: 'number', default: 80, min: 1, max: 100 },
  { key: 'restCommand', label: '自己回：休息時送的指令（可空）', type: 'text', default: '' },
  { key: 'dangerBelow', label: '自己回：戰鬥中氣低於幾 % 就回家停止', type: 'number', default: 20, min: 1, max: 99 },
  { key: 'afterKillCommand', label: '怪倒下後送的指令（可多個，用 ; 分隔）', type: 'text', default: 'gc' },
  { key: 'specialCommand', label: '特攻指令（可空，可以是你的別名）', type: 'text', default: '' },
  { key: 'specialIntervalSec', label: '特攻最小間隔（秒）', type: 'number', default: 10, min: 1, max: 600 },
  { key: 'refuseKeyword', label: '怪不想打時遊戲回的字（fight 被拒就改 kill）', type: 'text', default: '並不想跟你較量' },
  { key: 'endKeywords', label: '怪倒下的字（用、分隔）', type: 'text', default: '一動也不動了、死了' },
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
  return out;
}

function create(deps) {
  const Route = globalThis.CatworldMapRoute;
  const Collect = globalThis.CatworldMapCollect;
  const Parse = globalThis.CatworldHuntParse;
  let state = null;
  let timer = null;
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
  // 玩家與 NPC（NPC 記下來，下次不再問）；看不到房間（l 沒回應或讀不懂）當成走不過去；其餘算看過了（之後的票在這裡打怪）。
  // 每個 await 之後都要確認這一次巡怪還在（停止或重新開始後，舊的檢查不能再動新的狀態、也不能再送指令）
  async function inspect(token, here) {
    const info = Parse.parseLook(await deps.ask('l', 'look'));
    if (state !== token) return;
    if (!info.exits.length) { skipTarget(here, '讀不到房間'); return; }
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
    doneWith(here, here);
  }
  function arrive(here) {
    const token = state;
    state.phase = 'look';
    state.goal = here;
    deps.notify();
    inspect(token, here).catch(() => { if (state === token) finish('看房間時出錯，已停止', { alert: true }); });
  }

  // 規劃下一步：到了目標就看房間；否則挑路線最短的目標，送出路線的第一個指令
  function plan(here) {
    if (state.targets.has(here)) { arrive(here); return; }
    let best = null;
    [...state.targets].forEach(key => {
      const way = Route.route(state.graph, here, key);
      if (!way) { state.targets.delete(key); state.skipped.push({ key, why: '走不到' }); return; }
      if (!best || way.length < best.way.length) best = { key, way };
    });
    if (!best) { finish(state.handled ? `這一輪巡完了（到過 ${state.visited.length} 間）` : '沒有走得到的目標房間了'); return; }
    state.goal = best.key;
    state.expected = state.graph.rooms[here].exits[best.way[0]];
    if (!deps.send(best.way[0])) { finish('指令送不出去，已停止', { alert: true }); return; }
    state.phase = 'move';
    state.from = here;
    state.waited = 0;
    deps.notify();
  }

  function tick() {
    if (!state || state.phase === 'look') return;
    const here = deps.room();
    state.waited += 1;
    if (state.phase === 'move') {
      if (here && here !== state.from) {
        state.phase = 'plan';
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
      if (cancelled) return fail('已取消', false);
      const places = target.mobs.flatMap(mob => Collect.locate(store, mob)).filter(place => place.area === target.area);
      const rooms = [...new Set(places.flatMap(place => place.rooms.map(room => `${place.area}/${room}`)))];
      const targets = new Set(rooms.filter(key => graph.rooms[key]));
      if (!targets.size) return fail('這個區域沒有蒐集到勾選的怪的房間（或那些房間不在地圖上）');
      state = {
        mobs: target.mobs, graph, targets, skipped: rooms.filter(key => !graph.rooms[key]).map(key => ({ key, why: '不在地圖上' })),
        skips: 0, tries: 0, wrong: 0, blind: 0, handled: 0, visited: [], phase: 'plan', goal: null, expected: null, from: null, waited: 0,
      };
      note = '';
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
    if (state.phase === 'look') return { text: `${who}：到了 ${state.goal}，看房間…${skippedNote(state.skipped)}`, alert: noteAlert };
    return { text: `${who}：走向 ${state.goal ?? '…'}（目標剩 ${state.targets.size} 間）${skippedNote(state.skipped)}`, alert: noteAlert };
  };
  const snapshot = () => ({ on: on(), note, targets: state ? [...state.targets] : [], skipped: state ? state.skipped : [] });

  return { start, stop, on, summary, snapshot };
}

globalThis.CatworldMapHunt = { SETTINGS_KEY, NPCS_KEY, FIELDS, normalizeSettings, splitIds, create };
})();

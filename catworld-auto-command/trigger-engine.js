// 狀態觸發的規則引擎：只做判斷，不碰 DOM。讀數、時間、送出指令、停用警報都由呼叫端以 io 傳入，方便獨立測試。
//
// 每條規則的狀態機（每秒 tick 一次）：
//   ready    待命。目前值 ≤ 門檻且已過冷卻 → 觸發（按開始時門檻已達成也在第一個 tick 立刻命中；實際送出時間見下面的命中後延遲），進入 waiting。
//   waiting  已觸發。
//            · 目前值 > 回復條件（數值：門檻 ×(1+緩衝%)；％：門檻＋緩衝個百分點）→ 回到 ready，無效次數歸零。
//            · 冷卻結束且目前值仍 ≤ 門檻 → 先判斷上次有沒有效果：目前值 > 觸發當下的值算有效（無效次數歸零），
//              否則無效次數 +1，達到上限就停用；沒停用就再觸發一次。
//            · 數值在門檻與回復條件之間 → 不動作，等回復。
//   disabled 已停用（次數達上限、連續無效、指令數超過全域上限），要手動重新啟用。
//   off      設定裡沒啟用或設定不完整的規則，永遠不判斷。
// 三道限制各有開關，預設都關閉（舊的設定沒有開關欄位也視為關閉）：
//   limitFires        同一規則在區間內的觸發次數上限，超過就停用該規則
//   limitIneffective  連續無效次數上限，達到就停用該規則
//   limitGlobal       所有規則合計每分鐘送出的指令數（只延後，不停用；單條規則一次要送的指令數超過它才停用）
// 全部關閉時，條件持續成立就每隔冷卻時間（最少 3 秒）重送一次，不會自己停。
// 命中後不會馬上送出：在 0～delayMax 秒之間隨機等一段時間（delayMax 為 0 就不延遲），由每秒一次的 tick 到時間才送，
// 所以實際送出時間最多比預定晚一個 tick。命中當下就算一次觸發（次數上限、每分鐘上限），冷卻從實際送出的時間起算；
// 延遲期間規則維持 waiting，不會重複命中。停止（引擎被丟掉）時尚未送出的指令一併作廢。
// 「有效」只比較觸發當下與現在的數值；精、氣、神本來就會自然恢復，這個判斷對它們比較不準，不特別處理。
// 規則方向 op：'le'（目前值 ≤ 門檻，預設）或 'ge'（目前值 ≥ 門檻）。'ge' 時上面所有「回升／高於」都鏡像成「回落／低於」：
// 回復條件是低於「門檻 −緩衝」，有效是數值比觸發當下更低。
//
// 關鍵字規則（kind: 'keyword'）：新出現的遊戲文字含有關鍵字（不分大小寫的子字串）就送出指令，由呼叫端把新文字交給 onText。
// 防迴圈（觸發 → 回覆又含關鍵字 → 再觸發）靠三件事，缺一不可：
//   1. 只看「新出現」的文字：按開始時不掃歷史，也不會一開始就觸發。
//   2. 冷卻期間（waiting）出現的關鍵字直接丟掉，不補送：冷卻結束後沒有新的關鍵字文字就不會再觸發。
//   3. 以 > 開頭的行是指令回聲（自己或使用者打的指令），整行略過。
// 關鍵字規則沒有「有沒有效果」可判斷，limitIneffective 不適用；三道限制關閉時，冷卻（最少 3 秒）是唯一的頻率限制。
// 規則的 stopGroup（命中送出後停止這一組）由呼叫端的 send 處理，引擎只把它帶在規則上；勾了 stopGroup 的規則可以不填指令
//（只停止、不送任何指令），所以「指令為空」只在沒勾 stopGroup 時才算規則無效。
(() => {
if (globalThis.CatworldTriggerEngine) return;

// 精、氣、神的上限是 eff_*（max_* 是百分比）；其餘項目的上限是 max_*
const STATS = {
  '精': { cur: 'gin', max: 'eff_gin' },
  '氣': { cur: 'kee', max: 'eff_kee' },
  '神': { cur: 'sen', max: 'eff_sen' },
  '靈力': { cur: 'atman', max: 'max_atman' },
  '內力': { cur: 'force', max: 'max_force' },
  '法力': { cur: 'mana', max: 'max_mana' },
  '食物': { cur: 'food', max: 'max_food' },
  '飲水': { cur: 'water', max: 'max_water' },
};
const MIN_COOLDOWN_SEC = 3;
const DEFAULTS = { cooldown: 10, buffer: 10, maxFires: 5, windowMinutes: 5, maxIneffective: 3, globalPerMinute: 6, delayMax: 5 };

// 觸發有兩組，各有自己的規則清單、開始／停止、命中延遲與安全機制，功能完全一樣（順序也是 popup 分頁與面板的順序）
const GROUPS = [{ id: 'combat', name: '戰鬥' }, { id: 'practice', name: '練功' }];

// 已儲存的設定：triggerGroupSettings = { combat: 設定, practice: 設定 }。
// 舊版只有一組，存在 triggerSettings；還沒有新格式時整份放進練功，戰鬥從空的開始
function loadGroupSettings(stored = {}) {
  const saved = stored.triggerGroupSettings;
  const result = Object.fromEntries(GROUPS.map(({ id }) => [id, saved?.[id] || null]));
  if (!saved && stored.triggerSettings) result.practice = stored.triggerSettings;
  return result;
}

function positive(value, fallback, min) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function normalizeRule(raw = {}) {
  const commands = (Array.isArray(raw.commands) ? raw.commands : String(raw.commands || '').split('\n'))
    .map(command => String(command).trim()).filter(Boolean);
  const stopGroup = raw.stopGroup === true;
  const hasAction = commands.length > 0 || stopGroup;
  if (raw.kind === 'keyword') {
    const pattern = String(raw.pattern ?? '').trim();
    return {
      kind: 'keyword',
      enabled: raw.enabled !== false && pattern !== '' && hasAction,
      pattern,
      commands,
      stopGroup,
      cooldown: positive(raw.cooldown, DEFAULTS.cooldown, MIN_COOLDOWN_SEC),
    };
  }
  const value = Number(raw.value);
  const valid = Boolean(STATS[raw.stat]) && Number.isFinite(value) && value >= 0 && hasAction;
  return {
    kind: 'stat',
    enabled: raw.enabled !== false && valid,
    stat: raw.stat,
    op: raw.op === 'ge' ? 'ge' : 'le',
    unit: raw.unit === 'pct' ? 'pct' : 'abs',
    value,
    commands,
    stopGroup,
    cooldown: positive(raw.cooldown, DEFAULTS.cooldown, MIN_COOLDOWN_SEC),
    buffer: positive(raw.buffer, DEFAULTS.buffer, 0),
  };
}

function normalizeConfig(raw = {}) {
  return {
    rules: (raw.rules || []).map(normalizeRule),
    limitFires: raw.limitFires === true,
    limitIneffective: raw.limitIneffective === true,
    limitGlobal: raw.limitGlobal === true,
    maxFires: positive(raw.maxFires, DEFAULTS.maxFires, 1),
    windowMinutes: positive(raw.windowMinutes, DEFAULTS.windowMinutes, 1),
    maxIneffective: positive(raw.maxIneffective, DEFAULTS.maxIneffective, 1),
    globalPerMinute: positive(raw.globalPerMinute, DEFAULTS.globalPerMinute, 1),
    delayMax: positive(raw.delayMax, DEFAULTS.delayMax, 0),
    requireNormal: raw.requireNormal !== false,
  };
}

function hasActiveRules(raw) {
  return normalizeConfig(raw).rules.some(rule => rule.enabled);
}

const unitSuffix = rule => (rule.unit === 'pct' ? '％' : '');
const isUpper = rule => rule.op === 'ge';
const ruleLabel = rule => (rule.kind === 'keyword'
  ? `關鍵字「${rule.pattern}」`
  : `${rule.stat} ${isUpper(rule) ? '≥' : '≤'} ${rule.value}${unitSuffix(rule)}`);
function rearmLevel(rule) {
  if (rule.unit === 'pct') return isUpper(rule) ? rule.value - rule.buffer : rule.value + rule.buffer;
  return isUpper(rule) ? Math.floor(rule.value * (1 - rule.buffer / 100)) : Math.ceil(rule.value * (1 + rule.buffer / 100));
}
const rearmText = rule => `${isUpper(rule) ? '<' : '>'} ${rearmLevel(rule)}${unitSuffix(rule)}`;
const meets = (rule, current) => (isUpper(rule) ? current >= rule.value : current <= rule.value);
const recovered = (rule, current) => (isUpper(rule) ? current < rearmLevel(rule) : current > rearmLevel(rule));
const improved = (rule, current, from) => (isUpper(rule) ? current < from : current > from);

// io: { now(), readStat(name) → { value, max } | null, isNormal() → true | false | null, send(commands, index), onDisable(index, label, reason), random?() }
function createEngine(rawConfig, io) {
  const config = normalizeConfig(rawConfig);
  const runtime = config.rules.map(rule => ({
    phase: rule.enabled ? 'ready' : 'off',
    fires: [],
    fireValue: null,
    cooldownUntil: 0,
    pendingUntil: null,
    ineffective: 0,
    current: null,
    note: '',
  }));
  let sent = [];
  let pending = [];

  function recentFires(state, now) {
    const windowMs = config.windowMinutes * 60 * 1000;
    state.fires = state.fires.filter(time => now - time < windowMs);
    return state.fires.length;
  }

  function disable(index, reason) {
    runtime[index].phase = 'disabled';
    runtime[index].note = reason;
    io.onDisable(index, ruleLabel(config.rules[index]), reason);
  }

  function fire(index, current, now) {
    const rule = config.rules[index];
    const state = runtime[index];
    if (config.limitFires && recentFires(state, now) >= config.maxFires) {
      disable(index, `${config.windowMinutes} 分鐘內已觸發 ${state.fires.length} 次，達到上限`);
      return;
    }
    if (config.limitGlobal) {
      if (rule.commands.length > config.globalPerMinute) {
        disable(index, `一次要送 ${rule.commands.length} 個指令，超過每分鐘上限 ${config.globalPerMinute}`);
        return;
      }
      if (sent.length + rule.commands.length > config.globalPerMinute) {
        state.note = '已達每分鐘送出上限，稍後再送';
        return;
      }
    }
    const delayMs = Math.round((io.random ? io.random() : Math.random()) * config.delayMax * 1000);
    const executeAt = now + delayMs;
    rule.commands.forEach(() => sent.push(now));
    state.fires.push(now);
    state.fireValue = current;
    state.cooldownUntil = executeAt + rule.cooldown * 1000;
    state.phase = 'waiting';
    state.note = '';
    if (delayMs > 0) {
      state.pendingUntil = executeAt;
      pending.push({ index, at: executeAt });
    } else {
      io.send(rule.commands, index);
    }
  }

  // 到時間的延遲指令才真的送出；這時角色狀態不是「正常」（預設會擋）就略過這一次
  function runPending(now) {
    const due = pending.filter(item => item.at <= now);
    pending = pending.filter(item => item.at > now);
    due.forEach(item => {
      runtime[item.index].pendingUntil = null;
      if (config.requireNormal && io.isNormal() !== true) return;
      io.send(config.rules[item.index].commands, item.index);
    });
  }

  // 關鍵字規則：冷卻結束就回到待命，狀態文字才不會一直停在「冷卻中」
  function releaseKeywordRules(now) {
    config.rules.forEach((rule, index) => {
      const state = runtime[index];
      if (rule.kind !== 'keyword') return;
      if (state.phase === 'waiting' && now >= state.cooldownUntil) state.phase = 'ready';
      if (state.phase === 'ready') state.note = '';
    });
  }

  // 新出現的遊戲文字（可含多行）。只有待命中的關鍵字規則會看；冷卻中、已停用的直接略過，不補送
  function onText(text) {
    const now = io.now();
    sent = sent.filter(time => now - time < 60 * 1000);
    if (config.requireNormal && io.isNormal() !== true) return;
    const lines = String(text ?? '').split('\n').filter(line => !/^\s*>/.test(line));
    if (!lines.length) return;
    // 遊戲會把長句子在固定寬度硬斷行，所以比對時忽略換行與空白（關鍵字也一樣），跨行的句子才對得到
    const squash = value => value.toLowerCase().replace(/\s+/g, '');
    const haystack = squash(lines.join(''));
    releaseKeywordRules(now);
    config.rules.forEach((rule, index) => {
      if (rule.kind !== 'keyword' || runtime[index].phase !== 'ready') return;
      const needle = squash(rule.pattern);
      if (needle && haystack.includes(needle)) fire(index, null, now);
    });
  }

  function tick() {
    const now = io.now();
    sent = sent.filter(time => now - time < 60 * 1000);
    runPending(now);
    releaseKeywordRules(now);
    if (config.requireNormal && io.isNormal() !== true) {
      runtime.forEach(state => { if (state.phase !== 'off' && state.phase !== 'disabled') state.note = '角色狀態不是「正常」，暫不觸發'; });
      return;
    }
    config.rules.forEach((rule, index) => {
      const state = runtime[index];
      if (rule.kind === 'keyword' || state.phase === 'off' || state.phase === 'disabled') return;
      const stat = io.readStat(rule.stat);
      if (!stat || !Number.isFinite(stat.value)) { state.note = '讀不到數值'; return; }
      let current = stat.value;
      if (rule.unit === 'pct') {
        if (!(stat.max > 0)) { state.note = '讀不到上限'; return; }
        current = (stat.value / stat.max) * 100;
      }
      state.current = current;
      state.note = '';
      const hit = meets(rule, current);
      if (state.phase === 'waiting' && recovered(rule, current)) {
        state.phase = 'ready';
        state.ineffective = 0;
      }
      if (state.phase === 'ready') {
        if (hit && now >= state.cooldownUntil) fire(index, current, now);
        return;
      }
      if (now < state.cooldownUntil || !hit) return;
      state.ineffective = improved(rule, current, state.fireValue) ? 0 : state.ineffective + 1;
      if (config.limitIneffective && state.ineffective >= config.maxIneffective) {
        disable(index, `連續 ${state.ineffective} 次觸發後數值都沒${isUpper(rule) ? '回落' : '回升'}`);
        return;
      }
      fire(index, current, now);
    });
  }

  function rearm(index) {
    const state = runtime[index];
    if (!state || state.phase !== 'disabled') return;
    Object.assign(state, { phase: 'ready', fires: [], fireValue: null, cooldownUntil: 0, pendingUntil: null, ineffective: 0, note: '' });
    pending = pending.filter(item => item.index !== index);
  }

  const shown = (rule, value) => (value === null ? '—' : `${Math.round(value * 10) / 10}${unitSuffix(rule)}`);

  function snapshot() {
    const now = io.now();
    return {
      rules: config.rules.map((rule, index) => {
        const state = runtime[index];
        const fires = recentFires(state, now);
        const keyword = rule.kind === 'keyword';
        const count = config.limitFires ? `${fires}/${config.maxFires}` : `${fires} 次`;
        const pendingSeconds = state.pendingUntil === null ? null : Math.max(0, Math.ceil((state.pendingUntil - now) / 1000));
        let text;
        if (state.phase === 'off') text = '未啟用';
        else if (state.phase === 'disabled') text = `已停用：${state.note}`;
        else if (pendingSeconds !== null) text = `命中，${pendingSeconds} 秒後${rule.commands.length ? `執行：${rule.commands.join(' → ')}` : '停止這組觸發'}`;
        else if (state.phase === 'waiting') text = keyword ? `已觸發 ${count}，冷卻中` : `已觸發 ${count}，等待回復 ${rearmText(rule)}`;
        else text = state.note || (keyword ? '待命（等待關鍵字）' : `待命（目前 ${shown(rule, state.current)}）`);
        return { label: ruleLabel(rule), kind: rule.kind, phase: state.phase, text, rearm: keyword ? null : rearmLevel(rule), fires, commands: rule.commands, pendingSeconds };
      }),
    };
  }

  return { tick, onText, rearm, snapshot };
}

globalThis.CatworldTriggerEngine = { STATS, MIN_COOLDOWN_SEC, DEFAULTS, GROUPS, loadGroupSettings, normalizeConfig, hasActiveRules, rearmLevel, rearmText, createEngine };
})();

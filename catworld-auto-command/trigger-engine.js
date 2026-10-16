// 狀態觸發的規則引擎：只做判斷，不碰 DOM。讀數、時間、送出指令、停用警報都由呼叫端以 io 傳入，方便獨立測試。
//
// 每條規則的狀態機（每秒 tick 一次）：
//   ready    待命。目前值 ≤ 門檻且已過冷卻 → 觸發（按開始時門檻已達成也在第一個 tick 立刻觸發），進入 waiting。
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
// 「有效」只比較觸發當下與現在的數值；精、氣、神本來就會自然恢復，這個判斷對它們比較不準，不特別處理。
// 規則方向 op：'le'（目前值 ≤ 門檻，預設）或 'ge'（目前值 ≥ 門檻）。'ge' 時上面所有「回升／高於」都鏡像成「回落／低於」：
// 回復條件是低於「門檻 −緩衝」，有效是數值比觸發當下更低。
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
const DEFAULTS = { cooldown: 10, buffer: 10, maxFires: 5, windowMinutes: 5, maxIneffective: 3, globalPerMinute: 6 };

function positive(value, fallback, min) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function normalizeRule(raw = {}) {
  const commands = (Array.isArray(raw.commands) ? raw.commands : String(raw.commands || '').split('\n'))
    .map(command => String(command).trim()).filter(Boolean);
  const value = Number(raw.value);
  const valid = Boolean(STATS[raw.stat]) && Number.isFinite(value) && value >= 0 && commands.length > 0;
  return {
    enabled: raw.enabled !== false && valid,
    stat: raw.stat,
    op: raw.op === 'ge' ? 'ge' : 'le',
    unit: raw.unit === 'pct' ? 'pct' : 'abs',
    value,
    commands,
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
    requireNormal: raw.requireNormal !== false,
  };
}

function hasActiveRules(raw) {
  return normalizeConfig(raw).rules.some(rule => rule.enabled);
}

const unitSuffix = rule => (rule.unit === 'pct' ? '％' : '');
const isUpper = rule => rule.op === 'ge';
const ruleLabel = rule => `${rule.stat} ${isUpper(rule) ? '≥' : '≤'} ${rule.value}${unitSuffix(rule)}`;
function rearmLevel(rule) {
  if (rule.unit === 'pct') return isUpper(rule) ? rule.value - rule.buffer : rule.value + rule.buffer;
  return isUpper(rule) ? Math.floor(rule.value * (1 - rule.buffer / 100)) : Math.ceil(rule.value * (1 + rule.buffer / 100));
}
const rearmText = rule => `${isUpper(rule) ? '<' : '>'} ${rearmLevel(rule)}${unitSuffix(rule)}`;
const meets = (rule, current) => (isUpper(rule) ? current >= rule.value : current <= rule.value);
const recovered = (rule, current) => (isUpper(rule) ? current < rearmLevel(rule) : current > rearmLevel(rule));
const improved = (rule, current, from) => (isUpper(rule) ? current < from : current > from);

// io: { now(), readStat(name) → { value, max } | null, isNormal() → true | false | null, send(commands), onDisable(index, label, reason) }
function createEngine(rawConfig, io) {
  const config = normalizeConfig(rawConfig);
  const runtime = config.rules.map(rule => ({
    phase: rule.enabled ? 'ready' : 'off',
    fires: [],
    fireValue: null,
    cooldownUntil: 0,
    ineffective: 0,
    current: null,
    note: '',
  }));
  let sent = [];

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
    io.send(rule.commands);
    rule.commands.forEach(() => sent.push(now));
    state.fires.push(now);
    state.fireValue = current;
    state.cooldownUntil = now + rule.cooldown * 1000;
    state.phase = 'waiting';
    state.note = '';
  }

  function tick() {
    const now = io.now();
    sent = sent.filter(time => now - time < 60 * 1000);
    if (config.requireNormal && io.isNormal() !== true) {
      runtime.forEach(state => { if (state.phase !== 'off' && state.phase !== 'disabled') state.note = '角色狀態不是「正常」，暫不觸發'; });
      return;
    }
    config.rules.forEach((rule, index) => {
      const state = runtime[index];
      if (state.phase === 'off' || state.phase === 'disabled') return;
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
    Object.assign(state, { phase: 'ready', fires: [], fireValue: null, cooldownUntil: 0, ineffective: 0, note: '' });
  }

  const shown = (rule, value) => (value === null ? '—' : `${Math.round(value * 10) / 10}${unitSuffix(rule)}`);

  function snapshot() {
    const now = io.now();
    return {
      rules: config.rules.map((rule, index) => {
        const state = runtime[index];
        const fires = recentFires(state, now);
        let text;
        if (state.phase === 'off') text = '未啟用';
        else if (state.phase === 'disabled') text = `已停用：${state.note}`;
        else if (state.phase === 'waiting') text = `已觸發 ${config.limitFires ? `${fires}/${config.maxFires}` : `${fires} 次`}，等待回復 ${rearmText(rule)}`;
        else text = state.note || `待命（目前 ${shown(rule, state.current)}）`;
        return { label: ruleLabel(rule), phase: state.phase, text, rearm: rearmLevel(rule), fires };
      }),
    };
  }

  return { tick, rearm, snapshot };
}

globalThis.CatworldTriggerEngine = { STATS, MIN_COOLDOWN_SEC, DEFAULTS, normalizeConfig, hasActiveRules, rearmLevel, rearmText, createEngine };
})();

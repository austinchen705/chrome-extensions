// 手動紀錄累積成的個人資料（通用、不分地圖）：把一段手動紀錄的事件算成量（extract），跨多段累加（merge），讀回時檢查形狀（normalizeProfile）。
// 不碰 DOM 與 chrome.*。事件：{ at, kind: 'send', command }、{ at, kind: 'room', room }、{ at, kind: 'down' }、{ at, kind: 'knockout' }，at 是毫秒。
// 儲存的是原始、有上限的樣本與計數，之後算建議值的規則都從這份資料算，不需要再回頭看事件。
(() => {
if (globalThis.CatworldHuntProfile) return;

const PROFILE_KEY = 'mapHuntProfile';
const SAMPLE_MAX = 500;      // 每種樣本陣列最多留幾個（留最新的）
const MAP_MAX = 100;         // 每種計數表最多留幾個鍵（留次數最多的）
const KEY_MAX = 100;         // 計數表的鍵最長幾字
const FIGHT_CMD_MAX = 5;     // 一場裡最多記幾種重複指令
const FIGHT_GAP_MAX = 10;    // 一種重複指令最多記幾個間隔
const WALK_GAP_MAX_MS = 5000;
const REACT_MAX_MS = 8000;
const KNOCKOUT_WINDOW_MS = 10000;
const DOWN_WINDOW_MS = 10000;
const TYPO_WINDOW_MS = 5000;
const SAMPLE_VALUE_MAX = 10000000;
const HABIT_COMMANDS = ['l', 'i', 'hp', 'sc', 'score', 'edf'];

const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'u', 'd', 'nu', 'nd', 'su', 'sd', 'eu', 'ed', 'wu', 'wd']);
const firstWord = command => String(command ?? '').trim().split(/\s+/)[0].toLowerCase();

// walk：只有一個字、是方向（可以帶前面的數字，2n）；look：l；attack：fight／kill／f／k 或設定的開打、打死用的指令，後面還有字；其他
function classify(command, settings = {}) {
  const words = String(command ?? '').trim().split(/\s+/).filter(Boolean);
  const verb = (words[0] || '').toLowerCase();
  if (!verb) return 'other';
  if (words.length === 1 && DIRECTIONS.has(verb.replace(/^\d+/, ''))) return 'walk';
  if (words.length === 1 && verb === 'l') return 'look';
  const attackVerbs = new Set(['fight', 'kill', 'f', 'k', firstWord(settings.fightCommand), firstWord(settings.killCommand)].filter(Boolean));
  if (words.length > 1 && attackVerbs.has(verb)) return 'attack';
  return 'other';
}

// 編輯距離剛好 1（代換、少一個字或多一個字）
function oneEdit(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}
// 較長的就是較短的把某個字重複一次（s→ss）：重複，不算打錯
const isDoubling = (a, b) => {
  if (a.length === b.length) return false;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  for (let i = 0; i < short.length; i += 1) if (long === short.slice(0, i + 1) + short.slice(i)) return true;
  return false;
};

const bump = (map, key, by = 1) => { if (key !== '') map[key] = (map[key] || 0) + by; };

function emptyProfile() {
  return {
    segments: 0, commands: 0, typos: 0, rooms: 0, stops: 0, downs: 0,
    walkGaps: [], reactGaps: [], fights: [],
    firstAttack: {}, knockoutAttack: {}, afterDown: {}, habitArrive: {}, habitKill: {},
  };
}

// 一段手動紀錄的事件 → 這一段的量（和 emptyProfile 同樣的欄位，沒有 segments）
function extract(events, settings = {}) {
  const out = emptyProfile();
  delete out.segments;
  const list = (Array.isArray(events) ? events : []).filter(event => event && Number.isFinite(event.at));
  const sends = list.filter(event => event.kind === 'send' && event.command).map(event => ({ ...event, type: classify(event.command, settings) }));
  out.commands = sends.length;

  // 打錯字：兩個指令相隔不到 5 秒、編輯距離 1、不是重複、不是兩個都是走路
  for (let i = 1; i < sends.length; i += 1) {
    const a = sends[i - 1].command.trim().toLowerCase();
    const b = sends[i].command.trim().toLowerCase();
    if (sends[i].at - sends[i - 1].at > TYPO_WINDOW_MS) continue;
    if (a.length < 2 || b.length < 2 || !oneEdit(a, b) || isDoubling(a, b)) continue;
    if (sends[i - 1].type === 'walk' && sends[i].type === 'walk') continue;
    out.typos += 1;
  }

  // 依時間順序走一遍：走路間隔、反應時間、第一個開打動詞、昏迷後的動詞、一場裡的重複指令、倒下後的指令、習慣指令
  let prevSend = null;
  let pendingReact = null;      // 進房間或送 l 的時間，等下一個 attack
  let armed = true;             // 進房間後第一個 attack 還沒出現
  let knockoutAt = null;
  let fight = null;             // { cmds: { 指令: [at…] } }
  let down = null;              // { at, seq: [指令] }
  let arrive = null;            // { seenLook }
  const finishDown = () => {
    if (down && down.seq.length) {
      const collapsed = down.seq.filter((cmd, index) => index === 0 || cmd !== down.seq[index - 1]).join(';');
      if (collapsed && collapsed.length <= KEY_MAX) bump(out.afterDown, collapsed);
    }
    down = null;
  };
  list.forEach(event => {
    if (event.kind === 'room') {
      out.rooms += 1;
      pendingReact = event.at;
      armed = true;
      arrive = { seenLook: false, counted: false };
      fight = null;
      return;
    }
    if (event.kind === 'knockout') { knockoutAt = event.at; return; }
    if (event.kind === 'down') {
      out.downs += 1;
      if (fight) {
        const repeated = Object.entries(fight.cmds).filter(([, times]) => times.length >= 2)
          .sort((x, y) => y[1].length - x[1].length).slice(0, FIGHT_CMD_MAX)
          .map(([cmd, times]) => ({ cmd, count: times.length, gaps: times.slice(1).map((at, index) => at - times[index]).slice(0, FIGHT_GAP_MAX) }));
        if (repeated.length) out.fights.push(repeated);
        fight = null;
      }
      finishDown();
      down = { at: event.at, seq: [] };
      return;
    }
    if (event.kind !== 'send' || !event.command) return;
    const command = event.command.trim();
    const type = classify(command, settings);
    if (type === 'walk' && prevSend?.type === 'walk' && event.at - prevSend.at <= WALK_GAP_MAX_MS) out.walkGaps.push(event.at - prevSend.at);
    prevSend = { type, at: event.at };
    if (type === 'attack') {
      if (pendingReact !== null && event.at - pendingReact <= REACT_MAX_MS) out.reactGaps.push(event.at - pendingReact);
      pendingReact = null;
      if (armed) { bump(out.firstAttack, firstWord(command)); armed = false; }
      if (knockoutAt !== null && event.at - knockoutAt <= KNOCKOUT_WINDOW_MS) bump(out.knockoutAttack, firstWord(command));
      knockoutAt = null;
      if (!fight) fight = { cmds: {} };
    } else if (type === 'look') {
      pendingReact = event.at;
    } else if (type === 'walk') {
      pendingReact = null;
      fight = null;
    } else if (fight) {
      (fight.cmds[command] = fight.cmds[command] || []).push(event.at);
    }
    // 習慣指令：倒下後 10 秒內、進房間後，到下一個走路或開打之前；到房間後的第一個 l 是看房間，不算
    if (down && (type === 'walk' || type === 'attack' || event.at - down.at > DOWN_WINDOW_MS)) finishDown();
    if (down) {
      down.seq.push(command);
      if (HABIT_COMMANDS.includes(command.toLowerCase())) bump(out.habitKill, command.toLowerCase());
    }
    if (arrive) {
      if (type !== 'walk' && !arrive.counted) { out.stops += 1; arrive.counted = true; }
      if (type === 'walk' || type === 'attack') arrive = null;
      else if (HABIT_COMMANDS.includes(command.toLowerCase())) {
        if (command.toLowerCase() === 'l' && !arrive.seenLook) arrive.seenLook = true;
        else bump(out.habitArrive, command.toLowerCase());
      }
    }
  });
  finishDown();
  return out;
}

const percentile = (sorted, p) => sorted[Math.round(p * (sorted.length - 1))];
const median = list => { const sorted = [...list].sort((x, y) => x - y); const mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const topOf = map => Object.entries(map).sort((x, y) => y[1] - x[1])[0] || null;
const sumOf = map => Object.values(map).reduce((total, n) => total + n, 0);
const squash = text => String(text ?? '').replace(/\s*;\s*/g, ';').trim().toLowerCase();

// 依累積資料算建議的設定值。回傳每一列 { keys, label, current, value, basis, enough, need, same }：
// 資料不夠時 enough 為 false、value 是 null、need 是還差幾個；same 是建議值和目前值一樣。fields 是巡怪設定的欄位表（取標籤與範圍）
function suggest(rawProfile, settings = {}, fields = []) {
  const profile = normalizeProfile(rawProfile);
  const field = key => fields.find(item => item.key === key) || {};
  const clamp = (key, value) => {
    const { min = -Infinity, max = Infinity } = field(key);
    return Math.min(max, Math.max(min, value));
  };
  const toMs = (key, ms) => clamp(key, Math.round(ms / 100) * 100);
  const rows = [];
  const add = (keys, label, have, needed, build) => {
    const row = { keys, label, current: Object.fromEntries(keys.map(key => [key, settings[key]])), value: null, basis: '', enough: have >= needed, need: Math.max(0, needed - have), same: false };
    if (row.enough) {
      const built = build();
      if (built) {
        row.value = built.value;
        row.basis = built.basis;
        row.same = keys.every(key => (built.same ? built.same(key) : String(row.current[key]) === String(built.value[key])));
      } else { row.enough = false; row.need = 0; }
    }
    rows.push(row);
  };
  const range = (minKey, maxKey, label, gaps, needed, what) => add([minKey, maxKey], label, gaps.length, needed, () => {
    const sorted = [...gaps].sort((x, y) => x - y);
    const low = toMs(minKey, percentile(sorted, 0.2));
    const high = Math.max(low, toMs(maxKey, percentile(sorted, 0.8)));
    return { value: { [minKey]: low, [maxKey]: high }, basis: `依 ${gaps.length} 個${what}（取 20%～80%）` };
  });
  range('commandGapMinMs', 'commandGapMaxMs', '指令間隔 最短／最長（毫秒）', profile.walkGaps, 30, '連續走路的間隔');
  range('reactMinMs', 'reactMaxMs', '看完房間到開打 最短／最長（毫秒）', profile.reactGaps, 15, '看完房間到開打的時間');

  const verb = (key, map, needed, what) => {
    const total = sumOf(map);
    add([key], field(key).label || key, total, needed, () => {
      const [word, n] = topOf(map);
      return { value: { [key]: word }, basis: `依 ${total} 次${what}，最多的是「${word}」${n} 次`, same: () => String(settings[key] ?? '').trim().toLowerCase() === word };
    });
  };
  verb('fightCommand', profile.firstAttack, 10, '進房後第一個開打');
  verb('killCommand', profile.knockoutAttack, 5, '昏迷後的開打');

  // 特攻：出現在最多場的重複指令；間隔取它相鄰兩次的中位數
  const inFights = {};
  const times = {};
  const gapsOf = {};
  profile.fights.forEach(fight => fight.forEach(item => {
    inFights[item.cmd] = (inFights[item.cmd] || 0) + 1;
    times[item.cmd] = (times[item.cmd] || 0) + item.count;
    (gapsOf[item.cmd] = gapsOf[item.cmd] || []).push(...item.gaps);
  }));
  const ranked = Object.entries(inFights).sort((x, y) => y[1] - x[1] || times[y[0]] - times[x[0]]);
  const topFights = ranked[0]?.[1] || 0;
  add(['specialCommand', 'specialIntervalSec'], '特攻指令與間隔（秒）', topFights, 5, () => {
    const [cmd, fights] = ranked[0];
    const seconds = gapsOf[cmd].length ? clamp('specialIntervalSec', Math.round(median(gapsOf[cmd]) / 1000)) : settings.specialIntervalSec;
    const second = ranked[1];
    return {
      value: { specialCommand: cmd, specialIntervalSec: seconds },
      basis: `依 ${fights} 場裡重複出現的「${cmd}」（共 ${times[cmd]} 次）${second ? `，另有 ${second[0]} ${times[second[0]]} 次` : ''}`,
      same: key => (key === 'specialCommand' ? squash(settings.specialCommand) === squash(cmd) : String(settings.specialIntervalSec) === String(seconds)),
    };
  });

  add(['afterKillCommand'], field('afterKillCommand').label || 'afterKillCommand', profile.downs, 10, () => {
    const top = topOf(profile.afterDown);
    if (!top) return null;
    return { value: { afterKillCommand: top[0] }, basis: `依 ${profile.downs} 隻倒下，最多的是「${top[0]}」${top[1]} 次`, same: () => squash(settings.afterKillCommand) === squash(top[0]) };
  });

  add(['typoPercent'], field('typoPercent').label || 'typoPercent', profile.commands, 200, () => {
    const percent = clamp('typoPercent', Math.round(profile.typos / profile.commands * 100));
    return { value: { typoPercent: percent }, basis: `${profile.commands} 個指令裡有 ${profile.typos} 次打錯字` };
  });
  return rows;
}

const keepLatest = (list, extra) => [...list, ...extra].slice(-SAMPLE_MAX);
function mergeMap(base, extra) {
  const sum = { ...base };
  Object.entries(extra || {}).forEach(([key, n]) => { sum[key] = (sum[key] || 0) + n; });
  return Object.fromEntries(Object.entries(sum).sort((x, y) => y[1] - x[1]).slice(0, MAP_MAX));
}

// 把這一段的量加進累積資料（回新物件，不改輸入）
function merge(profile, extracted) {
  const base = normalizeProfile(profile);
  const add = normalizeProfile({ ...extracted, segments: 0 });
  return {
    segments: base.segments + 1,
    commands: base.commands + add.commands,
    typos: base.typos + add.typos,
    rooms: base.rooms + add.rooms,
    stops: base.stops + add.stops,
    downs: base.downs + add.downs,
    walkGaps: keepLatest(base.walkGaps, add.walkGaps),
    reactGaps: keepLatest(base.reactGaps, add.reactGaps),
    fights: keepLatest(base.fights, add.fights),
    firstAttack: mergeMap(base.firstAttack, add.firstAttack),
    knockoutAttack: mergeMap(base.knockoutAttack, add.knockoutAttack),
    afterDown: mergeMap(base.afterDown, add.afterDown),
    habitArrive: mergeMap(base.habitArrive, add.habitArrive),
    habitKill: mergeMap(base.habitKill, add.habitKill),
  };
}

const count = value => (Number.isInteger(value) && value >= 0 && value <= SAMPLE_VALUE_MAX * 100 ? value : 0);
const samples = value => (Array.isArray(value) ? value.filter(item => Number.isFinite(item) && item >= 0 && item <= SAMPLE_VALUE_MAX).slice(-SAMPLE_MAX) : []);
function counts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, n]) => key && key.length <= KEY_MAX && Number.isInteger(n) && n > 0)
    .sort((x, y) => y[1] - x[1]).slice(0, MAP_MAX));
}
function fightList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(fight => (Array.isArray(fight) ? fight : [])
      .filter(item => item && typeof item.cmd === 'string' && item.cmd && item.cmd.length <= KEY_MAX && Number.isInteger(item.count) && item.count >= 2)
      .slice(0, FIGHT_CMD_MAX)
      .map(item => ({ cmd: item.cmd, count: item.count, gaps: samples(item.gaps).slice(0, FIGHT_GAP_MAX) })))
    .filter(fight => fight.length)
    .slice(-SAMPLE_MAX);
}
// 讀回儲存的值：壞的欄位丟掉（變空的），整份壞就是空的
function normalizeProfile(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    segments: count(source.segments), commands: count(source.commands), typos: count(source.typos), rooms: count(source.rooms), stops: count(source.stops), downs: count(source.downs),
    walkGaps: samples(source.walkGaps), reactGaps: samples(source.reactGaps), fights: fightList(source.fights),
    firstAttack: counts(source.firstAttack), knockoutAttack: counts(source.knockoutAttack), afterDown: counts(source.afterDown),
    habitArrive: counts(source.habitArrive), habitKill: counts(source.habitKill),
  };
}

globalThis.CatworldHuntProfile = { PROFILE_KEY, SAMPLE_MAX, HABIT_COMMANDS, classify, extract, merge, normalizeProfile, emptyProfile, suggest };
})();

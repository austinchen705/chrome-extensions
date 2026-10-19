// 怪物比對與分級：不碰 DOM，content script、background、測試共用。
//
// 分級看 q = 怪物強度 S × 2 ÷ 目前經驗 E：q ≤ 1 打了沒有潛能（白）；q > 1 有潛能，q 越大越難打，
// 依兩個門檻分成綠（≤ greenMax）、黃（≤ yellowMax）、紅（其餘）。遊戲沒有公開門檻，預設值是依實測校準點估的，
// 使用者可在設定調整。E 讀不到或 ≤ 0、強度不明時回 unknown，不當成白色。
//
// 比對鍵是完整顯示名稱「名稱(ID)」（不分大小寫）；同 ID 常有多隻不同的怪，所以完整名稱沒命中時才退而用 ID，
// 並標 idOnly，由呼叫端把所有候選列給使用者，不猜。
(() => {
if (globalThis.CatworldZapMobs) return;

const DEFAULT_THRESHOLDS = Object.freeze({ greenMax: 1.5, yellowMax: 3 });
const SUITABLE_LIMIT = 200;

function normalizeThresholds(raw) {
  const greenMax = Number(raw?.greenMax);
  const yellowMax = Number(raw?.yellowMax);
  const valid = Number.isFinite(greenMax) && Number.isFinite(yellowMax) && greenMax > 1 && yellowMax > greenMax;
  return valid ? { greenMax, yellowMax } : { ...DEFAULT_THRESHOLDS };
}

function normalizeName(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const idOf = name => /\(([^)]*)\)\s*$/.exec(normalizeName(name))?.[1].trim() ?? '';

// 遊戲裡的怪物行：「  ※名稱(ID) [fight][kill]」。去掉 ※ 與行尾標籤，同一隻合併計數
function parseMobLines(text) {
  const counts = new Map();
  String(text ?? '').split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.normalize('NFKC');
    const match = /^\s*※\s*(.+?)\s*(?:\[[^\]]*\]\s*)*$/.exec(line);
    if (!match) return;
    const name = match[1].replace(/\s+/g, ' ');
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  return Array.from(counts, ([name, count]) => ({ name, count }));
}

function gradeOf(strength, exp, thresholds = DEFAULT_THRESHOLDS) {
  if (!Number.isFinite(strength) || !Number.isFinite(exp) || exp <= 0) return { q: null, grade: 'unknown' };
  const { greenMax, yellowMax } = normalizeThresholds(thresholds);
  const q = (strength * 2) / exp;
  const grade = q <= 1 ? 'white' : q <= greenMax ? 'green' : q <= yellowMax ? 'yellow' : 'red';
  return { q, grade };
}

function findMobs(mobs, name) {
  const key = normalizeName(name);
  const exact = mobs.filter(mob => normalizeName(mob.name) === key);
  if (exact.length) return exact.map(mob => ({ mob, idOnly: false }));
  const id = idOf(name);
  if (!id) return [];
  return mobs.filter(mob => (mob.id || idOf(mob.name)) === id).map(mob => ({ mob, idOnly: true }));
}

function describe(mobs, items, exp, thresholds) {
  return items.map(({ name, count }) => ({
    name,
    count,
    candidates: findMobs(mobs, name).map(({ mob, idOnly }) => ({ mob, idOnly, ...gradeOf(mob.exp, exp, thresholds) })),
  }));
}

function suitable(mobs, exp, thresholds, { grades = ['green'], query = '' } = {}) {
  if (!Number.isFinite(exp) || exp <= 0) return [];
  const needle = normalizeName(query);
  return mobs
    .map(mob => ({ mob, ...gradeOf(mob.exp, exp, thresholds) }))
    .filter(item => grades.includes(item.grade))
    .filter(item => !needle || normalizeName(`${item.mob.name} ${item.mob.location}`).includes(needle))
    .sort((a, b) => b.mob.exp - a.mob.exp);
}

// background 用：回 null 表示不是這個模組的訊息
function handleMessage(mobs, message) {
  if (message?.type === 'ZAP_LOOKUP') {
    return { ok: true, items: describe(mobs, message.names || [], message.exp, message.thresholds) };
  }
  if (message?.type === 'ZAP_SUITABLE') {
    const all = suitable(mobs, message.exp, message.thresholds, { grades: message.grades, query: message.query });
    return { ok: true, items: all.slice(0, SUITABLE_LIMIT), total: all.length };
  }
  return null;
}

globalThis.CatworldZapMobs = {
  DEFAULT_THRESHOLDS, SUITABLE_LIMIT, normalizeThresholds, normalizeName, parseMobLines,
  gradeOf, findMobs, describe, suitable, handleMessage,
};
})();

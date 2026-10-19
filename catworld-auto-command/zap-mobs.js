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

// 綠上限 2＝怪物強度比你的經驗小（q = 2S/E < 2 ⇔ S < E）就是綠：遊戲實測夏老（390000）、丐幫長老（370000）在經驗 416944 時是綠，
// 蒙古將軍（500000，q≈2.4）是黃。黃上限 3 沒有紅色的校準點，是猜的
const DEFAULT_THRESHOLDS = Object.freeze({ greenMax: 2, yellowMax: 3 });
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

// 遊戲裡的怪物行：「  ※名稱(ID) <戰鬥中> [fight][kill]」（<…> 是狀態，不一定有）。
// 去掉 ※、狀態與行尾標籤，同一隻合併計數
function parseMobLines(text) {
  const counts = new Map();
  String(text ?? '').split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.normalize('NFKC');
    const match = /^\s*※\s*(.+?)\s*(?:(?:<[^>]*>|\[[^\]]*\])\s*)*$/.exec(line);
    if (!match) return;
    const name = match[1].replace(/\s+/g, ' ');
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  return Array.from(counts, ([name, count]) => ({ name, count }));
}

// 遊戲把一行輸出拆成好幾個節點（※、稱號、名稱各在自己的 <span>），所以節點文字要直接相接，不能加分隔
function textFromAdded(texts) {
  return texts.join('');
}

function gradeOf(strength, exp, thresholds = DEFAULT_THRESHOLDS) {
  if (!Number.isFinite(strength) || !Number.isFinite(exp) || exp <= 0) return { q: null, grade: 'unknown' };
  const { greenMax, yellowMax } = normalizeThresholds(thresholds);
  const q = (strength * 2) / exp;
  const grade = q <= 1 ? 'white' : q <= greenMax ? 'green' : q <= yellowMax ? 'yellow' : 'red';
  return { q, grade };
}

// 遊戲與攻略表對稱號後面的空白不一致（「猛虎大將軍 蒙古將軍」vs「猛虎大將軍蒙古將軍」），比對時忽略所有空白
const compactName = text => normalizeName(text).replace(/\s/g, '');

function findMobs(mobs, name) {
  const key = compactName(name);
  const exact = mobs.filter(mob => compactName(mob.name) === key);
  if (exact.length) return exact.map(mob => ({ mob, idOnly: false }));
  const id = idOf(name);
  if (!id) return [];
  return mobs.filter(mob => (mob.id || idOf(mob.name)) === id).map(mob => ({ mob, idOnly: true }));
}

// 一個候選的說明文字。經驗讀不到時分不出顏色，但強度本身是已知的，照樣顯示
function metaText({ mob, q, idOnly }) {
  const strength = !Number.isFinite(mob.exp) ? '強度未知' : q === null ? `強度 ${mob.exp}` : `強度 ${mob.exp}（q=${q.toFixed(2)}）`;
  return [strength, mob.location, mob.note, idOnly ? '僅 ID 命中' : ''].filter(Boolean).join('　');
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

// 浮層一次最多列 max 筆，其餘只算數量
function limitHints(items, max) {
  return { shown: items.slice(0, max), hidden: Math.max(0, items.length - max) };
}

// 視窗內提示過的名稱不再提示（房間重畫會重複送出同一批怪）；會更新 lastShown
function recentFilter(names, now, lastShown, windowMs) {
  return names.filter(name => {
    if (name in lastShown && now - lastShown[name] < windowMs) return false;
    lastShown[name] = now;
    return true;
  });
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
  textFromAdded, gradeOf, findMobs, metaText, describe, suitable, limitHints, recentFilter, handleMessage,
};
})();

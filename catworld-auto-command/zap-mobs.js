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
  const added = mob.source === 'shared' ? `共用新增（${mob.by || '未署名'}）` : '';
  return [strength, mob.location, mob.note, idOnly ? '僅 ID 命中' : '', added].filter(Boolean).join('　');
}

// 怪物的出沒地點對應「總路徑」表。完全同名優先；否則只接受「其中一個名稱以另一個開頭」（天魔塔2f↔天魔塔、襄陽↔襄陽城），
// 地名只是夾在別的字中間（往黑木崖渡口、金礦坑南方小鎮）不猜。多個地點時完全同名優先，其次取最長的路線名
function routeFor(location, routes, aliases = {}) {
  const tokens = String(location ?? '').split(/[、,，/]/).map(compactName).filter(Boolean);
  let exact = null;
  let partial = null;
  tokens.forEach(token => (routes || []).forEach(route => {
    const name = compactName(route.name);
    if (!name || route.mob) return;
    if (token === name) {
      if (!exact || name.length > compactName(exact.name).length) exact = route;
    } else if (!route.command && (token.startsWith(name) || name.startsWith(token)) && (!partial || name.length > compactName(partial.name).length)) {
      partial = route;
    }
  }));
  if (exact) return { route: exact, exact: true };
  if (partial) return { route: partial, exact: false };
  // 別名表（tools/zap-route-aliases.json）：地點以別名開頭就借用該路線，一律標成約略對應；別名多個命中取最長
  const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    const key = keys.find(alias => token.startsWith(compactName(alias)));
    const route = key && (routes || []).find(item => item.name === aliases[key]);
    if (route) return { route, exact: false };
  }
  return null;
}

// 手動指定給單一怪物的指令（routes 裡帶 mob:true 的項目，名稱是怪物全名）優先於位置的比對
function routeForMob(mob, routes, aliases) {
  const own = (routes || []).find(route => route.mob && compactName(route.name) === compactName(mob.name));
  return own ? { route: own, exact: true } : routeFor(mob.location, routes, aliases);
}

// 使用者在面板補的路線（chrome.storage.local.mobRoutes：怪物名稱（忽略空白）→ 完整指令），只給那一隻怪、優先於內建資料
const customKey = name => compactName(name);

function applyCustomRoute(item, custom) {
  const command = custom?.[customKey(item.mob.name)];
  return command ? { ...item, route: { route: { name: item.mob.name, path: '', command }, exact: true, custom: true } } : item;
}

// 回傳新物件；指令清空就移除（還原成內建路線）
function setCustomRoute(custom, name, command) {
  const next = { ...custom };
  const text = String(command ?? '').trim();
  if (text) next[customKey(name)] = text;
  else delete next[customKey(name)];
  return next;
}

// 匯入前先驗證形狀，不合法不能動既有資料
function parseCustomRoutes(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是有效的 JSON' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: '格式不對：要是「怪物名稱: 指令」的物件' };
  const routes = {};
  for (const [name, command] of Object.entries(value)) {
    if (!name.trim() || typeof command !== 'string') return { ok: false, error: `格式不對：「${name}」` };
    if (command.trim()) routes[customKey(name)] = command.trim();
  }
  return { ok: true, routes };
}

// 路徑表的路徑都從新長安門口起算；和其他地圖路徑一樣，先從醉仙樓（recall 回來的位置）走到門口
function routeCommand(route) {
  return route.command ?? `run e 5n 2o ${route.path}`;
}

function describe(mobs, items, exp, thresholds, routes, aliases) {
  return items.map(({ name, count }) => ({
    name,
    count,
    candidates: findMobs(mobs, name).map(({ mob, idOnly }) => ({
      mob, idOnly, ...gradeOf(mob.exp, exp, thresholds), route: routeForMob(mob, routes, aliases),
    })),
  }));
}

function suitable(mobs, exp, thresholds, { grades = ['green'], query = '' } = {}, routes, aliases) {
  if (!Number.isFinite(exp) || exp <= 0) return [];
  const needle = normalizeName(query);
  return mobs
    .map(mob => ({ mob, ...gradeOf(mob.exp, exp, thresholds) }))
    .filter(item => grades.includes(item.grade))
    .filter(item => !needle || normalizeName(`${item.mob.name} ${item.mob.location}`).includes(needle))
    .sort((a, b) => a.mob.exp - b.mob.exp)
    .map(item => ({ ...item, route: routeForMob(item.mob, routes, aliases) }));
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
function handleMessage(mobs, message, routes, aliases) {
  if (message?.type === 'ZAP_LOOKUP') {
    return { ok: true, items: describe(mobs, message.names || [], message.exp, message.thresholds, routes, aliases) };
  }
  if (message?.type === 'ZAP_SUITABLE') {
    const all = suitable(mobs, message.exp, message.thresholds, { grades: message.grades, query: message.query }, routes, aliases);
    return { ok: true, items: all.slice(0, SUITABLE_LIMIT), total: all.length };
  }
  return null;
}

globalThis.CatworldZapMobs = {
  DEFAULT_THRESHOLDS, SUITABLE_LIMIT, normalizeThresholds, normalizeName, parseMobLines,
  textFromAdded, gradeOf, findMobs, metaText, routeFor, routeForMob, routeCommand, customKey, applyCustomRoute, setCustomRoute, parseCustomRoutes, describe, suitable, limitHints, recentFilter, handleMessage,
};
})();

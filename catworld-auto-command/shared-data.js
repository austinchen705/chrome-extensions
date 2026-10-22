// 共用資料：把 Google 試算表「發布到網路」的 CSV 變成共用層（怪物路線），不碰 DOM、不碰 chrome.*，background、設定頁、測試共用。
// 共用層介於個人層（chrome.storage.local.mobRoutes）與內建資料之間：個人 > 共用 > 內建。
// 試算表由一群互信的玩家一起填，所以共用來的指令只收白名單動詞（走路與互動類），不合的整列丟掉並記在報告裡。
// 鍵與個人層是同一個函式（CatworldZapMobs.customKey），不然個人層蓋不掉共用層。
(() => {
if (globalThis.CatworldSharedData) return;

const MAX_SEGMENT = 500;
const MAX_ROWS = 2000;
const MAX_BUY = 20;
const MAX_PAY = 100;
const DISABLE = '停用';
// 第一次安裝（或更新後從來沒設定過）時自動帶入的共用表連結：作者這一群朋友在用的那份（README「現在在用的共用表連結」要寫同樣兩條，測試會對照）。
// 設定頁清空後（存成空字串）不會再帶入；功能開關預設關閉，開了才會抓
const DEFAULT_SOURCES = Object.freeze({
  mob: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQXSjhzXVd_Qy2B773sXN8tPVA1x_mTQ26xFHfkzB5F-5tWwRrvxJv9DxeHaLNrlS8uOwsNToJtRK57/pub?gid=49592298&single=true&output=csv',
  riddle: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQXSjhzXVd_Qy2B773sXN8tPVA1x_mTQ26xFHfkzB5F-5tWwRrvxJv9DxeHaLNrlS8uOwsNToJtRK57/pub?gid=65492013&single=true&output=csv',
});
const PUBLISH_HINT = '要用「檔案 → 共用 → 發布到網路」選那個分頁、格式選 CSV，再貼上產生的連結';

// 第一個詞在這份清單裡的指令段才收；走路的方向（n、2e、nu…）與 @等待 另外判斷。
// 只收走路與互動類，不收會打怪、丟東西、賣東西、離線、施招、換裝備、拜師、公開說話或把東西放進容器的。
// give、buy、pay 會轉移財物，另外限制參數（見 checkCommand）。README「共用資料」一節的「允許的動詞」要和這份一樣（測試會對照）
const ALLOWED_VERBS = new Set([
  'run', 'push', 'touch', 'enter', 'climb', 'worship', 'open', 'squeeze', 'dis', 'jump', 'walk', 'knife',
  'pay', 'out', 'ask', 'give', 'buy', 'study', 'move', 'see', 'diving',
  'ride', 'search', 'unlock', 'nod', 'knock', 'insert', 'wash', 'fly', 'tan', 'recall', 'get', 'up', 'down',
]);
const DIRECTION = /^\d*(?:ne|nw|se|sw|nu|nd|eu|ed|su|sd|wu|wd|n|s|e|w|u|d)$/;
const WAIT = /^@(?:等待|wait)$/i;

// 會轉移財物的指令只看第一個詞不夠（give all to bob、pay 5000 都會過）：不收 all 與 *，buy 的數量與 pay 的金額有上限
function refuseArguments(verb, args) {
  const numbers = args.filter(arg => /^\d+$/.test(arg)).map(Number);
  if ((verb === 'give' || verb === 'buy') && args.some(arg => /^(?:all|\*)$/i.test(arg))) return `「${verb}」不能用 all 或 *`;
  if (verb === 'buy' && numbers.some(n => n > MAX_BUY)) return `「buy」數量不能超過 ${MAX_BUY}`;
  if (verb === 'pay' && numbers.some(n => n > MAX_PAY)) return `「pay」金額不能超過 ${MAX_PAY}`;
  return '';
}

function checkCommand(command) {
  // 遊戲只用 ASCII 的 ; 切指令；換行與全形分號不是合法的分隔，可能用來夾帶第二個指令，直接拒絕
  if (/[\r\n；]/.test(String(command ?? ''))) return { ok: false, reason: '指令裡有換行或全形分號（；），要用半形的 ;' };
  for (const raw of String(command ?? '').split(';')) {
    const segment = raw.trim();
    if (!segment) continue;
    if (segment.length > MAX_SEGMENT) return { ok: false, reason: `有一段超過 ${MAX_SEGMENT} 字` };
    const verb = segment.split(/\s+/)[0];
    if (!ALLOWED_VERBS.has(verb.toLowerCase()) && !DIRECTION.test(verb.toLowerCase()) && !WAIT.test(verb)) {
      return { ok: false, reason: `不允許的指令「${verb}」` };
    }
    const refused = refuseArguments(verb.toLowerCase(), segment.split(/\s+/).slice(1));
    if (refused) return { ok: false, reason: refused };
  }
  return { ok: true };
}

// 只接受 Google 試算表發布成 CSV 的連結；別的網址一律拒絕（background 會對它發請求）
function checkUrl(text) {
  const raw = String(text ?? '').trim();
  const refuse = () => ({ ok: false, error: `不是 Google 試算表發布成 CSV 的連結：${PUBLISH_HINT}` });
  let url;
  try {
    url = new URL(raw);
  } catch {
    return refuse();
  }
  const valid = url.protocol === 'https:' && url.hostname === 'docs.google.com'
    && url.pathname.startsWith('/spreadsheets/') && url.searchParams.get('output') === 'csv';
  return valid ? { ok: true, url: raw } : refuse();
}

// RFC 4180：引號內可以有逗號、換行與兩個引號（代表一個引號）。回傳二維陣列，不處理標題
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (source[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// 怪的位置（整串，或「、」「,」「/」分開的每個地點）正規化後的鍵，給「位置」欄比對
const mobPlaces = mob => {
  const key = globalThis.CatworldZapMobs.customKey;
  return [...new Set([key(mob.location ?? ''), ...String(mob.location ?? '').split(/[、,，/]/).map(key)])].filter(Boolean);
};

// 共用表與內建怪物對照用的鍵：名稱，或「名稱|位置」（位置有填才帶）
const mobKey = (name, location) => {
  const key = globalThis.CatworldZapMobs.customKey;
  return location ? `${key(name)}|${key(location)}` : key(name);
};

// 內建怪物資料認得的怪：名稱，或名稱配它的整串位置與每個地點。
// 內建怪沒有位置的（野狗、黑熊…），位置欄填什麼都沒有可以「不同」的地方，所以不算新地點，名稱對上就算認得
const knownMobs = mobs => {
  const key = globalThis.CatworldZapMobs.customKey;
  const names = new Set();
  const placed = new Set();
  const placeless = new Set();
  (mobs ?? []).forEach(mob => {
    const name = key(mob.name);
    names.add(name);
    const places = mobPlaces(mob);
    if (!places.length) placeless.add(name);
    places.forEach(place => placed.add(`${name}|${place}`));
  });
  const hasPlace = (name, location) => placed.has(mobKey(name, location));
  return {
    hasName: name => names.has(key(name)),
    hasPlace,
    has: (name, location) => (location ? hasPlace(name, location) || placeless.has(key(name)) : names.has(key(name))),
  };
};

// 更新時間：2026-10-21 14:30（秒可有可無、斜線也行、只有日期也行）。解析不了回 NaN
function parseTime(text) {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(text ?? '').trim());
  if (!match) return NaN;
  const [y, mo, d, h, mi, s] = match.slice(1).map(part => Number(part ?? 0));
  const date = new Date(y, mo - 1, d, h, mi, s);
  // 超出日曆的值（13 月、2/31、25 點）Date 會自己進位成別天，要當成讀不到
  const same = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d
    && date.getHours() === h && date.getMinutes() === mi && date.getSeconds() === s;
  return same ? date.getTime() : NaN;
}

// 兩個分頁共用的讀法：解析 CSV、依標題文字找欄位（順序不拘，缺必要欄位就是格式錯誤）、略過空列；
// 每一列給 { row（試算表上的列號，標題是第 1 列）, cell(欄名)（沒有這個欄位或空的回空字串）}。
// 最多讀前 MAX_ROWS 列（壞掉或爆量的表不能拖垮面板），其餘不讀，回 total（全部有資料的列數）、overflow（沒讀的列數）、overflowFrom（第一個沒讀的列號）
function readSheet(csvText, required) {
  const records = parseCsv(csvText);
  if (!records.length) return { error: '內容是空的，不是 CSV' };
  const index = Object.fromEntries(records[0].map((name, i) => [String(name).trim(), i]));
  const missing = required.filter(name => !(name in index));
  if (missing.length) return { error: `缺少欄位「${missing.join('、')}」，第一列要是標題列` };
  const rows = [];
  let total = 0;
  let overflowFrom = null;
  records.slice(1).forEach((record, i) => {
    if (record.every(value => !String(value).trim())) return;
    total += 1;
    if (rows.length >= MAX_ROWS) {
      overflowFrom ??= i + 2;
      return;
    }
    rows.push({ row: i + 2, cell: name => (name in index ? String(record[index[name]] ?? '').trim() : '') });
  });
  return { rows, total, overflow: total - rows.length, overflowFrom, has: name => name in index };
}

// 兩個分頁共用的報告起點：rows 是有資料的列數（含超過上限沒讀的），其餘由各自的 build 填
const newReport = sheet => ({ rows: sheet.total, overflow: sheet.overflow, overflowFrom: sheet.overflowFrom, used: 0, dropped: [], unmatched: [] });

// 指令欄的共用規則：空白丟掉；整個詞「停用」是關掉；其餘過白名單。回 { entry, rank } 或 { reason }；
// rank 是更新時間（讀不到當最舊），同一個鍵多列取 rank 最大的、一樣大取後面的
function commandEntry(cell) {
  const command = cell('指令');
  if (!command) return { reason: '指令是空的' };
  const disabled = command === DISABLE;
  const check = disabled ? { ok: true } : checkCommand(command);
  if (!check.ok) return { reason: check.reason };
  const at = parseTime(cell('更新時間'));
  const entry = { command: disabled ? '' : command, by: cell('更新者'), note: cell('備註'), at: Number.isFinite(at) ? at : null };
  if (disabled) entry.disabled = true;
  return { entry, rank: Number.isFinite(at) ? at : -Infinity };
}

// 強度的寫法：純數字、`N萬`、`NW`（大小寫不拘）、`1W5`（＝1.5 萬，W 後面接小數）；要大於 0、不超過 1 億
const MAX_STRENGTH = 100000000;
const STRENGTH_HINT = '強度要寫成純數字，或「25萬」「25W」「1W5」這樣的寫法';
function parseStrength(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, reason: `強度是空的：${STRENGTH_HINT}` };
  let value = NaN;
  let match;
  if (/^\d+$/.test(raw)) value = Number(raw);
  else if ((match = /^(\d+(?:\.\d+)?)\s*(?:萬|w)$/i.exec(raw))) value = Number(match[1]) * 10000;
  else if ((match = /^(\d+)w(\d+)$/i.exec(raw))) value = Number(`${match[1]}.${match[2]}`) * 10000;
  if (!Number.isFinite(value)) return { ok: false, reason: `強度「${raw}」看不懂：${STRENGTH_HINT}` };
  value = Math.round(value);
  if (value < 1) return { ok: false, reason: '強度要大於 0' };
  if (value > MAX_STRENGTH) return { ok: false, reason: `強度超過上限 1 億（${raw}）` };
  return { ok: true, value };
}

// 新怪的名稱要帶括號 ID（遊戲輸出是 ※名稱(ID)，怪物出現提示靠名稱、再退而用 ID 比對）；ID 正規化成和 findMobs 比對的一樣（小寫）
const bracketId = name => {
  const match = /[(（]([^()（）]+)[)）]\s*$/.exec(String(name ?? ''));
  return match ? globalThis.CatworldZapMobs.normalizeName(match[1]) : '';
};

// 怪物路線分頁：怪物名稱 | 位置（選填） | 強度（選填） | 指令 | 備註 | 更新者 | 更新時間。
// 鍵是「名稱」或「名稱|位置」（位置有填才帶）：同名的怪常在不同地方，位置有填就只管那個地方的怪。指令寫「停用」代表這隻怪不要路線。
// 有填強度、而且名稱＋位置不在內建怪物資料裡的列是「新怪」（要帶括號 ID、強度要合法；可以沒有指令）；
// 有填強度、而且名稱＋位置對得上內建怪的列是「修正強度」：只改那隻怪的強度（強度寫法與新怪相同，不合法整列丟掉），備註只當路線備註；
// 沒填強度、不在內建資料的列維持原樣（只列在 unmatched，打錯字的名稱不會變成新怪）。
// 回 { ok, routes: { 鍵: { command, by, note, at, disabled? } }, mobs: { 鍵: { name, id, exp, location, note, by, at } },
//      fixes: { 鍵: { exp, by, at } },
//      report: { rows, used, created, dropped: [{row, reason}], unmatched: [{row, name, location?, reason}] } }。
// 同一個鍵多列取更新時間最新的；被丟掉的列什麼都不留下（路線和新怪都不會有）
function buildMobRoutes(csvText, mobs) {
  const customKey = globalThis.CatworldZapMobs.customKey;
  const sheet = readSheet(csvText, ['怪物名稱']);
  if (sheet.error) return { ok: false, error: sheet.error };
  // 一列要嘛有指令、要嘛是有強度的新怪：標題列兩個欄位都沒有的表，沒有任何一列能用
  if (!sheet.has('指令') && !sheet.has('強度')) return { ok: false, error: '缺少欄位「指令」，第一列要是標題列' };
  const known = knownMobs(mobs);
  const best = new Map();
  const bestMob = new Map();
  const bestFix = new Map();
  const report = newReport(sheet);
  sheet.rows.forEach(({ row, cell }) => {
    const name = cell('怪物名稱');
    if (!name) return report.dropped.push({ row, reason: '怪物名稱是空的' });
    const location = cell('位置');
    const key = mobKey(name, location);
    // 先把整列驗證完才寫進結果：被丟掉的列不能留下一半
    const hasStrength = cell('強度') !== '';
    const fixes = hasStrength && known.has(name, location);
    const creates = hasStrength && !fixes;
    let exp = null;
    if (hasStrength) {
      const parsed = parseStrength(cell('強度'));
      if (!parsed.ok) return report.dropped.push({ row, reason: parsed.reason });
      if (creates && !bracketId(name)) return report.dropped.push({ row, reason: '新怪的名稱要寫成「稱號 名稱(ID)」，缺少括號 ID' });
      exp = parsed.value;
    }
    const hasCommand = cell('指令') !== '';
    if (!hasCommand && !hasStrength) return report.dropped.push({ row, reason: '指令是空的' });
    const made = hasCommand ? commandEntry(cell) : null;
    if (made && !made.entry) return report.dropped.push({ row, reason: made.reason });
    const at = parseTime(cell('更新時間'));
    const rank = Number.isFinite(at) ? at : -Infinity;
    if (made) {
      const old = best.get(key);
      if (!old || made.rank >= old.rank) best.set(key, { rank: made.rank, row, name, location, entry: made.entry });
    }
    if (fixes) {
      const old = bestFix.get(key);
      if (!old || rank >= old.rank) bestFix.set(key, { rank, name, location, fix: { exp, by: cell('更新者'), at: Number.isFinite(at) ? at : null } });
    }
    if (creates) {
      const old = bestMob.get(key);
      if (!old || rank >= old.rank) bestMob.set(key, { rank, mob: { name, id: bracketId(name), exp, location, note: cell('備註'), by: cell('更新者'), at: Number.isFinite(at) ? at : null } });
    }
  });
  const routes = {};
  // 位置不屬於任何同名的內建怪（內建怪沒有位置、或填錯地方）的列：位置挑不到怪，就退回名稱套用到同名的怪，
  // 但輸給真正沒填位置的列；這種列之間取最新的。共用表自己新增的怪的路線只給那隻怪
  const loose = new Map();
  best.forEach(({ rank, name, location, entry }, key) => {
    if (!location || !known.hasName(name) || known.hasPlace(name, location) || bestMob.has(key)) return;
    const nameKey = customKey(name);
    if (!loose.has(nameKey) || rank >= loose.get(nameKey).rank) loose.set(nameKey, { rank, entry });
  });
  best.forEach(({ row, name, location, entry }, key) => {
    routes[key] = entry;
    if (known.has(name, location) || bestMob.has(key)) return;
    const unmatched = location ? { row, name, location, reason: known.hasName(name) ? `這個怪物沒有在「${location}」，已改用名稱套用` : '資料裡沒有這個怪物' } : { row, name, reason: '資料裡沒有這個怪物' };
    report.unmatched.push(unmatched);
  });
  loose.forEach(({ entry }, nameKey) => { routes[nameKey] ??= entry; });
  const fixesByKey = Object.fromEntries([...bestFix].map(([key, { fix }]) => [key, fix]));
  // 內建怪沒有位置時，位置挑不到怪：修正也退回名稱（輸給真正沒填位置的列，這種列之間取最新的）
  const looseFix = new Map();
  bestFix.forEach(({ rank, name, location, fix }) => {
    if (!location || known.hasPlace(name, location)) return;
    const nameKey = customKey(name);
    if (!looseFix.has(nameKey) || rank >= looseFix.get(nameKey).rank) looseFix.set(nameKey, { rank, fix });
  });
  looseFix.forEach(({ fix }, nameKey) => { fixesByKey[nameKey] ??= fix; });
  const newMobs = Object.fromEntries([...bestMob].map(([key, { mob }]) => [key, mob]));
  report.used = new Set([...best.keys(), ...bestMob.keys(), ...bestFix.keys()]).size;
  report.created = bestMob.size;
  report.unmatched.sort((a, b) => a.row - b.row);
  return { ok: true, routes, mobs: newMobs, fixes: fixesByKey, report };
}

// 共用層（鍵是名稱或名稱|位置）裡這隻怪對得上的項目：有填位置的先比（怪的位置整串或其中一個地點相符），沒有才用沒填位置的
const entryFor = (table, mob) => {
  const nameKey = globalThis.CatworldZapMobs.customKey(mob.name);
  const hit = mobPlaces(mob).find(place => table[`${nameKey}|${place}`]);
  return hit ? table[`${nameKey}|${hit}`] : table[nameKey];
};

// background 用：把共用表的修正強度套在內建怪上（只改強度，帶 fixed: { by, original }），再把新增的怪併在後面，
// 回傳新陣列、不改動輸入（沒有任何變動就回同一個陣列）。
// 內建資料後來已經有同一隻新怪（名稱＋位置，或沒填位置的名稱）就以內建的為準，不重複列出
function applySharedMobs(mobs, shared, fixes) {
  const list = mobs ?? [];
  const entries = Object.values(shared ?? {});
  const table = fixes ?? {};
  if (!entries.length && !Object.keys(table).length) return list;
  const corrected = list.map(mob => {
    const fix = entryFor(table, mob);
    return fix ? { ...mob, exp: fix.exp, fixed: { by: fix.by, original: mob.exp } } : mob;
  });
  const base = corrected.some((mob, index) => mob !== list[index]) ? corrected : list;
  const known = knownMobs(list);
  const added = entries
    .filter(mob => !known.has(mob.name, mob.location))
    .map(mob => ({ name: mob.name, id: mob.id, exp: mob.exp, location: mob.location, note: mob.note, source: 'shared', by: mob.by }));
  return added.length ? [...base, ...added] : base;
}

// 解謎指令分頁：謎名稱 | 步驟 | 指令 | 備註 | 更新者 | 更新時間 | 步驟數（選填）。
// 步驟是「這個謎的第幾步」（面板每個步驟旁標出來，從 1 起算、一定唯一；不看頁面印的編號，一頁有兩個編號清單時印的編號會重複），
// 對到這個謎自己那一段（sectionSteps）的第 N 個步驟，換算成步驟在該頁的 1 起算位置當鍵。
// 步驟數是存檔當時該頁的步驟數，有填而且和現在不同就標「步驟已變動」，留空就不警告。
// 回 { ok, steps: { 頁面檔名: { 位置: { command, by, note, at, n?, disabled? } } }, report }；
// 謎或步驟對不到的列沒有位置可放，只列在 report.unmatched（{row, name, step}），不進共用層
function buildRiddleSteps(csvText, riddles, pages) {
  const customKey = globalThis.CatworldZapMobs.customKey;
  const sheet = readSheet(csvText, ['謎名稱', '步驟', '指令']);
  if (sheet.error) return { ok: false, error: sheet.error };
  const byName = new Map();
  (riddles ?? []).forEach(riddle => { if (!byName.has(customKey(riddle.name))) byName.set(customKey(riddle.name), riddle); });
  const best = new Map();
  const report = newReport(sheet);
  sheet.rows.forEach(({ row, cell }) => {
    const name = cell('謎名稱');
    const no = Number(cell('步驟'));
    if (!name) return report.dropped.push({ row, reason: '謎名稱是空的' });
    if (!Number.isInteger(no) || no < 1) return report.dropped.push({ row, reason: '步驟要填面板上顯示的序號（正整數）' });
    const made = commandEntry(cell);
    if (!made.entry) return report.dropped.push({ row, reason: made.reason });
    const riddle = byName.get(customKey(name));
    const page = riddle?.page && pages?.[riddle.page];
    const position = page && globalThis.CatworldZapRiddles.sectionSteps(riddle, page)[no - 1];
    if (!position) return report.unmatched.push({ row, name, step: no, reason: riddle ? `這個謎沒有第 ${no} 步` : '資料裡沒有這個謎' });
    const n = Number(cell('步驟數'));
    if (Number.isInteger(n) && n > 0) made.entry.n = n;
    const key = `${riddle.page}|${position}`;
    const old = best.get(key);
    if (!old || made.rank >= old.rank) best.set(key, { rank: made.rank, file: riddle.page, position, entry: made.entry });
  });
  const steps = {};
  best.forEach(({ file, position, entry }) => {
    (steps[file] ??= {})[position] = entry;
  });
  report.used = best.size;
  return { ok: true, steps, report };
}

// 設定頁用：報告變成一行一行的訊息（被丟掉的、對不到的、超過上限沒讀的），最多 max 行，其餘寫「還有 N 筆」。
// 每一行帶等級讓畫面上色：被丟掉的是 error、對不到與超過上限是 warn、「還有 N 筆」是 info
function reportEntries(report, max = 30) {
  if (!report) return [];
  const label = item => `${item.name}${item.location ? `（${item.location}）` : ''}${item.step === undefined ? '' : ` 第 ${item.step} 步`}`;
  const lines = [
    ...(report.dropped ?? []).map(item => ({ row: item.row, level: 'error', text: `第 ${item.row} 列：丟掉（${item.reason}）` })),
    ...(report.unmatched ?? []).map(item => ({ row: item.row, level: 'warn', text: `第 ${item.row} 列：${label(item)}　${item.reason}` })),
  ].sort((a, b) => a.row - b.row).map(({ level, text }) => ({ level, text }));
  const shown = lines.length > max ? [...lines.slice(0, max), { level: 'info', text: `…還有 ${lines.length - max} 筆沒有顯示` }] : lines;
  // 超過上限沒讀的提示一定要看得到，不能被長清單截掉
  if (report.overflow > 0) shown.push({ level: 'warn', text: `第 ${report.overflowFrom} 列以後共 ${report.overflow} 列超過上限（${MAX_ROWS} 列）沒有讀` });
  return shown;
}
const reportLines = (report, max) => reportEntries(report, max).map(entry => entry.text);

// 設定頁每個分頁的標題與單位：生效的是「隻」怪物或「步」，對不到的是怪物或謎／步驟
const SHEET_LABELS = {
  mob: { title: '怪物路線', used: '隻', unmatched: '怪物' },
  riddle: { title: '解謎指令', used: '步', unmatched: '謎或步驟' },
};

// 設定頁每個分頁的結果文字：尚未設定／尚未抓取／上次更新的筆數（超過上限沒讀的另外說明）／更新失敗的原因與目前還在用的資料。
// timeText 把時間戳轉成文字（由呼叫端給，這裡不碰時區）
const lacksGid = url => {
  try {
    return !new URL(url).searchParams.has('gid');
  } catch {
    return false;
  }
};
// features 是 { mobs, riddles }（兩個功能開關）：都關著 background 不抓；只開一個時兩份表都會抓，但沒勾那個功能對應的表面板用不到，要說明。
// 回傳一行一行的 { level, text }：error（更新失敗）、warn（有被丟掉或對不到的列、超過上限、沒勾、沒有 gid、不會抓取）、info（其他）
const OWN_FEATURE = { mob: { key: 'mobs', name: '怪物查詢', what: '路線' }, riddle: { key: 'riddles', name: '解謎清單', what: '指令' } };
function describeSheetParts(kind, url, entry, timeText, features = { mobs: true, riddles: true }) {
  if (!url) return [{ level: 'info', text: `${SHEET_LABELS[kind].title}：尚未設定` }];
  const enabled = Boolean(features.mobs || features.riddles);
  const notes = [];
  const own = OWN_FEATURE[kind];
  if (enabled && !features[own.key]) notes.push(`注意：「${own.name}」沒勾，面板不會用到這份${own.what}（另一個功能開著，所以還是會抓）`);
  // 沒有 gid 的連結讀到的是試算表的第一個分頁，貼到第二個分頁的欄位會讀錯；連結本身仍然收（單一分頁的表沒有問題）
  if (enabled && lacksGid(url)) notes.push('注意：這條連結沒有 gid，讀到的是試算表的第一個分頁（發布時要選那個分頁，連結才會有 gid）');
  return [...describeFetched(kind, entry, timeText, enabled), ...notes.map(text => ({ level: 'warn', text }))];
}
function describeFetched(kind, entry, timeText, enabled) {
  const { title, used, unmatched } = SHEET_LABELS[kind];
  // 怪物查詢與解謎都關著時 background 不抓，上次的結果已經沒有意義，不能繼續顯示得像現在還在用
  if (!enabled) return [{ level: 'warn', text: `${title}：怪物查詢與解謎都關著，不會抓取` }];
  if (!entry) return [{ level: 'info', text: `${title}：尚未抓取（怪物查詢或解謎要開著；開著的話查一次，或按「立即更新」）` }];
  const report = entry.report;
  const rows = report?.overflow > 0 ? `共 ${report.rows} 列（其中 ${report.overflow} 列超過上限沒有讀）` : `共 ${report?.rows} 列`;
  const usable = Boolean(entry.at && report);
  const ok = usable
    ? `上次更新 ${timeText(entry.at)}：${rows}，生效 ${report.used} ${used}，丟掉 ${report.dropped.length} 列，對不到${unmatched} ${report.unmatched.length} 筆`
    : '沒有可用的資料';
  // 有被丟掉或對不到的列、超過上限、或根本沒有可用的資料，都是需要使用者留意的
  const level = !usable || report.dropped.length || report.unmatched.length || report.overflow > 0 ? 'warn' : 'info';
  if (entry.error) return [{ level: 'error', text: `${title}：更新失敗（${timeText(entry.error.at)}）：${entry.error.reason}` }, { level: 'info', text: `目前使用：${ok}` }];
  return [{ level, text: `${title}：${ok}` }];
}
const describeSheet = (...args) => describeSheetParts(...args).map(part => part.text).join('\n');

// 貼的連結格式不對時：沒有存進去，原本存的連結（如果有）照常使用，要說清楚
function describeRejectedUrl(kind, error, hasStored) {
  return `${SHEET_LABELS[kind].title}：${error}（沒有儲存${hasStored ? '，目前仍使用原本的連結' : ''}）`;
}

// background 用：把共用層疊在 ZAP_LOOKUP／ZAP_SUITABLE 的回覆上（個人層在面板那邊再蓋過去）。
// 有共用路線的怪，路線換成共用的並帶 shared: { by, note } 給面板標示；共用寫「停用」的怪路線變 null、帶 sharedDisabled: { by, note }；其餘原樣。
// 有填位置的列先比（怪的位置整串或其中一個地點相符），沒有才用沒填位置的列。不改動輸入
function overlayReply(reply, shared) {
  if (!reply?.ok || !shared || !Object.keys(shared).length) return reply;
  const apply = item => {
    const entry = item?.mob && entryFor(shared, item.mob);
    if (!entry) return item;
    if (entry.disabled) return { ...item, route: null, sharedDisabled: { by: entry.by, note: entry.note } };
    return { ...item, route: { route: { name: item.mob.name, path: '', command: entry.command }, exact: true, shared: { by: entry.by, note: entry.note } } };
  };
  return { ...reply, items: reply.items.map(item => (item.candidates ? { ...item, candidates: item.candidates.map(apply) } : apply(item))) };
}

globalThis.CatworldSharedData = { parseStrength, applySharedMobs, DEFAULT_SOURCES, MAX_SEGMENT, MAX_ROWS, ALLOWED_VERBS, SHEET_LABELS, describeSheet, describeSheetParts, describeRejectedUrl, reportEntries, reportLines, checkCommand, checkUrl, parseCsv, parseTime, buildMobRoutes, buildRiddleSteps, overlayReply };
})();

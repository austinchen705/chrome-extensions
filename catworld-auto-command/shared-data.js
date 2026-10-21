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
  return { rows, total, overflow: total - rows.length, overflowFrom };
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

// 怪物路線分頁：怪物名稱 | 位置（選填） | 指令 | 備註 | 更新者 | 更新時間。
// 鍵是「名稱」或「名稱|位置」（位置有填才帶）：同名的怪常在不同地方，位置有填就只管那個地方的怪。指令寫「停用」代表這隻怪不要路線。
// 回 { ok, routes: { 鍵: { command, by, note, at, disabled? } }, report: { rows, used, dropped: [{row, reason}], unmatched: [{row, name, location?}] } }。
// 同一個鍵多列取更新時間最新的；在怪物表找不到的名稱（或那個名稱沒有在那個位置）照樣保留（也許是資料還沒收錄），只列在 unmatched
function buildMobRoutes(csvText, mobs) {
  const customKey = globalThis.CatworldZapMobs.customKey;
  const sheet = readSheet(csvText, ['怪物名稱', '指令']);
  if (sheet.error) return { ok: false, error: sheet.error };
  const known = new Set();
  (mobs ?? []).forEach(mob => {
    known.add(customKey(mob.name));
    mobPlaces(mob).forEach(place => known.add(`${customKey(mob.name)}|${place}`));
  });
  const best = new Map();
  const report = newReport(sheet);
  sheet.rows.forEach(({ row, cell }) => {
    const name = cell('怪物名稱');
    if (!name) return report.dropped.push({ row, reason: '怪物名稱是空的' });
    const made = commandEntry(cell);
    if (!made.entry) return report.dropped.push({ row, reason: made.reason });
    const location = cell('位置');
    const key = location ? `${customKey(name)}|${customKey(location)}` : customKey(name);
    const old = best.get(key);
    if (!old || made.rank >= old.rank) best.set(key, { rank: made.rank, row, name, location, entry: made.entry });
  });
  const routes = {};
  best.forEach(({ row, name, location, entry }, key) => {
    routes[key] = entry;
    if (known.has(key)) return;
    const unmatched = location ? { row, name, location, reason: known.has(customKey(name)) ? `這個怪物沒有在「${location}」` : '資料裡沒有這個怪物' } : { row, name, reason: '資料裡沒有這個怪物' };
    report.unmatched.push(unmatched);
  });
  report.used = best.size;
  report.unmatched.sort((a, b) => a.row - b.row);
  return { ok: true, routes, report };
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

// 設定頁用：報告變成一行一行的文字（被丟掉的、對不到的、超過上限沒讀的），最多 max 行，其餘寫「還有 N 筆」
function reportLines(report, max = 30) {
  if (!report) return [];
  const label = item => `${item.name}${item.location ? `（${item.location}）` : ''}${item.step === undefined ? '' : ` 第 ${item.step} 步`}`;
  const lines = [
    ...(report.dropped ?? []).map(item => ({ row: item.row, text: `第 ${item.row} 列：丟掉（${item.reason}）` })),
    ...(report.unmatched ?? []).map(item => ({ row: item.row, text: `第 ${item.row} 列：${label(item)}　${item.reason}` })),
  ].sort((a, b) => a.row - b.row).map(line => line.text);
  const shown = lines.length > max ? [...lines.slice(0, max), `…還有 ${lines.length - max} 筆沒有顯示`] : lines;
  // 超過上限沒讀的提示一定要看得到，不能被長清單截掉
  if (report.overflow > 0) shown.push(`第 ${report.overflowFrom} 列以後共 ${report.overflow} 列超過上限（${MAX_ROWS} 列）沒有讀`);
  return shown;
}

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
function describeSheet(kind, url, entry, timeText, enabled = true) {
  if (!url) return `${SHEET_LABELS[kind].title}：尚未設定`;
  const text = describeFetched(kind, url, entry, timeText, enabled);
  // 沒有 gid 的連結讀到的是試算表的第一個分頁，貼到第二個分頁的欄位會讀錯；連結本身仍然收（單一分頁的表沒有問題）
  return enabled && lacksGid(url) ? `${text}\n注意：這條連結沒有 gid，讀到的是試算表的第一個分頁（發布時要選那個分頁，連結才會有 gid）` : text;
}
function describeFetched(kind, url, entry, timeText, enabled) {
  const { title, used, unmatched } = SHEET_LABELS[kind];
  // 怪物查詢與解謎都關著時 background 不抓，上次的結果已經沒有意義，不能繼續顯示得像現在還在用
  if (!enabled) return `${title}：怪物查詢與解謎都關著，不會抓取`;
  if (!entry) return `${title}：尚未抓取（怪物查詢或解謎要開著；開著的話查一次，或按「立即更新」）`;
  const report = entry.report;
  const rows = report?.overflow > 0 ? `共 ${report.rows} 列（其中 ${report.overflow} 列超過上限沒有讀）` : `共 ${report?.rows} 列`;
  const ok = entry.at && report
    ? `上次更新 ${timeText(entry.at)}：${rows}，生效 ${report.used} ${used}，丟掉 ${report.dropped.length} 列，對不到${unmatched} ${report.unmatched.length} 筆`
    : '沒有可用的資料';
  return entry.error ? `${title}：更新失敗（${timeText(entry.error.at)}）：${entry.error.reason}\n目前使用：${ok}` : `${title}：${ok}`;
}

// 貼的連結格式不對時：沒有存進去，原本存的連結（如果有）照常使用，要說清楚
function describeRejectedUrl(kind, error, hasStored) {
  return `${SHEET_LABELS[kind].title}：${error}（沒有儲存${hasStored ? '，目前仍使用原本的連結' : ''}）`;
}

// background 用：把共用層疊在 ZAP_LOOKUP／ZAP_SUITABLE 的回覆上（個人層在面板那邊再蓋過去）。
// 有共用路線的怪，路線換成共用的並帶 shared: { by, note } 給面板標示；共用寫「停用」的怪路線變 null、帶 sharedDisabled: { by, note }；其餘原樣。
// 有填位置的列先比（怪的位置整串或其中一個地點相符），沒有才用沒填位置的列。不改動輸入
function overlayReply(reply, shared) {
  if (!reply?.ok || !shared || !Object.keys(shared).length) return reply;
  const customKey = globalThis.CatworldZapMobs.customKey;
  const find = mob => {
    const nameKey = customKey(mob.name);
    const hit = mobPlaces(mob).find(place => shared[`${nameKey}|${place}`]);
    return hit ? shared[`${nameKey}|${hit}`] : shared[nameKey];
  };
  const apply = item => {
    const entry = item?.mob && find(item.mob);
    if (!entry) return item;
    if (entry.disabled) return { ...item, route: null, sharedDisabled: { by: entry.by, note: entry.note } };
    return { ...item, route: { route: { name: item.mob.name, path: '', command: entry.command }, exact: true, shared: { by: entry.by, note: entry.note } } };
  };
  return { ...reply, items: reply.items.map(item => (item.candidates ? { ...item, candidates: item.candidates.map(apply) } : apply(item))) };
}

globalThis.CatworldSharedData = { DEFAULT_SOURCES, MAX_SEGMENT, MAX_ROWS, ALLOWED_VERBS, SHEET_LABELS, describeSheet, describeRejectedUrl, reportLines, checkCommand, checkUrl, parseCsv, parseTime, buildMobRoutes, buildRiddleSteps, overlayReply };
})();

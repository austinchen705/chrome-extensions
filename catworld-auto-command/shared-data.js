// 共用資料：把 Google 試算表「發布到網路」的 CSV 變成共用層（怪物路線），不碰 DOM、不碰 chrome.*，background、設定頁、測試共用。
// 共用層介於個人層（chrome.storage.local.mobRoutes）與內建資料之間：個人 > 共用 > 內建。
// 試算表由一群互信的玩家一起填，所以共用來的指令只收白名單動詞（走路與互動類），不合的整列丟掉並記在報告裡。
// 鍵與個人層是同一個函式（CatworldZapMobs.customKey），不然個人層蓋不掉共用層。
(() => {
if (globalThis.CatworldSharedData) return;

const MAX_SEGMENT = 500;
const DISABLE = '停用';
const PUBLISH_HINT = '要用「檔案 → 共用 → 發布到網路」選那個分頁、格式選 CSV，再貼上產生的連結';

// 第一個詞在這份清單裡的指令段才收；走路的方向（n、2e、nu…）與 @等待 另外判斷
const ALLOWED_VERBS = new Set([
  'run', 'push', 'touch', 'enter', 'climb', 'worship', 'open', 'squeeze', 'dis', 'jump', 'walk', 'knife',
  'pay', 'out', 'ask', 'give', 'buy', 'study', 'move', 'see', 'diving',
]);
const DIRECTION = /^\d*(?:ne|nw|se|sw|nu|nd|eu|ed|su|sd|wu|wd|n|s|e|w|u|d)$/;
const WAIT = /^@(?:等待|wait)$/i;

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
// 每一列給 { row（試算表上的列號，標題是第 1 列）, cell(欄名)（沒有這個欄位或空的回空字串）}
function readSheet(csvText, required) {
  const records = parseCsv(csvText);
  if (!records.length) return { error: '內容是空的，不是 CSV' };
  const index = Object.fromEntries(records[0].map((name, i) => [String(name).trim(), i]));
  const missing = required.filter(name => !(name in index));
  if (missing.length) return { error: `缺少欄位「${missing.join('、')}」，第一列要是標題列` };
  const rows = [];
  records.slice(1).forEach((record, i) => {
    if (record.every(value => !String(value).trim())) return;
    rows.push({ row: i + 2, cell: name => (name in index ? String(record[index[name]] ?? '').trim() : '') });
  });
  return { rows };
}

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
  const report = { rows: sheet.rows.length, used: 0, dropped: [], unmatched: [] };
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
    if (!known.has(key)) report.unmatched.push(location ? { row, name, location } : { row, name });
  });
  report.used = best.size;
  report.unmatched.sort((a, b) => a.row - b.row);
  return { ok: true, routes, report };
}

// 解謎指令分頁：謎名稱 | 步驟 | 指令 | 備註 | 更新者 | 更新時間 | 步驟數（選填）。
// 步驟是面板上顯示的序號（步驟檔裡印的 no；共用頁每個謎各自編號，所以只在那個謎自己的那一段裡找），換算成步驟在該頁的 1 起算位置當鍵。
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
  const report = { rows: sheet.rows.length, used: 0, dropped: [], unmatched: [] };
  sheet.rows.forEach(({ row, cell }) => {
    const name = cell('謎名稱');
    const no = Number(cell('步驟'));
    if (!name) return report.dropped.push({ row, reason: '謎名稱是空的' });
    if (!Number.isInteger(no) || no < 1) return report.dropped.push({ row, reason: '步驟要填面板上顯示的序號（正整數）' });
    const made = commandEntry(cell);
    if (!made.entry) return report.dropped.push({ row, reason: made.reason });
    const riddle = byName.get(customKey(name));
    const page = riddle?.page && pages?.[riddle.page];
    const position = page && globalThis.CatworldZapRiddles.sectionSteps(riddle, page).find(index => page.steps[index - 1].no === no);
    if (!position) return report.unmatched.push({ row, name, step: no });
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

globalThis.CatworldSharedData = { MAX_SEGMENT, ALLOWED_VERBS, checkCommand, checkUrl, parseCsv, parseTime, buildMobRoutes, buildRiddleSteps, overlayReply };
})();

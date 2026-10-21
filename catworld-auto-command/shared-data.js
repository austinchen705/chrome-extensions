// 共用資料：把 Google 試算表「發布到網路」的 CSV 變成共用層（怪物路線），不碰 DOM、不碰 chrome.*，background、設定頁、測試共用。
// 共用層介於個人層（chrome.storage.local.mobRoutes）與內建資料之間：個人 > 共用 > 內建。
// 試算表由一群互信的玩家一起填，所以共用來的指令只收白名單動詞（走路與互動類），不合的整列丟掉並記在報告裡。
// 鍵與個人層是同一個函式（CatworldZapMobs.customKey），不然個人層蓋不掉共用層。
(() => {
if (globalThis.CatworldSharedData) return;

const MAX_SEGMENT = 500;
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

// 以標題文字找欄位（順序不拘）；缺必要欄位回 error
function columns(header, required, optional) {
  const index = Object.fromEntries(header.map((name, i) => [String(name).trim(), i]));
  const missing = required.filter(name => !(name in index));
  if (missing.length) return { error: `缺少欄位「${missing.join('、')}」，第一列要是標題列` };
  return { index, optional };
}

// 怪物路線分頁：怪物名稱 | 指令 | 備註 | 更新者 | 更新時間。
// 回 { ok, routes: { 鍵: { command, by, note, at } }, report: { rows, used, dropped: [{row, reason}], unmatched: [{row, name}] } }；
// row 是試算表上的列號（標題是第 1 列）。同一隻怪多列取更新時間最新的（讀不到時間當最舊、同時取後面的）；
// 在怪物表找不到的名稱照樣保留（也許是資料還沒收錄），只列在 unmatched
function buildMobRoutes(csvText, mobs) {
  const customKey = globalThis.CatworldZapMobs.customKey;
  const records = parseCsv(csvText);
  if (!records.length) return { ok: false, error: '內容是空的，不是 CSV' };
  const found = columns(records[0], ['怪物名稱', '指令']);
  if (found.error) return { ok: false, error: found.error };
  const { index } = found;
  const cell = (record, name) => (name in index ? String(record[index[name]] ?? '').trim() : '');
  const known = new Set((mobs ?? []).map(mob => customKey(mob.name)));
  const best = new Map();
  const report = { rows: 0, used: 0, dropped: [], unmatched: [] };
  records.slice(1).forEach((record, i) => {
    if (record.every(value => !String(value).trim())) return;
    const row = i + 2;
    report.rows += 1;
    const name = cell(record, '怪物名稱');
    const command = cell(record, '指令');
    if (!name) return report.dropped.push({ row, reason: '怪物名稱是空的' });
    if (!command) return report.dropped.push({ row, reason: '指令是空的' });
    const check = checkCommand(command);
    if (!check.ok) return report.dropped.push({ row, reason: check.reason });
    const at = parseTime(cell(record, '更新時間'));
    const key = customKey(name);
    const rank = Number.isFinite(at) ? at : -Infinity;
    const old = best.get(key);
    if (!old || rank >= old.rank) {
      best.set(key, { rank, row, name, entry: { command, by: cell(record, '更新者'), note: cell(record, '備註'), at: Number.isFinite(at) ? at : null } });
    }
  });
  const routes = {};
  best.forEach(({ row, name, entry }, key) => {
    routes[key] = entry;
    if (!known.has(key)) report.unmatched.push({ row, name });
  });
  report.used = best.size;
  report.unmatched.sort((a, b) => a.row - b.row);
  return { ok: true, routes, report };
}

// background 用：把共用層疊在 ZAP_LOOKUP／ZAP_SUITABLE 的回覆上（個人層在面板那邊再蓋過去）。
// 有共用路線的怪，路線換成共用的並帶 shared: { by, note } 給面板標示；其餘原樣。不改動輸入
function overlayReply(reply, shared) {
  if (!reply?.ok || !shared || !Object.keys(shared).length) return reply;
  const customKey = globalThis.CatworldZapMobs.customKey;
  const apply = item => {
    const entry = item?.mob && shared[customKey(item.mob.name)];
    if (!entry) return item;
    return { ...item, route: { route: { name: item.mob.name, path: '', command: entry.command }, exact: true, shared: { by: entry.by, note: entry.note } } };
  };
  return { ...reply, items: reply.items.map(item => (item.candidates ? { ...item, candidates: item.candidates.map(apply) } : apply(item))) };
}

globalThis.CatworldSharedData = { MAX_SEGMENT, ALLOWED_VERBS, checkCommand, checkUrl, parseCsv, parseTime, buildMobRoutes, overlayReply };
})();

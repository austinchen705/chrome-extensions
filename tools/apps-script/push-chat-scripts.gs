// 劇本對話：把 tools/push-chat-scripts.js 送來的劇本寫進共用試算表的「劇本」分頁。
// 這是獨立的 Apps Script 專案（在 script.google.com 新增），不綁在試算表上：同一份試算表的驗證碼樣本收集已經有自己的 doPost。
// 部署步驟寫在 docs/data/README.md「推上試算表」。
// 指令碼屬性（專案設定 → 指令碼屬性）：
//   SHEET_ID  試算表網址 /d/ 和 /edit 之間那一段
//   TOKEN     自己取的一長串密碼，推送腳本要帶一樣的；拿到網址又知道密碼的人才寫得進去
// 寫法：同一個劇本ID 已經在分頁裡的整份換掉（舊的列拿掉、新的接在最後），沒有的接在最後；其他列原樣保留。
// 整個分頁的前 6 欄以純文字寫回（週 2026-11-09 才不會被試算表轉成日期，CSV 讀到的格式就會變）。
var TAB = '劇本';
var HEADER = ['劇本ID', '順序', '誰', '台詞', '備註', '週'];
var MAX_ROWS = 2000; // shared-data.js 每個分頁只讀前 2000 列

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: '內容不是 JSON' });
  }
  var props = PropertiesService.getScriptProperties();
  // 屬性值前後的空白（貼上時常多帶）不算；沒設定和對不上分開說，才知道該查哪裡
  var token = String(props.getProperty('TOKEN') || '').trim();
  if (!token) return reply({ ok: false, error: 'Apps Script 沒有指令碼屬性 TOKEN（名稱要全大寫，在「專案設定 → 指令碼屬性」）' });
  if (!body || body.token !== token) return reply({ ok: false, error: '密碼不對：送來的和指令碼屬性 TOKEN 不一樣（屬性值不要加引號）' });
  var problem = rowsProblem(body.rows);
  if (problem) return reply({ ok: false, error: problem });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheetByName(TAB);
    if (!sheet) return reply({ ok: false, error: '試算表裡找不到「' + TAB + '」分頁' });
    var all = sheet.getDataRange().getDisplayValues();
    var empty = all.length === 1 && all[0].every(function (cell) { return cell === ''; });
    if (empty) all = [];
    if (all.length && HEADER.some(function (name, i) { return all[0][i] !== name; })) {
      return reply({ ok: false, error: '「' + TAB + '」分頁第一列不是 ' + HEADER.join(',') + '，不動它' });
    }
    if (all.some(function (row) { return row.slice(HEADER.length).some(function (cell) { return cell !== ''; }); })) {
      return reply({ ok: false, error: '「' + TAB + '」分頁第 ' + (HEADER.length + 1) + ' 欄之後有資料，不動它' });
    }
    var old = all.slice(1).map(function (row) { return row.slice(0, HEADER.length); });
    var merged = merge(old, body.rows);
    var result = { ok: true, dryRun: body.dryRun === true, added: merged.added, replaced: merged.replaced, rows: merged.rows.length };
    if (merged.rows.length > MAX_ROWS) result.warning = '分頁有 ' + merged.rows.length + ' 列，超過 ' + MAX_ROWS + ' 列的部分擴充功能不會讀';
    if (body.dryRun === true) return reply(result);

    sheet.getRange(1, 1, 1, HEADER.length).setNumberFormat('@').setValues([HEADER]);
    if (old.length) sheet.getRange(2, 1, old.length, HEADER.length).clearContent();
    if (merged.rows.length) sheet.getRange(2, 1, merged.rows.length, HEADER.length).setNumberFormat('@').setValues(merged.rows);
    return reply(result);
  } finally {
    lock.releaseLock();
  }
}

// 每列 6 格文字、劇本ID 不空
function rowsProblem(rows) {
  if (!Array.isArray(rows) || !rows.length) return '沒有任何列';
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var shaped = Array.isArray(row) && row.length === HEADER.length && row.every(function (cell) { return typeof cell === 'string'; });
    if (!shaped) return '第 ' + (i + 1) + ' 列不是 ' + HEADER.length + ' 格文字';
    if (!row[0]) return '第 ' + (i + 1) + ' 列沒有劇本ID';
  }
  return '';
}

// 舊的列拿掉這次送來的劇本ID（全空的列也拿掉），新的接在最後
function merge(old, incoming) {
  var ids = {};
  incoming.forEach(function (row) { ids[row[0]] = true; });
  var had = {};
  var kept = old.filter(function (row) {
    if (row.every(function (cell) { return cell === ''; })) return false;
    if (ids[row[0]]) { had[row[0]] = true; return false; }
    return true;
  });
  var order = Object.keys(ids);
  return {
    rows: kept.concat(incoming),
    replaced: order.filter(function (id) { return had[id]; }),
    added: order.filter(function (id) { return !had[id]; })
  };
}

function reply(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

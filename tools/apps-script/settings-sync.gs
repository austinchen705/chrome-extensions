// 設定雲端同步：擴充功能設定頁「雲端同步」把每個遊戲角色的設定與遊戲巨集存在作者的 Google Drive。
// 這是獨立的 Apps Script 專案（在 script.google.com 新增），不綁在驗證碼樣本收集的試算表上：兩邊各有自己的 doPost。
// 部署步驟寫在 README.md「設定雲端同步（作者部署）」，行為與格式寫在 docs/claude/cloud-sync.md。
// 指令碼屬性（專案設定 → 指令碼屬性，選用）：
//   FOLDER_ID  存檔的資料夾 ID；沒設就找／建 My Drive 根目錄的「catworld-settings-sync」並把它的 ID 記在這個屬性（資料夾改名、搬家後仍找得到）
// 請求：POST JSON { action: 'upload' | 'download' | 'info', account, password, payload? }
// 回應一律 200，內容 { ok: true, ... } 或 { ok: false, error: 'bad-password' | 'not-found' | 'too-large' | 'bad-request' | 'server-error' }
//   upload   → { updatedAt, claimed }（claimed 為 true 表示這次建立了角色並認領）
//   download → { payload, updatedAt, exportedWith }
//   info     → { updatedAt, exportedWith }
// 每個角色一個檔 <角色>.json：{ account, salt, hash, updatedAt, exportedWith, payload }；只存 SHA-256(salt + 密碼) 的雜湊，不存密碼。
var FOLDER_NAME = 'catworld-settings-sync';
var MAX_BODY = 1024 * 1024; // 請求本文的字元數上限
var MAX_ACCOUNT = 40;
var MAX_PASSWORD = 200;
var SETTINGS_FORMAT = 'catworld-settings';

function doPost(e) {
  var raw = (e && e.postData && e.postData.contents) || '';
  if (raw.length > MAX_BODY) return reply({ ok: false, error: 'too-large' });
  var body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    return reply({ ok: false, error: 'bad-request' });
  }
  if (!isObject(body)) return reply({ ok: false, error: 'bad-request' });
  var action = body.action;
  if (action !== 'upload' && action !== 'download' && action !== 'info') return reply({ ok: false, error: 'bad-request' });
  var account = normalizeAccount(body.account);
  if (!account) return reply({ ok: false, error: 'bad-request' });
  var password = body.password;
  if (typeof password !== 'string' || password === '' || password.length > MAX_PASSWORD) return reply({ ok: false, error: 'bad-request' });
  if (action === 'upload' && !validPayload(body.payload)) return reply({ ok: false, error: 'bad-request' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return reply(handle(action, account, password, body.payload));
  } catch (err) {
    return reply({ ok: false, error: 'server-error' });
  } finally {
    lock.releaseLock();
  }
}

function handle(action, account, password, payload) {
  var folder = getFolder();
  var name = account + '.json';
  var files = folder.getFilesByName(name);
  var file = files.hasNext() ? files.next() : null;
  var record = file ? JSON.parse(file.getBlob().getDataAsString()) : null;

  if (!record) {
    if (action !== 'upload') return { ok: false, error: 'not-found' };
    var salt = Utilities.getUuid();
    record = { account: account, salt: salt, hash: hashPassword(salt, password) };
    return { ok: true, updatedAt: save(folder, null, record, payload), claimed: true };
  }
  if (record.hash !== hashPassword(record.salt, password)) return { ok: false, error: 'bad-password' };
  if (action === 'upload') return { ok: true, updatedAt: save(folder, file, record, payload), claimed: false };
  if (action === 'download') return { ok: true, payload: record.payload, updatedAt: record.updatedAt, exportedWith: record.exportedWith };
  return { ok: true, updatedAt: record.updatedAt, exportedWith: record.exportedWith };
}

// 寫入整份紀錄，回傳這次的上傳時間（ISO 字串）
function save(folder, file, record, payload) {
  record.updatedAt = new Date().toISOString();
  record.exportedWith = String(payload.settings.exportedWith == null ? '' : payload.settings.exportedWith);
  record.payload = payload;
  var text = JSON.stringify(record);
  if (file) file.setContent(text);
  else folder.createFile(record.account + '.json', text, 'application/json');
  return record.updatedAt;
}

// 去前後空白、英文轉小寫；只收文字（含中文）、數字、底線、連字號，長度 1～40
function normalizeAccount(value) {
  if (typeof value !== 'string') return '';
  var name = value.trim().replace(/[A-Z]/g, function (c) { return c.toLowerCase(); });
  if (name === '' || name.length > MAX_ACCOUNT) return '';
  return /^[\p{L}\p{N}_-]+$/u.test(name) ? name : '';
}

// payload 是物件，settings 是設定備份格式的物件，macros 沒有或是物件
function validPayload(payload) {
  if (!isObject(payload) || !isObject(payload.settings)) return false;
  if (payload.settings.format !== SETTINGS_FORMAT) return false;
  return payload.macros === undefined || isObject(payload.macros);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hashPassword(salt, password) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + password, Utilities.Charset.UTF_8);
  return digest.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

// FOLDER_ID 有值且開得到就用；否則找／建 FOLDER_NAME 並記下 ID
function getFolder() {
  var props = PropertiesService.getScriptProperties();
  var id = String(props.getProperty('FOLDER_ID') || '').trim();
  if (id) {
    try {
      var saved = DriveApp.getFolderById(id);
      if (!saved.isTrashed()) return saved;
    } catch (err) { /* ID 不對或已刪除：往下找／建 */ }
  }
  var found = DriveApp.getRootFolder().getFoldersByName(FOLDER_NAME);
  var folder = found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function reply(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// 設定備份：把擴充功能存在 chrome.storage.local 的設定與累積資料匯出成一份 JSON。
// 純函式，不碰 DOM 與 chrome.*（設定頁載入，content script 不載入）。
// 儲存鍵分三份清單：BLOCKS（可匯出、可挑區塊）、SECRET_KEYS（機密，勾選才匯出）、EXCLUDED_KEYS（一律不匯出：執行狀態、快取、
// 各裝置自己的版面偏好、備份本身）。tests/settings-backup.test.js 會掃原始碼，用到的鍵不在三份清單裡就失敗。
(() => {
const FORMAT = 'catworld-settings';
const VERSION = 1;
const MAX_TEXT = 10 * 1024 * 1024; // 匯入文字最多這麼多字元（儲存空間本來就只有 10 MB）

const BLOCKS = [
  { id: 'timer', label: '定時與隨機', keys: ['settings', 'idleSettings'] },
  { id: 'trigger', label: '觸發', keys: ['triggerGroupSettings', 'triggerSettings'] },
  { id: 'safety', label: '安全與警報', keys: ['stopKeywords', 'persistentAlert', 'autoReward'] },
  { id: 'helpers', label: '輔助功能', keys: ['zapFeatures', 'zapThresholds', 'mainWeapon', 'forceExtras', 'equipmentKeep', 'equipmentScore', 'whisperColor', 'shopMinPrice', 'shopBuyNames', 'shopSkipNames'] },
  { id: 'chat', label: '聊天', keys: ['chatReply', 'chatScript'] },
  { id: 'hunt', label: '巡怪', keys: ['mapHuntSettings', 'mapHuntPicks'] },
  { id: 'sources', label: '共用與網址', keys: ['sharedSources', 'extraGameUrls'] },
  {
    id: 'data',
    label: '累積資料',
    keys: ['mapMonsters', 'shopItems', 'shopNonEquip', 'chatPairs', 'mentorRoutes', 'mobRoutes', 'riddleCommands', 'riddleDone', 'macroNotes', 'wornEquipment', 'mapHuntNpcs', 'mapHuntExits', 'mapVisited', 'forceLevels'],
  },
];
const SECRET_KEYS = ['lineNotify', 'captchaSampleUrl'];
const EXCLUDED_KEYS = [
  'running', 'randomRunning', 'stopReason',
  'sharedCache', 'updateCheck', 'lineLastResult', 'lineThrottle', 'captchaSampleLastResult', 'chatScriptState',
  'popupFolds', 'popupTab', 'panelUi', 'pipSize', 'macroWindowSize', 'statsCollapsed',
  'macroBackup', 'macroNotesWriter', 'settingsBackup',
];

const copy = value => JSON.parse(JSON.stringify(value));
const pick = (store, keys) => Object.fromEntries(keys.filter(key => store[key] !== undefined).map(key => [key, copy(store[key])]));

// blocks：要匯出的區塊 id（沒給＝全部，不認得的忽略）；secrets 為 true 才多帶機密
function exportData(store, { blocks, secrets = false, version = '', now = Date.now() } = {}) {
  const ids = Array.isArray(blocks) ? blocks : BLOCKS.map(block => block.id);
  const data = {
    format: FORMAT,
    version: VERSION,
    exportedWith: String(version),
    exportedAt: new Date(now).toISOString(),
    blocks: {},
  };
  BLOCKS.filter(block => ids.includes(block.id)).forEach(block => { data.blocks[block.id] = pick(store ?? {}, block.keys); });
  if (secrets) data.secrets = pick(store ?? {}, SECRET_KEYS);
  return data;
}
const exportText = (store, options) => JSON.stringify(exportData(store, options), null, 2);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 整份檢查匯入的文字。通過回 { ok: true, data, blocks, hasSecrets }：data 只留認得的區塊與鍵（檔案裡其他的忽略，
// 所以白名單外的鍵絕不會被寫入）；任何一處不合就整份拒絕，回 { ok: false, error } 說明哪裡不對。
function checkImport(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '沒有內容' };
  if (text.length > MAX_TEXT) return { ok: false, error: '檔案太大，不像是設定備份' };
  let file;
  try { file = JSON.parse(text); } catch (e) { return { ok: false, error: `不是有效的 JSON：${e.message}` }; }
  if (!isObject(file)) return { ok: false, error: '內容要是一個物件（{ … }）' };
  if (file.format !== FORMAT) return { ok: false, error: `這不是設定備份檔（format 要是 ${FORMAT}）` };
  if (!Number.isInteger(file.version) || file.version < 1) return { ok: false, error: 'version 要是 1 以上的整數' };
  if (file.version > VERSION) return { ok: false, error: `這份檔案是較新的格式（version ${file.version}），請先更新擴充功能` };
  if (!isObject(file.blocks)) return { ok: false, error: 'blocks 要是物件' };

  const data = { blocks: {}, secrets: null };
  const section = (label, source, keys) => {
    if (!isObject(source)) return `${label}的內容不是物件`;
    const kept = {};
    for (const key of keys) {
      if (!(key in source)) continue;
      if (source[key] === null || source[key] === undefined) return `${label}的 ${key} 是空值`;
      kept[key] = source[key];
    }
    return kept;
  };
  for (const block of BLOCKS) {
    if (!(block.id in file.blocks)) continue;
    const kept = section(`區塊「${block.label}」`, file.blocks[block.id], block.keys);
    if (typeof kept === 'string') return { ok: false, error: kept };
    if (Object.keys(kept).length) data.blocks[block.id] = kept;
  }
  if ('secrets' in file) {
    const kept = section('secrets', file.secrets, SECRET_KEYS);
    if (typeof kept === 'string') return { ok: false, error: kept };
    if (Object.keys(kept).length) data.secrets = kept; // 空的 secrets（匯出時勾了但什麼都沒存）沒有東西可匯入
  }
  const blocks = Object.keys(data.blocks);
  if (!blocks.length && !data.secrets) return { ok: false, error: '檔案裡沒有任何可匯入的區塊' };
  return { ok: true, data, blocks, hasSecrets: Boolean(data.secrets), version: file.version, exportedWith: String(file.exportedWith ?? ''), exportedAt: String(file.exportedAt ?? '') };
}

// 把檢查過的檔案變成寫入計畫：選到的區塊整個取代（檔案有的鍵寫入，區塊裡檔案沒有、現在有的鍵移除），沒選的區塊不動；
// 機密要 secrets 為 true 才處理。只算計畫、不寫儲存；blocks 是真的會處理的區塊 id（檔案裡沒有的區塊不會出現）
function planImport(current, data, { blocks = [], secrets = false } = {}) {
  const set = {};
  const remove = [];
  const replace = (source, keys) => keys.forEach(key => {
    if (source[key] !== undefined) set[key] = copy(source[key]);
    else if (current?.[key] !== undefined) remove.push(key);
  });
  const done = [];
  BLOCKS.filter(block => blocks.includes(block.id) && data.blocks[block.id]).forEach(block => {
    replace(data.blocks[block.id], block.keys);
    done.push(block.id);
  });
  const withSecrets = Boolean(secrets && data.secrets);
  if (withSecrets) replace(data.secrets, SECRET_KEYS);
  return { set, remove, blocks: done, secrets: withSecrets };
}

// 匯入前的備份：這次會被動到的鍵現在的值（values），以及現在沒有這個鍵的（absent，還原時要移除；存成 null 的當作沒有，
// 匯入檢查本來就不收 null）。只存本機、不進匯出
function makeBackup(current, plan, now = Date.now()) {
  const values = {};
  const absent = [];
  [...Object.keys(plan.set), ...plan.remove].forEach(key => {
    if (current?.[key] != null) values[key] = copy(current[key]);
    else absent.push(key);
  });
  return { at: new Date(now).toISOString(), values, absent };
}

// 讀回儲存裡的備份：形狀不對或含沒分類過的鍵就說明原因，呼叫端什麼都不動
function checkBackup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: '備份不是物件' };
  const { values, absent } = value;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { ok: false, error: '備份缺少 values' };
  if (!Array.isArray(absent) || absent.some(key => typeof key !== 'string')) return { ok: false, error: '備份缺少 absent' };
  const known = new Set([...BLOCKS.flatMap(block => block.keys), ...SECRET_KEYS]);
  const stray = [...Object.keys(values), ...absent].find(key => !known.has(key));
  if (stray) return { ok: false, error: `備份裡有不認得的項目：${stray}` };
  if (Object.keys(values).some(key => values[key] === null || absent.includes(key))) return { ok: false, error: '備份內容自相矛盾' };
  return { ok: true, at: String(value.at ?? ''), keys: Object.keys(values).length + absent.length, backup: { values, absent } };
}

// 還原計畫：values 寫回、absent 移除（和匯入同一種 set／remove 形狀）
function planRestore(backup) {
  const set = {};
  Object.keys(backup.values).forEach(key => { set[key] = copy(backup.values[key]); });
  return { set, remove: [...backup.absent] };
}

globalThis.CatworldSettingsBackup = { FORMAT, VERSION, MAX_TEXT, BLOCKS, SECRET_KEYS, EXCLUDED_KEYS, exportData, exportText, checkImport, planImport, makeBackup, checkBackup, planRestore };
})();

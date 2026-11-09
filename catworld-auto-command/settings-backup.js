// 設定備份：把擴充功能存在 chrome.storage.local 的設定與累積資料匯出成一份 JSON。
// 純函式，不碰 DOM 與 chrome.*（設定頁載入，content script 不載入）。
// 儲存鍵分三份清單：BLOCKS（可匯出、可挑區塊）、SECRET_KEYS（機密，勾選才匯出）、EXCLUDED_KEYS（一律不匯出：執行狀態、快取、
// 各裝置自己的版面偏好、備份本身）。tests/settings-backup.test.js 會掃原始碼，用到的鍵不在三份清單裡就失敗。
(() => {
const FORMAT = 'catworld-settings';
const VERSION = 1;

const BLOCKS = [
  { id: 'timer', label: '定時與隨機', keys: ['settings', 'idleSettings'] },
  { id: 'trigger', label: '觸發', keys: ['triggerGroupSettings', 'triggerSettings'] },
  { id: 'safety', label: '安全與警報', keys: ['stopKeywords', 'persistentAlert', 'autoReward'] },
  { id: 'helpers', label: '輔助功能', keys: ['zapFeatures', 'zapThresholds', 'mainWeapon', 'equipmentKeep', 'whisperColor', 'shopMinPrice', 'shopBuyNames', 'shopSkipNames'] },
  { id: 'chat', label: '聊天', keys: ['chatReply', 'chatScript'] },
  { id: 'hunt', label: '巡怪', keys: ['mapHuntSettings', 'mapHuntPicks'] },
  { id: 'sources', label: '共用與網址', keys: ['sharedSources', 'extraGameUrls'] },
  {
    id: 'data',
    label: '累積資料',
    keys: ['mapMonsters', 'shopItems', 'shopNonEquip', 'chatPairs', 'mentorRoutes', 'mobRoutes', 'riddleCommands', 'riddleDone', 'macroNotes', 'wornEquipment', 'mapHuntNpcs', 'mapHuntExits', 'forceLevels'],
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

globalThis.CatworldSettingsBackup = { FORMAT, VERSION, BLOCKS, SECRET_KEYS, EXCLUDED_KEYS, exportData, exportText };
})();

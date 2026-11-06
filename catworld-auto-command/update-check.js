// 新版本提示：定期（一天一次）去 GitHub 讀最新的 manifest.json，版本比目前的新就在設定頁提醒，更新動作還是照 README 的安裝腳本、再到 chrome://extensions 重新載入
// （解壓縮載入的擴充功能 Chrome 不會自動更新，擴充功能也不能改寫自己的檔案）。
// 純函式，不碰 DOM、不碰 chrome.*，background 與設定頁共用；抓取與排程在 background.js，結果存在 chrome.storage.local.updateCheck：
// { checkedAt, latest, error: { at, message, manual } }。自動檢查失敗（沒網路、GitHub 連不上）不吵人，只有手動按「立即檢查」失敗才顯示。
(() => {
if (globalThis.CatworldUpdateCheck) return;

const KEY = 'updateCheck';
const MANIFEST_URL = 'https://raw.githubusercontent.com/austinchen705/chrome-extensions/main/catworld-auto-command/manifest.json';
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000; // 自動檢查失敗後多久內不再試
const COMMANDS = Object.freeze({
  win: 'irm https://raw.githubusercontent.com/austinchen705/chrome-extensions/main/install.ps1 | iex',
  unix: 'curl -fsSL https://raw.githubusercontent.com/austinchen705/chrome-extensions/main/install.sh | sh',
});

const VERSION = /^\d{1,6}(?:\.\d{1,6}){1,3}$/;

// 從 manifest.json 的文字取出版本；不是 JSON、沒有版本、格式不對回 null
function parseVersion(text) {
  try {
    const version = JSON.parse(String(text ?? '')).version;
    return typeof version === 'string' && VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

// a 比 b 新回 1、舊回 -1、一樣回 0；段數不同的缺的當 0；格式不對的當作一樣（不要因為壞資料亂提示）
function compareVersions(a, b) {
  if (!VERSION.test(String(a)) || !VERSION.test(String(b))) return 0;
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// 要不要自動檢查：從沒檢查過、距上次成功超過 INTERVAL_MS；上次失敗的 RETRY_MS 內不再試；時間在未來（時鐘往回調）當作要檢查
function shouldCheck(state, now) {
  const failedAt = Number(state?.error?.at);
  if (Number.isFinite(failedAt) && failedAt <= now && now - failedAt < RETRY_MS) return false;
  const checkedAt = Number(state?.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > now) return true;
  return now - checkedAt >= INTERVAL_MS;
}

// 設定頁顯示的內容：{ level, text, newer }；沒有任何紀錄（還沒檢查過）回 null，自動檢查失敗也回 null（不吵人）；
// 手動檢查失敗是 error 級
function describe(state, current, timeText = String) {
  if (state?.error?.manual === true && (!state.checkedAt || state.error.at >= state.checkedAt)) {
    return { level: 'error', text: `檢查新版本失敗：${state.error.message}`, newer: false };
  }
  if (typeof state?.latest !== 'string' || !VERSION.test(state.latest)) return null;
  if (compareVersions(state.latest, current) > 0) {
    return { level: 'warn', text: `有新版本 v${state.latest}（目前 v${current}）。更新方式：執行下面的指令，再到 chrome://extensions 按「重新載入」、重新整理遊戲分頁。`, newer: true };
  }
  return { level: 'info', text: `已是最新版本（v${current}），最後檢查：${timeText(state.checkedAt)}`, newer: false };
}

globalThis.CatworldUpdateCheck = { KEY, MANIFEST_URL, INTERVAL_MS, RETRY_MS, COMMANDS, parseVersion, compareVersions, shouldCheck, describe };
})();

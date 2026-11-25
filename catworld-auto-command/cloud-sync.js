// 雲端同步（設定頁專用，只有 popup.html 載入）：和作者部署的 Apps Script（tools/apps-script/settings-sync.gs）說話的純函式，
// 不碰 DOM 與 chrome.*。請求與回應格式見 docs/claude/cloud-sync.md。
(() => {
// 作者部署的網頁應用程式網址（tools/apps-script/settings-sync.gs）。空的＝還沒設定：設定頁顯示錯誤、不送任何請求；設定頁「進階」欄位填了就以欄位為準
const DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbxa5bpxnTkJLbI0yuTI1Ilw1mtQQALEDTQTb2qWtaS9z5oqYfXXNmrRXyn18_wWBlng/exec';
// 別的主機 manifest 沒有權限打，會悄悄失敗
const URL_PREFIX = 'https://script.google.com/macros/';
const TIMEOUT_MS = 30000;

// 遊戲分頁標題是「角色名 - …」；讀不到回空字串
const characterFromTitle = title => (/ - /.test(String(title ?? '')) ? String(title).split(' - ')[0].trim() : '');

const pad = value => String(value).padStart(2, '0');
function formatTime(value) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '不明';
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

// 送一個請求，一律回 { ok: true, ...伺服器的回應 } 或 { ok: false, error, detail? }：伺服器的錯誤代碼原樣帶回，
// 本機的失敗用 no-url、bad-url、network、timeout、http、bad-reply。用 text/plain：JSON 會觸發 CORS 預檢，Apps Script 不回應預檢
async function call(fetchImpl, { url, action, account, password, payload }) {
  const target = String(url ?? '').trim();
  if (!target) return { ok: false, error: 'no-url' };
  if (!target.startsWith(URL_PREFIX)) return { ok: false, error: 'bad-url' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(target, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, account, password, ...(payload === undefined ? {} : { payload }) }),
      signal: controller.signal,
    });
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : 'network', detail: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return { ok: false, error: 'http', detail: String(response.status) };
  let reply;
  try { reply = await response.json(); } catch { return { ok: false, error: 'bad-reply' }; }
  if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') return { ok: false, error: 'bad-reply' };
  return reply.ok ? reply : { ok: false, error: String(reply.error ?? 'bad-reply') };
}

// 失敗結果的說明文字（呼叫端一律用紅色顯示）
function errorText(result, account = '') {
  switch (result.error) {
    case 'no-url': return '雲端同步網址還沒設定';
    case 'bad-url': return `雲端同步網址要以 ${URL_PREFIX} 開頭（Apps Script 部署成網頁應用程式的網址）`;
    case 'bad-password': return '同步密碼不對';
    case 'not-found': return `雲端還沒有 ${account} 的設定`;
    case 'too-large': return '設定太大，雲端放不下（上限 1 MB），請取消勾選一些區塊再試';
    case 'bad-request': return '角色名稱或同步密碼的格式不對（角色只能用文字、數字、_、-，最多 40 字；密碼 1～200 字）';
    case 'server-error': return '雲端伺服器出錯了，請稍後再試';
    case 'network': return `連不上雲端：${result.detail || '網路失敗'}`;
    case 'timeout': return `雲端沒有回應（逾時 ${TIMEOUT_MS / 1000} 秒）`;
    case 'http': return `雲端回了 HTTP ${result.detail}，不是預期的回應`;
    case 'bad-reply': return '雲端的回應看不懂（不是 JSON），網址可能不對';
    default: return `雲端回了不認得的錯誤：${result.error}`;
  }
}

globalThis.CatworldCloudSync = { DEFAULT_URL, URL_PREFIX, TIMEOUT_MS, characterFromTitle, formatTime, call, errorText };
})();

// 額外的遊戲網址：臨時讓面板出現在別的網站上（例如 ngrok 的臨時網址）。純函式，不碰 DOM 與 chrome.*，
// background（註冊 content script）、設定頁（新增、移除、判斷分頁）與測試共用。
// 清單存在 chrome.storage.local.extraGameUrls：match pattern 的陣列，每一項是「整個主機」（https://主機/*）。
// Chrome 的 match pattern 不認 port，所以貼的網址帶 port 時會把 port 拿掉（同一主機的所有 port 都算）。
(() => {
if (globalThis.CatworldGameUrls) return;

const BUILT_IN_HOST = 'catworld.muds.tw';
const BUILT_IN_PATTERN = `https://${BUILT_IN_HOST}/web*`;
const MAX_EXTRA = 5;
// 這個功能自己產生的樣子才相信：http 或 https、一個沒有萬用字元的主機、整個網站。讀回來的值不合格式就不用，
// 免得儲存裡被放進 <all_urls> 之類的值就讓程式在每個網頁上執行
const EXTRA_PATTERN = /^https?:\/\/[a-z0-9._-]+\/\*$/;

const fail = error => ({ ok: false, error });
const isExtraPattern = value => typeof value === 'string' && EXTRA_PATTERN.test(value);

// 使用者貼的網址 → 整個主機的 match pattern
function parse(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return fail('網址是空的');
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return fail('看不懂這個網址，要完整寫成 https://…（含 https://）');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('只能加 http 或 https 的網站');
  if (url.username || url.password) return fail('網址裡不能帶帳號或密碼');
  if (url.hostname.includes('*')) return fail('不能用 * 萬用字元，請寫完整的網址');
  if (url.hostname.startsWith('[')) return fail('不支援 IPv6 位址');
  if (url.protocol === 'https:' && url.hostname === BUILT_IN_HOST) return fail('這個網站已經內建，不用另外加');
  return { ok: true, pattern: `${url.protocol}//${url.hostname}/*` };
}

function add(list, pattern) {
  if (!isExtraPattern(pattern)) return fail('不是這個功能能收的網址格式');
  if (list.includes(pattern)) return fail('已經在清單裡了');
  if (list.length >= MAX_EXTRA) return fail(`最多只能加 ${MAX_EXTRA} 個網站，請先移除不用的`);
  return { ok: true, list: [...list, pattern] };
}

const remove = (list, pattern) => list.filter(item => item !== pattern);

// 分頁網址算不算遊戲頁：內建的遊戲（https://catworld.muds.tw/web…），或清單裡的網站（同一主機、同一個 http／https，port 不看，路徑不看）
function isGameUrl(url, extras = []) {
  let tab;
  try {
    tab = new URL(url);
  } catch {
    return false;
  }
  if (tab.protocol === 'https:' && tab.hostname === BUILT_IN_HOST && tab.pathname.startsWith('/web')) return true;
  return extras.some(pattern => {
    if (!isExtraPattern(pattern)) return false;
    const site = new URL(pattern.replace(/\*$/, ''));
    return site.protocol === tab.protocol && site.hostname === tab.hostname;
  });
}

// 儲存裡讀回來的清單：只留格式合格的
const extraPatterns = extras => (Array.isArray(extras) ? extras.filter(isExtraPattern) : []);

// chrome.tabs.query 找遊戲分頁用的網址樣式：內建的加上清單裡的
const tabPatterns = extras => [BUILT_IN_PATTERN, ...extraPatterns(extras)];

globalThis.CatworldGameUrls = { MAX_EXTRA, parse, add, remove, isExtraPattern, extraPatterns, isGameUrl, tabPatterns };
})();

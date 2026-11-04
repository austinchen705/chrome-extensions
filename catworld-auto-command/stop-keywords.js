// 停止關鍵字：遊戲輸出（#content 裡新出現的文字）含有清單裡任何一個詞，就停掉所有功能並警報一次。
// 純函式，不碰 DOM 與 chrome.*（content script 與設定頁共用）；設定存在 chrome.storage.local.stopKeywords：
// { enabled, words }，words 是用「、」「,」「;」或換行分隔的字串。缺值＝開著、清單是 jrealm。
// 遊戲輸出常分成好幾批到、也會在行中間換行，所以和驗證碼偵測（captcha-art.js 的 createWatcher）一樣，不能只看單一批：
// createWatcher 把最近 WINDOW_MS 內的新增文字接在一起比對，而且比對時忽略所有空白與換行（詞跨行、跨批、中間夾換行都命中）。
(() => {
const KEY = 'stopKeywords';
const DEFAULT_WORDS = 'jrealm';
const MAX_WORDS = 50;
const MAX_LENGTH = 100;
const WINDOW_MS = 5000; // 接在一起比對的時間範圍
const MAX_CHARS = 4000; // 接在一起的最大字數（只留最後這麼多）

// 詞的清單：去空白、去重（不分大小寫）、過長的丟掉、最多 MAX_WORDS 個
function list(words) {
  const seen = new Set();
  const out = [];
  String(words ?? '').split(/[、,，;；\n]+/).forEach(raw => {
    const word = raw.trim();
    if (!word || word.length > MAX_LENGTH || seen.has(word.toLowerCase()) || out.length >= MAX_WORDS) return;
    seen.add(word.toLowerCase());
    out.push(word);
  });
  return out;
}

// 儲存的設定可能缺欄位或被改壞：缺值＝開、預設清單；清單被清空就是真的沒有詞（開著也不會命中）
function normalize(raw) {
  return {
    enabled: raw?.enabled !== false,
    words: typeof raw?.words === 'string' ? raw.words : DEFAULT_WORDS,
  };
}

// 比對用的樣子：不分大小寫、去掉所有空白與換行
const squash = text => String(text ?? '').toLowerCase().replace(/\s+/g, '');
// 以「>」開頭的行是自己打的指令的回聲，不算（自己打字不能讓功能停下來）
const withoutEchoes = text => String(text ?? '').split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join('\n');

// 一段文字裡第一個命中的詞（清單裡的原樣）；沒命中回 null
function find(text, words) {
  const body = squash(withoutEchoes(text));
  if (!body) return null;
  return list(words).find(word => squash(word) && body.includes(squash(word))) ?? null;
}

// 接起最近幾秒的新增文字再比對；命中後清空（同一段文字不會一直命中）。now 由呼叫端注入，方便測試
function createWatcher({ now = () => Date.now(), windowMs = WINDOW_MS, maxChars = MAX_CHARS } = {}) {
  let pieces = [];
  const reset = () => { pieces = []; };
  function feed(text, words) {
    const at = now();
    const clean = withoutEchoes(text);
    if (clean.trim()) pieces.push({ at, text: clean });
    pieces = pieces.filter(piece => at - piece.at <= windowMs);
    const joined = squash(pieces.map(piece => piece.text).join('\n')).slice(-maxChars);
    if (!joined) return null;
    const hit = list(words).find(word => squash(word) && joined.includes(squash(word)));
    if (hit) reset();
    return hit ?? null;
  }
  return { feed, reset };
}

globalThis.CatworldStopKeywords = { KEY, DEFAULT_WORDS, MAX_WORDS, MAX_LENGTH, WINDOW_MS, list, normalize, find, createWatcher };
})();

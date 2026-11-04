// 停止關鍵字：遊戲輸出（#content 裡新出現的文字）含有清單裡任何一個詞，就停掉所有功能並警報一次。
// 純函式，不碰 DOM 與 chrome.*（content script 與設定頁共用）；設定存在 chrome.storage.local.stopKeywords：
// { enabled, words }，words 是用「、」「,」「;」或換行分隔的字串。缺值＝開著、清單是 jrealm。
(() => {
const KEY = 'stopKeywords';
const DEFAULT_WORDS = 'jrealm';
const MAX_WORDS = 50;
const MAX_LENGTH = 100;

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

// 新出現的文字裡第一個命中的詞（不分大小寫，子字串）；沒命中回 null。
// 以「>」開頭的行是自己打的指令的回聲，不算（自己打字不能讓功能停下來）
function find(text, words) {
  const body = String(text ?? '').split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join('\n').toLowerCase();
  if (!body) return null;
  return list(words).find(word => body.includes(word.toLowerCase())) ?? null;
}

globalThis.CatworldStopKeywords = { KEY, DEFAULT_WORDS, MAX_WORDS, MAX_LENGTH, list, normalize, find };
})();

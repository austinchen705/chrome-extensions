// 驗證碼圖形的偵測：不依賴提示文字，只看遊戲輸出裡新增的內容長得像不像圖。content script 與測試共用，不碰 chrome.*。
// 遊戲輸出常分成好幾批新增文字到達（一張圖可能被切成一行一批、幾行一批），所以 createWatcher 把最近幾秒的新增文字接在一起判斷，
// 偵測規則本身（looksLikeAsciiArt、looksLikeNoiseCaptcha）都是看「連續好幾行」，只看單一批會漏掉被切開的圖。
(() => {
if (globalThis.CatworldCaptchaArt) return;

const BLOCK = '█';
const NOISE_MARK = '\u0001';
// 新增節點轉成可逐行判斷的文字：以背景色（B1~B7）空白 span 拼成的圖沒有可見字元，
// 改用實心方塊代表，才能和 @ $ 等符號圖用同一套規則偵測
function artText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (node.tagName === 'BR') return '\n';
  const text = node.textContent || '';
  if (!node.children.length && /\bB\d\b/.test(node.getAttribute('class') || '') && /^[ \n]+$/.test(text) && text.includes(' ')) {
    return text.replace(/ /g, BLOCK);
  }
  if (!node.children.length && /\bB\d\b/.test(node.getAttribute('class') || '') && text.trim()) {
    return NOISE_MARK + text;
  }
  const inner = Array.from(node.childNodes, artText).join('');
  return /^(DIV|P|PRE)$/.test(node.tagName) && !inner.endsWith('\n') ? `${inner}\n` : inner;
}
// 驗證碼是多行「只含同一種符號（@ $ # █ 等）與空白」的圖，不依賴提示文字；
// 圖可能與前一段回覆接在同一批文字，所以逐行找連續的同符號行（空白行不中斷）
function looksLikeAsciiArt(text) {
  let run = 0;
  let symbol = '';
  for (const line of (text || '').split('\n')) {
    const chars = line.replace(/\s/g, '');
    if (!chars) continue;
    const match = new RegExp(`^([@$#%&*${BLOCK}])\\1*$`).exec(chars);
    if (!match) { run = 0; continue; }
    run = match[1] === symbol ? run + 1 : 1;
    symbol = match[1];
    if (run >= 5) return true;
  }
  return false;
}
// 另一種驗證碼：一大塊隨機英數字亂碼，其中少數字元以背景色（B1 等）標出，沒有提示文字；
// 連續 8 行以上只含英數字與空白的長行，且帶背景色標記的字元至少 8 個
// （背景色 span 內容是空白時已轉成 █，同樣算標記）
function looksLikeNoiseCaptcha(text) {
  let run = 0;
  let marks = 0;
  for (const line of (text || '').split('\n')) {
    if (!line.trim()) continue;
    if (line.length >= 30 && new RegExp(`^[A-Za-z0-9 ${NOISE_MARK}${BLOCK}]+$`).test(line)) {
      run += 1;
      marks += (line.match(new RegExp(`[${NOISE_MARK}${BLOCK}]`, 'g')) || []).length;
      if (run >= 8 && marks >= 8) return true;
    } else {
      run = 0;
      marks = 0;
    }
  }
  return false;
}

// 最近 windowMs 內新增的文字接在一起（最多 maxLines 行）交給上面兩個偵測；偵測到就清空，同一張圖剩下的幾行不會再觸發一次。
// 批次之間隔太久的不接，不然一般輸出裡零星的幾行會被拼成圖
function createWatcher({ now = Date.now, windowMs = 5000, maxLines = 120 } = {}) {
  let pieces = [];
  return {
    feed(text) {
      const at = now();
      pieces = pieces.filter(piece => at - piece.at <= windowMs);
      pieces.push({ at, text });
      const lines = pieces.map(piece => piece.text).join('').split('\n');
      const joined = lines.slice(-maxLines).join('\n');
      const hit = looksLikeAsciiArt(joined) || looksLikeNoiseCaptcha(joined);
      if (hit) pieces = [];
      return hit;
    },
    clear() { pieces = []; },
  };
}

globalThis.CatworldCaptchaArt = { BLOCK, NOISE_MARK, artText, looksLikeAsciiArt, looksLikeNoiseCaptcha, createWatcher };
})();

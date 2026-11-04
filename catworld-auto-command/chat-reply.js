// 聊天回覆的資料集：遊戲輸出裡別人對我說的話（「[P]有氣質回答你：測試」）和我的回覆（「[P]你告訴有氣質：…」或「[P]你回答有氣質：…」）
// 配成一筆「對方說 → 我回」，存在 chrome.storage.local.chatPairs（[{ said, reply, at }]）。
// 輸出分批到、行可能在中間被切開，所以只處理「已經收到換行」的完整行，剩下的留給下一批。
// 公開 say（「[P]你說道：」）、自己打的指令的回聲（> 開頭）不算。純函式，不碰 DOM 與 chrome.*；遊戲頁的觀察器接在 content.js。
(() => {
if (globalThis.CatworldChatReply) return;

const KEY = 'chatPairs';
const MAX_PAIRS = 500;
const PAIR_WINDOW_MS = 2 * 60 * 1000; // 來訊之後多久內的回覆才算「回這句」
const INCOMING = /^\s*\[P\]\s*(.+?)回答你[：:]\s*(.*?)\s*$/;
const OUTGOING = /^\s*\[P\]\s*你(?:告訴|回答)(.+?)[：:]\s*(.*?)\s*$/;

// 一行的意思：{ kind: 'in' | 'out', name, text }；不是私聊、或是回聲（> 開頭）回 null
function parseLine(line) {
  if (/^\s*>/.test(line)) return null;
  const out = OUTGOING.exec(line);
  if (out) return { kind: 'out', name: out[1], text: out[2] };
  const incoming = INCOMING.exec(line);
  return incoming ? { kind: 'in', name: incoming[1], text: incoming[2] } : null;
}

// 回覆文字會被原樣送出或當成巨集：含分號（巨集分隔）的不收
const safeReply = text => text.length > 0 && !text.includes(';') && !text.includes('；');

function createRecorder({ now = () => Date.now() } = {}) {
  let rest = '';
  const waiting = new Map(); // 暱稱 → { text, at }：這個人最後對我說的一句
  function handle(line, pairs) {
    const event = parseLine(line);
    if (!event) return;
    if (event.kind === 'in') {
      if (event.text) waiting.set(event.name, { text: event.text, at: now() });
      else waiting.delete(event.name); // 空的來訊蓋掉這個人之前那句，免得回覆配到更早的話
      return;
    }
    const heard = waiting.get(event.name);
    if (!heard) return;
    if (now() - heard.at > PAIR_WINDOW_MS) { waiting.delete(event.name); return; }
    if (!safeReply(event.text)) return; // 不安全的回覆不收，但來訊還在，之後乾淨的回覆仍然配得上
    waiting.delete(event.name);
    pairs.push({ said: heard.text, reply: event.text, at: now() });
  }
  // 餵進新增的文字，回傳這一批湊成的對話（可能是空陣列）
  function feed(text) {
    const lines = (rest + String(text ?? '')).replace(/\r\n?/g, '\n').split('\n');
    rest = lines.pop();
    const pairs = [];
    lines.forEach(line => handle(line, pairs));
    return pairs;
  }
  return { feed };
}

// 加進已存的清單（回傳新陣列，不改輸入）：同一組 said+reply 不重複，只留最新的 MAX_PAIRS 筆
function addPair(pairs, pair) {
  if (pairs.some(known => known.said === pair.said && known.reply === pair.reply)) return pairs;
  return [...pairs, pair].slice(-MAX_PAIRS);
}

globalThis.CatworldChatReply = { KEY, MAX_PAIRS, PAIR_WINDOW_MS, parseLine, createRecorder, addPair };
})();

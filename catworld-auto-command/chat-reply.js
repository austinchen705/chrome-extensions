// 聊天回覆的資料集：遊戲輸出裡別人對我說的話（「[P]有氣質回答你：測試」）和我的回覆（「[P]你告訴有氣質：…」或「[P]你回答有氣質：…」）
// 配成一筆「對方說 → 我回」，存在 chrome.storage.local.chatPairs（[{ said, reply, at }]）。
// 輸出分批到、行可能在中間被切開，所以只處理「已經收到換行」的完整行，剩下的留給下一批。
// 公開 say（「[P]你說道：」）、自己打的指令的回聲（> 開頭）不算。純函式，不碰 DOM 與 chrome.*；遊戲頁的觀察器接在 content.js。
(() => {
if (globalThis.CatworldChatReply) return;

const KEY = 'chatPairs';
const SETTINGS_KEY = 'chatReply';
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

// 回覆文字會被原樣送出或當成巨集：含分號（巨集分隔）或 @等待 的不收
const safeReply = text => text.length > 0 && !text.includes(';') && !text.includes('；') && !text.includes('@等待');

// onIncoming（選填）：每收到一句別人對我說的話（非空）就呼叫一次，帶 { name, text }
function createRecorder({ now = () => Date.now(), onIncoming = null } = {}) {
  let rest = '';
  const waiting = new Map(); // 暱稱 → { text, at }：這個人最後對我說的一句
  function handle(line, pairs) {
    const event = parseLine(line);
    if (!event) return;
    if (event.kind === 'in') {
      if (event.text) {
        waiting.set(event.name, { text: event.text, at: now() });
        onIncoming?.({ name: event.name, text: event.text });
      }
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

// 自動回覆的設定（chrome.storage.local.chatReply）：預設關；門檻是相似度（0～1）要達到多少才回，預設 0.5，限制在 0.1～1
function normalizeSettings(raw) {
  const threshold = typeof raw?.threshold === 'number' && Number.isFinite(raw.threshold) ? Math.min(1, Math.max(0.1, raw.threshold)) : 0.5;
  return { enabled: raw?.enabled === true, threshold };
}

// 字面相似度：兩段文字去掉標點與空白後，以相鄰兩字（bigram）算 Dice 係數（2×共同 ÷ 兩邊總數，0～1）；只有一個字就拿那一個字比
const squash = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function bigrams(text) {
  const chars = [...squash(text)];
  return chars.length < 2 ? chars : chars.slice(1).map((char, index) => chars[index] + char);
}
function similarity(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.length || !right.length) return 0;
  const counts = new Map();
  left.forEach(gram => counts.set(gram, (counts.get(gram) || 0) + 1));
  let common = 0;
  right.forEach(gram => {
    const unused = counts.get(gram) || 0;
    if (unused > 0) { common += 1; counts.set(gram, unused - 1); }
  });
  return (2 * common) / (left.length + right.length);
}

// 太短（不到兩個字）的來訊不回（自己指令的回聲在 parseLine 就濾掉了）
const worthAnswering = text => [...String(text ?? '').trim()].length >= 2;

// 資料集裡「對方說的話」和 said 最相似的那一筆的回覆（只看回覆安全的）；最高分不到門檻回 null，同分的隨機挑一個
function bestReply(pairs, said, threshold, random = Math.random) {
  const scored = pairs.filter(pair => safeReply(pair.reply)).map(pair => ({ pair, score: similarity(pair.said, said) }));
  const best = Math.max(0, ...scored.map(item => item.score));
  if (!scored.length || best < threshold) return null;
  const top = scored.filter(item => item.score >= best - 1e-9);
  return top[Math.floor(random() * top.length)].pair;
}

// 看到來訊到送出回覆之間隨機等 3～10 秒（毫秒）
const replyDelayMs = (random = Math.random) => 3000 + Math.floor(random() * 7000);

globalThis.CatworldChatReply = { KEY, SETTINGS_KEY, MAX_PAIRS, PAIR_WINDOW_MS, parseLine, createRecorder, addPair, normalizeSettings, similarity, worthAnswering, bestReply, replyDelayMs };
})();

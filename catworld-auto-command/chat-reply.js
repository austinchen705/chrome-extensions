// 聊天回覆的資料集：遊戲輸出裡別人對我說的話（「[P]有氣質回答你：測試」，對方先開口時是「[P]山本由伸(yamamoto)告訴你：你好」）和我的回覆（「[P]你告訴有氣質：…」或「[P]你回答有氣質：…」）
// 配成一筆「對方說 → 我回」，存在 chrome.storage.local.chatPairs（[{ said, reply, at }]）。
// 輸出分批到、行可能在中間被切開，所以只處理「已經收到換行」的完整行，剩下的留給下一批。
// 公開 say（「[P]你說道：」）、自己打的指令的回聲（> 開頭）不算。純函式，不碰 DOM 與 chrome.*；遊戲頁的觀察器接在 content.js。
(() => {
if (globalThis.CatworldChatReply) return;

const KEY = 'chatPairs';
const SETTINGS_KEY = 'chatReply';
const MAX_PAIRS = 500;
const PAIR_WINDOW_MS = 2 * 60 * 1000; // 來訊之後多久內的回覆才算「回這句」
const INCOMING = /^\s*\[P\]\s*(.+?)(?:回答|告訴)你[：:]\s*(.*?)\s*$/;
const OUTGOING = /^\s*\[P\]\s*你(?:告訴|回答)(.+?)[：:]\s*(.*?)\s*$/;

// 一行的意思：{ kind: 'in' | 'out', name, text }；不是私聊、或是回聲（> 開頭）回 null。
// 例外：遊戲閒置時新輸出前面會帶提示符「> 」（實際輸出：「> [P]山本由伸回答你：w r u」），所以來訊的開頭允許有一個「> 」；
// 回聲是「> 指令」，不會長成 [P]… 的樣子，所以這樣不會把回聲當成來訊
function parseLine(line) {
  if (/^\s*>/.test(line)) {
    const prompted = INCOMING.exec(line.replace(/^\s*>\s*(?=\[P\])/, ''));
    return prompted ? { kind: 'in', name: prompted[1], text: prompted[2] } : null;
  }
  const out = OUTGOING.exec(line);
  if (out) return { kind: 'out', name: out[1], text: out[2] };
  const incoming = INCOMING.exec(line);
  return incoming ? { kind: 'in', name: incoming[1], text: incoming[2] } : null;
}

// 回覆文字會被原樣送出或當成巨集：含分號（巨集分隔）或 @等待 的不收
const safeReply = text => text.length > 0 && !text.includes(';') && !text.includes('；') && !text.includes('@等待');

// onIncoming（選填）：每收到一句別人對我說的話（非空）就呼叫一次，帶 { name, text }；
// isOwn（選填）：我的回覆行如果是工具自己送的（isOwn(文字) 為真）就不記成我的回覆，這個人那句來訊也算回過了
function createRecorder({ now = () => Date.now(), onIncoming = null, isOwn = null } = {}) {
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
    if (isOwn?.(event.text)) { waiting.delete(event.name); return; }
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
  // 一段時間沒有新輸出時呼叫：留著的最後一行（沒收到換行）當作完整的一行處理，不然最後一句私聊會一直等到下一批輸出才出現
  function flush() {
    const line = rest;
    rest = '';
    const pairs = [];
    if (line.trim()) handle(line, pairs);
    return pairs;
  }
  return { feed, flush };
}

// 加進已存的清單（回傳新陣列，不改輸入）：同一組 said+reply 不重複，只留最新的 MAX_PAIRS 筆
function addPair(pairs, pair) {
  if (pairs.some(known => known.said === pair.said && known.reply === pair.reply)) return pairs;
  return [...pairs, pair].slice(-MAX_PAIRS);
}

// 自動回覆的設定（chrome.storage.local.chatReply）：預設關；門檻是相似度（0～1）要達到多少才回，預設 0.5，限制在 0.1～1；
// cooldownSec 同一個人的冷卻秒數（預設 60，0～3600）、perHour 全部每小時最多回幾則（預設 10，1～100）
const bounded = (value, min, max, fallback) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
function normalizeSettings(raw) {
  return {
    enabled: raw?.enabled === true,
    threshold: bounded(raw?.threshold, 0.1, 1, 0.5),
    cooldownSec: bounded(raw?.cooldownSec, 0, 3600, 60),
    perHour: bounded(raw?.perHour, 1, 100, 10),
  };
}

// 匯出／匯入文字：一行一筆「對方說 <Tab> 我回」，舊的在前（匯入後順序不變）
const flat = text => String(text).replace(/\s+/g, ' ').trim();
const exportText = pairs => pairs.map(pair => flat(pair.said) + '\t' + flat(pair.reply)).join('\n');
// 檢查匯入文字：整份每一行都合格才回 { ok: true, pairs }，否則回 { ok: false, error }（說明第幾行哪裡不對）；空行略過
function parseImport(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const pairs = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const parts = lines[index].split('\t');
    const where = '第 ' + (index + 1) + ' 行';
    if (parts.length !== 2) return { ok: false, error: where + '要剛好有一個 Tab，分成「對方說」和「我回」兩段' };
    const said = flat(parts[0]);
    const reply = flat(parts[1]);
    if (!said) return { ok: false, error: where + '「對方說」是空的' };
    if (!reply) return { ok: false, error: where + '「我回」是空的' };
    if (!safeReply(reply)) return { ok: false, error: where + '的回覆含分號或 @等待，會被當成巨集，不收' };
    pairs.push({ said, reply });
  }
  if (!pairs.length) return { ok: false, error: '沒有可匯入的內容' };
  return { ok: true, pairs };
}
// 把匯入的接在已存的後面（算最新的）：同一組 said+reply 不重複，總數超過 MAX_PAIRS 丟最舊的；回傳 { pairs, added, duplicate, dropped, trimmed }（dropped＝被擠掉的舊資料筆數，trimmed＝匯入的比上限還多、匯入裡最舊的被丟掉幾筆，added 不含 trimmed）
function mergeImported(existing, imported, at) {
  const keyOf = pair => JSON.stringify([pair.said, pair.reply]);
  const known = new Set(existing.map(keyOf));
  const fresh = [];
  let duplicate = 0;
  imported.forEach((pair, index) => {
    if (known.has(keyOf(pair))) { duplicate += 1; return; }
    known.add(keyOf(pair));
    fresh.push({ said: pair.said, reply: pair.reply, at: at + index });
  });
  const all = [...existing, ...fresh];
  const trimmed = Math.max(0, fresh.length - MAX_PAIRS);
  return { pairs: all.slice(-MAX_PAIRS), added: fresh.length - trimmed, duplicate, dropped: Math.min(existing.length, Math.max(0, all.length - MAX_PAIRS)), trimmed };
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

const REPEAT_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const OWN_MS = 5 * 60 * 1000; // 工具送出的回覆，遊戲回印「你回答…」最多等這麼久
// 限流：同一個人 cooldownSec 秒內只回一次、同一個人說同一句話 REPEAT_MS 內不再回、全部每小時最多 perHour 則。
// take 預約（回票）、confirm 送出時改從那一刻算、refund 沒送出時還回去；
// noteSent／isOwn：記下工具自己送出的回覆文字，遊戲回印同一句時 isOwn 認得（去標點空白後比對、只認一次、超過 OWN_MS 就當是自己手打的）
function createLimiter({ now = () => Date.now() } = {}) {
  const lastByName = new Map();
  const seen = new Map();
  let reserved = []; // 這一小時內預約的回覆（{ at }），每筆也是 take 回傳的票
  let own = [];
  // 檢查並預約：可以回就記下（同一個人緊接著來的第二句才擋得住）並回票，不行回 null（被拒絕的不占額度）
  function take(name, text, { cooldownSec, perHour }) {
    const at = now();
    reserved = reserved.filter(item => at - item.at < HOUR_MS);
    [lastByName, seen].forEach(map => map.forEach((time, key) => { if (at - time >= HOUR_MS) map.delete(key); }));
    const key = `${name}\n${squash(text)}`;
    if (reserved.length >= perHour) return null;
    if (lastByName.has(name) && at - lastByName.get(name) < cooldownSec * 1000) return null;
    if (seen.has(key) && at - seen.get(key) < REPEAT_MS) return null;
    const ticket = { at, name, key, prevLast: lastByName.get(name), prevSeen: seen.get(key) };
    reserved.push(ticket);
    lastByName.set(name, at);
    seen.set(key, at);
    return ticket;
  }
  // 真的要送出了：冷卻與額度改從送出的這一刻算
  function confirm(ticket) {
    const at = now();
    ticket.at = at;
    lastByName.set(ticket.name, at);
    seen.set(ticket.key, at);
  }
  // 預約的回覆沒有送出（被取消、被擋下）：把額度與冷卻還回去
  function refund(ticket) {
    reserved = reserved.filter(item => item !== ticket);
    const restore = (map, key, previous) => {
      if (previous === undefined) map.delete(key);
      else map.set(key, previous);
    };
    restore(lastByName, ticket.name, ticket.prevLast);
    restore(seen, ticket.key, ticket.prevSeen);
  }
  const prune = () => { own = own.filter(item => now() - item.at <= OWN_MS); };
  function noteSent(text) {
    prune();
    own.push({ text: squash(text), at: now() });
  }
  function isOwn(text) {
    prune();
    const index = own.findIndex(item => item.text === squash(text));
    if (index < 0) return false;
    own.splice(index, 1);
    return true;
  }
  return { take, confirm, refund, noteSent, isOwn };
}

// 看到來訊到送出回覆之間隨機等 3～10 秒（毫秒）
const replyDelayMs = (random = Math.random) => 3000 + Math.floor(random() * 7000);

globalThis.CatworldChatReply = { KEY, SETTINGS_KEY, MAX_PAIRS, PAIR_WINDOW_MS, parseLine, createRecorder, addPair, exportText, parseImport, mergeImported, createLimiter, REPEAT_MS, OWN_MS, normalizeSettings, similarity, worthAnswering, bestReply, replyDelayMs };
})();

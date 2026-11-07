// 劇本對話：兩個帳號用 tell 照一份劇本一人一輪地聊（劇本是 [{ who: 'A' | 'B', text }]，A 開場、B 接話）。
// 兩台電腦不共用儲存，所以只靠遊戲裡傳來的 tell 內容同步：收到對方的來訊就和「預期的那一輪對方台詞」比對（相似度達 MATCH_THRESHOLD），
// 對上了才換我說下一輪，對不上就當沒這回事（交還給原本的聊天回覆）。
// 純函式，不碰 DOM 與 chrome.*；遊戲頁的接線在 content.js。依賴 chat-reply.js 的 similarity。
(() => {
if (globalThis.CatworldChatScript) return;

const SETTINGS_KEY = 'chatScript';
const MATCH_THRESHOLD = 0.8; // 來訊和預期台詞的相似度要達到多少才算「是劇本的下一句」
const ID_PATTERN = /^[A-Za-z0-9_.'-]{1,30}$/; // 放進 tell 指令的英文 ID：只收這些字元
const PLACEHOLDER = '{對方}';

// 台詞會原樣送出（走巨集）：空的、含分號（巨集分隔）、@等待、換行的不收
const hasBreak = text => text.includes(String.fromCharCode(10)) || text.includes(String.fromCharCode(13));
const safeText = text => typeof text === 'string' && text.trim().length > 0 && !text.includes(';') && !text.includes('；') && !text.includes('@等待') && !hasBreak(text);

// 設定（chrome.storage.local.chatScript）：預設關；role 是 A（開場）或 B（接話），預設 B；
// partner 是對方的英文 ID（tell 用，也用來認出來訊），不合格當沒填；partnerName 是對方暱稱（只給台詞裡的 {對方} 代入，選填）
function normalizeSettings(raw) {
  const partner = typeof raw?.partner === 'string' ? raw.partner.trim() : '';
  const name = typeof raw?.partnerName === 'string' ? raw.partnerName.trim() : '';
  return {
    enabled: raw?.enabled === true,
    role: raw?.role === 'A' ? 'A' : 'B',
    partner: ID_PATTERN.test(partner) ? partner : '',
    partnerName: name.length <= 20 && (name === '' || safeText(name)) ? name : '',
  };
}

// 來訊的名稱「暱稱(ID)」括號裡的英文 ID（小寫）；沒有括號回空字串
function partnerIdOf(name) {
  const text = String(name ?? '').trim();
  if (!text.endsWith(')')) return '';
  const open = text.lastIndexOf('(');
  return open < 0 ? '' : text.slice(open + 1, -1).trim().toLowerCase();
}

// 把台詞裡的 {對方} 換成名字
const fill = (text, name) => String(text).split(PLACEHOLDER).join(name);
const tellCommand = (id, text) => `tell ${id} ${text}`;

// 台詞裡用全形斜線 ／ 分開的幾段，每段各送一則 tell
const splitParts = text => text.split('／').map(part => part.trim()).filter(Boolean);
// 劇本的一句：{ who: 'A' | 'B', text }，台詞要通過 safeText，而且至少有一段
const validLine = line => (line?.who === 'A' || line?.who === 'B') && safeText(line.text) && splitParts(line.text).length > 0;
// 從背景拿到的劇本只留形狀對、每一句都安全的
const usableScripts = raw => (Array.isArray(raw) ? raw : []).filter(script => typeof script?.id === 'string'
  && Array.isArray(script.lines) && script.lines.length >= 2 && script.lines.every(validLine));

// 同一個人連續的句子算同一輪：[{ who, parts: [台詞…] }]
function toTurns(script) {
  const turns = [];
  script.lines.forEach(line => {
    const last = turns[turns.length - 1];
    if (last && last.who === line.who) last.parts.push(...splitParts(line.text));
    else turns.push({ who: line.who, parts: splitParts(line.text) });
  });
  return turns;
}

// 對方這一輪預期會看到的每一則：{對方} 是對方在送出時換成「我的暱稱」的，所以這裡換成我自己的角色名（不知道就拿掉）
const expectedParts = (turn, ownName) => turn.parts.map(part => fill(part, ownName));
// 來訊和這一輪的哪一則最像：{ index, score }
const closestPart = (turn, ownName, text, similarity) => {
  const scores = expectedParts(turn, ownName).map(part => similarity(part, text));
  const score = Math.max(...scores);
  return { index: scores.indexOf(score), score };
};

// 沒有進行中的一場時，來訊像哪一份劇本的第一輪（必須是對方的一輪，像其中任何一則都算）：回相似度最高且達門檻的劇本，沒有回 null
function bestStart(scripts, role, text, ownName = '', similarity = globalThis.CatworldChatReply.similarity) {
  let best = null;
  let bestScore = 0;
  scripts.forEach(script => {
    const first = toTurns(script)[0];
    if (first.who === role) return;
    const { score } = closestPart(first, ownName, text, similarity);
    if (score >= MATCH_THRESHOLD && score > bestScore) { best = script; bestScore = score; }
  });
  return best;
}

// 進行中的一場：index 是下一個要處理的輪（已經送出或收到的都越過了）。
// start()（A 開場）回第一輪要送的台詞；hear(text) 收到對方的來訊：對上預期那一輪的最後一則就換我說下一輪，回 { send, done }；
// 對上的是前面的某一則（對方這一輪還沒說完）就收下、不前進，回 { send: [], done: false, partial: true }；都對不上回 null。
// done 是整份劇本走完了（我說了最後一輪，或對方的最後一輪到了）。
function createSession({ script, role, ownName = '', similarity = globalThis.CatworldChatReply.similarity }) {
  const turns = toTurns(script);
  let index = 0;
  const take = () => {
    const send = turns[index].parts;
    index += 1;
    return send;
  };
  return {
    scriptId: script.id,
    start() {
      if (index !== 0 || turns[0].who !== role) return null;
      return { send: take(), done: index >= turns.length };
    },
    hear(text) {
      if (index >= turns.length || turns[index].who === role) return null;
      const heard = closestPart(turns[index], ownName, text, similarity);
      if (heard.score < MATCH_THRESHOLD) return null;
      if (heard.index < turns[index].parts.length - 1) return { send: [], done: false, partial: true };
      index += 1;
      const send = index < turns.length ? take() : [];
      return { send, done: index >= turns.length };
    },
    status: () => ({ scriptId: script.id, turn: index, total: turns.length, done: index >= turns.length }),
  };
}

// 擬真計時（毫秒）：一輪送出前等「思考時間加依字數算的打字時間」，夾在 TURN_LIMITS_MS 之內；同一輪拆開的兩則之間隔 SPLIT_GAP_MS。random 可注入
const THINK_MS = [1000, 4000];
const PER_CHAR_MS = [300, 600];
const TURN_LIMITS_MS = [3000, 45000];
const SPLIT_GAP_MS = [1000, 3000];
const between = ([min, max], random) => min + (max - min) * random();
const turnDelayMs = (text, random = Math.random) => {
  const waited = between(THINK_MS, random) + [...text].length * between(PER_CHAR_MS, random);
  return Math.round(Math.min(TURN_LIMITS_MS[1], Math.max(TURN_LIMITS_MS[0], waited)));
};
const splitGapMs = (random = Math.random) => Math.round(between(SPLIT_GAP_MS, random));

globalThis.CatworldChatScript = { SETTINGS_KEY, MATCH_THRESHOLD, normalizeSettings, partnerIdOf, fill, tellCommand, usableScripts, toTurns, bestStart, createSession, turnDelayMs, splitGapMs };
})();

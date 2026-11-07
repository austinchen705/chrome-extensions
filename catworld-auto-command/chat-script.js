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

// 劇本的一句：{ who: 'A' | 'B', text }，台詞要通過 safeText
const validLine = line => (line?.who === 'A' || line?.who === 'B') && safeText(line.text);
// 從背景拿到的劇本只留形狀對、每一句都安全的（完整的檢查在試算表解析那一票）
const usableScripts = raw => (Array.isArray(raw) ? raw : []).filter(script => typeof script?.id === 'string'
  && Array.isArray(script.lines) && script.lines.length >= 2 && script.lines.every(validLine));

// 同一個人連續的句子算同一輪：[{ who, parts: [台詞…] }]
function toTurns(script) {
  const turns = [];
  script.lines.forEach(line => {
    const last = turns[turns.length - 1];
    if (last && last.who === line.who) last.parts.push(line.text);
    else turns.push({ who: line.who, parts: [line.text] });
  });
  return turns;
}

// 對方這一輪預期會看到的字：它的最後一句，{對方} 是對方在送出時換成「我的暱稱」的，所以這裡換成我自己的角色名（不知道就拿掉）
const expectedText = (turn, ownName) => fill(turn.parts[turn.parts.length - 1], ownName);

// 沒有進行中的一場時，來訊像哪一份劇本的第一輪（必須是對方的一輪）：回相似度最高且達門檻的劇本，沒有回 null
function bestStart(scripts, role, text, ownName = '', similarity = globalThis.CatworldChatReply.similarity) {
  let best = null;
  let bestScore = 0;
  scripts.forEach(script => {
    const first = toTurns(script)[0];
    if (first.who === role) return;
    const score = similarity(expectedText(first, ownName), text);
    if (score >= MATCH_THRESHOLD && score > bestScore) { best = script; bestScore = score; }
  });
  return best;
}

// 進行中的一場：index 是下一個要處理的輪（已經送出或收到的都越過了）。
// start()（A 開場）回第一輪要送的台詞；hear(text) 收到對方的來訊：對上預期的那一輪就換我說下一輪，回 { send, done }，對不上回 null。
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
      if (similarity(expectedText(turns[index], ownName), text) < MATCH_THRESHOLD) return null;
      index += 1;
      const send = index < turns.length ? take() : [];
      return { send, done: index >= turns.length };
    },
    status: () => ({ scriptId: script.id, turn: index, total: turns.length, done: index >= turns.length }),
  };
}

globalThis.CatworldChatScript = { SETTINGS_KEY, MATCH_THRESHOLD, normalizeSettings, partnerIdOf, fill, tellCommand, usableScripts, toTurns, bestStart, createSession };
})();

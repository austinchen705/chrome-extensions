// 劇本對話：兩個帳號用 tell 照一份劇本一人一輪地聊（劇本是 [{ who: 'A' | 'B', text }]，A 開場、B 接話）。
// 兩台電腦不共用儲存，所以只靠遊戲裡傳來的 tell 內容同步：收到對方的來訊就和「預期的那一輪對方台詞」比對（相似度達 MATCH_THRESHOLD），
// 對上了才換我說下一輪，對不上就當沒這回事（交還給原本的聊天回覆）。
// 純函式，不碰 DOM 與 chrome.*；遊戲頁的接線在 content.js。依賴 chat-reply.js 的 similarity。
(() => {
if (globalThis.CatworldChatScript) return;

const SETTINGS_KEY = 'chatScript';
const STATE_KEY = 'chatScriptState'; // { date, count, recent }：今天開了幾場、最近用過的劇本
const MATCH_THRESHOLD = 0.8; // 來訊和預期台詞的相似度要達到多少才算「是劇本的下一句」
const ID_PATTERN = /^[A-Za-z0-9_.'-]{1,30}$/; // 放進 tell 指令的英文 ID：只收這些字元
const PLACEHOLDER = '{對方}';
// 擬真計時用的範圍 [最小, 最大]（毫秒）：思考時間、每個字的打字時間、一輪等待的上下限、同一輪拆開的兩則之間
const THINK_MS = [1000, 4000];
const PER_CHAR_MS = [300, 600];
const TURN_LIMITS_MS = [3000, 45000];
const SPLIT_GAP_MS = [1000, 3000];
const PER_DAY_DEFAULT = 3; // 每天最多幾場
const PER_DAY_MAX = 99;
const RECENT_LIMIT = 5; // A 挑劇本時避開最近用過的幾份
const TYPO_RATE_DEFAULT = 3; // 每一輪出錯字的機率（%）
const TYPO_MIN_LENGTH = 6; // 一則至少幾個字才會被打錯
// 常見的誤用字：打錯時優先換成它的另一半，沒有的字換成同一則裡的另一個字
const CONFUSABLE = { 的: '得', 得: '的', 他: '她', 她: '他', 在: '再', 再: '在', 做: '作', 作: '做', 嗎: '嘛', 嘛: '嗎', 哪: '那', 那: '哪', 吧: '把', 把: '吧', 已: '以', 以: '已' };

// 台詞會原樣送出（走巨集）：空的、含分號（巨集分隔）、@等待、換行的不收
const hasBreak = text => text.includes(String.fromCharCode(10)) || text.includes(String.fromCharCode(13));
const safeText = text => typeof text === 'string' && text.trim().length > 0 && !text.includes(';') && !text.includes('；') && !text.includes('@等待') && !hasBreak(text);

// 設定（chrome.storage.local.chatScript）：預設關；role 是 A（開場）或 B（接話），預設 B；
// partner 是對方的英文 ID（tell 用，也用來認出來訊），不合格當沒填；partnerName 是對方的角色名（只給台詞裡的 {對方} 代入，選填；沒填代入 ID）；
// perDay 是每天最多幾場（0～PER_DAY_MAX 的整數，0 就是不開也不接），typoRate 是每一輪出錯字的機率（0～100 的百分比）；留白或不是數字退回預設
function normalizeNumber(value, [min, max], fallback) {
  const number = value === '' || value == null ? NaN : Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function normalizeSettings(raw) {
  const partner = typeof raw?.partner === 'string' ? raw.partner.trim() : '';
  const name = typeof raw?.partnerName === 'string' ? raw.partnerName.trim() : '';
  return {
    enabled: raw?.enabled === true,
    role: raw?.role === 'A' ? 'A' : 'B',
    partner: ID_PATTERN.test(partner) ? partner : '',
    partnerName: name.length <= 20 && (name === '' || safeText(name)) ? name : '',
    perDay: Math.floor(normalizeNumber(raw?.perDay, [0, PER_DAY_MAX], PER_DAY_DEFAULT)),
    typoRate: normalizeNumber(raw?.typoRate, [0, 100], TYPO_RATE_DEFAULT),
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
// start()（A 開場）回第一輪要送的台詞；hear(text) 收到對方的來訊：先和對方這一輪預期的下一則比，比不上才和這一輪的其他則比（掉了一則也跟得上）；
// 對上最後一則就換我說下一輪，回 { send, done }；對上前面的某一則（這一輪還沒說完）就收下、不前進，回 { send: [], done: false, partial: true }；都對不上回 null。
// 這一輪有幾則很像時，靠「下一則」的位置分辨先後。
// done 是整份劇本走完了（我說了最後一輪，或對方的最後一輪到了）。
function createSession({ script, role, ownName = '', similarity = globalThis.CatworldChatReply.similarity }) {
  const turns = toTurns(script);
  let index = 0;
  let received = 0; // 對方這一輪已經收到的則數，也就是下一則預期的位置
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
      const parts = expectedParts(turns[index], ownName);
      const heard = similarity(parts[received], text) >= MATCH_THRESHOLD ? { index: received, score: 1 } : closestPart(turns[index], ownName, text, similarity);
      if (heard.score < MATCH_THRESHOLD) return null;
      if (heard.index < parts.length - 1) {
        received = Math.max(received, heard.index + 1);
        return { send: [], done: false, partial: true };
      }
      received = 0;
      index += 1;
      const send = index < turns.length ? take() : [];
      return { send, done: index >= turns.length };
    },
    status: () => ({ scriptId: script.id, turn: index, total: turns.length, done: index >= turns.length }),
  };
}

// 一輪送出前等「思考時間加依字數算的打字時間」，夾在 TURN_LIMITS_MS 之內；同一輪拆開的兩則之間隔 SPLIT_GAP_MS（毫秒）。random 可注入
const between = ([min, max], random) => min + (max - min) * random();
const turnDelayMs = (text, random = Math.random) => {
  const waited = between(THINK_MS, random) + [...text].length * between(PER_CHAR_MS, random);
  return Math.round(Math.min(TURN_LIMITS_MS[1], Math.max(TURN_LIMITS_MS[0], waited)));
};
const splitGapMs = (random = Math.random) => Math.round(between(SPLIT_GAP_MS, random));

// 錯字：以 rate（%）的機率在這一輪的某一則（至少 TYPO_MIN_LENGTH 個字）換掉一個字，緊接著那一則補一則「*正確的字」。
// 只換「換了之後對方仍認得（相似度達 MATCH_THRESHOLD）」的位置：長的一則哪裡都行，6～10 個字的只剩頭尾；沒有合適的位置就不出錯字。
// 空白與標點不換。回新的陣列（沒出錯字時就是原本那一個）；random、similarity 可注入
const isLetter = char => /[\p{L}\p{N}]/u.test(char);
function wrongChar(chars, at) {
  const right = chars[at];
  if (CONFUSABLE[right]) return CONFUSABLE[right];
  const others = chars.filter(char => char !== right && isLetter(char));
  return others.length ? others[at % others.length] : null;
}
function addTypo(texts, rate, random = Math.random, similarity = globalThis.CatworldChatReply.similarity) {
  if (!(rate > 0) || random() * 100 >= rate) return texts;
  const candidates = [];
  texts.forEach((text, index) => {
    const chars = [...text];
    if (chars.length < TYPO_MIN_LENGTH) return;
    chars.forEach((right, at) => {
      if (!isLetter(right)) return;
      const wrong = wrongChar(chars, at);
      const typed = wrong && chars.map((char, position) => (position === at ? wrong : char)).join('');
      const correction = `*${right}`;
      if (typed && safeText(typed) && safeText(correction) && similarity(text, typed) >= MATCH_THRESHOLD) candidates.push({ index, typed, correction });
    });
  });
  if (!candidates.length) return texts;
  const pick = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
  const result = [...texts];
  result.splice(pick.index, 1, pick.typed, pick.correction);
  return result;
}
// 每日場數與最近用過的劇本（STATE_KEY）：date 是本機日期（dayKey），跨日 count 歸零；recent 舊的在前、最多 RECENT_LIMIT 個
const dayKey = ms => {
  const day = new Date(ms);
  return [day.getFullYear(), day.getMonth() + 1, day.getDate()].map((part, index) => String(part).padStart(index ? 2 : 4, '0')).join('-');
};
const normalizeState = raw => ({
  date: typeof raw?.date === 'string' ? raw.date : '',
  count: Number.isInteger(raw?.count) && raw.count > 0 ? raw.count : 0,
  recent: Array.isArray(raw?.recent) ? raw.recent.filter(id => typeof id === 'string').slice(-RECENT_LIMIT) : [],
});
const todayCount = (state, today) => (state.date === today ? state.count : 0);
const recordStart = (state, today, scriptId) => ({
  date: today,
  count: todayCount(state, today) + 1,
  recent: [...state.recent.filter(id => id !== scriptId), scriptId].slice(-RECENT_LIMIT),
});
// 從可開場的劇本挑一份：避開 recent；全都在 recent 裡（劇本不足 6 份）就挑最久以前用過的
function pickScript(choices, recent, random = Math.random) {
  const fresh = choices.filter(script => !recent.includes(script.id));
  const oldest = Math.min(...choices.map(script => recent.indexOf(script.id)));
  const pool = fresh.length ? fresh : choices.filter(script => recent.indexOf(script.id) === oldest);
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}
// 設定頁的狀態行；session 是 STATUS 回的 chatScript（沒有進行中是 null，遊戲頁沒回應是 undefined）
function describeStatus({ session, state, perDay, today }) {
  const day = '今天 ' + todayCount(state, today) + '/' + perDay + ' 場';
  if (session === undefined) return day + '；遊戲頁沒有回應';
  if (!session) return day + '；目前沒有進行中的一場';
  return day + '；進行中：劇本 ' + session.scriptId + '，已演 ' + session.turn + '/' + session.total + ' 輪，' + (session.phase === 'say' ? '正在說' : '等對方回');
}

// 對方更正錯字的那一則（「*字」）：不是劇本的台詞，但屬於這一場，收下就好
const isCorrection = text => /^[*＊]\S{1,4}$/u.test(String(text ?? '').trim());

globalThis.CatworldChatScript = { SETTINGS_KEY, STATE_KEY, MATCH_THRESHOLD, normalizeSettings, partnerIdOf, fill, tellCommand, usableScripts, toTurns, bestStart, createSession, turnDelayMs, splitGapMs, addTypo, isCorrection, dayKey, normalizeState, todayCount, recordStart, pickScript, describeStatus };
})();

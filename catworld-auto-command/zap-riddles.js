// 解謎查詢：不碰 DOM，content script、background、測試共用。
//
// 謎的條件分三組：條件夠／需自行確認／條件未達。能自動比對的只有經驗（#exp）和內力（取內力上限 #max_force）；
// 技能等級、天賦、需要某件物品、是否為新手這些狀態視窗看不到，一律歸「需自行確認」，不猜。
// 可讀的條件有任何一項未達就是「條件未達」（優先於需自行確認）；需要的數值讀不到時也只歸「需自行確認」，不當成未達。
//
// 使用者補的指令存在 chrome.storage.local.riddleCommands：{ [頁面檔名]: { n: 編輯時該頁的步驟數, cmds: { [步驟序號]: 指令 } } }。
// 步驟序號是該頁解析出的步驟的 1 起算位置（共用頁會重新編號，頁面印的編號不能當鍵）；
// n 和目前步驟數不同代表資料檔重新產生過、步驟可能移動，要標示給使用者確認。
(() => {
if (globalThis.CatworldZapRiddles) return;

const DIFFICULTY_ORDER = ['極易', '易', '一般', '難', '極難'];

function parseCondition(text) {
  const raw = String(text ?? '').trim();
  if (raw === '無') return { exp: null, force: null, unreadable: false };
  const expMatch = /(\d+(?:\.\d+)?)\s*萬\s*EXP/i.exec(raw);
  const forceMatch = /內力\s*(\d+)/.exec(raw);
  const marker = /\[天賦\]|技能|需為新手|未知|不一定|\?{4}|\[註\]/.test(raw);
  return {
    exp: expMatch ? Number(expMatch[1]) * 10000 : null,
    force: forceMatch ? Number(forceMatch[1]) : null,
    unreadable: marker || (!expMatch && !forceMatch),
  };
}

function classify(condition, stats) {
  const parsed = parseCondition(condition);
  const unmet = (need, have) => need !== null && Number.isFinite(have) && have < need;
  const unknown = (need, have) => need !== null && !Number.isFinite(have);
  if (unmet(parsed.exp, stats.exp) || unmet(parsed.force, stats.force)) return 'unmet';
  return parsed.unreadable || unknown(parsed.exp, stats.exp) || unknown(parsed.force, stats.force) ? 'check' : 'ok';
}

const difficultyRank = difficulty => {
  const rank = DIFFICULTY_ORDER.indexOf(difficulty);
  return rank < 0 ? DIFFICULTY_ORDER.length : rank;
};

function groupRiddles(riddles, stats) {
  const groups = { ok: [], check: [], unmet: [] };
  riddles.forEach((riddle, order) => groups[classify(riddle.condition, stats)].push({ riddle, order }));
  const sorted = list => list
    .sort((a, b) => difficultyRank(a.riddle.difficulty) - difficultyRank(b.riddle.difficulty) || a.order - b.order)
    .map(entry => entry.riddle);
  return { ok: sorted(groups.ok), check: sorted(groups.check), unmet: sorted(groups.unmet) };
}

const squash = text => String(text ?? '').toLowerCase().replace(/\s/g, '');

function searchRiddles(riddles, query) {
  const needle = squash(query);
  if (!needle) return riddles;
  return riddles.filter(riddle => squash(`${riddle.name}${riddle.hint}${riddle.reward}${riddle.category}`).includes(needle));
}

// 換行也當分隔：編輯框裡多行的文字不能原封不動送出（單行輸入框會吃掉換行，指令會黏成 run elook）
// 共用頁（石牢＆入古墓＆入明教 在同一頁）只該顯示這個謎自己的那一段，不然點「入古墓」看到的是石牢的步驟。
// 以步驟的小標題分段：標題包含謎名的段落就是它的；沒有標題的開頭那段，屬於「名字沒出現在任何標題、但同頁其他謎有」的謎。
// 認不出來就回傳整頁（寧可多顯示，不要漏）。回傳的是步驟在該頁的 1 起算位置，編輯與儲存都用這個位置。
function sectionSteps(riddle, page) {
  const all = page.steps.map((_, index) => index + 1);
  if (!riddle.shared?.length) return all;
  const starts = page.steps.map((step, index) => (step.heading ? index : -1)).filter(index => index >= 0);
  if (!starts.length) return all;
  const groups = starts.map((from, k) => ({ heading: page.steps[from].heading, from, to: starts[k + 1] ?? page.steps.length }));
  const range = ({ from, to }) => Array.from({ length: to - from }, (_, i) => from + i + 1);
  const mine = groups.filter(group => group.heading.includes(riddle.name));
  if (mine.length) return mine.flatMap(range);
  const othersHaveHeadings = riddle.shared.some(name => groups.some(group => group.heading.includes(name)));
  if (starts[0] > 0 && othersHaveHeadings) return range({ from: 0, to: starts[0] });
  return all;
}

// 路徑是不是從醉仙樓客棧出發（`run e 5n o…`／`run e 5n 2o…`）；不是的路徑接在上一步的位置後面，不能亂標
const startsAtInn = commands => /^run e 5n (?:2o|o)(?:[\s;]|$)/.test(String(commands ?? ''));

const splitCommands = text => String(text ?? '').split(/[;；\r\n]+/).map(piece => piece.trim()).filter(Boolean);
const joinCommands = list => list.join(';');

// 「步驟已變動」是逐步判斷的：只有帶著指令（自己補的或共用的）的那一步、而且它存檔當時的步驟數和現在不同才算
// （自己補的記在 ns[序號]，舊資料沒有就用整頁的 n；共用的記在試算表的步驟數欄）。改一步不能讓同頁其他還沒重新確認過的補充指令跟著變成「沒問題」。
// 優先順序：個人補的 > 共用（試算表，shared[頁面檔名][位置]）> 網站。共用的步驟數 n 有填而且和現在不同才算已變動，留空不警告；
// 共用寫「停用」（disabled）的步驟沒有指令（來源 shared-off），網站的指令也不採用
function effectiveStep(page, index, edits, file, shared) {
  const entry = edits?.[file];
  const edited = entry?.cmds?.[index];
  const hasEdit = typeof edited === 'string' && edited.trim() !== '';
  const stale = hasEdit && (entry.ns?.[index] ?? entry.n) !== page.steps.length;
  if (hasEdit) return { commands: edited.trim(), source: 'edited', stale };
  const sharedEntry = shared?.[file]?.[index];
  if (sharedEntry) {
    const info = { by: sharedEntry.by, note: sharedEntry.note };
    if (sharedEntry.disabled) return { commands: '', source: 'shared-off', stale: false, shared: info };
    return { commands: sharedEntry.command, source: 'shared', stale: Number.isInteger(sharedEntry.n) && sharedEntry.n !== page.steps.length, shared: info };
  }
  const site = page.steps[index - 1]?.commands || '';
  return { commands: site, source: site ? 'site' : 'none', stale: false };
}

function setEdit(edits, file, stepCount, index, text) {
  const next = { ...edits };
  const old = edits[file];
  const cmds = { ...old?.cmds };
  // 舊資料沒有逐步的紀錄時，其他步驟沿用整頁的 n（維持它們的「已變動」狀態）
  const ns = { ...(old?.ns ?? Object.fromEntries(Object.keys(cmds).map(key => [key, old.n]))) };
  const clean = String(text ?? '').trim();
  if (clean) {
    cmds[index] = clean;
    ns[index] = stepCount;
  } else {
    delete cmds[index];
    delete ns[index];
  }
  if (Object.keys(cmds).length) next[file] = { n: stepCount, cmds, ns };
  else delete next[file];
  return next;
}

// 匯入前驗證形狀；任何一項不合法都不能動既有的資料
function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是有效的 JSON' };
  }
  const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(data) || !isObject(data.riddleCommands) || !isObject(data.riddleDone)) {
    return { ok: false, error: '缺少 riddleCommands 或 riddleDone' };
  }
  for (const [file, entry] of Object.entries(data.riddleCommands)) {
    const valid = isObject(entry) && Number.isInteger(entry.n) && isObject(entry.cmds)
      && Object.values(entry.cmds).every(value => typeof value === 'string')
      && (entry.ns === undefined || (isObject(entry.ns) && Object.values(entry.ns).every(Number.isInteger)));
    if (!valid) return { ok: false, error: `riddleCommands 的 ${file} 格式不對` };
  }
  if (!Object.values(data.riddleDone).every(value => value === true)) return { ok: false, error: 'riddleDone 的值只能是 true' };
  return { ok: true, riddleCommands: data.riddleCommands, riddleDone: data.riddleDone };
}

// background 用：回 null 表示不是這個模組的訊息
function handleMessage(data, message) {
  if (message?.type !== 'ZAP_RIDDLES') return null;
  return { ok: true, riddles: data?.riddles ?? [], pages: data?.pages ?? {} };
}

globalThis.CatworldZapRiddles = {
  DIFFICULTY_ORDER, parseCondition, classify, groupRiddles, searchRiddles, sectionSteps, startsAtInn, splitCommands, joinCommands,
  effectiveStep, setEdit, parseImport, handleMessage,
};
})();

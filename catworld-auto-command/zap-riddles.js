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

const splitCommands = text => String(text ?? '').split(/[;；]/).map(piece => piece.trim()).filter(Boolean);
const joinCommands = list => list.join(';');

function effectiveStep(page, index, edits, file) {
  const entry = edits?.[file];
  const stale = Boolean(entry) && entry.n !== page.steps.length;
  const edited = entry?.cmds?.[index];
  if (typeof edited === 'string' && edited.trim()) return { commands: edited.trim(), source: 'edited', stale };
  const site = page.steps[index - 1]?.commands || '';
  return { commands: site, source: site ? 'site' : 'none', stale };
}

function setEdit(edits, file, stepCount, index, text) {
  const next = { ...edits };
  const entry = { n: stepCount, cmds: { ...edits[file]?.cmds } };
  const clean = String(text ?? '').trim();
  if (clean) entry.cmds[index] = clean;
  else delete entry.cmds[index];
  if (Object.keys(entry.cmds).length) next[file] = entry;
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
      && Object.values(entry.cmds).every(value => typeof value === 'string');
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
  DIFFICULTY_ORDER, parseCondition, classify, groupRiddles, searchRiddles, splitCommands, joinCommands,
  effectiveStep, setEdit, parseImport, handleMessage,
};
})();

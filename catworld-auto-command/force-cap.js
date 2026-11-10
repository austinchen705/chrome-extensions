// 內力可練上限：技能部分 = (內功心法（force）等級 + ⌊enable 的內功有效等級 ÷ 5⌋) × 10，再加上玩家在設定頁自己填的其他加成
// （人物等級超過 60 的部分 × 10、朱果每顆 × 10、臘八粥 +100、東瀛 +50、裝備的內功每點 × 10，公式來自試算表「內力試算」，存在 chrome.storage.local.forceExtras）。
// 打 hp 時在輸出下面多一行上限與目前最大內力的差；兩個等級 hp 不會印，所以在打 sk（內功心法）與 enable（有效等級）時記下來，
// 存在 chrome.storage.local.forceLevels（{ base, effective, baseAt, effectiveAt }）。
// 純函式匯出在 globalThis.CatworldForceCap；遊戲頁的觀察器只在有 #content 與 chrome 時才跑。開關是 zapFeatures.forceCap（缺值＝開）。
(() => {
if (globalThis.CatworldForceCap) return;

const NUM = '(\\d+)';
const BASE = new RegExp(`內功心法\\s*\\(force\\)\\s*-\\s*\\S+\\s+${NUM}\\s*/`);
const EFFECTIVE = new RegExp(`內功\\s*\\(force\\)\\s*[：:]\\s*\\S+\\s+有效等級\\s*[：:]\\s*${NUM}`);
const FORCE = new RegExp(`內力\\s*[：:]\\s*${NUM}\\s*/\\s*${NUM}`);
const HP_END = /目前狀態/; // hp 才有；sc 的人物表也有內力那一行，但沒有這一行

const toNumber = match => (match ? Number(match[1]) : null);

// sk：「內功心法 (force) - 出神入化 156/ 0」的 156
const parseBase = text => toNumber(String(text ?? '').match(BASE));
// enable：「內功 (force) ： 六合童子功 有效等級：244」的 244
const parseEffective = text => toNumber(String(text ?? '').match(EFFECTIVE));
// hp：「內力： 1046 / 1560 (+10)」的 1046 與 1560；沒有「目前狀態」（不是 hp）回 null
function parseHp(text) {
  const value = String(text ?? '');
  const match = value.match(FORCE);
  if (!match || !HP_END.test(value.slice(match.index))) return null;
  return { cur: Number(match[1]), max: Number(match[2]) };
}

const cap = (base, effective) => (base + Math.floor(effective / 5)) * 10;

// 其他加成：遊戲輸出裡讀不到（等級沒有指令確定印得出來、朱果與解謎沒有來源），所以由玩家自己填。讀回來的值逐欄檢查，壞的當 0／沒做
const EXTRA_MAX = { level: 999, zhuguo: 9999, equip: 9999 };
const wholeNumber = (value, max) => {
  const number = Number(value);
  return value !== '' && value !== null && value !== undefined && Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), max) : 0;
};
function normalizeExtras(raw) {
  const extras = raw && typeof raw === 'object' ? raw : {};
  return {
    level: wholeNumber(extras.level, EXTRA_MAX.level),
    zhuguo: wholeNumber(extras.zhuguo, EXTRA_MAX.zhuguo),
    laba: extras.laba === true,
    dongying: extras.dongying === true,
    equip: wholeNumber(extras.equip, EXTRA_MAX.equip),
  };
}
// 每一項加多少點
function extraPoints(raw) {
  const extras = normalizeExtras(raw);
  return {
    level: extras.level < 60 ? 0 : 10 * (extras.level - 60),
    zhuguo: extras.zhuguo * 10,
    laba: extras.laba ? 100 : 0,
    dongying: extras.dongying ? 50 : 0,
    equip: extras.equip * 10,
  };
}
const extraTotal = raw => Object.values(extraPoints(raw)).reduce((sum, points) => sum + points, 0);
const known = value => Number.isFinite(value) && value >= 0;

// 公式只算得出基本值，等級、上線時間等其他因素可能再加上限，所以文字標明是估算，超過時不顯示。
// 顯示的一行：{ level, text }；等級沒記過時說要先打什麼，不猜；最大內力已經到（或超過）上限就沒有東西要提示，回 null
function describe(levels, hp, timeText = String, extras) {
  const missing = [];
  if (!known(levels?.base)) missing.push('sk');
  if (!known(levels?.effective)) missing.push('enable');
  if (missing.length) return { level: 'warn', text: `內力可練上限：還不知道，先打 ${missing.join('、')} 讓我記下等級` };
  const skill = cap(levels.base, levels.effective);
  const extra = extraTotal(extras);
  const total = skill + extra;
  const gap = total - hp.max;
  if (gap <= 0) return null;
  const at = Math.min(levels.baseAt ?? Infinity, levels.effectiveAt ?? Infinity);
  const when = Number.isFinite(at) ? `，等級讀於 ${timeText(at)}` : '';
  const parts = extra > 0 ? `技能 ${skill}＋其他 ${extra}；` : '';
  return { level: 'info', text: `內力可練上限：${total}（公式估算，實際可能更高；${parts}目前最大 ${hp.max}，還差 ${gap}${when}）` };
}

globalThis.CatworldForceCap = { parseBase, parseEffective, parseHp, cap, normalizeExtras, extraPoints, extraTotal, describe };

const content = typeof document === 'undefined' ? null : document.getElementById('content');
if (!content || !globalThis.chrome?.storage?.local || !globalThis.CatworldZapMobs) return;

const OWN = 'data-catworld-forcecap';
const SETTLE_MS = 300; // 輸出分批到，靜止這麼久才解析
const WINDOW_MS = 5000; // 只接最近這段時間的新增文字
const isOwn = node => Boolean((node.nodeType === 1 ? node : node.parentElement)?.closest?.(`[${OWN}]`));
const clock = at => new Date(at).toLocaleTimeString('zh-TW', { hour12: false });

let buffer = '';
let startedAt = 0;
let lastNode = null;
let timer = null;

function render(view) {
  const box = document.createElement('div');
  box.setAttribute(OWN, '');
  Object.assign(box.style, { padding: '2px 0', color: view.level === 'warn' ? '#ffb347' : '#6cc4ff' });
  box.textContent = view.text;
  if (lastNode?.isConnected) lastNode.after(box);
  else content.append(box);
  box.scrollIntoView?.({ block: 'nearest' });
}

async function flush() {
  const text = buffer;
  buffer = '';
  const base = parseBase(text);
  const effective = parseEffective(text);
  const hp = parseHp(text);
  if (base === null && effective === null && !hp) return;
  try {
    const data = await chrome.storage.local.get(['zapFeatures', 'forceLevels', 'forceExtras']);
    if (data.zapFeatures?.forceCap === false) return;
    const levels = { ...data.forceLevels };
    const now = Date.now();
    if (base !== null) Object.assign(levels, { base, baseAt: now });
    if (effective !== null) Object.assign(levels, { effective, effectiveAt: now });
    if (base !== null || effective !== null) await chrome.storage.local.set({ forceLevels: levels });
    const view = hp && describe(levels, hp, clock, data.forceExtras);
    if (view) render(view);
  } catch {
    // 連不上儲存（孤兒程式）：什麼都不做
  }
}

const observer = new MutationObserver(records => {
  const mine = records.filter(record => !isOwn(record.target));
  const text = CatworldZapMobs.textFromAdded(mine.flatMap(record => (record.type === 'characterData'
    ? [record.target.textContent || '']
    : Array.from(record.addedNodes, node => (isOwn(node) ? '' : node.textContent || '')))));
  if (!text) return;
  const now = Date.now();
  if (now - startedAt > WINDOW_MS) buffer = '';
  if (!buffer) startedAt = now;
  buffer += `${text}\n`;
  const added = mine.flatMap(record => Array.from(record.addedNodes)).filter(node => !isOwn(node));
  if (added.length) lastNode = added[added.length - 1];
  clearTimeout(timer);
  timer = setTimeout(flush, SETTLE_MS);
});
observer.observe(content, { subtree: true, childList: true, characterData: true });
})();

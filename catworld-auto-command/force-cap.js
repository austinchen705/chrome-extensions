// 內力可練上限：最大內力 = 內功心法（force）等級 × 10 + ⌊enable 的內功有效等級 ÷ 5⌋。
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

const cap = (base, effective) => base * 10 + Math.floor(effective / 5);
const known = value => Number.isFinite(value) && value >= 0;

// 顯示的一行：{ level, text }；等級沒記過時說要先打什麼，不猜
function describe(levels, hp, timeText = String) {
  const missing = [];
  if (!known(levels?.base)) missing.push('sk');
  if (!known(levels?.effective)) missing.push('enable');
  if (missing.length) return { level: 'warn', text: `內力可練上限：還不知道，先打 ${missing.join('、')} 讓我記下等級` };
  const total = cap(levels.base, levels.effective);
  const gap = total - hp.max;
  const state = gap > 0 ? `還差 ${gap}` : gap === 0 ? '已達上限' : `已超過 ${-gap}`;
  const at = Math.min(levels.baseAt ?? Infinity, levels.effectiveAt ?? Infinity);
  const when = Number.isFinite(at) ? `，等級讀於 ${timeText(at)}` : '';
  return { level: 'info', text: `內力可練上限：${total}（目前最大 ${hp.max}，${state}${when}）` };
}

globalThis.CatworldForceCap = { parseBase, parseEffective, parseHp, cap, describe };

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
    const data = await chrome.storage.local.get(['zapFeatures', 'forceLevels']);
    if (data.zapFeatures?.forceCap === false) return;
    const levels = { ...data.forceLevels };
    const now = Date.now();
    if (base !== null) Object.assign(levels, { base, baseAt: now });
    if (effective !== null) Object.assign(levels, { effective, effectiveAt: now });
    if (base !== null || effective !== null) await chrome.storage.local.set({ forceLevels: levels });
    if (hp) render(describe(levels, hp, clock));
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

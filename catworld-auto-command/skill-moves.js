// 武功招式列表：玩家打 careers（或任何會印出「你所領悟的招式數目為」那一段的指令）時，在輸出下面插一塊，
// 依 skills-data.js（從 jrealm/the-cat-world 產生）把「已悟 N 招」的前 N 招列出來：招式名、傷害與傷害類型（依傷害上色）、
// 加內力的招式標內力加成與特效，並寫下一招要的武功與內功門檻。
// 資料只在 background 被問到時用（skills-data.js 約 170 KB，不隨每個遊戲分頁載入）；整個功能由設定頁「輔助功能」的
// 招式列表開關（chrome.storage.local.zapFeatures.skills）控制，缺值＝關閉。
(() => {
const HEADER = /你所領悟的招式數目為/;
// 「  全真劍法          :  5 招」；輸出被拆成節點時行與行可能沒有換行，所以不靠行首，直接在標題之後找「名稱 : N 招」
const LEARNED = /([^\s:：]+)\s*[:：]\s*(\d+)\s*招/g;

// 輸出文字 → [{ name, count }]；只看「你所領悟的招式數目為」之後的文字
function parseLearned(text) {
  const all = String(text ?? '').normalize('NFKC');
  const header = HEADER.exec(all);
  if (!header) return [];
  return [...all.slice(header.index + header[0].length).matchAll(LEARNED)].map(match => ({ name: match[1], count: Number(match[2]) }));
}

// background 用：只回被問到的武功（名稱完全相同），免得把整份資料送過去
function lookup(data, names) {
  const skills = {};
  [...new Set(names)].slice(0, 30).forEach(name => {
    const skill = data?.skills?.find(item => item.name === name);
    if (!skill) return;
    skills[name] = {
      forceName: skill.forceName,
      levels: skill.levels.map(level => ({ self: level.self, force: level.force })),
      moves: skill.moves.map(move => ({ level: move.level, name: move.name, damage: move.damage, damageType: move.damageType, extra: move.extra })),
    };
  });
  return skills;
}

// 傷害分級（顏色）：沒有傷害數字的（加內力、特效）另一色
const TIERS = [
  { min: 300, color: '#ff6b6b', label: '300 以上' },
  { min: 200, color: '#ffb347', label: '200 以上' },
  { min: 100, color: '#7bd88f', label: '100 以上' },
  { min: 0, color: '#9aa5b1', label: '100 以下' },
];
const FORCE_COLOR = '#6cc4ff';
const tierOf = damage => TIERS.find(tier => damage >= tier.min) ?? TIERS.at(-1);
// 傷害類型欄有時混著一長段說明（「傷勢。\n本來無效的一招…」），只留第一句
const cleanType = text => String(text ?? '').split(/。|\\n|\n/)[0].trim();

// 一門武功、已悟 count 招 → 畫面要的資料
function describe(skill, count) {
  const learned = skill.moves.slice(0, count).map(move => {
    const hasDamage = Number.isFinite(move.damage);
    return {
      no: move.level,
      name: move.name,
      damage: hasDamage ? move.damage : null,
      type: cleanType(move.damageType),
      force: move.extra?.force ?? null,
      effect: move.extra?.effect ?? null,
      color: hasDamage ? tierOf(move.damage).color : FORCE_COLOR,
    };
  });
  const next = skill.moves[count];
  const need = skill.levels[count];
  return {
    count,
    total: skill.moves.length,
    moves: learned,
    next: next && need ? { no: next.level, name: next.name, self: need.self, force: need.force, forceName: skill.forceName } : null,
  };
}

function moveText(move) {
  const parts = [`${move.no}. ${move.name}`];
  if (move.damage !== null) parts.push(`傷害 ${move.damage}${move.type ? `（${move.type}）` : ''}`);
  if (move.force !== null) parts.push(`內力加成 ${move.force}`);
  if (move.effect) parts.push(`特效 ${move.effect}`);
  return parts.join('　');
}

globalThis.CatworldSkillMoves = { parseLearned, lookup, describe, moveText, tierOf, cleanType, TIERS, FORCE_COLOR };

const content = typeof document === 'undefined' ? null : document.getElementById('content');
if (!content || !globalThis.chrome?.storage?.local || !globalThis.chrome?.runtime?.sendMessage || !globalThis.CatworldZapMobs) return;

const OWN = 'data-catworld-skills';
const ARM_MS = 1500; // 標題出現之後，這麼久內新增的文字都接上去（輸出可能分批到）
const SETTLE_MS = 300;
const isOwn = node => Boolean((node.nodeType === 1 ? node : node.parentElement)?.closest?.(`[${OWN}]`));

let buffer = '';
let lastNode = null;
let timer = null;
let armedUntil = 0;

function line(box, text, color, indent = false) {
  const row = document.createElement('div');
  row.textContent = text;
  if (color) row.style.color = color;
  if (indent) row.style.paddingLeft = '1.5em';
  box.append(row);
}

function render(learned, reply) {
  const box = document.createElement('div');
  box.setAttribute(OWN, '');
  Object.assign(box.style, { border: '1px dashed #bbbbbb', padding: '4px 8px', margin: '4px 0', whiteSpace: 'pre-wrap' });
  line(box, `招式列表（顏色＝傷害：${TIERS.map(tier => `${tier.label}`).join('、')}；藍＝加內力）`, '#9aa5b1');
  if (!reply?.ok) {
    line(box, `查不到招式資料：${reply?.error ?? '沒有回應'}（extension 剛重新載入的話，請重新整理遊戲頁）`, '#ff8a7a');
  } else {
    learned.forEach(({ name, count }) => {
      const skill = reply.skills?.[name];
      if (!skill) { line(box, `${name}：資料裡沒有這門武功`, '#9aa5b1'); return; }
      const info = describe(skill, count);
      line(box, `${name}　已悟 ${info.count}／${info.total} 招`);
      info.moves.forEach(move => line(box, moveText(move), move.color, true));
      if (info.next) line(box, `下一招 ${info.next.no}. ${info.next.name}：${name} ≥ ${info.next.self}、${info.next.forceName} ≥ ${info.next.force}`, '#9aa5b1', true);
    });
  }
  if (lastNode?.isConnected) lastNode.after(box);
  else content.append(box);
  box.scrollIntoView?.({ block: 'nearest' });
}

async function flush() {
  const text = buffer;
  buffer = '';
  const learned = parseLearned(text);
  if (!learned.length) return;
  try {
    const data = await chrome.storage.local.get('zapFeatures');
    console.log('[catworld] 招式列表：偵測到招式數目的輸出', learned, data.zapFeatures?.skills === true ? '' : '（設定頁「輔助功能」的「招式列表」沒勾，所以不顯示）');
    if (data.zapFeatures?.skills !== true) return;
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: 'SKILL_MOVES', names: learned.map(item => item.name) });
    } catch (error) {
      reply = { ok: false, error: error?.message };
    }
    render(learned, reply);
  } catch {
    // 連不上儲存（孤兒程式）：什麼都不做
  }
}

const observer = new MutationObserver(records => {
  const mine = records.filter(record => !isOwn(record.target));
  const text = CatworldZapMobs.textFromAdded(mine.flatMap(record => (record.type === 'characterData'
    ? [record.target.textContent || '']
    : Array.from(record.addedNodes, node => (isOwn(node) ? '' : node.textContent || '')))));
  if (HEADER.test(text)) armedUntil = Date.now() + ARM_MS;
  if (Date.now() > armedUntil) return;
  buffer += `${text}\n`;
  const added = mine.flatMap(record => Array.from(record.addedNodes)).filter(node => !isOwn(node));
  if (added.length) lastNode = added[added.length - 1];
  clearTimeout(timer);
  timer = setTimeout(flush, SETTLE_MS);
});
observer.observe(content, { subtree: true, childList: true, characterData: true });
})();

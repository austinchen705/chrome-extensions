// 鑑定出來的裝備（以及 view 身上裝備）的「此物名曰」區塊：不碰 DOM，content script 與測試共用。
//
// 區塊長這樣（標籤中間有空白；品階、屬性、潛能不一定有；屬性可多行、數值可為負）：
//   此物名曰 ：鋼盔甲，盔甲類防具
//   防 禦 力 ：37 / 37            （武器是「傷 害 力 ：48 / 48」）
//   屬    性 ：+2   行動
//   佩帶條件 ：[使用者 xxx，]經驗 60000
// 區塊之間會夾雜文字圖案、「特殊物品非無名裝備…」、「共鑑定…」這類行：不認得的行一律略過，
// 不能被當成屬性，也不能讓區塊切壞。
(() => {
if (globalThis.CatworldZapEquipment) return;

const HEADER = /此物名曰\s*[：:]\s*(.+?)\s*[，,]\s*(\S+類(?:武器|防具))/;
const WEAPON_PRIMARY = /傷\s*害\s*力\s*[：:]\s*(\d+)\s*\/\s*\d+/;
const ARMOR_PRIMARY = /防\s*禦\s*力\s*[：:]\s*(\d+)\s*\/\s*\d+/;
const ATTRIBUTE = /^\s*屬\s*性\s*[：:]\s*([+-]?\d+)\s+(\S+)\s*$/;
const NEED_EXP = /佩帶條件\s*[：:](?:\s*使用者\s*[^，,]+[，,])?\s*經驗\s*(\d+)/;

// 遊戲各處對同一個屬性的寫法不一致（補助／輔助、回復／恢復）
const normalizeAttrName = name => String(name ?? '').trim().replace(/補助/g, '輔助').replace(/回復/g, '恢復');

function parseEquipmentBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      current = {
        name: header[1].trim(),
        category: header[2],
        kind: header[2].endsWith('武器') ? 'weapon' : 'armor',
        primary: null,
        attrs: [],
        needExp: null,
        raw: line,
      };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    current.raw += `\n${line}`;
    const primary = (current.kind === 'weapon' ? WEAPON_PRIMARY : ARMOR_PRIMARY).exec(line);
    if (primary) current.primary = Number(primary[1]);
    const attribute = ATTRIBUTE.exec(line);
    if (attribute) current.attrs.push({ name: normalizeAttrName(attribute[2]), value: Number(attribute[1]) });
    const need = NEED_EXP.exec(line);
    if (need) current.needExp = Number(need[1]);
  }
  return blocks;
}

// ---- 比較 ----
// 規則（使用者定的：先比攻擊力／防禦力，再比附加屬性，和自己主要武器類型相關的屬性加分）：
// 主要數值相差 PRIMARY_GAP 以上就以高者為準；差不多再比屬性分數（相關屬性每點 2 分、其他每點 1 分、負值照扣）。
// PRIMARY_GAP 與權重是設計者的猜測，之後依實際使用校準。
const PRIMARY_GAP = 3;
const IGNORED_ATTRS = ['重量', '硬度', '潛能', '損修'];
const RELATED_BY_WEAPON = {
  劍: ['劍術', '劍法'], 刀: ['刀術', '刀法'], 杖: ['棒法', '杖法'], 鞭: ['鞭法'], 拳套: ['拳腳'], 暗器: ['暗器', '暗器使用'],
};

// 「攻擊」對任何人都算相關；主要武器類型沒設定或不認得時只有「攻擊」
const relatedAttrNames = mainWeapon => ['攻擊', ...(RELATED_BY_WEAPON[mainWeapon] ?? [])];

function scoreAttrs(attrs, related) {
  return attrs
    .filter(attr => !IGNORED_ATTRS.includes(attr.name))
    .reduce((sum, attr) => sum + attr.value * (related.includes(attr.name) ? 2 : 1), 0);
}

const VERDICT_TEXT = { better: '比現在好，建議留下', worse: '比現在差', equal: '相當', none: '沒有基準可比' };

// baseline 是「同類別」現在穿的清單（呼叫端先依類別取出）；同類別有好幾件時（兩枚戒指）和最弱的那一件比，
// 這樣比較差的裝備不可能被標成比較好
function compareEquipment(candidate, baseline, { mainWeapon, exp } = {}) {
  const blocked = Number.isFinite(exp) && candidate.needExp !== null && candidate.needExp > exp;
  const none = { verdict: 'none', text: VERDICT_TEXT.none, reasons: [], against: null, blocked };
  const usable = (baseline ?? []).filter(item => item.primary !== null);
  if (candidate.primary === null || !usable.length) return none;
  const related = relatedAttrNames(mainWeapon);
  const weakest = usable
    .map(item => ({ item, score: scoreAttrs(item.attrs, related) }))
    .sort((a, b) => a.item.primary - b.item.primary || a.score - b.score)[0];
  const diff = candidate.primary - weakest.item.primary;
  const reasons = [];
  if (diff !== 0) reasons.push(`${candidate.kind === 'weapon' ? '傷害' : '防禦'} ${diff > 0 ? '+' : ''}${diff}`);
  const valueOf = (attrs, name) => attrs.find(attr => attr.name === name)?.value ?? 0;
  const names = [...new Set([...candidate.attrs, ...weakest.item.attrs].map(attr => attr.name))].filter(name => !IGNORED_ATTRS.includes(name));
  names.forEach(name => {
    const delta = valueOf(candidate.attrs, name) - valueOf(weakest.item.attrs, name);
    if (delta > 0) reasons.push(`多了 ${name} +${delta}`);
    else if (delta < 0) reasons.push(`少了 ${name} +${-delta}`);
  });
  const scoreDiff = scoreAttrs(candidate.attrs, related) - weakest.score;
  const decided = Math.abs(diff) >= PRIMARY_GAP ? diff : scoreDiff;
  const verdict = decided > 0 ? 'better' : decided < 0 ? 'worse' : 'equal';
  return { verdict, text: VERDICT_TEXT[verdict], reasons, against: weakest.item.name, blocked };
}

// ---- 基準（現在穿的裝備）----
// Store = { [類別]: [ { name, primary, attrs, needExp, readAt } ] }；同類別可能穿兩件（兩枚戒指），所以是清單
const toBaselineItem = (block, now) => ({
  name: block.name, primary: block.primary, attrs: block.attrs, needExp: block.needExp, readAt: now,
});

function replaceBaseline(blocks, now) {
  const store = {};
  blocks.forEach(block => {
    (store[block.category] ??= []).push(toBaselineItem(block, now));
  });
  return store;
}

function upsertBaseline(store, block, now) {
  const list = [...(store[block.category] ?? [])];
  const index = list.findIndex(item => item.name === block.name);
  const item = toBaselineItem(block, now);
  if (index >= 0) list[index] = item;
  else list.push(item);
  return { ...store, [block.category]: list };
}

// 背包（i）輸出裡穿著的行：有「ˇ」標記，同一行有 view #編號 的連結（武器是 unwield）。
// 名稱常被 <span> 拆開（「金線」＋「手套」），去掉標籤後取到「(英文 id)」之前
function parseWornHtml(html) {
  const worn = [];
  for (const line of String(html ?? '').split(/\r?\n/)) {
    const id = /target="view #(\d+)"/.exec(line)?.[1];
    if (!line.includes('ˇ') || !id) continue;
    const text = line.replace(/<[^>]*>/g, '');
    const name = /ˇ\s*([^(\s]+?)\s*\(/.exec(text)?.[1];
    if (name) worn.push({ name, id, weapon: /target="unwield #/.test(line) });
  }
  return worn;
}

// ---- 鑑定過程追蹤 ----
// 「你想請…鑑定所有無名物」到「共鑑定…樣無名物」之間出現的區塊是候選（要和基準比），之外的區塊（自己 view 的）
// 只用來更新基準。區塊可能跨封包：新增的文字先放進緩衝，呼叫端靜止一小段時間後呼叫 flush 才一次解析。
const RUN_START = /你想請[^\n]{0,12}鑑定所有無名物/;
const RUN_END = /共鑑定[^\n，。]{0,8}樣無名物/;

function createTracker({ runTimeoutMs = 30000 } = {}) {
  let segments = [];
  let inRun = false;
  let lastActivity = 0;
  let worn = [];

  function feed(text, now) {
    let rest = String(text ?? '');
    while (rest) {
      const marker = (inRun ? RUN_END : RUN_START).exec(rest);
      if (!marker) {
        segments.push({ text: rest, inRun });
        if (inRun && rest.includes('此物名曰')) lastActivity = now;
        return;
      }
      const cut = marker.index + marker[0].length;
      const head = inRun ? rest.slice(0, cut) : rest.slice(0, marker.index);
      if (head) segments.push({ text: head, inRun });
      if (inRun && head.includes('此物名曰')) lastActivity = now;
      inRun = !inRun;
      if (inRun) lastActivity = now;
      rest = rest.slice(cut);
    }
  }

  function flush() {
    const groups = [];
    segments.forEach(segment => {
      const last = groups[groups.length - 1];
      if (last && last.inRun === segment.inRun) last.text += segment.text;
      else groups.push({ ...segment });
    });
    segments = [];
    const result = { candidates: [], passive: [] };
    groups.forEach(group => {
      result[group.inRun ? 'candidates' : 'passive'].push(...parseEquipmentBlocks(group.text));
    });
    return result;
  }

  return {
    feed,
    flush,
    running: now => inRun && now - lastActivity <= runTimeoutMs,
    setWorn: list => { worn = list; },
    wornNames: () => worn.map(item => item.name),
    isPassiveUpdatable: name => worn.filter(item => item.name === name).length === 1,
  };
}

globalThis.CatworldZapEquipment = {
  PRIMARY_GAP, IGNORED_ATTRS, normalizeAttrName, parseEquipmentBlocks, relatedAttrNames, scoreAttrs, compareEquipment,
  toBaselineItem, replaceBaseline, upsertBaseline, parseWornHtml, createTracker,
};
})();

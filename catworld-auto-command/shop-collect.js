// 商人裝備資料庫：玩家在商人面前自己打 list 與 check N（check 要付錢，工具絕不代送），這裡只記錄與比對。
// check 的輸出和鑑定後的裝備同一種「此物名曰」區塊，解析共用 zap-equipment.js；每件裝備以名稱為鍵存進
// chrome.storage.local.shopItems（{ 名稱: { name, category, kind, primary, attrs, needExp, seen } }，不分店、同名後讀的覆蓋）。
// 打 list 時：用目前經驗與「讀取目前穿著」的基準比對資料庫，在 list 那一頁的輸出下面插一塊摘要
// （比現在好的編號、還沒蒐集的編號與可複製的 check 指令）；摘要受「無名物品鑑定提示與裝備比較」開關控制，蒐集不受影響。
(() => {
if (globalThis.CatworldShopCollect) return;

const DB_KEY = 'shopItems';
const SETTLE_MS = 600;
const ARM_MS = 3000;
const BETTER_MAX = 12;
const UNKNOWN_MAX = 40;
const CHECK_PHRASE = /你付了一筆錢給商人/;
// 「 1 黃金鎖鍊              價格：60S       2 虹色項鍊 …」一行兩項；名稱沒有空白
const LIST_ITEM = /(\d{1,3})\s+(\S+?)\s+價格\s*[：:]\s*(\S+)/g;

function parseList(text) {
  return [...String(text ?? '').matchAll(LIST_ITEM)].map(match => ({ no: Number(match[1]), name: match[2], price: match[3] }));
}

const entryFrom = (block, now) => ({
  name: block.name, category: block.category, kind: block.kind, primary: block.primary, attrs: block.attrs, needExp: block.needExp, seen: now,
});

// 設定頁顯示與複製用：依類別與名稱排序，每列是 [名稱, 類別, 主要數值, 佩帶經驗, 屬性]
function rows(db) {
  return Object.values(db || {})
    .sort((a, b) => `${a.category}/${a.name}`.localeCompare(`${b.category}/${b.name}`))
    .map(item => [item.name, item.category, item.primary ?? '', item.needExp ?? '', (item.attrs || []).map(attr => `${attr.name}${attr.value >= 0 ? '+' : ''}${attr.value}`).join(' ')]);
}

// 把 list 這一頁的項目逐一和資料庫比：沒蒐集過的放 unknown；蒐集過的用 compareEquipment 比（同類別、和現在穿的最弱的比），
// 還穿不了的只計數，比現在好（含屬性達門檻）的放 better，沒有基準可比的只計數
function evaluate(items, db, { exp, baseline, mainWeapon, keep } = {}) {
  const E = globalThis.CatworldZapEquipment;
  const out = { total: items.length, known: 0, better: [], unknown: [], tooHigh: 0, noBaseline: 0 };
  items.forEach(item => {
    const entry = db?.[item.name];
    if (!entry) { out.unknown.push(item.no); return; }
    out.known += 1;
    const result = E.compareEquipment(entry, baseline?.[entry.category], { mainWeapon, exp, keep });
    if (result.blocked) out.tooHigh += 1;
    else if (result.verdict === 'better' || result.verdict === 'keep') out.better.push({ ...item, reasons: result.reasons.slice(0, 3).join('，') });
    else if (result.verdict === 'none') out.noBaseline += 1;
  });
  return out;
}

const checkCommand = numbers => numbers.map(no => `check ${no}`).join(';');

function summaryLines(result, exp) {
  const lines = [`【裝備資料庫】經驗 ${Number.isFinite(exp) ? exp : '讀不到'}　這頁 ${result.total} 件，已蒐集 ${result.known} 件`];
  if (result.better.length) {
    const shown = result.better.slice(0, BETTER_MAX).map(item => `${item.no} ${item.name}${item.reasons ? `（${item.reasons}）` : ''}`);
    lines.push(`比現在好：${shown.join('；')}${result.better.length > BETTER_MAX ? `…共 ${result.better.length} 件` : ''}`);
  } else if (result.known) lines.push('比現在好：沒有');
  if (result.tooHigh) lines.push(`經驗還不夠穿：${result.tooHigh} 件`);
  if (result.noBaseline) lines.push(`沒有目前穿著的資料可比：${result.noBaseline} 件（先用面板的「讀取目前穿著」）`);
  if (result.unknown.length) lines.push(`還沒蒐集（${result.unknown.length}）：${result.unknown.slice(0, UNKNOWN_MAX).join(' ')}${result.unknown.length > UNKNOWN_MAX ? ' …' : ''}`);
  return lines;
}

globalThis.CatworldShopCollect = { parseList, entryFrom, rows, evaluate, checkCommand, summaryLines, DB_KEY };

const content = typeof document === 'undefined' ? null : document.getElementById('content');
if (!content || !globalThis.chrome?.storage?.local || !globalThis.CatworldZapMobs || !globalThis.CatworldZapEquipment) return;

const OWN = 'data-catworld-shop';
const isOwn = node => {
  const element = node.nodeType === 1 ? node : node.parentElement;
  return Boolean(element?.closest?.(`[${OWN}]`));
};
const characterName = () => (/ - /.test(document.title) ? document.title.split(' - ')[0].trim() : '');
const readExp = () => Number(String(document.getElementById('exp')?.textContent || '').replace(/[,\s]/g, '')) || NaN;

let buffer = '';
let lastNode = null;
let timer = null;
let armedUntil = 0;
let lastAnchor = null;

function showSummary(items, data, db) {
  const E = globalThis.CatworldZapEquipment;
  const exp = readExp();
  const result = evaluate(items, db, {
    exp,
    baseline: data.wornEquipment?.[characterName()],
    mainWeapon: data.mainWeapon,
    keep: E.normalizeKeepRule(data.equipmentKeep),
  });
  const box = document.createElement('div');
  box.setAttribute(OWN, '');
  Object.assign(box.style, { border: '1px dashed #bbbbbb', padding: '4px 8px', margin: '4px 0', whiteSpace: 'pre-wrap' });
  summaryLines(result, exp).forEach(line => {
    const row = document.createElement('div');
    row.textContent = line;
    box.append(row);
  });
  if (result.unknown.length) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '複製 check 指令';
    button.addEventListener('click', async event => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(checkCommand(result.unknown));
        button.textContent = `已複製 ${result.unknown.length} 個 check`;
      } catch {
        button.textContent = '複製失敗';
      }
    });
    box.append(button);
  }
  if (lastAnchor?.isConnected) lastAnchor.after(box);
  else content.append(box);
  box.scrollIntoView?.({ block: 'nearest' });
}
async function flush() {
  const text = buffer;
  lastAnchor = lastNode;
  buffer = '';
  lastNode = null;
  timer = null;
  armedUntil = 0;
  try {
    const data = await chrome.storage.local.get([DB_KEY, 'zapFeatures', 'wornEquipment', 'mainWeapon', 'equipmentKeep']);
    let db = data[DB_KEY] || {};
    const at = text.search(CHECK_PHRASE);
    if (at >= 0) {
      const blocks = globalThis.CatworldZapEquipment.parseEquipmentBlocks(text.slice(at));
      if (blocks.length) {
        db = { ...db };
        blocks.forEach(block => { db[block.name] = entryFrom(block, Date.now()); });
        await chrome.storage.local.set({ [DB_KEY]: db });
      }
    }
    const items = parseList(text);
    if (items.length && data.zapFeatures?.items === true) showSummary(items, data, db);
  } catch {
    // 擴充功能重新載入後留在頁面上的舊程式連不上儲存：不再收集，新程式會接手
    observer.disconnect();
  }
}

const observer = new MutationObserver(records => {
  const mine = records.filter(record => !isOwn(record.target));
  const texts = mine.flatMap(record => (record.type === 'characterData'
    ? [record.target.textContent || '']
    : Array.from(record.addedNodes, node => (isOwn(node) ? '' : node.textContent || ''))));
  const text = CatworldZapMobs.textFromAdded(texts);
  if (CHECK_PHRASE.test(text)) armedUntil = Date.now() + ARM_MS;
  // check 的輸出可能分成好幾批到，叫出來之後 ARM_MS 內的新文字都接上去
  if (!/價格\s*[：:]/.test(text) && Date.now() > armedUntil) return;
  buffer += text;
  const added = mine.flatMap(record => Array.from(record.addedNodes)).filter(node => !isOwn(node));
  if (added.length) lastNode = added[added.length - 1];
  clearTimeout(timer);
  timer = setTimeout(flush, SETTLE_MS);
});
observer.observe(content, { subtree: true, childList: true, characterData: true });
})();

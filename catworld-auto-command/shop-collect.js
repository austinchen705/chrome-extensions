// 商人裝備資料庫：玩家在商人面前自己打 list 與 check N（check 要付錢，工具絕不代送），這裡只記錄與比對。
// check 的輸出和鑑定後的裝備同一種「此物名曰」區塊，解析共用 zap-equipment.js；每件裝備以名稱為鍵存進
// chrome.storage.local.shopItems（{ 名稱: { name, category, kind, primary, attrs, needExp, seen } }，不分店、同名後讀的覆蓋）。
// 資料庫裡可靠的是「類別」與「佩帶經驗」（等級）；同名裝備的傷害、屬性不一定一樣，所以 list 的推薦只看等級：
// 打 list 時，用目前經驗與「讀取目前穿著」的基準，在 list 那一頁的輸出下面插一塊摘要——穿得了、而且佩帶經驗比現在穿的同類別高的
// 列為「建議 check」，還沒蒐集的列為「還沒蒐集」（先蒐集才有等級可比），兩者都有批次 check 按鈕；check 之後再用那件實際的數值和身上的比。整個功能（蒐集、回報、摘要）由設定頁「輔助功能」的「裝備資料庫」開關
// （chrome.storage.local.zapFeatures.shop）控制，缺值＝關閉。
(() => {
if (globalThis.CatworldShopCollect) return;

const DB_KEY = 'shopItems';
const SETTLE_MS = 600;
const ARM_MS = 3000;
const SUGGEST_MAX = 12;
const UNKNOWN_MAX = 40;
// 一次批次 check 最多幾個（每個都要付錢，一次不要放太多；沒蒐集的比這個多就分幾次按）
const BATCH_MAX = 40;
const CHECK_PHRASE = /你付了一筆錢給商人/;
// 「 1 黃金鎖鍊              價格：60S       2 虹色項鍊 …」一行兩項；名稱沒有空白
const LIST_ITEM = /(\d{1,3})\s+(\S+?)\s+價格\s*[：:]\s*(\S+)/g;

// 價格寫法是「1G40S」「16S50C」「30C」：1G＝100S、1S＝100C。讀不懂回 null
function parsePrice(text) {
  const match = /^(?:(\d+)G)?(?:(\d+)S)?(?:(\d+)C)?$/i.exec(String(text ?? '').trim());
  if (!match || !match[0]) return null;
  return Number(match[1] || 0) * 10000 + Number(match[2] || 0) * 100 + Number(match[3] || 0);
}
function formatMoney(coppers) {
  const gold = Math.floor(coppers / 10000);
  const silver = Math.floor((coppers % 10000) / 100);
  const copper = coppers % 100;
  return [gold && `${gold}G`, silver && `${silver}S`, copper && `${copper}C`].filter(Boolean).join('') || '0C';
}
// check 的費用只有幾筆實測：約是價格的 5%，有幾筆比 5% 多一點（最多約再多 5%），所以預估寫成一個範圍；
// 不是準確值（進位規則不明），小額與 2G 以上還沒有實測
const CHECK_RATE = 0.05;
const CHECK_SLACK = 1.05;
function checkCost(prices) {
  const base = prices.reduce((sum, price) => sum + price * CHECK_RATE, 0);
  return { low: Math.floor(base), high: Math.ceil(base * CHECK_SLACK) };
}

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

// 把 list 這一頁的項目逐一和資料庫比：沒蒐集過的放 unknown；蒐集過的只看佩帶經驗（等級）：
// 經驗不夠穿的只計數；穿得了的和「現在穿的同類別裡佩帶經驗最低的那件」（最該換掉的）比，要求經驗更高的放 suggest（建議 check），
// 不比它高的只計數；同類別沒有穿著資料可比的只計數。傷害、屬性不拿來判斷（同名裝備的數值可能不同）
function evaluate(items, db, { exp, baseline } = {}) {
  const out = { total: items.length, known: 0, suggest: [], unknown: [], unknownPrices: [], unknownItems: [], tooHigh: 0, notHigher: 0, noBaseline: 0 };
  items.forEach(item => {
    const entry = db?.[item.name];
    if (!entry) {
      out.unknown.push(item.no);
      const price = parsePrice(item.price);
      out.unknownItems.push({ no: item.no, price });
      if (price !== null) out.unknownPrices.push(price);
      return;
    }
    out.known += 1;
    const level = entry.needExp ?? 0;
    if (Number.isFinite(exp) && level > exp) { out.tooHigh += 1; return; }
    const worn = (baseline?.[entry.category] ?? []).slice().sort((a, b) => (a.needExp ?? 0) - (b.needExp ?? 0))[0];
    if (!worn) out.noBaseline += 1;
    else if (level > (worn.needExp ?? 0)) out.suggest.push({ ...item, level, against: worn.name, wornLevel: worn.needExp ?? 0 });
    else out.notHigher += 1;
  });
  out.suggest.sort((a, b) => b.level - a.level || a.no - b.no);
  return out;
}

const checkCommand = numbers => numbers.map(no => `check ${no}`).join(';');

function summaryLines(result, exp, pages = 1) {
  const lines = [`【裝備資料庫】經驗 ${Number.isFinite(exp) ? exp : '讀不到'}　${pages > 1 ? `累計 ${pages} 頁` : '這頁'} ${result.total} 件，已蒐集 ${result.known} 件`];
  if (result.suggest.length) {
    const shown = result.suggest.slice(0, SUGGEST_MAX).map(item => `${item.no} ${item.name}（需經驗 ${item.level}，現穿 ${item.against} ${item.wornLevel}）`);
    lines.push(`建議 check（穿得了、佩帶經驗比現在穿的高；實際數值 check 後才知道）：${shown.join('；')}${result.suggest.length > SUGGEST_MAX ? `…共 ${result.suggest.length} 件` : ''}`);
  } else if (result.known) lines.push('建議 check：沒有');
  if (result.tooHigh) lines.push(`經驗還不夠穿：${result.tooHigh} 件`);
  if (result.notHigher) lines.push(`佩帶經驗不比現在穿的高：${result.notHigher} 件`);
  if (result.noBaseline) lines.push(`沒有目前穿著的資料可比：${result.noBaseline} 件（先用面板的「讀取目前穿著」）`);
  if (result.unknown.length) {
    const cost = checkCost(result.unknownPrices);
    const unpriced = result.unknown.length - result.unknownPrices.length;
    lines.push(`還沒蒐集（${result.unknown.length}）：${result.unknown.slice(0, UNKNOWN_MAX).join(' ')}${result.unknown.length > UNKNOWN_MAX ? ' …' : ''}`);
    lines.push(`全部 check 預估約 ${formatMoney(cost.low)}～${formatMoney(cost.high)}（價格的 5% 上下，不是準確值${unpriced ? `；${unpriced} 件讀不到價格沒算` : ''}）`);
  }
  return lines;
}

// 批次 check 的送出由 content.js 注入（交給巨集執行器依序送，遵守指令間隔、驗證碼偵測與停止）；沒注入就送不出去
let sender = null;
const setSender = fn => { sender = typeof fn === 'function' ? fn : null; };

globalThis.CatworldShopCollect = { setSender, BATCH_MAX, parsePrice, formatMoney, checkCost, parseList, entryFrom, rows, evaluate, checkCommand, summaryLines, DB_KEY };

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

function newBox() {
  const box = document.createElement('div');
  box.setAttribute(OWN, '');
  Object.assign(box.style, { border: '1px dashed #bbbbbb', padding: '4px 8px', margin: '4px 0', whiteSpace: 'pre-wrap' });
  return box;
}
function place(box) {
  if (lastAnchor?.isConnected) lastAnchor.after(box);
  else content.append(box);
  box.scrollIntoView?.({ block: 'nearest' });
}

// 剛 check 到的這件和現在穿的同類別比（用這次的實際數值，不是資料庫裡同名的舊資料）
function judge(block, data) {
  const E = globalThis.CatworldZapEquipment;
  const baseline = data.wornEquipment?.[characterName()]?.[block.category];
  const result = E.compareEquipment(block, baseline, { mainWeapon: data.mainWeapon, exp: readExp(), keep: E.normalizeKeepRule(data.equipmentKeep) });
  if (result.blocked) return `和現在穿的比：經驗還不夠穿（需要 ${block.needExp}）`;
  if (result.verdict === 'none') return '和現在穿的比：沒有這個類別的穿著資料可比（先用面板的「讀取目前穿著」）';
  return `和現在穿的 ${result.against} 比：${result.text}${result.reasons.length ? `（${result.reasons.slice(0, 3).join('，')}）` : ''}`;
}
const sameStats = (a, b) => a.primary === b.primary && JSON.stringify(a.attrs) === JSON.stringify(b.attrs);

// check 之後在輸出下面回報：有沒有記進資料庫、和現在穿的比如何；同名裝備的數值和資料庫舊資料不同要提醒（同名不代表數值一樣）；
// 這次 check 沒有裝備資料（沒記）也要說，不然看不出是沒記還是沒反應
function showRecorded(blocks, before, after, data) {
  const box = newBox();
  const lines = blocks.length
    ? blocks.flatMap(block => [
      `已記進裝備資料庫：${block.name}（${block.category}，${block.kind === 'weapon' ? '傷害' : '防禦'} ${block.primary ?? '?'}，佩帶經驗 ${block.needExp ?? '無'}）${before[block.name] ? '，更新舊資料' : ''}`,
      ...(before[block.name] && !sameStats(before[block.name], block) ? [`注意：同名裝備的數值和資料庫舊資料不同（傷害／防禦 ${before[block.name].primary ?? '?'} → ${block.primary ?? '?'}），已改成這次的`] : []),
      judge(block, data),
    ])
    : ['這次 check 的輸出裡沒有裝備資料（不是裝備，或格式讀不懂），沒有記錄'];
  if (blocks.length) lines.push(`資料庫共 ${Object.keys(after).length} 件`);
  lines.forEach(line => {
    const row = document.createElement('div');
    row.textContent = line;
    box.append(row);
  });
  place(box);
}

const button = (text, onClick) => {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = text;
  node.addEventListener('click', event => { event.stopPropagation(); onClick(); });
  return node;
};

// 「批次 check」：先顯示個數與預估費用，玩家按了確認才送（check 要付錢）；用注入的 sender（巨集）依序送。
// 一次最多 BATCH_MAX 個，多的分批：送完一批出現「下一批」按鈕，接著送後面的（不會重送已送的）。list: [{ no, price }]
function batchControls(label, list) {
  let offset = 0;
  const area = document.createElement('div');
  const startButton = () => {
    const batch = list.slice(offset, offset + BATCH_MAX);
    const cost = checkCost(batch.map(item => item.price).filter(price => price !== null));
    const range = `${formatMoney(cost.low)}～${formatMoney(cost.high)}`;
    const start = button(`批次 check ${label} ${offset > 0 ? '下一批 ' : ''}${batch.length} 個（約 ${range}）`, () => {
      const confirmRow = document.createElement('div');
      confirmRow.append(
        `將依序送出 ${batch.length} 個 check，預估約 ${range}，確認嗎？`,
        button('確認送出', () => {
          const started = sender ? sender(checkCommand(batch.map(item => item.no))) : false;
          if (started === false || !sender) {
            confirmRow.replaceChildren('送不出去（找不到送指令的功能，或指令格式錯誤）');
            return;
          }
          offset += batch.length;
          area.replaceChildren(`已開始送出 ${batch.length} 個 check，要中止請按面板巨集那一列的「停止」`);
          if (offset < list.length) {
            const rest = document.createElement('div');
            rest.append(`還有 ${list.length - offset} 個：`, startButton());
            area.append(rest);
          } else {
            area.append(' 全部送完了；check 完再打一次 list，推薦會重新整理。');
          }
        }),
        button('取消', () => area.replaceChildren(start)),
      );
      area.replaceChildren(confirmRow);
    });
    return start;
  };
  area.append(startButton());
  return area;
}

function showSummary(items, data, db, pages = 1) {
  const exp = readExp();
  const result = evaluate(items, db, { exp, baseline: data.wornEquipment?.[characterName()] });
  const box = newBox();
  summaryLines(result, exp, pages).forEach(line => {
    const row = document.createElement('div');
    row.textContent = line;
    box.append(row);
  });
  // 建議的要 check 才知道這一件實際的數值（check 之後會立刻和身上的比）；沒蒐集的 check 之後才進資料庫、有等級可比
  if (result.suggest.length) box.append(batchControls('建議的', result.suggest.map(item => ({ no: item.no, price: parsePrice(item.price) }))));
  if (result.unknown.length) {
    box.append(batchControls('還沒蒐集的', result.unknownItems));
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '複製 check 指令（貼進遊戲巨集用）';
    copy.addEventListener('click', async event => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(checkCommand(result.unknown));
        copy.textContent = `已複製 ${result.unknown.length} 個 check`;
      } catch {
        copy.textContent = '複製失敗';
      }
    });
    box.append(copy);
  }
  place(box);
  return box;
}
// 同一次 list 的好幾頁累計在一起（編號是接著數的）：list 的第一頁有「商人現在有賣以下貨物」開頭就重新開始，沒有開頭的頁
// 併進目前這一次；超過 SESSION_MS 沒新的頁也重新開始。每一頁的摘要是累計的，新的出現時舊的那塊拿掉，這樣批次按鈕只有最新的一組
const LIST_HEADER = /商人現在有賣以下貨物/;
const SESSION_MS = 10 * 60 * 1000;
let session = { items: new Map(), pages: 0, at: 0, box: null };

async function flush() {
  const text = buffer;
  lastAnchor = lastNode;
  buffer = '';
  lastNode = null;
  timer = null;
  armedUntil = 0;
  try {
    const data = await chrome.storage.local.get([DB_KEY, 'zapFeatures', 'wornEquipment', 'mainWeapon', 'equipmentKeep']);
    if (data.zapFeatures?.shop !== true) return;
    let db = data[DB_KEY] || {};
    const at = text.search(CHECK_PHRASE);
    if (at >= 0) {
      const blocks = globalThis.CatworldZapEquipment.parseEquipmentBlocks(text.slice(at));
      const before = db;
      if (blocks.length) {
        db = { ...db };
        blocks.forEach(block => { db[block.name] = entryFrom(block, Date.now()); });
        await chrome.storage.local.set({ [DB_KEY]: db });
      }
      showRecorded(blocks, before, db, data);
    }
    const items = parseList(text);
    if (items.length) {
      const now = Date.now();
      if (LIST_HEADER.test(text) || now - session.at > SESSION_MS) session = { items: new Map(), pages: 0, at: now, box: null };
      items.forEach(item => session.items.set(item.no, item));
      session.pages += 1;
      session.at = now;
      session.box?.remove();
      session.box = showSummary([...session.items.values()].sort((a, b) => a.no - b.no), data, db, session.pages);
    }
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

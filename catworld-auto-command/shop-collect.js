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
// 沒資料的商品，價格低於這個（單位 S）的不列入批次 check（食物、藥草之類便宜的非裝備，check 要錢又沒用）；0＝都 check
const MIN_PRICE_KEY = 'shopMinPrice';
const DEFAULT_MIN_SILVER = 5;
const normalizeMinSilver = value => (Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_SILVER);
// 快速購買：list 裡名稱和設定一樣的商品（用、逗號或分號分隔）全部一鍵買（遊戲的 buy 不能帶數量，每個編號 buy 一次）。
// 名稱清單存 chrome.storage.local.shopBuyNames（字串），缺值用預設；一次最多 BUY_MAX 個編號
const BUY_NAMES_KEY = 'shopBuyNames';
const DEFAULT_BUY_NAMES = '無名物品、無名藥草、不知名藥草';
const BUY_MAX = 20;
const parseNames = (value, fallback) => String(typeof value === 'string' ? value : fallback).split(/[、,，;；\s]+/).filter(Boolean);
const buyNames = value => parseNames(value, DEFAULT_BUY_NAMES);
// 不 check 名單：名稱「含有」其中任何一個詞的商品（例如馬：赤兔馬、白馬、烏黑駒，含「自由行走的花的赤兔馬」）不進批次 check、
// 也不算沒蒐集或這一頁的件數，只在摘要註明略過幾件。存 chrome.storage.local.shopSkipNames（字串，空字串＝都不略過），缺值用預設
const SKIP_NAMES_KEY = 'shopSkipNames';
const DEFAULT_SKIP_NAMES = '赤兔馬、白馬、烏黑駒、自由行走的花的赤兔馬';
const skipNames = value => parseNames(value, DEFAULT_SKIP_NAMES);
// 已知不是裝備的商品（精確比對名稱）：不 check、不算沒蒐集。內建的是作者 check 過的雜物；另外 check 之後輸出裡沒有「此物名曰」
// 裝備區塊的商品會自動記進 chrome.storage.local.shopNonEquip（名稱陣列），之後也一樣略過
const NON_EQUIP_KEY = 'shopNonEquip';
const BUILTIN_NON_EQUIPMENT = [
  '破扇子', '破舊八卦鏡', '鑼', '假玉佩', '玉手鐲', '黑耀石球', '彈珠', '祖母綠', '奶茶兔吊飾', '粉兔兔吊飾',
  '明朝古董木雕', '木如意', '三彩翠玉', '斷掉的玉釵', '銅燈', '馬蹄鐵', '唸珠', '象牙箸', '夜壺', '照妖鏡',
];
const nonEquipSet = learned => new Set([...BUILTIN_NON_EQUIPMENT, ...(Array.isArray(learned) ? learned.filter(name => typeof name === 'string') : [])]);
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

// 內建的商人裝備（shop-data.js，由 tools/gen-shop-data.js 從 docs/data/shop-items.tsv 產生）和個人 check 的紀錄合併，個人的優先；
// 只在讀取時合併、不寫回儲存。內建資料只有類別與佩帶經驗可靠（同名裝備的傷害、屬性不一定相同），list 的建議只看這兩個
let builtinCache = null;
function builtinDb() {
  if (builtinCache) return builtinCache;
  builtinCache = {};
  (globalThis.CatworldShopData || []).forEach(([name, category, primary, needExp, attrs]) => {
    builtinCache[name] = { name, category, kind: category.endsWith('武器') ? 'weapon' : 'armor', primary, attrs: attrs.map(([attr, value]) => ({ name: attr, value })), needExp, builtin: true };
  });
  return builtinCache;
}
const withBuiltin = db => ({ ...builtinDb(), ...(db || {}) });

// 設定頁顯示與複製用：依類別與名稱排序，每列是 [名稱, 類別, 主要數值, 佩帶經驗, 屬性]
function rows(db) {
  return Object.values(db || {})
    .sort((a, b) => `${a.category}/${a.name}`.localeCompare(`${b.category}/${b.name}`))
    .map(item => [item.name, item.category, item.primary ?? '', item.needExp ?? '', (item.attrs || []).map(attr => `${attr.name}${attr.value >= 0 ? '+' : ''}${attr.value}`).join(' ')]);
}

// 把 list 這一頁的項目逐一和資料庫比：沒蒐集過的放 unknown；蒐集過的只看佩帶經驗（等級）：
// 經驗不夠穿的只計數；穿得了的和「現在穿的同類別裡佩帶經驗最低的那件」（最該換掉的）比，要求經驗更高的放 suggest（建議 check），
// 不比它高的只計數；同類別沒有穿著資料可比的只計數。傷害、屬性不拿來判斷（同名裝備的數值可能不同）
function evaluate(items, db, { exp, baseline, minPrice = 0, skip = [], nonEquip = new Set() } = {}) {
  const out = { total: 0, skipped: 0, nonEquipment: 0, known: 0, suggest: [], unknown: [], unknownPrices: [], unknownItems: [], cheap: 0, tooHigh: 0, notHigher: 0, noBaseline: 0 };
  items.forEach(item => {
    if (skip.some(word => item.name.includes(word))) { out.skipped += 1; return; }
    if (nonEquip.has(item.name)) { out.nonEquipment += 1; return; }
    out.total += 1;
    const entry = db?.[item.name];
    if (!entry) {
      out.unknown.push(item.no);
      const price = parsePrice(item.price);
      // 價格低於門檻的只算在 unknown（還是沒蒐集），不進批次與費用預估；讀不到價格的照樣 check
      if (price !== null && price < minPrice) { out.cheap += 1; return; }
      out.unknownItems.push({ no: item.no, name: item.name, price });
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

// check 的輸出沒有商品名稱，編號取自指令回聲（`> check 2` 單獨一行）：每個「你付了一筆錢給商人」往前找最近的回聲
// （不能越過上一個回應；第一個找不到時用 priorNo，也就是這段文字之前最後一次回聲的編號）。這段回應裡沒有「此物名曰」就不是裝備。
// 找不到編號的不回傳（寧可不學，也不要把裝備誤記成非裝備）
const ECHO_LINE = /(?:^|\n|>)[ \t]*check[ \t]+(\d+)[ \t]*(?=\r?\n|$|你付了)/g;
const lastEchoNo = text => {
  const found = [...String(text ?? '').matchAll(ECHO_LINE)];
  return found.length ? Number(found[found.length - 1][1]) : null;
};
function nonEquipmentNumbers(text, priorNo = null) {
  const starts = [...text.matchAll(new RegExp(CHECK_PHRASE.source, 'g'))].map(match => match.index);
  const echoes = [...text.matchAll(ECHO_LINE)].map(match => ({ at: match.index, no: Number(match[1]) }));
  const out = [];
  starts.forEach((start, i) => {
    const previous = i > 0 ? starts[i - 1] : -1;
    const echo = echoes.filter(item => item.at < start && item.at > previous).pop();
    const no = echo ? echo.no : (i === 0 ? priorNo : null);
    const segment = text.slice(start, i + 1 < starts.length ? starts[i + 1] : text.length);
    if (no !== null && !/此物名曰/.test(segment)) out.push(no);
  });
  return out;
}

const checkCommand = numbers => numbers.map(no => `check ${no}`).join(';');

function summaryLines(result, exp, pages = 1, minSilver = 0) {
  if (!result.total) {
    if (result.skipped) return [`【裝備資料庫】這頁 ${result.skipped} 件都在「不 check 名單」裡（例如馬），略過`];
    return result.nonEquipment ? [`【裝備資料庫】這頁 ${result.nonEquipment} 件都已確認不是裝備，略過`] : [];
  }
  const lines = [`【裝備資料庫】經驗 ${Number.isFinite(exp) ? exp : '讀不到'}　${pages > 1 ? `累計 ${pages} 頁` : '這頁'} ${result.total} 件，已蒐集 ${result.known} 件`];
  if (result.skipped) lines.push(`略過 ${result.skipped} 件（名稱含「不 check 名單」裡的字，例如馬；設定頁可調）`);
  if (result.nonEquipment) lines.push(`略過 ${result.nonEquipment} 件已確認不是裝備的商品`);
  if (result.suggest.length) {
    const shown = result.suggest.slice(0, SUGGEST_MAX).map(item => `${item.no} ${item.name}（需經驗 ${item.level}，現穿 ${item.against} ${item.wornLevel}）`);
    lines.push(`建議 check（穿得了、佩帶經驗比現在穿的高；實際數值 check 後才知道）：${shown.join('；')}${result.suggest.length > SUGGEST_MAX ? `…共 ${result.suggest.length} 件` : ''}`);
  } else if (result.known) lines.push('建議 check：沒有');
  if (result.tooHigh) lines.push(`經驗還不夠穿：${result.tooHigh} 件`);
  if (result.notHigher) lines.push(`佩帶經驗不比現在穿的高：${result.notHigher} 件`);
  if (result.noBaseline) lines.push(`沒有目前穿著的資料可比：${result.noBaseline} 件（先用面板的「讀取目前穿著」）`);
  if (result.unknown.length) {
    lines.push(`還沒蒐集（${result.unknown.length}）：${result.unknown.slice(0, UNKNOWN_MAX).join(' ')}${result.unknown.length > UNKNOWN_MAX ? ' …' : ''}`);
    if (result.cheap) lines.push(`其中 ${result.cheap} 件價格低於 ${minSilver}S，不列入批次 check（設定頁可調）`);
    if (result.unknownItems.length) {
      const cost = checkCost(result.unknownPrices);
      const unpriced = result.unknownItems.length - result.unknownPrices.length;
      lines.push(`批次 check 預估約 ${formatMoney(cost.low)}～${formatMoney(cost.high)}（價格的 5% 上下，不是準確值${unpriced ? `；${unpriced} 件讀不到價格沒算` : ''}）`);
    }
  }
  return lines;
}

// 批次 check 的送出由 content.js 注入（交給巨集執行器依序送，遵守指令間隔、驗證碼偵測與停止）；沒注入就送不出去
let sender = null;
const setSender = fn => { sender = typeof fn === 'function' ? fn : null; };

globalThis.CatworldShopCollect = { setSender, BATCH_MAX, BUY_MAX, BUY_NAMES_KEY, DEFAULT_BUY_NAMES, buyNames, SKIP_NAMES_KEY, DEFAULT_SKIP_NAMES, skipNames, MIN_PRICE_KEY, DEFAULT_MIN_SILVER, normalizeMinSilver, parsePrice, formatMoney, checkCost, parseList, entryFrom, withBuiltin, builtinDb, rows, evaluate, checkCommand, summaryLines, DB_KEY, NON_EQUIP_KEY, BUILTIN_NON_EQUIPMENT, nonEquipSet, nonEquipmentNumbers };

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
let lastEcho = null; // 最近一次看到的 check 指令回聲編號
let priorEcho = null; // buffer 開始累積時，在那之前最後一次回聲的編號

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
// kind：good（比現在好或屬性達門檻）、blocked（經驗不夠穿）、nobase（沒有同類別穿著資料）、other（不比現在好）
function classify(block, data) {
  const E = globalThis.CatworldZapEquipment;
  const baseline = data.wornEquipment?.[characterName()]?.[block.category];
  const result = E.compareEquipment(block, baseline, { mainWeapon: data.mainWeapon, exp: readExp(), keep: E.normalizeKeepRule(data.equipmentKeep) });
  const reasons = result.reasons.slice(0, 3).join('，');
  if (result.blocked) return { kind: 'blocked', text: `和現在穿的比：經驗還不夠穿（需要 ${block.needExp}）`, reasons };
  if (result.verdict === 'none') return { kind: 'nobase', text: '和現在穿的比：沒有這個類別的穿著資料可比（先用面板的「讀取目前穿著」）', reasons };
  const good = result.verdict === 'better' || result.verdict === 'keep';
  return { kind: good ? 'good' : 'other', text: `和現在穿的 ${result.against} 比：${result.text}${reasons ? `（${reasons}）` : ''}`, reasons, against: result.against };
}
const judge = (block, data) => classify(block, data).text;
const sameStats = (a, b) => a.primary === b.primary && JSON.stringify(a.attrs) === JSON.stringify(b.attrs);

// 「買 編號 名稱（價格）」：點了直接送 buy 編號（和快速購買一樣不再確認，使用者要求「點了 buy 編號」）；
// 用在批次彙整與手動 check 的「值得換」，編號從 list 對回來
function buyOne(item) {
  const row = document.createElement('div');
  const status = document.createElement('span');
  const label = `買 ${item.no} ${item.name}${item.price != null ? `（${formatMoney(item.price)}）` : ''}`;
  row.append(button(label, () => {
    const started = sender ? sender(`buy ${item.no}`) : false;
    status.textContent = started === false || !sender ? '　送不出去（找不到送指令的功能）' : `　已送出 buy ${item.no}`;
  }), status);
  return row;
}
// 目前累計的 list 裡這個名稱的編號與價格（沒有就 undefined）
function listed(name) {
  const item = [...session.items.values()].find(entry => entry.name === name);
  return item && { no: item.no, name, price: parsePrice(item.price) };
}

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
  // 比現在好、而且 list 裡找得到編號的，附一顆買的按鈕
  blocks.filter(block => classify(block, data).kind === 'good').forEach(block => {
    const item = listed(block.name);
    if (item) box.append(buyOne(item));
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
          beginBatch(batch);
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

// 快速購買：list 裡名稱符合的商品全部一次買（每個編號 buy 一次，用 ; 接起來交給同一個 sender 依序送），
// 一顆按鈕、點了就送出、不再確認（使用者明確要求「一按 buy」、不要輸入數量）。一次最多 BUY_MAX 個編號，多的再按一次前先重新 list
function buyAll(matches) {
  const batch = matches.slice(0, BUY_MAX);
  const prices = batch.map(item => parsePrice(item.price)).filter(price => price !== null);
  const total = prices.reduce((sum, price) => sum + price, 0);
  const area = document.createElement('div');
  const names = batch.map(item => `${item.no} ${item.name}`).join('、');
  const status = document.createElement('span');
  const buy = button(`買全部符合的 ${batch.length} 件（約 ${formatMoney(total)}）`, () => {
    const started = sender ? sender(batch.map(item => `buy ${item.no}`).join(';')) : false;
    status.textContent = started === false || !sender ? '　送不出去（找不到送指令的功能）' : `　已送出 ${batch.length} 個 buy`;
  });
  const note = document.createElement('div');
  note.textContent = `快速購買（點了就送出 buy，不再確認）：${names}${matches.length > BUY_MAX ? `；還有 ${matches.length - BUY_MAX} 件超過一次 ${BUY_MAX} 個的上限，沒包含在內` : ''}`;
  area.append(note, buy, status);
  return area;
}

function showSummary(items, data, db, pages = 1) {
  const exp = readExp();
  const minSilver = normalizeMinSilver(data.shopMinPrice);
  const result = evaluate(items, db, { exp, baseline: data.wornEquipment?.[characterName()], minPrice: minSilver * 100, skip: skipNames(data[SKIP_NAMES_KEY]), nonEquip: nonEquipSet(data[NON_EQUIP_KEY]) });
  const box = newBox();
  summaryLines(result, exp, pages, minSilver).forEach(line => {
    const row = document.createElement('div');
    row.textContent = line;
    box.append(row);
  });
  // 建議的要 check 才知道這一件實際的數值（check 之後會立刻和身上的比）；沒蒐集的 check 之後才進資料庫、有等級可比
  if (result.suggest.length) box.append(batchControls('建議的', result.suggest.map(item => ({ no: item.no, name: item.name, price: parsePrice(item.price) }))));
  if (result.unknownItems.length) {
    box.append(batchControls('還沒蒐集的', result.unknownItems));
  }
  const matches = items.filter(item => buyNames(data[BUY_NAMES_KEY]).includes(item.name));
  if (matches.length) box.append(buyAll(matches));
  place(box);
  return box;
}
// 同一次 list 的好幾頁累計在一起（編號是接著數的）：list 的第一頁有「商人現在有賣以下貨物」開頭就重新開始，沒有開頭的頁
// 併進目前這一次；超過 SESSION_MS 沒新的頁也重新開始。每一頁的摘要是累計的，新的出現時舊的那塊拿掉，這樣批次按鈕只有最新的一組
const LIST_HEADER = /商人現在有賣以下貨物/;
const SESSION_MS = 10 * 60 * 1000;
let session = { items: new Map(), pages: 0, at: 0, box: null };

// 批次 check 彙整：玩家按了確認送出之後（beginBatch），收到的 check 結果照常記進資料庫，但不再一條一條回報，
// 全部收到（或 BATCH_QUIET_MS 沒有新的回應）才印一塊彙整，只列推薦的（比現在好或屬性達門檻），其他只計件數
const BATCH_QUIET_MS = 20000;
let batchRun = null;
function beginBatch(batch) {
  // 上一批還沒收完就又送下一批：併成同一份彙整（不要把前一批提早結束），期待的個數與名稱表接上去
  if (batchRun) {
    batchRun.expected += batch.length;
    batch.forEach(item => batchRun.byName.set(item.name, item));
    clearTimeout(batchRun.timer);
    batchRun.timer = setTimeout(finishBatch, BATCH_QUIET_MS);
    return;
  }
  batchRun = { expected: batch.length, received: 0, byName: new Map(batch.map(item => [item.name, item])), good: [], blocked: 0, nobase: 0, other: 0, notEquipment: 0, timer: null };
}
function finishBatch() {
  const run = batchRun;
  if (!run) return;
  clearTimeout(run.timer);
  batchRun = null;
  const box = newBox();
  const lines = [`【批次 check 彙整】送出 ${run.expected} 個，收到 ${run.received} 個回應（實際數值都已記進資料庫）`];
  if (run.good.length) lines.push(`值得換（${run.good.length}）：`);
  else lines.push('沒有比現在好的');
  const others = [
    run.blocked && `經驗還不夠穿 ${run.blocked} 件`,
    run.nobase && `沒有穿著資料可比 ${run.nobase} 件`,
    run.other && `不比現在好 ${run.other} 件`,
    run.notEquipment && `不是裝備 ${run.notEquipment} 件`,
  ].filter(Boolean);
  if (others.length) lines.push(`其他：${others.join('、')}`);
  if (run.received < run.expected) lines.push(`沒收到回應：${run.expected - run.received} 個（被中止、錢不夠、或不在商人面前？）`);
  const addLine = line => {
    const row = document.createElement('div');
    row.textContent = line;
    box.append(row);
  };
  addLine(lines[0]);
  addLine(lines[1]);
  // 值得換的每件：有編號就一顆「買 編號」按鈕（點了直接送 buy），底下一行比較結果
  run.good.forEach(item => {
    if (item.no !== undefined) box.append(buyOne(item));
    addLine(`　${item.no === undefined ? `${item.name}　` : ''}${item.text}`);
  });
  lines.slice(2).forEach(addLine);
  place(box);
}
// 一次 flush 收到的 check：記進彙整；全部到齊就印出，否則等 BATCH_QUIET_MS（逾時印目前收到的）
function collectBatch(count, blocks, data) {
  const run = batchRun;
  run.received += count;
  run.notEquipment += Math.max(0, count - blocks.length);
  blocks.forEach(block => {
    const result = classify(block, data);
    if (result.kind === 'good') {
      const listed = run.byName.get(block.name);
      run.good.push({ no: listed?.no, name: block.name, price: listed?.price, text: result.text });
    } else run[result.kind] += 1;
  });
  clearTimeout(run.timer);
  if (run.received >= run.expected) finishBatch();
  else run.timer = setTimeout(finishBatch, BATCH_QUIET_MS);
}

async function flush() {
  const text = buffer;
  const echoBefore = priorEcho;
  lastAnchor = lastNode;
  buffer = '';
  lastNode = null;
  timer = null;
  armedUntil = 0;
  try {
    const data = await chrome.storage.local.get([DB_KEY, NON_EQUIP_KEY, MIN_PRICE_KEY, BUY_NAMES_KEY, SKIP_NAMES_KEY, 'zapFeatures', 'wornEquipment', 'mainWeapon', 'equipmentKeep']);
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
      // 沒有裝備區塊的商品（食物、雜物…）記成非裝備，之後 list 不再列為沒蒐集；名稱靠編號從累計的 list 找，找不到就不學
      const learned = new Set(Array.isArray(data[NON_EQUIP_KEY]) ? data[NON_EQUIP_KEY] : []);
      const before0 = learned.size;
      nonEquipmentNumbers(text, echoBefore).forEach(no => {
        const name = session.items.get(no)?.name ?? [...(batchRun?.byName.values() ?? [])].find(item => item.no === no)?.name;
        if (name && !blocks.some(block => block.name === name)) learned.add(name);
      });
      blocks.forEach(block => learned.delete(block.name));
      if (learned.size !== before0 || blocks.some(block => (data[NON_EQUIP_KEY] || []).includes(block.name))) {
        data[NON_EQUIP_KEY] = [...learned];
        await chrome.storage.local.set({ [NON_EQUIP_KEY]: data[NON_EQUIP_KEY] });
      }
      if (batchRun) collectBatch((text.match(new RegExp(CHECK_PHRASE.source, 'g')) || []).length, blocks, data);
      else showRecorded(blocks, before, db, data);
    }
    const items = parseList(text);
    if (items.length) {
      const now = Date.now();
      if (LIST_HEADER.test(text) || now - session.at > SESSION_MS) session = { items: new Map(), pages: 0, at: now, box: null };
      items.forEach(item => session.items.set(item.no, item));
      session.pages += 1;
      session.at = now;
      session.box?.remove();
      session.box = showSummary([...session.items.values()].sort((a, b) => a.no - b.no), data, withBuiltin(db), session.pages);
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
  const prior = lastEcho;
  lastEcho = lastEchoNo(text) ?? lastEcho;
  if (CHECK_PHRASE.test(text)) armedUntil = Date.now() + ARM_MS;
  // check 的輸出可能分成好幾批到，叫出來之後 ARM_MS 內的新文字都接上去
  if (!/價格\s*[：:]/.test(text) && Date.now() > armedUntil) return;
  if (!buffer) priorEcho = prior;
  buffer += text;
  const added = mine.flatMap(record => Array.from(record.addedNodes)).filter(node => !isOwn(node));
  if (added.length) lastNode = added[added.length - 1];
  clearTimeout(timer);
  timer = setTimeout(flush, SETTLE_MS);
});
observer.observe(content, { subtree: true, childList: true, characterData: true });
})();

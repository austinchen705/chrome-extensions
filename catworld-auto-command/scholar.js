// 六脈神劍（落魄書生）的判讀（純函式）：sc 的靈性、sk 的技能數、能不能開始。樣本是遊戲的真實輸出（tests/fixtures/scholar/）。不碰 DOM 與 chrome.*。
(() => {
if (globalThis.CatworldScholar) return;

// sc：「靈性： 31」→ 31，讀不到回 null
function parseSpirit(scText) {
  const match = /靈性\s*[：:]\s*(\d+)/.exec(String(scText ?? ''));
  return match ? Number(match[1]) : null;
}

// sk 第一行「你目前所學過的技能：(28)」→ { count, hasSixVein }；讀不到回 null。hasSixVein 只看讀到的這段文字有沒有 six-vein-sword
function parseSkillCount(skText) {
  const text = String(skText ?? '');
  const match = /你目前所學過的技能\s*[：:]\s*\(\s*(\d+)\s*\)/.exec(text);
  return match ? { count: Number(match[1]), hasSixVein: /six-vein-sword/.test(text) } : null;
}

// 還沒有六脈：技能數上限＝靈性；已經有六脈：上限＝靈性＋1。abandon＝超過上限要先丟掉幾個
function canStart({ spirit, skills, hasSixVein }) {
  const limit = spirit + (hasSixVein ? 1 : 0);
  const abandon = Math.max(0, skills - limit);
  return { ok: abandon === 0, limit, abandon };
}

// 一行遊戲文字 → { kind, ... } 或 null。kind：appear（房間行 ※落魄書生(dire scholar)）、request（要東西，item＝「誰能給我」與「呢？」中間的原文，line＝整句）、
// vanish、leave（direction＝「往」與「離開」中間）、followed（跟隨）、given（你給落魄書生…）、success（領悟六脈）、failed（沒解成）、already（已經領悟）
function classifyLine(line) {
  // 只認行首（前面可能黏著提示符「> 」）：頻道轉貼的「【幫】某人：落魄書生說道：…」不算，書生不在身邊
  const text = String(line ?? '').trim().replace(/^>\s*/, '');
  if (!/^(落魄書生|※落魄書生|恭喜你對六脈神劍|你決定開始跟隨落魄書生|你給落魄書生)/.test(text)) return null;
  let m;
  if ((m = /^落魄書生說道[：:]\s*誰能給我(.*?)呢[？?]/.exec(text))) return { kind: 'request', item: m[1], line: m[0] };
  if (/^落魄書生說道[：:]\s*你已經對六脈有相當的領悟了/.test(text)) return { kind: 'already' };
  if (text.startsWith('落魄書生突然身形一晃，便漸漸消逸了')) return { kind: 'vanish' };
  if ((m = /^落魄書生往(.+?)離開/.exec(text))) return { kind: 'leave', direction: m[1] };
  if (/^落魄書生向你打聽有關『可惜啊！看來我們有緣無份了。』/.test(text)) return { kind: 'failed' };
  if (text.startsWith('恭喜你對六脈神劍有所領悟了。')) return { kind: 'success' };
  if (text.startsWith('你決定開始跟隨落魄書生一起行動。')) return { kind: 'followed' };
  if (text.startsWith('你給落魄書生')) return { kind: 'given' };
  if (/^※落魄書生\(dire scholar\)/.test(text)) return { kind: 'appear' };
  return null;
}

// 出沒紀錄（舊的在前、新的在後，最多 CAP 筆）。一筆＝一次相遇：{ at, sinceSpawnSec, area, areaName, room, said, matched, result, ended }。
// 重生是每 15 分鐘整點：sinceSpawnSec 讀得到就用 at 往回推出重生時間，讀不到就只看距上次看到有沒有滿 15 分鐘
const CAP = 200;
const SPAWN_MS = 15 * 60 * 1000;
const spawnPassed = (record, now) => (Number.isFinite(record.sinceSpawnSec)
  ? now >= record.at - record.sinceSpawnSec * 1000 + SPAWN_MS
  : now - record.at >= SPAWN_MS);

// event：{ kind: 'appear' | 'request', sinceSpawnSec, area, areaName, room, line? }；回傳新陣列，不改輸入。
// 最後一筆還沒消失、也沒過下一個重生就併進去（說的話附上去，和上一句一樣的不重複；補上原本讀不到的房間）；否則新開一筆
function addSighting(records, event, now) {
  const list = Array.isArray(records) ? records : [];
  const last = list[list.length - 1];
  const said = event.kind === 'request' && event.line ? [event.line] : [];
  if (last && !last.ended && !spawnPassed(last, now)) {
    const merged = { ...last, said: [...last.said] };
    if (said.length && merged.said[merged.said.length - 1] !== said[0]) merged.said.push(said[0]);
    if (!merged.room && event.room) Object.assign(merged, { area: event.area, areaName: event.areaName, room: event.room });
    return [...list.slice(0, -1), merged];
  }
  const fresh = {
    at: now, sinceSpawnSec: Number.isFinite(event.sinceSpawnSec) ? event.sinceSpawnSec : null,
    area: event.area ?? null, areaName: event.areaName ?? '', room: event.room ?? null, said, matched: null, result: null,
  };
  return [...list, fresh].slice(-CAP);
}

// 書生消失：最後一筆標成結束，之後再看到書生算新的一筆
function endSighting(records) {
  const list = Array.isArray(records) ? records : [];
  const last = list[list.length - 1];
  if (!last || last.ended) return list;
  return [...list.slice(0, -1), { ...last, ended: true }];
}

// 房間描述 → 戶外 true／室內 false／讀不到 null。房間名稱行（結尾 " -" 或 " --"）之後第一段是描述（第一行縮排、後續行不縮排）；
// 描述段之後、出口行之前只要有一行縮排開頭有字（時辰、天氣句）就是戶外。出口行之後、沒縮排、空白的行都不算。有兩份描述只看最後一份
const EXITS_LINE = /^\s*這裡(?:明顯的出口是|唯一的出口是)/;
const TITLE_LINE = /\s-{1,2}\s*$/;
const indented = line => /^\s/.test(line) && line.trim() !== '';
function isOutdoor(lookText) {
  const lines = String(lookText ?? '').split(/\r?\n/);
  let exits = -1;
  lines.forEach((line, index) => { if (EXITS_LINE.test(line)) exits = index; });
  if (exits < 0) return null;
  let title = -1;
  for (let i = exits - 1; i >= 0; i -= 1) if (TITLE_LINE.test(lines[i])) { title = i; break; }
  if (title < 0) return null;
  let i = title + 1;
  if (i < exits && indented(lines[i])) i += 1; // 描述第一行
  while (i < exits && lines[i].trim() !== '' && !indented(lines[i])) i += 1; // 後續行
  return lines.slice(i, exits).some(indented);
}

// 物品清單對照 i 的輸出（要先載入 hunt-parse.js）：清單每一樣 → { name, have, qty, id }。身上的物品名＝清單名，或「數詞＋量詞」加清單名（「一顆玄鐵石」「四十四瓶蠻牛」）；
// 只比對這種前綴，免得「三字經」被當成「三」加「字經」。同一樣有好幾疊就加總
const QTY_PREFIX = /^([零一二三四五六七八九十兩]+)[^零一二三四五六七八九十兩\s]$/;
// 身上的哪幾行是這一樣：回 [{ item（parseInventory 的一筆，含給指令用的 ref）, qty }]
function ownedLines(owned, name) {
  const Parse = globalThis.CatworldHuntParse;
  const lines = [];
  owned.forEach(item => {
    const own = item.name.replace(/^[*ˇ]+/, ''); // 又標記又穿著的行，parseInventory 會把 ˇ 留在名稱前
    const prefix = own.endsWith(name) ? own.slice(0, own.length - name.length) : null;
    if (prefix === null || (prefix !== '' && !QTY_PREFIX.test(prefix))) return;
    lines.push({ item, qty: prefix === '' ? 1 : Parse.quantityOf(prefix) });
  });
  return lines;
}
function matchInventory(listItems, inventoryText) {
  const owned = globalThis.CatworldHuntParse.parseInventory(inventoryText);
  return listItems.map(([name]) => {
    const lines = ownedLines(owned, name);
    const qty = lines.reduce((sum, line) => sum + line.qty, 0);
    return { name, have: qty > 0, qty, id: lines.length ? lines[0].item.id : null };
  });
}
// 給書生用：身上第一行是這一樣的物品 → parseInventory 的那一筆（ref 是 give 要用的寫法，同 ID 有好幾樣時是「ID N」）；沒有回 null
function findOwned(inventoryText, name) {
  const lines = ownedLines(globalThis.CatworldHuntParse.parseInventory(inventoryText), name);
  return lines.length ? lines[0].item : null;
}

// 書生要的東西：「誰能給我…呢？」中間的原文（或整句）夾著亂碼，物品名的每個字依序都出現（中間可以夾雜別的字）就算命中；
// 取字數最多的那一樣，一樣長的有好幾個、或一個都沒有就認不出：{ name: null, candidates }
function matchRequest(sentence, names) {
  const text = String(sentence ?? '').normalize('NFKC');
  const hit = name => {
    let from = 0;
    for (const char of name.normalize('NFKC')) {
      const at = text.indexOf(char, from);
      if (at < 0) return false;
      from = at + 1;
    }
    return true;
  };
  let best = [];
  let length = 0;
  new Set(names).forEach(name => {
    const size = [...name.normalize('NFKC')].length;
    if (!size || size < length || !hit(name)) return;
    if (size > length) { length = size; best = []; }
    best.push(name);
  });
  return best.length === 1 ? { name: best[0] } : { name: null, candidates: best };
}

// 出沒紀錄最後一筆（還沒結束的）補欄位（matched、result）；回傳新陣列，不改輸入
function annotateSighting(records, fields) {
  const list = Array.isArray(records) ? records : [];
  const last = list[list.length - 1];
  if (!last || last.ended) return list;
  return [...list.slice(0, -1), { ...last, ...fields }];
}

// 購買指令（欄位裡用 ; 或換行分隔，可含 @巨集 N）→ 一個巨集文字：先 recall 回客棧，再跑那一列；欄位是空的回 ''（不執行）
function buyMacroText(command) {
  const pieces = String(command ?? '').split(/[;；\r\n]+/).map(piece => piece.trim()).filter(Boolean);
  return pieces.length ? ['recall', ...pieces].join(';') : '';
}
// 「把缺的都跑一遍」要跑的物品名（照清單順序）：最近一次讀身上（owned：{ 名稱: { have } }）缺的、而且有填指令的；沒填的不管哪一類都不跑
function missingToRun(listItems, owned, macros) {
  return listItems.map(([name]) => name).filter(name => owned?.[name] && !owned[name].have && buyMacroText(macros?.[name]));
}

globalThis.CatworldScholar = { parseSpirit, parseSkillCount, canStart, classifyLine, addSighting, endSighting, annotateSighting, isOutdoor, matchInventory, findOwned, matchRequest, buyMacroText, missingToRun, BUY_KEY: 'scholarBuyMacros', SIGHTINGS_KEY: 'scholarSightings', OUTDOOR_KEY: 'mapOutdoor', ITEM_IDS_KEY: 'scholarItemIds', CAP };
})();

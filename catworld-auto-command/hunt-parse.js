// 地圖巡怪用的遊戲輸出解析：l（出口、怪物、別人）、finger（玩家還是 NPC）、time（伺服器時間）。不碰 DOM 與 chrome.*。
(() => {
if (globalThis.CatworldHuntParse) return;

// 「台北時間為西元2026年11月4日 9點55分1秒 (星期三)。」→ 以 UTC+8 換成 epoch 毫秒，讀不到回 null
const TAIPEI = /台北時間為西元\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日\s*(\d+)\s*點\s*(\d+)\s*分\s*(\d+)\s*秒/;
function parseTime(text) {
  const match = TAIPEI.exec(String(text ?? ''));
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  return Date.UTC(year, month - 1, day, hour - 8, minute, second);
}

// finger <ID>：輸出有「權限等級：(player)」是玩家，有「找不到」是 NPC，其他（沒回應、讀不懂）是 unknown；呼叫端把 unknown 當玩家
function parseFinger(text) {
  const out = String(text ?? '');
  if (/權限等級\s*[：:]\s*\(player\)/.test(out)) return 'player';
  if (/找不到/.test(out)) return 'npc';
  return 'unknown';
}

// l 的出口行：「這裡明顯的出口是 south 和 west。」「這裡唯一的出口是 up。」；英文全名轉成移動指令，不認得的字照原樣（小寫）留著
const EXIT_COMMANDS = {
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  up: 'u', down: 'd',
  eastup: 'eu', eastdown: 'ed', westup: 'wu', westdown: 'wd',
  northup: 'nu', northdown: 'nd', southup: 'su', southdown: 'sd',
};
// 行首才算（玩家的稱號或名字裡含這句話不能當成出口行）
const EXIT_LINE = /^[ \t]*這裡(?:明顯的出口是|唯一的出口是)[ \t]*([^\n]*)/m;
function parseExits(text) {
  const match = EXIT_LINE.exec(text);
  if (!match) return [];
  return (match[1].match(/[A-Za-z][A-Za-z0-9_-]*/g) || []).map(word => EXIT_COMMANDS[word.toLowerCase()] ?? word.toLowerCase());
}

// 怪物行：「  ※名稱(ID) <戰鬥中> [fight][kill]」。同名的不合併（一隻一行）；full 是 名稱(ID)，和地圖蒐集存的 mobs 同一種寫法
const MOB_LINE = /^\s*※\s*(.+?)\s*\(([^()]+)\)\s*((?:<[^>]*>\s*)*)(?:\[[^\]]*\]\s*)*$/;
function parseMonster(rawLine) {
  const match = MOB_LINE.exec(rawLine.normalize('NFKC'));
  if (!match) return null;
  const name = match[1].replace(/\s+/g, ' ');
  const id = match[2].trim();
  return { name, id, full: name + '(' + id + ')', state: /<([^>]*)>/.exec(match[3])?.[1] ?? '' };
}

// 別人：沒有 ※、行尾有 (英文ID)，不是屍體；帶 <狀態>（<發呆中> 之類）的就是。沒在發呆的玩家沒有 <狀態>，行尾只有 (英文ID)，
// 這種要名字前面有稱號才算（「」括起來的、或稱號與名字之間有空白：天南段家第十七代弟子「悟金」某某某(id)、普通百姓 店小二(id)）；
// 地上的物品（紙皮水袋(waterskin)）是單純的一個名稱，沒有稱號也沒有 <狀態>，不算
const PERSON_LINE = /\(([A-Za-z][^()]*)\)\s*<([^>]+)>\s*$/;
const TITLED_LINE = /^(.*\S)\s*\(([A-Za-z][^()]*)\)$/;
function parsePerson(rawLine) {
  const line = rawLine.normalize('NFKC').trim();
  if (line.startsWith('※') || /屍體|\[sac\]/.test(line)) return null;
  const match = PERSON_LINE.exec(line);
  if (match) return { id: match[1].trim(), state: match[2] };
  const titled = TITLED_LINE.exec(line);
  return titled && /[「」\s]/.test(titled[1]) ? { id: titled[2].trim(), state: '' } : null;
}

// 有東西離開房間的句子（怪或人都算：fight 的順位數的是房間裡所有東西）。走進來的句子沒有樣本，不處理
const LEAVE_LINE = /往\S{1,6}離開/;

// 輸出裡可能有兩份房間描述（抵達時印的、再加 l 印的）：只算最後一份（從最後一個出口行開始，怪物與人物行都在它後面）
function parseLook(text) {
  const whole = String(text ?? '');
  const starts = [...whole.matchAll(new RegExp(EXIT_LINE.source, 'gm'))].map(match => match.index);
  const out = starts.length ? whole.slice(starts[starts.length - 1]) : whole;
  const lines = out.split(/\r?\n/);
  // 同一個房間 ID 一樣的怪（例如三隻 ID 都是 guard）fight guard 只會打第一隻，所以每個都帶 ref：第一個就是 ID，第 N 個是「ID N」
  // （遊戲照房間裡東西的順序數，和 l 列出的順序一樣；怪與別人一起數）
  const counts = new Map();
  const refOf = id => {
    const key = id.toLowerCase();
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    return n === 1 ? id : `${id} ${n}`;
  };
  // position：這隻怪是第幾個 ※ 怪物行（從 1 起算，沒勾選的、昏迷的都算），給「指令 順位」的寫法用
  const monsters = [];
  const people = [];
  lines.forEach(line => {
    const mob = parseMonster(line);
    if (mob) { monsters.push({ ...mob, ref: refOf(mob.id), position: monsters.length + 1 }); return; }
    const person = parsePerson(line);
    if (person) people.push({ ...person, ref: refOf(person.id) });
  });
  // moved：最後一份描述之後又有東西離開房間（「野狗往北離開。」），順位已經不準（使用者貼的真實輸出）
  return { exits: parseExits(out), monsters, people, moved: LEAVE_LINE.test(out) };
}

// i：「你身上帶著下列這些東西( 載重 23% ):」→ 23；讀不到回 null
const LOAD = /載重\s*(\d+(?:\.\d+)?)\s*[%％]/;
function parseLoad(text) {
  const match = LOAD.exec(String(text ?? '').normalize('NFKC'));
  return match ? Number(match[1]) : null;
}

// i 的物品行：「 *  一瓶普洱茶(puer tea)」（* 已標記）、「  ˇ布衣(cloth) [view][remove]」（ˇ 穿著中）、「    銀戒指(sliver ring) [view][wear]」。
// ref 是指令用的寫法：同一個 ID 第一個就是 ID、第 N 個是「ID N」（穿著與標記的也一起數，遊戲照背包順序數）
const ITEM_LINE = /^\s*([*ˇ]?)\s*(.+?)\s*\(([A-Za-z][^()]*)\)\s*((?:\[[^\]]*\]\s*)*)$/;
function parseInventory(text) {
  const counts = new Map();
  const items = [];
  String(text ?? '').split(/\r?\n/).forEach(rawLine => {
    const match = ITEM_LINE.exec(rawLine.normalize('NFKC'));
    if (!match) return;
    const id = match[3].trim();
    const key = id.toLowerCase();
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    items.push({ name: match[2].trim(), id, ref: n === 1 ? id : `${id} ${n}`, marked: match[1] === '*', worn: match[1] === 'ˇ' });
  });
  return items;
}

// alias：遊戲列出的別名，一行一個「名稱   = 展開內容」（$1、$2 是參數位置）。標題（你目前設定的 alias 有：）、
// 分頁提示（== 未完繼續 58% == …，名稱不能以 = 開頭）、指令回聲與空行都對不上，不會被當成別名。回傳 Map（名稱小寫 → 展開內容）
const ALIAS_LINE = /^\s*([^\s=]+)\s+=\s?(.*?)\s*$/;
function parseAliases(text) {
  const aliases = new Map();
  String(text ?? '').split(/\r?\n/).forEach(line => {
    const match = ALIAS_LINE.exec(line);
    if (match) aliases.set(match[1].toLowerCase(), match[2]);
  });
  return aliases;
}

// 巡怪「開打／打死用的指令」欄位的檢查：巡怪會送「這個指令 目標」，所以別名展開後要是「verb …… $1」。
// 巡怪一律接順位（一個數字）。只看指令的形狀，不判斷順位對不對（那要實際打一次才知道）。回 { level: 'info' | 'warn' | 'error', text }
function judgeAlias(aliases, command, { verb }) {
  const name = String(command ?? '').trim();
  if (!aliases.size) return { level: 'error', text: '讀不到別名列表（alias 的輸出裡沒有任何別名）' };
  const expansion = aliases.get(name.toLowerCase());
  if (expansion === undefined) return { level: 'info', text: `「${name}」不是別名，巡怪會直接送「${name} 順位」` };
  const shown = `「${name}」＝「${expansion}」`;
  const warn = text => ({ level: 'warn', text: `${shown}：${text}` });
  if (/[;；]/.test(expansion)) return warn('含多個指令（分號），巡怪接上的目標只會跟著最後一個');
  if (expansion.includes('*')) return warn('* 會一次攻擊全部的 NPC，不是打一隻怪');
  const words = expansion.trim().split(/\s+/);
  const params = expansion.match(/\$\d/g) || [];
  if (params.length !== 1 || words[words.length - 1] !== '$1') return warn('參數位置不對（要恰好一個 $1、而且在最後），巡怪接上的目標會放錯地方');
  if (words[0].toLowerCase() !== verb) return warn(`不是 ${verb} 的別名`);
  const middle = words.slice(1, -1);
  const npc = middle.some(word => word.toLowerCase() === 'npc');
  const notes = [];
  if (middle.length && !npc) notes.push(`中間有多出來的字（${middle.join(' ')}），遊戲的說明頁沒寫，請自己確認`);
  if (!npc) notes.push('房間裡有玩家或物品排在怪前面時順位可能偏掉，建議用 fight NPC $1');
  return { level: 'info', text: `${shown}，巡怪送「${name} 順位」，遊戲執行「${words.slice(0, -1).join(' ')} 順位」${notes.length ? `；${notes.join('；')}` : ''}` };
}

globalThis.CatworldHuntParse = { parseTime, parseFinger, parseLook, parseLoad, parseInventory, parseAliases, judgeAlias };
})();

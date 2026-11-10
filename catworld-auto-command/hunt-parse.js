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

// 別人：沒有 ※、行尾有 (英文ID) 並帶 <狀態>（<發呆中> 之類），不是屍體；地上的物品（紙皮水袋(waterskin)）沒有 <狀態>，所以不算
const PERSON_LINE = /\(([A-Za-z][^()]*)\)\s*<([^>]+)>\s*$/;
function parsePerson(rawLine) {
  const line = rawLine.normalize('NFKC').trim();
  if (line.startsWith('※') || /屍體|\[sac\]/.test(line)) return null;
  const match = PERSON_LINE.exec(line);
  return match ? { id: match[1].trim(), state: match[2] } : null;
}

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
  const monsters = [];
  const people = [];
  lines.forEach(line => {
    const mob = parseMonster(line);
    if (mob) { monsters.push({ ...mob, ref: refOf(mob.id) }); return; }
    const person = parsePerson(line);
    if (person) people.push({ ...person, ref: refOf(person.id) });
  });
  return { exits: parseExits(out), monsters, people };
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

globalThis.CatworldHuntParse = { parseTime, parseFinger, parseLook, parseLoad, parseInventory };
})();

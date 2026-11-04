// 區域地圖還原：遊戲地圖視窗裡每個區域（m-區域）是一塊文字畫，房間是 <a id="m-區域-房間">，其餘是連線字元，
// 房間與連線字元都佔一格（一個字元一格，全形空白也算一格）。這裡把它還原成房間之間的連線與方向指令，並算最短路線。
// 不碰 DOM：輸入是區域那一塊的 innerHTML 字串。
(() => {
if (globalThis.CatworldMapRoute) return;

const ROOM_ID = /^m-(.+)-([^-]+)$/;
const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/y;

// 每格：{ room: 鍵 } 或 { ch: 字元 }
function grid(html) {
  return String(html ?? '').split('\n').map(line => {
    const cells = [];
    let i = 0;
    while (i < line.length) {
      ANCHOR.lastIndex = i;
      const match = line[i] === '<' ? ANCHOR.exec(line) : null;
      if (match) {
        const id = /\bid="([^"]*)"/.exec(match[1])?.[1] ?? '';
        const idMatch = ROOM_ID.exec(id);
        // class N6 的 <a>（m-區域-z0 之類）是通往別區的標記，不是房間，當空白
        const marker = /\bclass="[^"]*\bN6\b/.test(match[1]);
        cells.push(idMatch && !marker ? { room: `${idMatch[1]}/${idMatch[2]}` } : { ch: ' ' });
        i = ANCHOR.lastIndex;
      } else {
        cells.push({ ch: line[i] });
        i += 1;
      }
    }
    return cells;
  });
}

// 從房間往下方與右方四個方向掃（每一對房間只會被掃到一次）：中間全是這個方向的連線字元，碰到下一個房間就連上。
// both＝雙向；toward＝箭頭指向掃描方向（只能從起點走到終點）；against＝箭頭指回來（只能從終點走回起點）。
// 房間之間可以隔很多格（──、→→→、連續好幾列 ↑），仍算一步。
const SCANS = [
  { dr: 0, dc: 1, there: 'e', back: 'w', both: '─', toward: '→', against: '←' },
  { dr: 1, dc: 0, there: 's', back: 'n', both: '│', toward: '↓', against: '↑' },
  { dr: 1, dc: 1, there: 'se', back: 'nw', both: '╲', toward: '↘', against: '↖' },
  { dr: 1, dc: -1, there: 'sw', back: 'ne', both: '╱', toward: '↙', against: '↗' },
];

function parseArea(html) {
  const cells = grid(html);
  const rooms = {};
  cells.forEach((row, r) => row.forEach((cell, c) => { if (cell.room) rooms[cell.room] = { key: cell.room, row: r, col: c, exits: {} }; }));
  Object.values(rooms).forEach(from => {
    SCANS.forEach(scan => {
      const seen = new Set();
      let steps = 1;
      for (; ; steps += 1) {
        const cell = cells[from.row + scan.dr * steps]?.[from.col + scan.dc * steps];
        if (!cell || cell.room || ![scan.both, scan.toward, scan.against].includes(cell.ch)) break;
        seen.add(cell.ch);
      }
      const target = cells[from.row + scan.dr * steps]?.[from.col + scan.dc * steps];
      if (steps === 1 || !target?.room) return;
      if (seen.has(scan.toward) && seen.has(scan.against)) return;
      if (!seen.has(scan.against)) from.exits[scan.there] = target.room;
      if (!seen.has(scan.toward)) rooms[target.room].exits[scan.back] = from.key;
    });
  });
  return { rooms };
}

// 最短路線（BFS）：回傳要依序送的方向指令陣列；起點等於終點回空陣列；任一端不在圖裡或走不到回 null
function route(graph, from, to) {
  if (!graph.rooms[from] || !graph.rooms[to]) return null;
  const came = new Map([[from, null]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head];
    if (at === to) break;
    Object.entries(graph.rooms[at].exits).forEach(([cmd, next]) => {
      if (came.has(next)) return;
      came.set(next, { from: at, cmd });
      queue.push(next);
    });
  }
  if (!came.has(to)) return null;
  const commands = [];
  for (let at = to; came.get(at); at = came.get(at).from) commands.unshift(came.get(at).cmd);
  return commands;
}

globalThis.CatworldMapRoute = { parseArea, route };
})();

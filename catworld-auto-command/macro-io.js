// 巨集匯入匯出的純函式模組：不碰 DOM、不碰 chrome.*，content script、popup 備援注入與測試共用。
// 遊戲把巨集存在頁面的 localStorage.MACROS：長度 90 的陣列，每格是 0（空）或 [按鍵值字串, 指令字串]。
// 匯出的文字是 { version, macros, notes }：macros 就是遊戲那份的原樣，notes 是我們自己的備註（列號 → 文字，只放有內容的列）。
(() => {
if (globalThis.CatworldMacroIO) return;

const COUNT = 90;
const VERSION = 1;

const emptyMacros = () => Array.from({ length: COUNT }, () => 0);
const isSlot = cell => Array.isArray(cell) && cell.length === 2 && typeof cell[0] === 'string' && typeof cell[1] === 'string';

// 讀遊戲存的巨集（localStorage 的原始文字，或已經解析好的陣列），一律回 90 格。
// status：ok（讀得懂）、missing（遊戲還沒存過；空字串遊戲也當作沒有）、damaged（資料壞了：不是 JSON、不是陣列、超過 90 格、某一格形狀不對；
// 壞的那格當成空、其餘照留，不會因為資料壞掉就丟例外）
function readMacros(raw) {
  if (raw === null || raw === undefined || raw === '') return { macros: emptyMacros(), status: 'missing' };
  let data = raw;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return { macros: emptyMacros(), status: 'damaged' };
    }
  }
  if (!Array.isArray(data)) return { macros: emptyMacros(), status: 'damaged' };
  let status = data.length > COUNT ? 'damaged' : 'ok';
  const macros = Array.from({ length: COUNT }, (_, index) => {
    const cell = data[index];
    if (cell === undefined || cell === 0) return 0;
    if (isSlot(cell)) return [cell[0], cell[1]];
    status = 'damaged';
    return 0;
  });
  return { macros, status };
}

// 備註：只收 1～90 列、內容是有字的文字；其他（不是物件、列號不對、不是文字、只有空白）一律不帶
function normalizeNotes(notes) {
  const out = {};
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return out;
  Object.entries(notes).forEach(([row, text]) => {
    const number = /^\d+$/.test(row) ? Number(row) : 0;
    if (number >= 1 && number <= COUNT && typeof text === 'string' && text.trim() !== '') out[row] = text;
  });
  return out;
}

function exportText(macros, notes) {
  return JSON.stringify({ version: VERSION, macros: readMacros(macros).macros, notes: normalizeNotes(notes) });
}

globalThis.CatworldMacroIO = { COUNT, VERSION, readMacros, exportText };
})();

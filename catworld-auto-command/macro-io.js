// 巨集匯入匯出的純函式模組：不碰 DOM、不碰 chrome.*，content script、popup 備援注入與測試共用。
// 遊戲把巨集存在頁面的 localStorage.MACROS：長度 90 的陣列，每格是 0（空）或 [按鍵值字串, 指令字串]。
// 匯出的文字是 { version, macros, notes }：macros 就是遊戲那份的原樣，notes 是我們自己的備註（列號 → 文字，只放有內容的列）。
(() => {
if (globalThis.CatworldMacroIO) return;

const COUNT = 90;
const VERSION = 1;
const MAX_COMMAND = 1000;
const MAX_NOTE = 200;
// 遊戲的按鍵值是 keyCode（最大 255）加修飾位元 Shift 256、Alt 512、Ctrl 1024、Meta 2048，最大 4095
const MAX_KEY = 4095;

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

const countFilled = macros => macros.filter(cell => cell !== 0).length;

const fail = error => ({ ok: false, error });

// 檢查貼進來的匯入文字，整份通過才回 { ok: true, macros（90 格）, notes }，否則 { ok: false, error }（錯誤說清楚是哪裡）。
// 規則：JSON 物件、version 是 1；macros 是陣列、最多 90 格（少的補空格）；每格是 0 或兩段文字 [按鍵值, 指令]；
// 按鍵值是空的（還沒設按鍵）或 1～4095 的整數，指令最多 1000 字，兩列不能用同一個按鍵值（空的不算）；
// notes 若有，要是物件、鍵是 1～90 的列號、值是最多 200 字的文字（只有空白的略過）；不認得的欄位忽略。不套用指令白名單（這是自己的巨集）
function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('不是 JSON 文字，請貼上「匯出」複製出來的內容');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('內容不是匯出的格式（應該是一個物件）');
  if (data.version !== VERSION) return fail(`看不懂的版本（${JSON.stringify(data.version) ?? '沒有'}），這個版本的 extension 只認得版本 ${VERSION}`);
  if (!Array.isArray(data.macros)) return fail('缺少 macros（要是一個陣列）');
  if (data.macros.length > COUNT) return fail(`macros 有 ${data.macros.length} 格，最多 ${COUNT} 格`);
  const macros = emptyMacros();
  const keyRows = new Map();
  for (let index = 0; index < data.macros.length; index += 1) {
    const cell = data.macros[index];
    const row = index + 1;
    if (cell === 0) continue;
    if (!isSlot(cell)) return fail(`第 ${row} 列的形狀不對：要是 0（空），或 [按鍵值, 指令] 兩段文字`);
    const [key, command] = cell;
    if (key !== '' && !(/^[1-9]\d*$/.test(key) && Number(key) <= MAX_KEY)) return fail(`第 ${row} 列的按鍵值「${key}」不合法（要是空的，或 1 到 ${MAX_KEY} 的整數）`);
    if (command.length > MAX_COMMAND) return fail(`第 ${row} 列的指令太長（${command.length} 字，最多 ${MAX_COMMAND} 字）`);
    if (key !== '') {
      if (keyRows.has(key)) return fail(`第 ${keyRows.get(key)} 列與第 ${row} 列的按鍵組合重複（按鍵值 ${key}），遊戲只會留一條`);
      keyRows.set(key, row);
    }
    macros[index] = [key, command];
  }
  const notes = {};
  if (data.notes !== undefined) {
    if (!data.notes || typeof data.notes !== 'object' || Array.isArray(data.notes)) return fail('備註（notes）要是一個物件');
    for (const [row, note] of Object.entries(data.notes)) {
      if (!/^[1-9]\d*$/.test(row) || Number(row) > COUNT) return fail(`備註的列號「${row}」不合法（要是 1 到 ${COUNT}）`);
      if (typeof note !== 'string') return fail(`備註第 ${row} 列要是文字`);
      if (note.length > MAX_NOTE) return fail(`備註第 ${row} 列太長（${note.length} 字，最多 ${MAX_NOTE} 字）`);
      if (note.trim() !== '') notes[row] = note;
    }
  }
  return { ok: true, macros, notes };
}

globalThis.CatworldMacroIO = { COUNT, VERSION, readMacros, exportText, countFilled, parseImport };
})();

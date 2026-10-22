// 巨集共用的純函式模組（匯入匯出的格式與檢查、備份、巨集視窗大小的夾限）：不碰 DOM、不碰 chrome.*，content script、popup 備援注入與測試共用。
// 遊戲把巨集存在頁面的 localStorage.MACROS：長度 90 的陣列，每格是 0（空）或 [按鍵值字串, 指令字串]。
// 匯出的文字是 { version, macros, notes }：macros 就是遊戲那份的原樣，notes 是我們自己的備註（列號 → 文字，只放有內容的列）。
(() => {
if (globalThis.CatworldMacroIO) return;

const COUNT = 90;
const VERSION = 1;
const MAX_COMMAND = 1000;
const MAX_NOTE = 200;
// 按鍵值只檢查範圍，不保證按得出來：遊戲的按鍵值是 keyCode（最大 255）加修飾位元 Shift 256、Alt 512、Ctrl 1024、Meta 2048，
// 最大 4095；遊戲真正能產生的組合比這少，但寫進一個按不出來的值不會弄壞遊戲，所以不另外收緊
const MAX_KEY = 4095;
const WHOLE_NUMBER = /^[1-9]\d*$/;

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

// 匯入的 macros：回 { macros（90 格，少的補空格） } 或 { error }。
// 每格是 0 或兩段文字 [按鍵值, 指令]；按鍵值是空的（還沒設按鍵）或 1～4095 的整數，指令最多 1000 字，兩列不能用同一個按鍵值（空的不算）
function parseMacros(list) {
  if (!Array.isArray(list)) return { error: '缺少 macros（要是一個陣列）' };
  if (list.length > COUNT) return { error: `macros 有 ${list.length} 格，最多 ${COUNT} 格` };
  const macros = emptyMacros();
  const keyRows = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const cell = list[index];
    const row = index + 1;
    if (cell === 0) continue;
    if (!isSlot(cell)) return { error: `第 ${row} 列的形狀不對：要是 0（空），或 [按鍵值, 指令] 兩段文字` };
    const [key, command] = cell;
    if (key !== '' && !(WHOLE_NUMBER.test(key) && Number(key) <= MAX_KEY)) return { error: `第 ${row} 列的按鍵值「${key}」不合法（要是空的，或 1 到 ${MAX_KEY} 的整數）` };
    if (command.length > MAX_COMMAND) return { error: `第 ${row} 列的指令太長（${command.length} 字，最多 ${MAX_COMMAND} 字）` };
    if (key !== '') {
      if (keyRows.has(key)) return { error: `第 ${keyRows.get(key)} 列與第 ${row} 列的按鍵組合重複（按鍵值 ${key}），遊戲只會留一條` };
      keyRows.set(key, row);
    }
    macros[index] = [key, command];
  }
  return { macros };
}

// 匯入的備註（選填）：回 { notes } 或 { error }。要是物件、鍵是 1～90 的列號、值是最多 200 字的文字（只有空白的略過）
function parseNotes(raw) {
  const notes = {};
  if (raw === undefined) return { notes };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '備註（notes）要是一個物件' };
  for (const [row, note] of Object.entries(raw)) {
    if (!WHOLE_NUMBER.test(row) || Number(row) > COUNT) return { error: `備註的列號「${row}」不合法（要是 1 到 ${COUNT}）` };
    if (typeof note !== 'string') return { error: `備註第 ${row} 列要是文字` };
    if (note.length > MAX_NOTE) return { error: `備註第 ${row} 列太長（${note.length} 字，最多 ${MAX_NOTE} 字）` };
    if (note.trim() !== '') notes[row] = note;
  }
  return { notes };
}

// 檢查貼進來的匯入文字，整份通過才回 { ok: true, macros（90 格）, notes }，否則 { ok: false, error }（錯誤說清楚是哪裡）。
// JSON 物件、version 是 1，再各自檢查 macros 與 notes；不認得的欄位忽略。不套用指令白名單（這是自己的巨集）
function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('不是 JSON 文字，請貼上「匯出」複製出來的內容');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('內容不是匯出的格式（應該是一個物件）');
  if (data.version !== VERSION) return fail(`看不懂的版本（${JSON.stringify(data.version) ?? '沒有'}），這個版本的 extension 只認得版本 ${VERSION}`);
  const macros = parseMacros(data.macros);
  if (macros.error) return fail(macros.error);
  const notes = parseNotes(data.notes);
  if (notes.error) return fail(notes.error);
  return { ok: true, macros: macros.macros, notes: notes.notes };
}

// 匯入前留的備份：遊戲存的巨集「原始文字」（壞掉也原樣留，還原才是原樣寫回）、備註、時間。
// 遊戲還沒存過（null 或空字串）就留 90 個空格，還原後遊戲就是沒有巨集
function makeBackup(raw, notes, at) {
  return { raw: typeof raw === 'string' && raw !== '' ? raw : JSON.stringify(emptyMacros()), notes: normalizeNotes(notes), at };
}

// 讀回存起來的備份：巨集文字不見或不是文字就拒絕並說明；備註不合格式的部分丟掉、時間不是數字當作不知道
function parseBackup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('備份的內容不是預期的格式');
  if (typeof value.raw !== 'string' || value.raw === '') return fail('備份裡的巨集內容不見了或壞了');
  return { ok: true, raw: value.raw, notes: normalizeNotes(value.notes), at: Number.isFinite(value.at) ? value.at : null };
}

// 巨集視窗的最小大小：寬 690（遊戲原本 435 加上備註欄 255）、高 463（遊戲原值）。記住的大小超過 10000 當作壞掉
const MIN_WINDOW = { width: 690, height: 463 };
const MAX_REMEMBERED = 10000;

// 讀回記住的大小：寬和高都是有限的正數、不超過 10000 才相信，否則回 null（當作沒記過）
function sanitizeSize(value) {
  if (!value || typeof value !== 'object') return null;
  const ok = number => typeof number === 'number' && Number.isFinite(number) && number > 0 && number <= MAX_REMEMBERED;
  return ok(value.width) && ok(value.height) ? { width: value.width, height: value.height } : null;
}

// 把大小夾在最小視窗與螢幕可用範圍之間（整數像素）；螢幕比最小視窗還小時仍然不小於最小視窗，螢幕大小不明就沒有上限
function clampWindowSize(size, available) {
  const fit = (value, min, room) => {
    const max = Number.isFinite(room) ? Math.max(min, Math.floor(room)) : Infinity;
    return Math.min(Math.max(Math.round(value), min), max);
  };
  return { width: fit(size.width, MIN_WINDOW.width, available?.width), height: fit(size.height, MIN_WINDOW.height, available?.height) };
}

globalThis.CatworldMacroIO = { COUNT, VERSION, MAX_COMMAND, MAX_NOTE, MAX_KEY, MIN_WINDOW, readMacros, exportText, countFilled, parseImport, makeBackup, parseBackup, sanitizeSize, clampWindowSize };
})();

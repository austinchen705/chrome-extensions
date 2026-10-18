// 遊戲巨集視窗多一欄「備註」。
//
// 遊戲在載入時一次建好 90 列（每列：序號、按鍵輸入框、指令輸入框），並用建立當下的陣列管理它們，
// 所以在每列最後多放一個輸入框不會影響遊戲：遊戲讀的是按鍵框的 nextSibling（指令框），備註框放在指令框後面。
// 備註只存在 extension 的 storage（綁在「列號」上，改按鍵組合備註不會跑掉），不會被送到遊戲，也不在遊戲自己的巨集備份裡。
// 視窗的加寬在 macro-notes.css。
(() => {
if (globalThis.__catworldMacroNotes) return;
globalThis.__catworldMacroNotes = true;

const STORAGE_KEY = 'macroNotes';
const WRITER_KEY = 'macroNotesWriter';
const SAVE_DELAY_MS = 300;
// 本頁專屬的寫入者代號：寫入時一起存。storage.onChanged 在「寫入的那個頁面」也會觸發，
// 沒有這個代號就分不出是自己剛寫的還是別的分頁改的，會拿較舊的內容蓋掉還沒存的編輯
const writerId = Math.random().toString(36).slice(2);
let notes = {};
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  chrome.storage.local.set({ [STORAGE_KEY]: notes, [WRITER_KEY]: writerId });
}

function setNote(row, value) {
  if (value.trim() === '') delete notes[row];
  else notes[row] = value;
}

// 每一列的列號：用序號欄的文字（遊戲寫的是 1～90），讀不到就用順序
function rowNumber(row, index) {
  return Number(row.querySelector('.num')?.textContent) || index + 1;
}

function inject() {
  const rows = [...document.querySelectorAll('#macro_list > div')];
  if (!rows.length) return false;
  const title = document.querySelector('#macro_table .title');
  if (title && !title.querySelector('.note')) {
    const header = document.createElement('span');
    header.className = 'note';
    header.textContent = '備註';
    title.append(header);
  }
  rows.forEach((row, index) => {
    if (row.querySelector('input.note')) return;
    const number = rowNumber(row, index);
    const input = document.createElement('input');
    input.className = 'note B7 N0';
    input.type = 'text';
    input.tabIndex = -1;
    input.placeholder = '備註';
    input.dataset.row = String(number);
    input.value = notes[number] || '';
    input.addEventListener('input', () => {
      setNote(number, input.value);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, SAVE_DELAY_MS);
    });
    input.addEventListener('change', save);
    row.append(input);
  });
  return true;
}

// 其他遊戲分頁改了備註：同步過來（正在輸入的那一格不動）
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY]) return;
  if (changes[WRITER_KEY]?.newValue === writerId) return;
  notes = changes[STORAGE_KEY].newValue || {};
  document.querySelectorAll('#macro_list input.note').forEach(input => {
    if (input !== document.activeElement) input.value = notes[input.dataset.row] || '';
  });
});

chrome.storage.local.get(STORAGE_KEY).then(data => {
  notes = data[STORAGE_KEY] || {};
  if (inject()) return;
  // 巨集視窗的列還沒建好（理論上遊戲載入時就建了）：等出現再注入
  const observer = new MutationObserver(() => { if (inject()) observer.disconnect(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
});
})();

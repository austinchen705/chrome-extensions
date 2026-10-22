// 遊戲巨集視窗（#macro_table）的調整大小把手。遊戲自己沒有任何調整大小的機制，視窗是 CSS 固定寬高，
// 位置用 right 與 top 定位（右邊緣固定），所以把手放在左下角：往左拖變寬、往下拖變高，把手永遠跟著滑鼠。
// 拉寬多出來的寬度全部給指令欄（macro-notes.css 的 --macro-extra），備註欄維持原寬；高度變大時內層列表自然顯示更多列。
// 大小記在 chrome.storage.local，下次載入沿用（記住的值壞掉當作沒記過，套用前夾在螢幕範圍內）。
// 夾限與檢查在 macro-io.js（純函式）。
(() => {
if (globalThis.__catworldMacroResize) return;
globalThis.__catworldMacroResize = true;

const STORAGE_KEY = 'macroWindowSize';
const M = globalThis.CatworldMacroIO;
const table = document.getElementById('macro_table');
if (!table || !M) return;

// 擴充功能重新載入後留在頁面上的舊程式也會留下把手，換成這份還活著的
table.querySelectorAll('.macro-resize').forEach(node => node.remove());
const handle = document.createElement('div');
handle.className = 'macro-resize';
handle.title = '拖曳調整巨集視窗的大小（往左變寬、往下變高）';
table.append(handle);

// 玩家已經拖過就不讓晚回來的讀取蓋掉他剛調的大小
let touched = false;

function apply(size) {
  const fitted = M.clampWindowSize(size, { width: window.innerWidth, height: window.innerHeight });
  table.style.width = `${fitted.width}px`;
  table.style.height = `${fitted.height}px`;
  table.style.setProperty('--macro-extra', `${fitted.width - M.MIN_WINDOW.width}px`);
  return fitted;
}

handle.addEventListener('mousedown', event => {
  if (event.button !== 0) return;
  // 遊戲的視窗只在標題列才拖曳；把手自己處理，不讓事件傳到遊戲的 onmousedown，也不要選到文字
  event.preventDefault();
  event.stopPropagation();
  touched = true;
  const style = getComputedStyle(table);
  const start = {
    x: event.clientX,
    y: event.clientY,
    width: parseFloat(style.width) || M.MIN_WINDOW.width,
    height: parseFloat(style.height) || M.MIN_WINDOW.height,
  };
  let current = null;
  const move = moved => {
    current = apply({ width: start.width + (start.x - moved.clientX), height: start.height + (moved.clientY - start.y) });
  };
  const up = () => {
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('mouseup', up, true);
    if (!current) return;
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: current }).catch(() => {});
    } catch {
      // 存不進去只是下次不沿用，不影響視窗
    }
  };
  document.addEventListener('mousemove', move, true);
  document.addEventListener('mouseup', up, true);
});

chrome.storage.local.get(STORAGE_KEY).then(data => {
  if (touched) return;
  const size = M.sanitizeSize(data[STORAGE_KEY]);
  if (size) apply(size);
}).catch(() => {});
})();

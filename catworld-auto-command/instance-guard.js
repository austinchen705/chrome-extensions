// 擴充功能重新載入後，舊版的 content script 還留在遊戲頁上（連不上擴充功能的「孤兒」）：
// 它的計時器、送指令的佇列和面板都還活著，而設定頁的備援注入會再裝一份新的，頁面上就有兩個面板、兩份程式同時在送指令。
// 這個模組只放判斷與清理的小工具（不碰 chrome.* 的呼叫本身），content script 與測試共用。
(() => {
if (globalThis.CatworldInstanceGuard) return;

// 面板宿主節點的標記；新的程式啟動時把頁面上殘留的（舊程式留下的）面板與置頂提示條拿掉
const HOST_ATTR = 'data-catworld-panel';
const PLACEHOLDER_ID = 'catworld-panel-placeholder';

// 擴充功能被重新載入或移除後，舊頁面裡的 chrome.runtime.id 會失效（讀不到或直接丟例外）
function contextAlive(chromeLike) {
  try {
    return Boolean(chromeLike?.runtime?.id);
  } catch {
    return false;
  }
}

function removeStalePanels(doc) {
  doc.querySelectorAll(`[${HOST_ATTR}], #${PLACEHOLDER_ID}`).forEach(node => node.remove());
}

globalThis.CatworldInstanceGuard = { HOST_ATTR, PLACEHOLDER_ID, contextAlive, removeStalePanels };
})();

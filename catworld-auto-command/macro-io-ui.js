// 面板「巨集」列的匯出（之後的匯入與還原也放這裡）：按「匯出」把遊戲的巨集加備註複製成一段 JSON 文字。
// 遊戲存巨集的 localStorage 與備註的 storage 都由 content.js 注入（deps.readRaw、deps.readNotes），這裡只管畫面與流程。
// 面板可能被搬進置頂浮窗（另一個 document）：剪貼簿一律用按鈕所在 document 的視窗，不假設事件會傳到主頁面。
(() => {
if (globalThis.CatworldMacroIOUI) return;

const MESSAGE_MS = 8000;

// 面板其他地方為了不搶遊戲輸入框的游標擋掉 mousedown，輸入框要放行；click 也要擋（遊戲的 window.onclick 會把游標搶回
// 遊戲輸入框）；打字也不讓遊戲的快捷鍵收到
function typable(node) {
  ['mousedown', 'click'].forEach(type => node.addEventListener(type, event => event.stopPropagation()));
  ['keydown', 'keyup', 'keypress'].forEach(type => node.addEventListener(type, event => event.stopPropagation()));
  return node;
}

// root：包含 .mexport 按鈕與 .macro-io 區塊（.macro-io-msg 訊息、.macro-io-text 手動複製框）的節點
// deps：readRaw() 回遊戲存的巨集原始文字（讀不到可以丟例外）、readNotes() 回備註（async）、relayout() 內容變了要重排面板（選用）
function attach(root, deps) {
  const M = globalThis.CatworldMacroIO;
  const exportButton = root.querySelector('.mexport');
  const box = root.querySelector('.macro-io');
  const message = root.querySelector('.macro-io-msg');
  const manual = typable(root.querySelector('.macro-io-text'));
  let hideTimer = null;

  // 訊息一會兒就收掉；要手動複製時文字框一直留著，直到下一次匯出
  function show(text, level = 'info', manualText = '') {
    clearTimeout(hideTimer);
    message.textContent = text;
    message.classList.toggle('warn', level === 'warn');
    message.classList.toggle('alert', level === 'error');
    manual.hidden = !manualText;
    manual.value = manualText;
    box.hidden = false;
    if (!manualText) hideTimer = setTimeout(() => { box.hidden = true; deps.relayout?.(); }, MESSAGE_MS);
    deps.relayout?.();
  }

  exportButton.addEventListener('click', async () => {
    let read;
    try {
      read = M.readMacros(deps.readRaw());
    } catch {
      read = { macros: M.readMacros(null).macros, status: 'damaged' };
    }
    let notes = {};
    try {
      notes = await deps.readNotes();
    } catch {
      // 讀不到備註就只匯出巨集
    }
    const text = M.exportText(read.macros, notes);
    const hint = read.status === 'missing' ? '遊戲還沒有存過巨集，匯出的巨集是空的'
      : read.status === 'damaged' ? '遊戲存的巨集資料讀不懂，匯出的巨集是空的，請不要拿這份去覆蓋' : '';
    const level = read.status === 'damaged' ? 'warn' : 'info';
    const win = exportButton.ownerDocument.defaultView;
    try {
      await (win?.navigator ?? navigator).clipboard.writeText(text);
      show(`已複製到剪貼簿${hint ? `（${hint}）` : ''}`, level);
    } catch {
      show(`無法寫入剪貼簿，請從下面的文字框自己複製${hint ? `（${hint}）` : ''}`, 'warn', text);
    }
  });

  return { show };
}

globalThis.CatworldMacroIOUI = { attach };
})();

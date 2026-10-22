// 面板「巨集」列的匯出與匯入：
// 匯出＝把遊戲的巨集加備註複製成一段 JSON 文字；匯入＝貼回那段文字，檢查通過、玩家確認後整份取代。
// 遊戲存巨集的 localStorage 與備註的 storage 都由 content.js 注入（deps），這裡只管畫面與流程。
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

// 匯入前要玩家看清楚的事：遊戲只在載入時讀一次巨集，而且之後改巨集時會用記憶體裡的舊內容整份存回去
const confirmText = replaced => [
  `將取代 ${replaced} 列（目前有內容的巨集），備註也會整份換成匯入的。`,
  '匯入後要重新整理遊戲頁，遊戲才會讀到新的巨集。',
  '連不上遊戲（例如 403）時請不要匯入，否則重新整理不了。',
  '重新整理前不要在遊戲的巨集視窗改巨集，遊戲會用記憶體裡的舊內容存回去、蓋掉匯入。',
  '開了多個遊戲分頁時，每個分頁都要重新整理。',
].join('\n');

// root：包含 .mexport、.mimport 按鈕與 .macro-import（貼文字）、.macro-confirm（確認）、.macro-io（訊息與手動複製框）區塊的節點
// deps：readRaw() 回遊戲存的巨集原始文字（讀不到可以丟例外）、readNotes() 回備註（async）、
//       writeMacros(text) 把文字寫進遊戲存巨集的地方（寫不進去要丟例外）、writeNotes(notes) 寫備註（async）、
//       relayout() 內容變了要重排面板（選用）
function attach(root, deps) {
  const M = globalThis.CatworldMacroIO;
  const pick = selector => root.querySelector(selector);
  const exportButton = pick('.mexport');
  const importButton = pick('.mimport');
  const importBox = pick('.macro-import');
  const pasteBox = typable(pick('.macro-import-text'));
  const confirmBox = pick('.macro-confirm');
  const confirmMessage = pick('.macro-confirm-msg');
  const ioBox = pick('.macro-io');
  const message = pick('.macro-io-msg');
  const manual = typable(pick('.macro-io-text'));
  let hideTimer = null;
  let pending = null;
  const relayout = () => deps.relayout?.();

  // 訊息：要手動複製時文字框一直留著，直到下一次匯出；autoHide 的訊息一會兒就收掉，其他（錯誤、匯入結果）留著等玩家看
  function show(text, level = 'info', manualText = '', autoHide = false) {
    clearTimeout(hideTimer);
    message.textContent = text;
    message.classList.toggle('warn', level === 'warn');
    message.classList.toggle('alert', level === 'error');
    manual.hidden = !manualText;
    manual.value = manualText;
    ioBox.hidden = false;
    if (autoHide && !manualText) hideTimer = setTimeout(() => { ioBox.hidden = true; relayout(); }, MESSAGE_MS);
    relayout();
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
      show(`已複製到剪貼簿${hint ? `（${hint}）` : ''}`, level, '', true);
    } catch {
      show(`無法寫入剪貼簿，請從下面的文字框自己複製${hint ? `（${hint}）` : ''}`, 'warn', text);
    }
  });

  // 等玩家確認的那一份檢查結果；貼的文字一改就作廢，免得確認的是已經不在框裡的內容
  const dropPending = () => {
    pending = null;
    confirmBox.hidden = true;
  };

  importButton.addEventListener('click', () => {
    importBox.hidden = !importBox.hidden;
    if (importBox.hidden) dropPending();
    relayout();
  });
  pasteBox.addEventListener('input', () => {
    if (pending) relayout();
    dropPending();
  });
  pick('.macro-import-cancel').addEventListener('click', () => {
    importBox.hidden = true;
    dropPending();
    relayout();
  });
  pick('.macro-import-check').addEventListener('click', () => {
    const result = M.parseImport(pasteBox.value);
    if (!result.ok) {
      dropPending();
      show(`匯入失敗，沒有改動任何資料：${result.error}`, 'error');
      return;
    }
    let replaced = 0;
    try {
      replaced = M.countFilled(M.readMacros(deps.readRaw()).macros);
    } catch {
      // 讀不到目前的巨集就當作 0 列
    }
    pending = result;
    confirmMessage.textContent = confirmText(replaced);
    confirmBox.hidden = false;
    relayout();
  });
  pick('.macro-confirm-cancel').addEventListener('click', () => {
    dropPending();
    relayout();
  });
  pick('.macro-confirm-ok').addEventListener('click', async () => {
    const data = pending;
    if (!data) return;
    dropPending();
    try {
      deps.writeMacros(JSON.stringify(data.macros));
    } catch (error) {
      show(`匯入失敗，沒有改動任何資料：遊戲的儲存寫不進去（${error?.message || error}）`, 'error');
      return;
    }
    importBox.hidden = true;
    pasteBox.value = '';
    try {
      await deps.writeNotes(data.notes);
    } catch (error) {
      show(`巨集已寫入，但備註沒有寫進去（${error?.message || error}）。請重新整理遊戲頁，遊戲才會讀到新的巨集`, 'warn');
      return;
    }
    show('已匯入，請重新整理遊戲頁，遊戲才會讀到新的巨集', 'info');
  });
}

globalThis.CatworldMacroIOUI = { attach };
})();

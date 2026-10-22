// 面板「巨集」列的匯出、匯入與還原上一份：
// 匯出＝把遊戲的巨集加備註複製成一段 JSON 文字；匯入＝貼回那段文字，檢查通過、玩家確認後整份取代，取代前先留一份備份；
// 還原上一份＝把那份備份原樣寫回（還原後備份還在）。
// 遊戲存巨集的 localStorage、備註與備份的 storage 都由 content.js 注入（deps），這裡只管畫面與流程。
// 面板可能被搬進置頂浮窗（另一個 document）：剪貼簿一律用按鈕所在 document 的視窗，不假設事件會傳到主頁面。
(() => {
if (globalThis.CatworldMacroIOUI) return;

const MESSAGE_MS = 8000;
const IMPORT_FAILED = '匯入失敗，沒有改動任何資料：';
const RESTORE_FAILED = '還原失敗，沒有改動任何資料：';
const describeError = error => error?.message || error;

// 面板其他地方為了不搶遊戲輸入框的游標擋掉 mousedown，輸入框要放行；click 也要擋（遊戲的 window.onclick 會把游標搶回
// 遊戲輸入框）；打字也不讓遊戲的快捷鍵收到
function typable(node) {
  ['mousedown', 'click'].forEach(type => node.addEventListener(type, event => event.stopPropagation()));
  ['keydown', 'keyup', 'keypress'].forEach(type => node.addEventListener(type, event => event.stopPropagation()));
  return node;
}

// 取代前要玩家看清楚的事：遊戲只在載入時讀一次巨集，而且之後改巨集時會用記憶體裡的舊內容整份存回去
const WARNINGS = [
  '匯入後要重新整理遊戲頁，遊戲才會讀到新的巨集。',
  '連不上遊戲（例如 403）時請不要匯入，否則重新整理不了。',
  '重新整理前不要在遊戲的巨集視窗改巨集，遊戲會用記憶體裡的舊內容存回去、蓋掉匯入。',
  '開了多個遊戲分頁時，每個分頁都要重新整理。',
];
const confirmText = pending => [
  pending.kind === 'restore'
    ? `將用匯入前的備份${pending.at ? `（${new Date(pending.at).toLocaleString('zh-TW', { hour12: false })}）` : ''}取代目前 ${pending.replaced} 列，備註也會整份換回備份的。`
    : `將取代 ${pending.replaced} 列（目前有內容的巨集），備註也會整份換成匯入的。`,
  ...WARNINGS,
].join('\n');

// 訊息區（.macro-io）：一則訊息加手動複製框。manual 有文字時文字框一直留著，直到下一次匯出；
// autoHide 的訊息一會兒就收掉，其他（錯誤、匯入結果）留著等玩家看
function createMessage(pick, relayout) {
  const box = pick('.macro-io');
  const message = pick('.macro-io-msg');
  const manual = typable(pick('.macro-io-text'));
  let hideTimer = null;
  return {
    show(text, { level = 'info', manual: manualText = '', autoHide = false } = {}) {
      clearTimeout(hideTimer);
      message.textContent = text;
      message.classList.toggle('warn', level === 'warn');
      message.classList.toggle('alert', level === 'error');
      manual.hidden = !manualText;
      manual.value = manualText;
      box.hidden = false;
      if (autoHide && !manualText) hideTimer = setTimeout(() => { box.hidden = true; relayout(); }, MESSAGE_MS);
      relayout();
    },
    hide() {
      clearTimeout(hideTimer);
      box.hidden = true;
    },
  };
}

function setupExport(pick, deps, messages) {
  const M = globalThis.CatworldMacroIO;
  const exportButton = pick('.mexport');
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
      messages.show(`已複製到剪貼簿${hint ? `（${hint}）` : ''}`, { level, autoHide: true });
    } catch {
      messages.show(`無法寫入剪貼簿，請從下面的文字框自己複製${hint ? `（${hint}）` : ''}`, { level: 'warn', manual: text });
    }
  });
}

function setupImport(pick, deps, messages, relayout) {
  const M = globalThis.CatworldMacroIO;
  const importBox = pick('.macro-import');
  const pasteBox = typable(pick('.macro-import-text'));
  const confirmBox = pick('.macro-confirm');
  const confirmMessage = pick('.macro-confirm-msg');
  const restoreButton = pick('.macro-restore');
  // 等玩家確認的那一份：{ kind: 'import' | 'restore', raw（要寫進遊戲的文字）, notes, replaced（現在有幾列）, at }。
  // 貼的文字一改、收起匯入框或取消就作廢，確認鈕只套用「檢查當下」的結果，不重新解析
  let pending = null;
  const dropPending = () => {
    pending = null;
    confirmBox.hidden = true;
  };
  const askToConfirm = next => {
    let currentRaw = null;
    try {
      currentRaw = deps.readRaw();
    } catch {
      // 讀不到目前的巨集就當作 0 列
    }
    messages.hide();
    pending = { ...next, replaced: M.countFilled(M.readMacros(currentRaw).macros) };
    confirmMessage.textContent = confirmText(pending);
    confirmBox.hidden = false;
    relayout();
  };

  // 有備份才能按「還原上一份」；備份壞掉也讓它按得下去，按了才說明壞在哪
  async function refreshRestore() {
    try {
      const stored = await deps.readBackup();
      restoreButton.disabled = stored === undefined || stored === null;
    } catch {
      restoreButton.disabled = true;
    }
  }
  refreshRestore();

  // 匯入與還原共用的寫入：先寫遊戲的 localStorage（寫不進去就停，什麼都沒動），再寫備註
  async function apply({ raw, notes }, { failed, done, clearPaste }) {
    try {
      deps.writeMacros(raw);
    } catch (error) {
      messages.show(`${failed}遊戲的儲存寫不進去（${describeError(error)}）`, { level: 'error' });
      return;
    }
    importBox.hidden = true;
    if (clearPaste) pasteBox.value = '';
    try {
      await deps.writeNotes(notes);
    } catch (error) {
      messages.show(`巨集已寫入，但備註沒有寫進去（${describeError(error)}）。請重新整理遊戲頁，遊戲才會讀到新的巨集`, { level: 'warn' });
      return;
    }
    messages.show(done);
    await refreshRestore();
  }

  pick('.mimport').addEventListener('click', () => {
    importBox.hidden = !importBox.hidden;
    if (importBox.hidden) dropPending();
    relayout();
  });
  pasteBox.addEventListener('input', () => {
    const asked = Boolean(pending);
    dropPending();
    if (asked) relayout();
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
      messages.show(`${IMPORT_FAILED}${result.error}`, { level: 'error' });
      return;
    }
    askToConfirm({ kind: 'import', raw: JSON.stringify(result.macros), notes: result.notes });
  });
  restoreButton.addEventListener('click', async () => {
    dropPending();
    let stored;
    try {
      stored = await deps.readBackup();
    } catch (error) {
      messages.show(`${RESTORE_FAILED}讀不到備份（${describeError(error)}）`, { level: 'error' });
      return;
    }
    const backup = M.parseBackup(stored);
    if (!backup.ok) {
      messages.show(`${RESTORE_FAILED}${backup.error}`, { level: 'error' });
      return;
    }
    askToConfirm({ kind: 'restore', raw: backup.raw, notes: backup.notes, at: backup.at });
  });
  pick('.macro-confirm-cancel').addEventListener('click', () => {
    dropPending();
    relayout();
  });
  pick('.macro-confirm-ok').addEventListener('click', async () => {
    const data = pending;
    if (!data) return;
    dropPending();
    if (data.kind === 'restore') {
      await apply(data, { failed: RESTORE_FAILED, done: '已還原成匯入前的備份，請重新整理遊戲頁，遊戲才會讀到還原的巨集', clearPaste: false });
      return;
    }
    // 匯入：取代之前先把現在的留起來；留不住就不匯入，免得一邊沒備份一邊覆蓋
    let currentRaw = null;
    let currentNotes = {};
    try {
      currentRaw = deps.readRaw();
    } catch {
      // 讀不到目前的巨集，備份就是空的
    }
    try {
      currentNotes = await deps.readNotes();
    } catch {
      // 讀不到備註，備份就沒有備註
    }
    try {
      await deps.writeBackup(M.makeBackup(currentRaw, currentNotes, Date.now()));
    } catch (error) {
      messages.show(`${IMPORT_FAILED}匯入前的備份寫不進去（${describeError(error)}），為了讓你能回頭，匯入沒有進行`, { level: 'error' });
      return;
    }
    await apply(data, { failed: IMPORT_FAILED, done: '已匯入，請重新整理遊戲頁，遊戲才會讀到新的巨集', clearPaste: true });
  });
}

// root：包含 .mexport、.mimport 按鈕與 .macro-import（貼文字、還原上一份）、.macro-confirm（確認）、.macro-io（訊息與手動複製框）區塊的節點
// deps：readRaw() 回遊戲存的巨集原始文字（讀不到可以丟例外）、readNotes() 回備註（async）、
//       writeMacros(text) 把文字寫進遊戲存巨集的地方（寫不進去要丟例外）、writeNotes(notes) 寫備註（async）、
//       readBackup()／writeBackup(backup) 讀寫匯入前的備份（async，沒有備份時 readBackup 回 undefined）、
//       relayout() 內容變了要重排面板（選用）
function attach(root, deps) {
  const pick = selector => root.querySelector(selector);
  const relayout = () => deps.relayout?.();
  const messages = createMessage(pick, relayout);
  setupExport(pick, deps, messages);
  setupImport(pick, deps, messages, relayout);
}

globalThis.CatworldMacroIOUI = { attach };
})();

// 面板的「解謎」列：清單（依經驗與內力分組）、步驟檢視、補指令、一步一步送出、已解過、匯出匯入。
// 資料由 background 提供（ZAP_RIDDLES），這裡只負責畫面。UI 放在面板的 shadow DOM 內，
// 頁面層級的 MutationObserver 與 body.textContent 看不到，不會被當成遊戲輸出或驗證碼提示。
//
// 「送出」只呼叫 deps.startSteps（content.js 的 startMacro）：走共用送出佇列，算 active()、
// 驗證碼時被取消，面板的「巨集」列有停止鈕；這裡不直接碰遊戲的輸入框。
(() => {
if (globalThis.CatworldZapRiddleUI) return;

const R = globalThis.CatworldZapRiddles;
const EDITS_KEY = 'riddleCommands';
const DONE_KEY = 'riddleDone';
const GROUP_LABEL = { ok: '條件夠', check: '條件需自行確認', unmet: '條件未達' };

const STYLE = `
  .rd-box { padding: 4px 0 8px; }
  .rd-box[hidden], .rd-io[hidden], .rd-edit[hidden] { display: none; }
  .rd-tools { display: flex; align-items: center; gap: 6px; padding-bottom: 6px; font-size: 14px; color: #bbb; flex-wrap: wrap; }
  .rd-tools input[type=search] { all: unset; flex: 1; min-width: 90px; padding: 3px 8px; border-radius: 6px; background: #3a3a3e; color: #eee; user-select: text; }
  .rd-tools label { white-space: nowrap; cursor: pointer; }
  .rd-btn { all: unset; cursor: pointer; padding: 2px 10px; border-radius: 6px; background: #3a3a3e; color: #eee; font-size: 13px; font-weight: 600; }
  .rd-btn:hover { background: #4a4a50; }
  .rd-btn[disabled] { opacity: .35; cursor: default; }
  .rd-main { max-height: 320px; overflow: auto; font-size: 14px; user-select: text; }
  .rd-group { color: #bbb; font-weight: 700; padding: 6px 0 2px; }
  .rd-row { padding: 3px 0; border-top: 1px solid #3a3a3e; overflow-wrap: anywhere; }
  .rd-name { cursor: pointer; font-weight: 600; color: #8cc4ff; }
  .rd-meta { color: #999; font-size: 13px; }
  .rd-step { padding: 5px 0; border-top: 1px solid #3a3a3e; overflow-wrap: anywhere; }
  .rd-cmd { font-family: ui-monospace, Consolas, monospace; font-size: 13px; color: #9fe0b0; padding: 2px 0; }
  .rd-warn { color: #ffb347; font-size: 13px; }
  .rd-text { white-space: pre-wrap; color: #ccc; font-size: 13px; }
  .rd-edit textarea, .rd-io textarea { all: unset; box-sizing: border-box; width: 100%; min-height: 54px; padding: 4px 6px; border-radius: 6px; background: #3a3a3e; color: #eee; font: 13px ui-monospace, Consolas, monospace; white-space: pre-wrap; user-select: text; }
  .rd-actions { display: flex; gap: 6px; padding-top: 3px; }
  .rd-note { color: #ffb347; font-size: 13px; padding-top: 4px; }
`;

const el = (name, props = {}, ...children) => {
  const node = Object.assign(document.createElement(name), props);
  children.flat().forEach(child => node.append(child));
  return node;
};

// 面板其他地方為了不搶遊戲輸入框的游標擋掉 mousedown，輸入框要放行；打字也不讓遊戲的快捷鍵收到
function typable(node) {
  node.addEventListener('mousedown', event => event.stopPropagation());
  ['keydown', 'keyup', 'keypress'].forEach(type => node.addEventListener(type, event => event.stopPropagation()));
  return node;
}

function attach(root, { readStats, startSteps }) {
  const style = el('style', { textContent: STYLE });
  const row = el('div', { className: 'line' },
    el('span', { className: 't', textContent: '解謎' }),
    el('span', { className: 's rd-status' }),
    el('span', { className: 'mini' }, el('button', { className: 'rd-open', textContent: '解謎清單' })));
  const search = typable(el('input', { type: 'search', placeholder: '搜尋謎、提示、獎勵' }));
  const showDone = el('input', { type: 'checkbox' });
  const exportButton = el('button', { className: 'rd-btn', textContent: '匯出' });
  const importButton = el('button', { className: 'rd-btn', textContent: '匯入' });
  const main = el('div', { className: 'rd-main' });
  const ioText = typable(el('textarea', { placeholder: '貼上匯出的 JSON' }));
  const ioApply = el('button', { className: 'rd-btn', textContent: '確認匯入' });
  const io = el('div', { className: 'rd-io', hidden: true }, ioText, el('div', { className: 'rd-actions' }, ioApply));
  const note = el('div', { className: 'rd-note' });
  const box = el('div', { className: 'rd-box', hidden: true },
    el('div', { className: 'rd-tools' }, search, el('label', {}, showDone, ' 顯示已解過'), exportButton, importButton),
    io, note, main);
  root.append(style);
  root.querySelector('.body').append(row, box);

  const status = row.querySelector('.rd-status');
  let data = null;
  let edits = {};
  let done = {};
  let current = null;

  const send = async message => {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };
  const say = text => { note.textContent = text; };
  const persist = async () => {
    try {
      await chrome.storage.local.set({ [EDITS_KEY]: edits, [DONE_KEY]: done });
    } catch (error) {
      say(`儲存失敗：${error.message}`);
    }
  };

  // ---- 清單 ----
  function riddleRow(riddle) {
    const check = el('input', { type: 'checkbox', checked: Boolean(done[riddle.id]), title: '已解過' });
    check.addEventListener('change', () => {
      done = { ...done };
      if (check.checked) done[riddle.id] = true;
      else delete done[riddle.id];
      persist();
      renderList();
    });
    const name = el('span', { className: 'rd-name', textContent: riddle.name });
    name.addEventListener('click', () => { current = riddle; say(''); renderDetail(); });
    const meta = [riddle.condition && `條件：${riddle.condition}`, riddle.hint, riddle.reward && `獎勵：${riddle.reward}`].filter(Boolean).join('　');
    return el('div', { className: 'rd-row' }, check, ' ', name, ` ${riddle.difficulty}`, el('div', { className: 'rd-meta', textContent: meta }));
  }

  function renderList() {
    current = null;
    const stats = readStats();
    const missing = [!Number.isFinite(stats.exp) && '經驗', !Number.isFinite(stats.force) && '內力'].filter(Boolean);
    status.textContent = missing.length
      ? `讀不到${missing.join('、')}，需要${missing.join('、')}的條件都歸「需自行確認」`
      : `經驗 ${stats.exp}　內力上限 ${stats.force}`;
    const visible = R.searchRiddles(data.riddles, search.value).filter(riddle => showDone.checked || !done[riddle.id]);
    const groups = R.groupRiddles(visible, stats);
    main.replaceChildren();
    ['ok', 'check', 'unmet'].forEach(key => {
      main.append(el('div', { className: 'rd-group', textContent: `${GROUP_LABEL[key]}（${groups[key].length}）` }));
      groups[key].forEach(riddle => main.append(riddleRow(riddle)));
    });
  }

  // ---- 步驟檢視 ----
  function stepRow(riddle, page, index) {
    const step = page.steps[index - 1];
    const effective = R.effectiveStep(page, index, edits, riddle.page);
    const cmdText = effective.commands
      ? `指令（${effective.source === 'edited' ? '已補' : '網站'}）：${effective.commands}`
      : '（沒有指令）';
    const editor = typable(el('textarea', { value: effective.commands }));
    const save = el('button', { className: 'rd-btn', textContent: '儲存' });
    const restore = el('button', { className: 'rd-btn', textContent: '還原' });
    const edit = el('div', { className: 'rd-edit', hidden: true }, editor, el('div', { className: 'rd-actions' }, save, restore));
    const apply = text => {
      edits = R.setEdit(edits, riddle.page, page.steps.length, index, text);
      persist();
      renderDetail();
    };
    save.addEventListener('click', () => apply(editor.value));
    restore.addEventListener('click', () => apply(''));
    const editButton = el('button', { className: 'rd-btn', textContent: '編輯指令' });
    editButton.addEventListener('click', () => { edit.hidden = !edit.hidden; });
    const sendButton = el('button', { className: 'rd-btn', textContent: '送出', disabled: !effective.commands });
    sendButton.addEventListener('click', () => {
      const text = R.joinCommands(R.splitCommands(effective.commands));
      if (!text || sendButton.disabled) return;
      // 連按兩下會啟動兩個巨集（含 kill 的步驟就送兩次），按下後短暫停用
      sendButton.disabled = true;
      setTimeout(() => { sendButton.disabled = false; }, 1500);
      // startSteps 回 false 代表巨集沒有執行（例如 @等待 格式錯誤），不能說已送出
      if (startSteps(text) === false) say('沒有送出：指令格式不對，請看面板「巨集」列的提示');
      else say(`已送出第 ${step.no} 步：${text}`);
    });
    return el('div', { className: 'rd-step' },
      step.heading ? el('div', { className: 'rd-group', textContent: step.heading }) : '',
      el('div', { textContent: `${step.no}. ${step.text}` }),
      el('div', { className: 'rd-cmd', textContent: cmdText }),
      effective.stale && effective.source === 'edited' ? el('div', { className: 'rd-warn', textContent: '步驟已變動，請確認這個補充的指令還對' }) : '',
      el('div', { className: 'rd-actions' }, editButton, sendButton), edit);
  }

  function renderDetail() {
    const riddle = current;
    const back = el('button', { className: 'rd-btn', textContent: '返回清單' });
    back.addEventListener('click', () => { say(''); renderList(); });
    main.replaceChildren(
      back,
      el('div', { className: 'rd-group', textContent: riddle.name }),
      el('div', { className: 'rd-meta', textContent: [`條件：${riddle.condition}`, `難度：${riddle.difficulty}`, `獎勵：${riddle.reward}`].join('　') }));
    if (riddle.shared.length) main.append(el('div', { className: 'rd-note', textContent: `這一頁同時包含：${riddle.shared.join('、')}` }));
    const page = riddle.page ? data.pages[riddle.page] : null;
    if (!riddle.page) main.append(el('div', { className: 'rd-note', textContent: '沒有步驟頁' }));
    else if (!page) main.append(el('div', { className: 'rd-note', textContent: '沒有步驟頁資料' }));
    else if (!page.steps.length) main.append(el('div', { className: 'rd-text', textContent: page.text }));
    else {
      // 第一步之前的文字常有準備事項（要先設的點、要先收集的東西），不顯示會漏掉前置條件
      if (page.preamble) main.append(el('div', { className: 'rd-text', textContent: page.preamble }));
      page.steps.forEach((_, i) => main.append(stepRow(riddle, page, i + 1)));
    }
  }

  // ---- 匯出／匯入 ----
  exportButton.addEventListener('click', async () => {
    const text = JSON.stringify({ [EDITS_KEY]: edits, [DONE_KEY]: done });
    try {
      await navigator.clipboard.writeText(text);
      say('已複製到剪貼簿');
    } catch {
      io.hidden = false;
      ioText.value = text;
      say('無法寫入剪貼簿，請從下面的文字框自己複製');
    }
  });
  importButton.addEventListener('click', () => { io.hidden = !io.hidden; });
  ioApply.addEventListener('click', () => {
    const result = R.parseImport(ioText.value);
    if (!result.ok) {
      say(`匯入失敗，沒有改動任何資料：${result.error}`);
      return;
    }
    edits = result.riddleCommands;
    done = result.riddleDone;
    persist();
    io.hidden = true;
    say('已匯入');
    renderList();
  });

  // 另一個遊戲分頁改了補充指令或已解過標記時同步進來；不然這個分頁下次存檔會用舊資料把對方的改動蓋掉。
  // 看步驟時不重畫（編輯框裡可能有還沒存的文字）
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[EDITS_KEY]) edits = changes[EDITS_KEY].newValue ?? {};
    if (changes[DONE_KEY]) done = changes[DONE_KEY].newValue ?? {};
    if (data && !current && !box.hidden) renderList();
  });

  // ---- 開關與載入 ----
  async function open() {
    if (!data) {
      status.textContent = '載入中…';
      const reply = await send({ type: 'ZAP_RIDDLES' });
      if (!reply?.ok) {
        status.textContent = reply?.error || '載入失敗';
        box.hidden = true;
        return;
      }
      data = { riddles: reply.riddles, pages: reply.pages };
      try {
        const saved = await chrome.storage.local.get([EDITS_KEY, DONE_KEY]);
        edits = saved[EDITS_KEY] ?? {};
        done = saved[DONE_KEY] ?? {};
      } catch (error) {
        say(`讀取已存的資料失敗：${error.message}`);
      }
    }
    if (box.hidden) return;
    renderList();
  }

  let searchTimer = null;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (data && !current) renderList(); }, 300); });
  showDone.addEventListener('change', () => { if (data && !current) renderList(); });
  row.querySelector('.rd-open').addEventListener('click', () => {
    box.hidden = !box.hidden;
    if (box.hidden) {
      status.textContent = '';
      return;
    }
    open();
  });
}

globalThis.CatworldZapRiddleUI = { attach };
})();

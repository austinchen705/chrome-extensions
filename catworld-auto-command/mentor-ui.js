// 面板的「拜師」列：搜尋導師名、功法名、配合心法，結果依導師與路線分組，顯示每位導師教哪些功法與路線，可以走過去，也可以改路線。
// 資料是內建的（mentor-data.js），分組與搜尋在 mentor-search.js；這裡只負責畫面。UI 放在面板的 shadow DOM 內，
// 頁面層級的 MutationObserver 與 body.textContent 看不到，不會被當成遊戲輸出或驗證碼提示。
//
// 「走過去」只呼叫 deps.startSteps（content.js 的 startMacro）：走共用送出佇列，算 active()、
// 驗證碼時被取消，面板的「巨集」列有停止鈕；這裡不直接碰遊戲的輸入框。
(() => {
if (globalThis.CatworldMentorUI) return;

const M = globalThis.CatworldMentorSearch;
const EDITS_KEY = 'mentorRoutes';

const STYLE = `
  .mt-box { padding: 4px 0 8px; }
  .mt-box[hidden] { display: none; }
  .mt-tools { display: flex; align-items: center; gap: 6px; padding-bottom: 6px; font-size: 14px; color: #bbb; }
  .mt-tools input[type=search] { all: unset; flex: 1; min-width: 90px; padding: 3px 8px; border-radius: 6px; background: #3a3a3e; color: #eee; user-select: text; }
  .mt-list { max-height: 320px; overflow: auto; font-size: 14px; user-select: text; }
  .mt-item { padding: 4px 0; border-top: 1px solid #3a3a3e; overflow-wrap: anywhere; }
  .mt-name { font-weight: 600; color: #8cc4ff; }
  .mt-meta { color: #999; font-size: 13px; }
  .mt-empty { color: #999; font-size: 13px; padding-top: 4px; }
  .mt-walk { font-size: 12px; cursor: pointer; }
  .mt-caution { color: #ffb347; }
  .mt-bad { color: #ff8a7a; }
  .mt-tag { color: #6ec1ff; font-size: 12px; }
  .mt-edit, .mt-editbox button { font-size: 12px; cursor: pointer; }
  .mt-editbox { padding: 4px 0; font-size: 13px; color: #bbb; }
  .mt-editbox textarea { all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 54px; margin: 4px 0; padding: 4px 6px; border-radius: 6px; background: #3a3a3e; color: #eee; font: 13px ui-monospace, Consolas, monospace; white-space: pre-wrap; user-select: text; }
  .mt-editbox label { margin-right: 8px; white-space: nowrap; cursor: pointer; }
`;

const el = (name, props = {}, ...children) => {
  const node = Object.assign(document.createElement(name), props);
  children.flat().forEach(child => node.append(child));
  return node;
};

// 清單裡的文字要能選取複製：面板其他地方擋掉 mousedown 會讓選取開不了，所以文字區域放行；click 也不傳給遊戲（它會把游標搶回輸入框）
function selectable(node) {
  const plain = event => !event.target.closest?.('button, input, textarea, label, a');
  ['mousedown', 'click'].forEach(type => node.addEventListener(type, event => { if (plain(event)) event.stopPropagation(); }));
  return node;
}

// 輸入框：面板其他地方擋掉 mousedown／click，輸入框要放行；打字也不讓遊戲的快捷鍵收到
function typable(node) {
  ['mousedown', 'click', 'keydown', 'keyup', 'keypress'].forEach(type => node.addEventListener(type, event => event.stopPropagation()));
  return node;
}

function attach(root, { startSteps }) {
  const style = el('style', { textContent: STYLE });
  const row = el('div', { className: 'line' },
    el('span', { className: 't', textContent: '拜師' }),
    el('span', { className: 's mt-status' }),
    el('span', { className: 'mini' }, el('button', { className: 'mt-open', textContent: '導師' })));
  const search = typable(el('input', { type: 'search', placeholder: '搜尋導師、功法、心法' }));
  const list = selectable(el('div', { className: 'mt-list' }));
  const box = el('div', { className: 'mt-box', hidden: true }, el('div', { className: 'mt-tools' }, search), list);
  root.append(style);
  root.querySelector('.body').append(row, box);

  const status = row.querySelector('.mt-status');
  const rows = M.rowsFromData(globalThis.CatworldMentorData);
  // 使用者自己改的路線（導師|功法 → 指令）：存在本機，套在內建資料上，內建資料本身不動
  let edits = {};
  let groups = M.groupRows(rows);
  const setEdits = value => {
    edits = M.parseEdits(value);
    groups = M.groupRows(M.applyEdits(rows, edits));
    if (!box.hidden) render();
  };
  chrome.storage.local.get(EDITS_KEY).then(data => setEdits(data[EDITS_KEY])).catch(() => {});
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes[EDITS_KEY]) setEdits(changes[EDITS_KEY].newValue);
  });

  // 一筆：導師、功法、路線原文；有巨集指令就附「走過去」（遇到謎只走到謎之前），備註與不能自動走的原因另起一行
  function itemNode(group) {
    const node = el('div', { className: 'mt-item' },
      el('span', { className: 'mt-name', textContent: group.mentor }), ' ',
      el('span', { textContent: group.skills.map(M.skillLabel).join('、') }), el('br'),
      el('span', { className: 'mt-meta', textContent: `路線 ${group.route}` }));
    if (group.command) {
      const idle = group.rest ? '走到解謎處' : '走過去';
      const button = el('button', { className: 'mt-walk', textContent: idle, title: group.command });
      button.addEventListener('click', () => {
        button.disabled = true;
        const sent = startSteps(group.command);
        button.textContent = sent === false ? '送不出去' : '已送出';
        button.classList.toggle('mt-bad', sent === false);
        setTimeout(() => { button.disabled = false; button.textContent = idle; button.classList.remove('mt-bad'); }, 1500);
      });
      node.append(' ', button);
    } else if (group.reason) {
      node.append(el('br'), el('span', { className: 'mt-meta mt-caution', textContent: `不能自動走：${group.reason}，請自己照路線走` }));
    }
    if (group.rest) node.append(el('br'), el('span', { className: 'mt-meta mt-caution', textContent: `走到這裡要先解謎，後面的路線：${group.rest}` }));
    if (group.notes.length) node.append(el('br'), el('span', { className: 'mt-meta', textContent: `備註：${group.notes.join('、')}` }));
    const edit = el('button', { className: 'mt-edit', textContent: '編輯' });
    edit.addEventListener('click', event => {
      // 不讓 click 傳到遊戲的 window.onclick：它會把游標搶回遊戲輸入框，輸入框就打不了字
      event.stopPropagation();
      const open = node.querySelector('.mt-editbox');
      if (open) open.remove();
      else node.append(editBox(group));
    });
    node.firstChild.after(...(group.edited ? [' ', el('span', { className: 'mt-tag', textContent: '已自訂' })] : []));
    node.append(' ', edit);
    return node;
  }

  // 編輯框：路線（分號隔開的巨集，從醉仙樓出發）與要套用的功法（預設這一筆的全部），存、改回內建、取消
  function editBox(group) {
    const area = typable(el('textarea', { className: 'mt-edit-text', value: group.command || group.route, placeholder: '完整指令，用 ; 分隔（從醉仙樓出發）' }));
    const checks = group.skills.map(skill => el('label', {}, el('input', { type: 'checkbox', className: 'mt-edit-skill', value: skill.skill, checked: true }), ` ${skill.skill}`));
    const msg = el('span', { className: 'mt-meta mt-edit-msg' });
    const save = el('button', { className: 'mt-edit-save', textContent: '儲存' });
    const reset = el('button', { className: 'mt-edit-reset', textContent: '改回內建' });
    const cancel = el('button', { className: 'mt-edit-cancel', textContent: '取消' });
    const box = el('div', { className: 'mt-editbox' }, el('div', { textContent: '這條路線套用到：' }), checks, area, save, ' ', reset, ' ', cancel, el('br'), msg);
    ['mousedown', 'click'].forEach(type => box.addEventListener(type, event => event.stopPropagation()));
    const complain = text => { msg.textContent = text; msg.classList.add('mt-bad'); };
    const chosen = () => group.skills.filter((skill, i) => checks[i].querySelector('input').checked).map(skill => M.routeKey(group.mentor, skill.skill));
    async function persist(next) {
      try {
        await chrome.storage.local.set({ [EDITS_KEY]: next });
        setEdits(next);
      } catch (error) {
        complain(`儲存失敗：${error.message}`);
      }
    }
    save.addEventListener('click', () => {
      const text = area.value.trim();
      const keys = chosen();
      const error = text && globalThis.CatworldMacro?.parseSteps?.(text)?.error;
      if (!text) complain('路線不能是空的（要改回內建請按「改回內建」）');
      else if (error) complain(error);
      else if (!keys.length) complain('至少選一個功法');
      else persist(M.setEdits(edits, keys, text));
    });
    reset.addEventListener('click', () => {
      const keys = chosen();
      if (!keys.length) complain('至少選一個功法');
      else persist(M.setEdits(edits, keys, ''));
    });
    cancel.addEventListener('click', () => box.remove());
    return box;
  }

  function render() {
    const found = M.search(groups, search.value);
    list.replaceChildren(...found.map(itemNode));
    if (!found.length) list.append(el('div', { className: 'mt-empty', textContent: '沒有符合的導師' }));
    status.textContent = `${found.length} 筆`;
  }

  search.addEventListener('input', render);
  row.querySelector('.mt-open').addEventListener('click', () => {
    box.hidden = !box.hidden;
    if (box.hidden) status.textContent = '';
    else render();
  });

  // 開關（popup 設定頁）：關掉就隱藏「拜師」列與展開的清單
  return {
    setEnabled(on) {
      row.hidden = on !== true;
      if (row.hidden) {
        box.hidden = true;
        status.textContent = '';
      }
    },
  };
}

globalThis.CatworldMentorUI = { attach };
})();

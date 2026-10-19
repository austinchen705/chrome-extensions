// 遊戲頁面板的「怪物」列：讀 #exp 列出適合打的怪，並在遊戲輸出出現怪物時顯示它的強度與分級。
// 查詢都交給 background（資料只在那裡載入），這裡只負責畫面。UI 放在面板的 shadow DOM 內，
// 頁面層級的 MutationObserver 與 body.textContent 看不到，不會被當成遊戲輸出。
(() => {
if (globalThis.CatworldZapPanel) return;

const Z = globalThis.CatworldZapMobs;
const THRESHOLDS_KEY = 'zapThresholds';
const GAME_WINDOWS = '#monitor, #map_table, #macro_table, #setting_table';
const HINT_MS = 10000;
const HINT_MAX = 8;
const DEDUPE_MS = 10000;
const CANDIDATE_MAX = 6;
const GRADE = {
  white: { color: '#555555', label: '白' },
  green: { color: '#3ecf6e', label: '綠' },
  yellow: { color: '#e6c029', label: '黃' },
  red: { color: '#ff5c4d', label: '紅' },
  unknown: { color: '#999999', label: '未知' },
};

const STYLE = `
  .zap-box { padding: 4px 0 8px; }
  .zap-box[hidden], .zap-hint[hidden] { display: none; }
  .zap-tools { display: flex; align-items: center; gap: 8px; padding-bottom: 6px; font-size: 14px; color: #bbb; }
  .zap-tools input[type=search] { all: unset; flex: 1; min-width: 0; padding: 3px 8px; border-radius: 6px; background: #3a3a3e; color: #eee; user-select: text; }
  .zap-tools label { white-space: nowrap; cursor: pointer; }
  .zap-list { max-height: 260px; overflow: auto; font-size: 14px; user-select: text; }
  .zap-item { padding: 3px 0; border-top: 1px solid #3a3a3e; overflow-wrap: anywhere; }
  .zap-item .meta { color: #999; font-size: 13px; }
  .zap-more { color: #999; font-size: 13px; padding-top: 4px; }
  .zap-hint { padding: 6px 12px 10px; border-top: 1px solid #3a3a3e; font-size: 14px; user-select: text; max-height: 280px; overflow: auto; }
  .zap-hint .title { color: #999; font-size: 13px; }
`;

const el = (name, props = {}, ...children) => {
  const node = Object.assign(document.createElement(name), props);
  children.flat().forEach(child => node.append(child));
  return node;
};

const gradeTag = grade => {
  const { color, label } = GRADE[grade] || GRADE.unknown;
  const node = el('b', { textContent: label });
  node.style.color = color;
  return node;
};

// 一隻怪的一個候選：顏色、名稱、q、位置、備註
function candidateNode({ mob, q, grade, idOnly }, showName) {
  return el('div', { className: 'zap-item' },
    gradeTag(grade), ' ', showName ? mob.name : '', showName ? el('br') : '',
    el('span', { className: 'meta', textContent: Z.metaText({ mob, q, idOnly }) }));
}

function attach(root, { readExp }) {
  const style = el('style', { textContent: STYLE });
  const row = el('div', { className: 'line' },
    el('span', { className: 't', textContent: '怪物' }),
    el('span', { className: 's zap-status' }),
    el('span', { className: 'mini' }, el('button', { className: 'zap-open', textContent: '適合的怪' })));
  const search = el('input', { type: 'search', placeholder: '搜尋名稱或位置' });
  const yellow = el('input', { type: 'checkbox' });
  const list = el('div', { className: 'zap-list' });
  const box = el('div', { className: 'zap-box', hidden: true },
    el('div', { className: 'zap-tools' }, search, el('label', {}, yellow, ' 含黃色')), list);
  const hint = el('div', { className: 'zap-hint', hidden: true });
  root.append(style);
  root.querySelector('.body').append(row, box);
  root.querySelector('.panel').append(hint);

  const status = row.querySelector('.zap-status');
  const send = async message => {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  let thresholds = Z.normalizeThresholds(undefined);
  const refresh = () => { if (!box.hidden) runQuery(); };
  chrome.storage.local.get(THRESHOLDS_KEY).then(data => { thresholds = Z.normalizeThresholds(data[THRESHOLDS_KEY]); });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes[THRESHOLDS_KEY]) return;
    thresholds = Z.normalizeThresholds(changes[THRESHOLDS_KEY].newValue);
    refresh();
  });

  // 搜尋框要能取得游標：面板其他地方為了不搶遊戲輸入框的游標擋掉 mousedown，這裡放行；
  // 打字也不讓遊戲的快捷鍵收到
  search.addEventListener('mousedown', event => event.stopPropagation());
  ['keydown', 'keyup', 'keypress'].forEach(type => search.addEventListener(type, event => event.stopPropagation()));

  // 查詢是非同步的（背景第一次要載入資料），連續操作時只採用最後一次的結果
  let queryId = 0;
  async function runQuery() {
    const exp = readExp();
    const mine = ++queryId;
    if (!(exp > 0)) {
      list.replaceChildren();
      status.textContent = '讀不到經驗';
      return;
    }
    status.textContent = `經驗 ${exp}`;
    const reply = await send({
      type: 'ZAP_SUITABLE', exp, thresholds, grades: yellow.checked ? ['green', 'yellow'] : ['green'], query: search.value,
    });
    if (mine !== queryId) return;
    list.replaceChildren();
    if (!reply?.ok) {
      status.textContent = reply?.error || '查詢失敗';
      return;
    }
    reply.items.forEach(item => list.append(candidateNode(item, true)));
    if (!reply.items.length) list.append(el('div', { className: 'zap-more', textContent: '沒有符合的怪' }));
    if (reply.total > reply.items.length) list.append(el('div', { className: 'zap-more', textContent: `共 ${reply.total} 筆，只列前 ${reply.items.length} 筆` }));
  }

  let searchTimer = null;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runQuery, 300); });
  yellow.addEventListener('change', runQuery);
  row.querySelector('.zap-open').addEventListener('click', () => {
    box.hidden = !box.hidden;
    if (box.hidden) status.textContent = '';
    else runQuery();
  });

  // ---- 怪物出現 ----
  let hideTimer = null;
  function showHints(results, hidden, expReadable) {
    hint.replaceChildren(el('div', { className: 'title', textContent: expReadable ? '這裡的怪物' : '這裡的怪物（讀不到經驗，無法分級）' }));
    results.forEach(({ name, count, candidates }) => {
      hint.append(el('div', { className: 'zap-item', textContent: count > 1 ? `${name} ×${count}` : name }));
      if (!candidates.length) hint.append(el('div', { className: 'zap-more', textContent: '表上無此怪' }));
      const { shown, hidden: more } = Z.limitHints(candidates, CANDIDATE_MAX);
      // 只靠 ID 命中時同一個 ID 可能有幾十隻，要顯示名稱才分得出來
      shown.forEach(candidate => hint.append(candidateNode(candidate, candidate.idOnly)));
      if (more) hint.append(el('div', { className: 'zap-more', textContent: `…還有 ${more} 筆同名候選` }));
    });
    if (hidden) hint.append(el('div', { className: 'zap-more', textContent: `…還有 ${hidden} 種` }));
    hint.hidden = false;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { hint.hidden = true; }, HINT_MS);
  }

  const inGameOutput = node => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element?.closest('#content')) && !element.closest(GAME_WINDOWS);
  };
  const lastShown = {};
  let lookupId = 0;
  const observer = new MutationObserver(records => {
    const text = Z.textFromAdded(records
      .filter(record => inGameOutput(record.target))
      .flatMap(record => (record.type === 'characterData'
        ? [record.target.textContent || '']
        : Array.from(record.addedNodes, node => node.textContent || ''))));
    const items = Z.parseMobLines(text);
    if (!items.length) return;
    const fresh = new Set(Z.recentFilter(items.map(item => item.name), Date.now(), lastShown, DEDUPE_MS));
    const { shown, hidden } = Z.limitHints(items.filter(item => fresh.has(item.name)), HINT_MAX);
    if (!shown.length) return;
    const exp = readExp();
    const mine = ++lookupId;
    send({ type: 'ZAP_LOOKUP', exp, thresholds, names: shown }).then(reply => {
      if (reply?.ok && mine === lookupId) showHints(reply.items, hidden, exp > 0);
    });
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
}

globalThis.CatworldZapPanel = { attach };
})();

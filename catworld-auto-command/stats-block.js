// 面板最上方的「數值」區塊：顯示經驗與精氣神、內力等（格式見 stats-view.js），每秒由 content.js 的 renderPanel 餵讀數。
// 標題可以點一下收合，收合狀態記在本機儲存（chrome.storage.local.statsCollapsed）。
// 面板可能被搬進置頂浮窗（另一個 document）：事件綁在節點上、樣式在 shadow root 裡，搬過去仍然有效。
(() => {
if (globalThis.CatworldStatsBlock) return;

const COLLAPSED_KEY = 'statsCollapsed';
const STYLE = `
  .stats { padding: 2px 0 6px; border-bottom: 1px solid #3a3a3e; margin-bottom: 4px; }
  .stats-title { all: unset; cursor: pointer; display: block; font-weight: 600; padding: 3px 0; color: #ddd; }
  .stats-title:hover { color: #fff; }
  .stats-grid { display: grid; grid-template-columns: auto 1fr; gap: 1px 12px; font-size: 14px; padding-top: 2px; }
  .stats-grid[hidden] { display: none; }
  .stat-label { color: #aaa; }
  .stat-value { color: #eee; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .stat-row { display: contents; }
`;

const el = (name, props = {}, ...children) => {
  const node = Object.assign(document.createElement(name), props);
  children.forEach(child => node.append(child));
  return node;
};

function attach(root) {
  const V = globalThis.CatworldStatsView;
  const rowNodes = new Map(V.LABELS.map(label => [label, {
    row: el('div', { className: 'stat-row' }),
    value: el('span', { className: 'stat-value', textContent: '—' }),
  }]));
  rowNodes.forEach(({ row, value }, label) => row.append(el('span', { className: 'stat-label', textContent: label }), value));

  const title = el('button', { className: 'stats-title' });
  const grid = el('div', { className: 'stats-grid' }, ...[...rowNodes.values()].map(({ row }) => row));
  const section = el('div', { className: 'stats' }, title, grid);
  root.append(el('style', { textContent: STYLE }));
  root.querySelector('.body').prepend(section);

  // 預設展開。讀到的收合狀態只在玩家還沒動過的時候才套用，晚到的讀取不能蓋掉玩家剛點的
  let collapsed = false;
  let touched = false;
  const apply = () => {
    grid.hidden = collapsed;
    title.textContent = `${collapsed ? '▸' : '▾'} 數值`;
  };
  apply();
  chrome.storage.local.get(COLLAPSED_KEY).then(data => {
    if (touched) return;
    collapsed = data[COLLAPSED_KEY] === true;
    apply();
  }).catch(() => { /* 讀不到就維持展開 */ });

  title.addEventListener('click', () => {
    touched = true;
    collapsed = !collapsed;
    apply();
    Promise.resolve(chrome.storage.local.set({ [COLLAPSED_KEY]: collapsed })).catch(() => { /* 存不進去就算了，這次還是收合著 */ });
  });

  // readings：content.js 的 readAllStats()；exp：#exp 的數字，讀不到是 NaN
  function render(readings, exp) {
    V.rows(readings, exp).forEach(({ label, text }) => {
      const node = rowNodes.get(label);
      if (node && node.value.textContent !== text) node.value.textContent = text;
    });
  }

  return { render };
}

globalThis.CatworldStatsBlock = { attach };
})();

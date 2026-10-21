// 面板最上方的「數值」區塊：顯示經驗與精氣神、內力等（格式見 stats-view.js），每秒由 content.js 的 renderPanel 餵讀數。
// 標題可以點一下收合，收合狀態記在本機儲存（chrome.storage.local.statsCollapsed）。
// 面板可能被搬進置頂浮窗（另一個 document）：事件綁在節點上、樣式在 shadow root 裡，搬過去仍然有效。
(() => {
if (globalThis.CatworldStatsBlock) return;

const COLLAPSED_KEY = 'statsCollapsed';
// 配色和遊戲的狀態視窗（#monitor）一樣：深色底、虛線淺色邊框、遊戲的文字色，經驗用它自己的顏色。
// 顏色由 content.js 讀遊戲視窗實際生效的值（隨遊戲設定的色彩主題與半透明而變），經 setTheme 放進 CSS 變數；
// 下面括號裡是讀不到時的預設值（遊戲預設的 XTerm 主題）。
const DEFAULT_THEME = Object.freeze({ background: '#222222', border: '#BBBBBB', text: 'rgb(229, 229, 229)', exp: 'rgb(255, 0, 255)' });
// 只收單純的顏色值（rgb()、rgba()、#十六進位）：它會被放進 style，不能讓任意字串進去
const COLOR = /^(?:rgba?\(\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}(?:\.\d+)?\s*(?:,\s*(?:0|1|0?\.\d+|1\.0+)\s*)?\)|#[0-9a-fA-F]{3,8})$/;
const FULLY_TRANSPARENT = /^rgba\(\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}(?:\.\d+)?\s*,\s*0(?:\.0+)?\s*\)$/;
const pick = (value, fallback) => {
  const color = typeof value === 'string' ? value.trim() : '';
  return COLOR.test(color) && !FULLY_TRANSPARENT.test(color) ? color : fallback;
};

// 遊戲的狀態視窗會依「這一項滿到幾成」替每一項的數字換顏色（超過 100% 亮青、90% 以上亮綠、60% 以上亮黃、
// 30% 以上暗黃、10% 以上亮紅、其餘暗紅），顏色隨使用者選的色彩主題而不同。我們不重做那套門檻，
// 直接讀遊戲裡那一項數字此刻實際的顏色，永遠和遊戲一致。
const STAT_LABELS = ['精', '氣', '神', '靈力', '內力', '法力', '食物', '飲水'];

// monitorStyle、expStyle：遊戲 #monitor 與 #exp 的 getComputedStyle 結果（或同樣欄位的物件，讀不到可以是空）；
// statStyles：{ 精: 該項數字元素的樣式, … }，讀不到的項目用一般文字色
function themeFrom(monitorStyle, expStyle, statStyles) {
  const text = pick(monitorStyle?.color, DEFAULT_THEME.text);
  return {
    background: pick(monitorStyle?.backgroundColor, DEFAULT_THEME.background),
    border: pick(monitorStyle?.borderTopColor, DEFAULT_THEME.border),
    text,
    exp: pick(expStyle?.color, DEFAULT_THEME.exp),
    values: Object.fromEntries(STAT_LABELS.map(label => [label, pick(statStyles?.[label]?.color, text)])),
  };
}

const STYLE = `
  .stats { box-sizing: border-box; padding: 4px 6px 6px; margin-bottom: 6px;
    background: var(--stats-bg, #222222); border: 1px dashed var(--stats-border, #BBBBBB); color: var(--stats-fg, rgb(229, 229, 229)); }
  /* 只在置頂浮窗裡顯示（宿主帶 data-pip）：遊戲頁本來就有狀態視窗，主面板不用再放一份 */
  :host(:not([data-pip])) .stats { display: none; }
  .stats-title { all: unset; cursor: pointer; display: block; font-weight: 600; padding: 2px 0; color: var(--stats-fg, rgb(229, 229, 229)); }
  .stats-title:hover { text-decoration: underline; }
  .stats-grid { display: grid; grid-template-columns: auto 1fr; gap: 1px 12px; font-size: 14px; padding-top: 2px; }
  .stats-grid[hidden] { display: none; }
  .stat-label { color: var(--stats-fg, rgb(229, 229, 229)); }
  .stat-value { color: var(--stats-fg, rgb(229, 229, 229)); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .stat-exp .stat-value { color: var(--stats-exp, rgb(255, 0, 255)); }
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
    row: el('div', { className: label === '經驗' ? 'stat-row stat-exp' : 'stat-row' }),
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

  // 配色：theme 通常是 themeFrom 的結果；沒給或壞掉的欄位用預設值。沒變就不重設
  let appliedTheme = '';
  function setTheme(theme) {
    const next = {
      background: pick(theme?.background, DEFAULT_THEME.background),
      border: pick(theme?.border, DEFAULT_THEME.border),
      text: pick(theme?.text, DEFAULT_THEME.text),
      exp: pick(theme?.exp, DEFAULT_THEME.exp),
      // 每一項數字的顏色；沒給的項目不加行內顏色，沿用樣式表的一般文字色
      values: Object.fromEntries(STAT_LABELS.map(label => [label, pick(theme?.values?.[label], '')])),
    };
    const key = JSON.stringify(next);
    if (key === appliedTheme) return;
    appliedTheme = key;
    STAT_LABELS.forEach(label => {
      const node = rowNodes.get(label);
      if (node) node.value.style.color = next.values[label];
    });
    section.style.setProperty('--stats-bg', next.background);
    section.style.setProperty('--stats-border', next.border);
    section.style.setProperty('--stats-fg', next.text);
    section.style.setProperty('--stats-exp', next.exp);
  }

  return { render, setTheme };
}

globalThis.CatworldStatsBlock = { attach, themeFrom };
})();

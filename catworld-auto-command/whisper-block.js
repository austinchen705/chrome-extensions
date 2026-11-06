// 置頂浮窗裡的「密語」區塊：有人私聊我（[P]暱稱回答你：內容）時顯示最近 MAX 句，按「清除」才消失；
// 新的一句進來時整塊閃爍幾次，之後維持醒目的底色。沒有密語時整塊不佔位置；只在置頂浮窗裡顯示（宿主帶 data-pip），
// 主面板不放：遊戲頁的輸出區本來就看得到。
// 配色是 chrome.storage.local.whisperColor（COLORS 的鍵，缺值＝橘），setColor 由 content.js 呼叫。
// 開關是 chrome.storage.local.zapFeatures.whisper（缺值＝開），setEnabled 由 content.js 的 applyZapFeatures 呼叫。
// 資料由 content.js 的聊天記錄器（chat-reply.js 的 onIncoming）餵進來，不另外解析遊戲輸出。
// 面板可能被搬進置頂浮窗（另一個 document）：事件綁在節點上、樣式在 shadow root 裡，搬過去仍然有效。
(() => {
if (globalThis.CatworldWhisperBlock) return;

const MAX = 5;
const MAX_TEXT = 200;

// 最新的在最前面，超過 MAX 句丟掉最舊的；不改輸入
const push = (list, entry, max = MAX) => [entry, ...list].slice(0, max);

// 設定頁可選的配色（chrome.storage.local.whisperColor 存鍵）：底色深、框與閃爍色亮，文字淺色、名字稍亮；預設 orange
const COLORS = Object.freeze({
  orange: { label: '橘', bg: '#5a3b00', accent: '#ffb347', text: '#fff3d6', name: '#ffd27a' },
  red: { label: '紅', bg: '#5c0f0f', accent: '#ff5a5a', text: '#ffe3e3', name: '#ffb3b3' },
  yellow: { label: '黃', bg: '#5c5200', accent: '#ffe14d', text: '#fffbe0', name: '#fff09a' },
  green: { label: '綠', bg: '#0f4a1f', accent: '#4ddc7a', text: '#e3ffec', name: '#9af0b6' },
  cyan: { label: '青', bg: '#0b4a52', accent: '#4dd8e8', text: '#e0fbff', name: '#9aeaf5' },
  blue: { label: '藍', bg: '#12285e', accent: '#6aa0ff', text: '#e6efff', name: '#adc8ff' },
  purple: { label: '紫', bg: '#3f1a63', accent: '#b98aff', text: '#f1e6ff', name: '#d7bdff' },
  pink: { label: '粉', bg: '#5c1a40', accent: '#ff7ac0', text: '#ffe3f1', name: '#ffb3d9' },
});
const DEFAULT_COLOR = 'orange';
const colorOf = key => COLORS[Object.hasOwn(COLORS, key) ? key : DEFAULT_COLOR];

const STYLE = `
  .whisper { box-sizing: border-box; padding: 4px 6px 6px; margin-bottom: 6px; background: var(--w-bg, #5a3b00); border: 2px solid var(--w-accent, #ffb347); color: var(--w-text, #fff3d6); }
  .whisper[hidden] { display: none; }
  /* 只在置頂浮窗裡顯示（宿主帶 data-pip） */
  :host(:not([data-pip])) .whisper { display: none; }
  /* 閃爍時整塊變成亮色底，文字與名字同步變深，才看得清楚 */
  .whisper.fresh { animation: whisper-flash 0.6s ease-in-out 5; }
  .whisper.fresh .whisper-name { animation: whisper-flash-name 0.6s ease-in-out 5; }
  @keyframes whisper-flash { 0%, 100% { background: var(--w-bg, #5a3b00); border-color: var(--w-accent, #ffb347); color: var(--w-text, #fff3d6); } 50% { background: var(--w-accent, #ffb347); border-color: var(--w-text, #fff3d6); color: #1b1200; } }
  @keyframes whisper-flash-name { 0%, 100% { color: var(--w-name, #ffd27a); } 50% { color: #1b1200; } }
  .whisper-head { display: flex; align-items: center; justify-content: space-between; font-weight: 600; padding: 2px 0; }
  .whisper-clear { all: unset; cursor: pointer; font-size: 12px; padding: 1px 6px; border: 1px solid var(--w-accent, #ffb347); border-radius: 3px; }
  .whisper-clear:hover { background: var(--w-accent, #ffb347); color: #1b1200; }
  .whisper-list { margin: 0; padding: 0; list-style: none; font-size: 14px; }
  .whisper-item { padding: 2px 0; overflow-wrap: anywhere; border-top: 1px dashed var(--w-accent, #ffb347); }
  .whisper-item:first-child { border-top: 0; }
  .whisper-name { color: var(--w-name, #ffd27a); font-weight: 600; }
`;

const el = (name, props = {}, ...children) => {
  const node = Object.assign(document.createElement(name), props);
  children.forEach(child => node.append(child));
  return node;
};

function attach(root) {
  const clear = el('button', { className: 'whisper-clear', type: 'button', textContent: '清除' });
  const list = el('ul', { className: 'whisper-list' });
  const section = el('div', { className: 'whisper', hidden: true }, el('div', { className: 'whisper-head' }, el('span', { textContent: '密語' }), clear), list);
  root.append(el('style', { textContent: STYLE }));
  root.querySelector('.body').prepend(section);

  let entries = [];
  let enabled = true;
  const draw = () => {
    section.hidden = entries.length === 0;
    list.replaceChildren(...entries.map(entry => el('li', { className: 'whisper-item' },
      el('span', { className: 'whisper-name', textContent: `${entry.name}：` }), entry.text)));
  };

  // 新的一句：加進清單並重新閃爍（先拿掉 fresh、強制重排，動畫才會從頭播）
  function add({ name, text }) {
    if (!enabled) return;
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!clean) return;
    entries = push(entries, { name: String(name ?? '').trim() || '?', text: clean });
    draw();
    section.classList.remove('fresh');
    void section.offsetWidth;
    section.classList.add('fresh');
  }

  clear.addEventListener('click', () => {
    entries = [];
    section.classList.remove('fresh');
    draw();
  });

  // 設定頁的開關（預設開）：關掉就清空並隱藏，之後的密語也不累積
  function setEnabled(on) {
    enabled = on !== false;
    if (!enabled) {
      entries = [];
      section.classList.remove('fresh');
      draw();
    }
  }

  // 設定頁選的配色（COLORS 的鍵）；不認得的退回預設
  function setColor(key) {
    const color = colorOf(key);
    section.style.setProperty('--w-bg', color.bg);
    section.style.setProperty('--w-accent', color.accent);
    section.style.setProperty('--w-text', color.text);
    section.style.setProperty('--w-name', color.name);
  }

  return { add, setEnabled, setColor };
}

globalThis.CatworldWhisperBlock = { attach, push, MAX, COLORS, DEFAULT_COLOR };
})();

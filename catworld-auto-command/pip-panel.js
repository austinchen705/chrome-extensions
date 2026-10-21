// 置頂浮窗（Document Picture-in-Picture）：把面板的宿主節點「搬」進一個永遠置頂的小視窗，關掉再搬回原位。
// 不直接碰 chrome.*；浮窗 API、宿主節點、提示與狀態變化都由呼叫端注入，方便用假的浮窗 API 測試。
// 搬的是節點本身（不是複製），事件與 shadow DOM 都跟著走。不要拿它搬遊戲自己的 #monitor：
// 搬走之後遊戲與我們用 getElementById 讀數值的程式都找不到它。
(() => {
if (globalThis.CatworldPip) return;

const DEFAULT_WIDTH = 360;
const MIN_HEIGHT = 200;
// 浮窗是一份空白文件：沒有頁面的 CSS，宿主要自己定位、底色要自己給（面板本身的樣式在 shadow root 裡，會跟著走）
// 面板比視窗高時要能捲動（視窗高度是開啟當下量的，之後內容會變）；宿主用一般排版，不用 fixed，才會跟著捲
const BODY_STYLE = 'margin:0;background:#1c1c1e;overflow:auto;';
const HOST_STYLE = 'display:block;';
// 面板搬走後留在原位的提示條：用行內樣式（遊戲頁的 CSS 可能影響它），位置沿用宿主原本的定位
const STRIP_STYLE = 'display:flex;align-items:center;gap:10px;box-sizing:border-box;padding:8px 12px;border-radius:12px;'
  + 'background:rgba(28,28,30,.93);color:#eee;font:14px system-ui,-apple-system,"Microsoft JhengHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);';
const BACK_STYLE = 'cursor:pointer;border:0;border-radius:6px;padding:3px 12px;background:#3a3a3e;color:#fff;font:600 14px system-ui,sans-serif;';

function create({ host, pipApi, notify = () => {}, onChange = () => {} }) {
  const supported = typeof pipApi?.requestWindow === 'function';
  let pipWindow = null;
  let strip = null;
  let home = null;
  let savedStyle = '';
  let opening = false;

  // 提示條：說明面板在浮窗裡，並提供收回；同時兼作「原位置」的標記，放回時靠它找位置
  function makeStrip(doc) {
    const bar = doc.createElement('div');
    bar.id = 'catworld-panel-placeholder';
    bar.style.cssText = `${host.style.cssText};${STRIP_STYLE}`;
    const text = doc.createElement('span');
    text.textContent = '面板在置頂視窗';
    const back = doc.createElement('button');
    back.textContent = '收回';
    back.style.cssText = BACK_STYLE;
    back.addEventListener('click', () => restore());
    bar.append(text, back);
    return bar;
  }

  // 放回原位：用開窗前放在宿主位置的提示條找回位置；提示條被頁面刪掉了就放回主頁面的根節點，
  // 面板絕對不能留在已經關掉的浮窗裡
  function putBack() {
    if (strip?.parentNode) strip.parentNode.insertBefore(host, strip);
    else if (home && host.ownerDocument !== home) home.documentElement.append(host);
    strip?.remove();
    strip = null;
  }

  // 可以重複呼叫（浮窗關閉事件與主動關閉都會走到這裡）
  function restore() {
    if (!pipWindow) return;
    const closing = pipWindow;
    pipWindow = null;
    putBack();
    host.style.cssText = savedStyle;
    host.removeAttribute('data-pip');
    onChange(false);
    try { closing.close(); } catch { /* 已經關了 */ }
  }

  async function open() {
    if (!supported) {
      notify('這個瀏覽器不支援置頂視窗（需要較新的 Chrome）');
      return false;
    }
    if (pipWindow || opening) return false;
    opening = true;
    let win = null;
    let styled = false;
    try {
      const height = Math.max(MIN_HEIGHT, Math.ceil(host.getBoundingClientRect().height) + 16);
      win = await pipApi.requestWindow({ width: DEFAULT_WIDTH, height });
      home = host.ownerDocument;
      strip = makeStrip(host.ownerDocument);
      host.parentNode.insertBefore(strip, host);
      savedStyle = host.style.cssText;
      styled = true;
      win.document.body.style.cssText = BODY_STYLE;
      host.style.cssText = HOST_STYLE;
      win.document.body.append(host);
      host.setAttribute('data-pip', '');
      pipWindow = win;
      win.addEventListener('pagehide', restore, { once: true });
      onChange(true, win);
      return true;
    } catch (error) {
      // 開到一半失敗：面板放回原位、清掉標記、關掉半開的浮窗，不能留下殘骸
      pipWindow = null;
      putBack();
      host.removeAttribute('data-pip');
      if (styled) host.style.cssText = savedStyle;
      try { win?.close(); } catch { /* 已經關了 */ }
      notify(`無法開啟置頂視窗：${error?.message ?? error}`);
      return false;
    } finally {
      opening = false;
    }
  }

  return {
    supported,
    isOpen: () => Boolean(pipWindow),
    open,
    close: restore,
    toggle: () => (pipWindow ? (restore(), Promise.resolve(false)) : open()),
  };
}

// 警報提示（標題閃爍、提示音）要靠「玩家有互動」來停止，原本只聽遊戲視窗的 focus、pointerdown、keydown。
// 面板搬進浮窗後玩家的操作只發生在浮窗裡，所以要同時聽遊戲視窗與浮窗：watch 登記要聽的事件，
// 之後加進來的視窗也會自動被聽到，stop 一次全部拿掉
function createInteractionHub(mainWindow) {
  const windows = new Set([mainWindow]);
  const watchers = new Set();
  const attach = (win, watcher) => watcher.events.forEach(name => {
    try { win.addEventListener(name, watcher.handler); } catch { /* 視窗已經關了 */ }
  });
  const detach = (win, watcher) => watcher.events.forEach(name => {
    try { win.removeEventListener(name, watcher.handler); } catch { /* 視窗已經關了 */ }
  });
  return {
    watch(events, handler) {
      const watcher = { events, handler };
      watchers.add(watcher);
      windows.forEach(win => attach(win, watcher));
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        watchers.delete(watcher);
        windows.forEach(win => detach(win, watcher));
      };
    },
    addWindow(win) {
      if (windows.has(win)) return;
      windows.add(win);
      watchers.forEach(watcher => attach(win, watcher));
    },
    // 遊戲視窗本身永遠不能被拿掉
    removeWindow(win) {
      if (win === mainWindow || !windows.delete(win)) return;
      watchers.forEach(watcher => detach(win, watcher));
    },
  };
}

globalThis.CatworldPip = { create, createInteractionHub };
})();

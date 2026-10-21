// 置頂浮窗（Document Picture-in-Picture）：把面板的宿主節點「搬」進一個永遠置頂的小視窗，關掉再搬回原位。
// 不直接碰 chrome.*；浮窗 API、宿主節點、提示與狀態變化都由呼叫端注入，方便用假的浮窗 API 測試。
// 搬的是節點本身（不是複製），事件與 shadow DOM 都跟著走。不要拿它搬遊戲自己的 #monitor：
// 搬走之後遊戲與我們用 getElementById 讀數值的程式都找不到它。
(() => {
if (globalThis.CatworldPip) return;

const DEFAULT_WIDTH = 360;
const MIN_HEIGHT = 200;
// 浮窗是一份空白文件：沒有頁面的 CSS，宿主要自己定位、底色要自己給（面板本身的樣式在 shadow root 裡，會跟著走）
const BODY_STYLE = 'margin:0;background:#1c1c1e;';
const HOST_STYLE = 'position:fixed;top:0;left:0;z-index:2147483647;';

function create({ host, pipApi, notify = () => {}, onChange = () => {} }) {
  const supported = typeof pipApi?.requestWindow === 'function';
  let pipWindow = null;
  let marker = null;
  let savedStyle = '';
  let opening = false;

  // 放回原位：用開窗前插在宿主旁邊的標記找回位置；可以重複呼叫（浮窗關閉事件與主動關閉都會走到這裡）
  function restore() {
    if (!pipWindow) return;
    const closing = pipWindow;
    pipWindow = null;
    if (marker?.parentNode) {
      marker.parentNode.insertBefore(host, marker);
      marker.remove();
    }
    marker = null;
    host.style.cssText = savedStyle;
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
      marker = host.ownerDocument.createComment('catworld-panel');
      host.parentNode.insertBefore(marker, host);
      savedStyle = host.style.cssText;
      styled = true;
      win.document.body.style.cssText = BODY_STYLE;
      host.style.cssText = HOST_STYLE;
      win.document.body.append(host);
      pipWindow = win;
      win.addEventListener('pagehide', restore, { once: true });
      onChange(true);
      return true;
    } catch (error) {
      // 開到一半失敗：面板放回原位、清掉標記、關掉半開的浮窗，不能留下殘骸
      pipWindow = null;
      if (marker?.parentNode) {
        marker.parentNode.insertBefore(host, marker);
        marker.remove();
      }
      marker = null;
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

globalThis.CatworldPip = { create };
})();

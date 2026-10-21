// content script 不能直接彈系統通知、也不能開分頁，由這裡代為處理
importScripts('zap-mobs.js', 'zap-items.js', 'zap-riddles.js', 'line-notify.js');
// 面板上的 ⚙：按一下在新分頁開啟設定頁（popup.html 當成分頁開，?tab= 帶遊戲分頁的 id），再按一次關閉並切回遊戲分頁。
// 「遊戲分頁 → 設定分頁」的對應放在 storage.session，service worker 被收掉再醒來也還在
const settingsKey = gameTabId => `settingsTab:${gameTabId}`;

async function toggleSettings(gameTab) {
  const key = settingsKey(gameTab.id);
  const saved = (await chrome.storage.session.get(key))[key];
  // 設定分頁可能已經被使用者自己關掉了，這時要重新開，不是關閉
  const alive = saved !== undefined && await chrome.tabs.get(saved).then(() => true, () => false);
  if (alive) {
    await chrome.tabs.remove(saved);
    await chrome.storage.session.remove(key);
    await chrome.tabs.update(gameTab.id, { active: true });
    return;
  }
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?tab=${gameTab.id}`) });
  await chrome.storage.session.set({ [key]: tab.id });
}

chrome.tabs.onRemoved.addListener(async removedId => {
  const all = await chrome.storage.session.get(null);
  const stale = Object.entries(all)
    .filter(([key, settingsTabId]) => key.startsWith('settingsTab:') && (settingsTabId === removedId || key === settingsKey(removedId)))
    .map(([key]) => key);
  if (stale.length) await chrome.storage.session.remove(stale);
});

// 手機通知（LINE）：憑證只在這裡從 storage.local 讀，不經過訊息；結果放 storage.session 給設定頁顯示，結果裡不含憑證
const LINE_KEY = 'lineNotify';
const LINE_RESULT_KEY = 'lineLastResult';

async function sendLine(text) {
  const saved = (await chrome.storage.local.get(LINE_KEY))[LINE_KEY] ?? {};
  const result = await CatworldLineNotify.send({
    fetchImpl: fetch, token: saved.token, userId: saved.userId, text, now: Date.now,
  });
  await chrome.storage.session.set({ [LINE_RESULT_KEY]: result }).catch(() => {});
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 設定頁的測試訊息：設定頁是開成分頁的（sender.tab 有值），所以看訊息是不是來自擴充功能自己的頁面（content script 的 sender.url 是遊戲網址）；
  // 要在下面「沒有 sender.tab 就略過」的檢查之前處理
  if (message?.type === 'LINE_TEST' && sender.url?.startsWith(chrome.runtime.getURL(''))) {
    sendLine('【CatWorld】這是一則測試訊息').then(sendResponse);
    return true;
  }
  if (!sender.tab) return;
  if (message.type === 'TOGGLE_SETTINGS') {
    toggleSettings(sender.tab);
    return;
  }
  if (message.type !== 'ALERT') return;
  chrome.notifications.create(`catworld-${sender.tab.id}-${sender.tab.windowId}`, {
    type: 'basic',
    iconUrl: 'icon.png',
    title: 'CatWorld 已停止',
    message: message.reason,
    priority: 2,
    requireInteraction: true,
    // 警報響鈴中（提示音只有按「確認」才停）：通知上也放一顆確認，不用回到遊戲分頁
    ...(message.confirmable ? { buttons: [{ title: '確認（停止提示音）' }] } : {})
  });
});

chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => {
  if (buttonIndex !== 0) return;
  const [, tabId] = id.split('-').map(Number);
  chrome.tabs.sendMessage(tabId, { type: 'CONFIRM_ALERT' }).catch(() => {});
  chrome.notifications.clear(id);
});

chrome.notifications.onClicked.addListener(id => {
  const [, tabId, windowId] = id.split('-').map(Number);
  chrome.tabs.update(tabId, { active: true });
  chrome.windows.update(windowId, { focused: true });
  chrome.notifications.clear(id);
});

// 怪物、無名物品與解謎資料（約 1.3MB）只在第一次被問到時才載入並留在記憶體，不隨每個遊戲分頁載入；載入失敗不快取，下次再試
let zapDataPromise = null;
function loadZapData() {
  zapDataPromise ??= fetch(chrome.runtime.getURL('zap-data.json'))
    .then(response => response.json())
    .catch(error => {
      zapDataPromise = null;
      throw error;
    });
  return zapDataPromise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!String(message?.type).startsWith('ZAP_')) return;
  loadZapData()
    .then(data => sendResponse(
      CatworldZapMobs.handleMessage(data.mobs ?? [], message, data.routes ?? [], data.routeAliases ?? {})
        ?? CatworldZapItems.handleMessage(data.items ?? [], message)
        ?? CatworldZapRiddles.handleMessage(data, message)
        ?? { ok: false, error: '未知的查詢' }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

// content script 不能直接彈系統通知、也不能開分頁，由這裡代為處理
importScripts('zap-mobs.js', 'zap-items.js', 'zap-riddles.js');
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

chrome.runtime.onMessage.addListener((message, sender) => {
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
      CatworldZapMobs.handleMessage(data.mobs ?? [], message, data.routes ?? [])
        ?? CatworldZapItems.handleMessage(data.items ?? [], message)
        ?? CatworldZapRiddles.handleMessage(data, message)
        ?? { ok: false, error: '未知的查詢' }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

// content script 不能直接彈系統通知、也不能開分頁，由這裡代為處理
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
    requireInteraction: true
  });
});

chrome.notifications.onClicked.addListener(id => {
  const [, tabId, windowId] = id.split('-').map(Number);
  chrome.tabs.update(tabId, { active: true });
  chrome.windows.update(windowId, { focused: true });
  chrome.notifications.clear(id);
});

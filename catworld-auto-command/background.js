// content script 不能直接彈系統通知，由這裡代為建立；點通知會切回該遊戲分頁
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== 'ALERT' || !sender.tab) return;
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

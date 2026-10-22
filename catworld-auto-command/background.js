// content script 不能直接彈系統通知、也不能開分頁，由這裡代為處理
importScripts('zap-mobs.js', 'zap-items.js', 'zap-riddles.js', 'shared-data.js', 'line-notify.js', 'game-urls.js');
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

const saveLineResult = result => chrome.storage.session.set({ [LINE_RESULT_KEY]: result }).catch(() => {});

// 設定頁的「發送測試訊息」：不看總開關，結果標成「測試」
async function sendLine(text) {
  const saved = (await chrome.storage.local.get(LINE_KEY))[LINE_KEY] ?? {};
  const result = {
    ...await CatworldLineNotify.send({ fetchImpl: fetch, token: saved.token, userId: saved.userId, text, now: Date.now }),
    source: 'test',
  };
  await saveLineResult(result);
  return result;
}

// 警報推播：總開關沒開、憑證沒填就什麼都不做（不碰網路）；結果標成「警報」。
// 去重與每小時上限的紀錄放 storage.session（service worker 被暫停再喚醒仍有效，關掉瀏覽器歸零）。
// 讀紀錄、判斷、寫回要一則一則排隊做，否則兩則警報同時到時會各自讀到舊紀錄、都以為自己是第一則。
// 呼叫端要自己 .catch，失敗不能影響系統通知
const LINE_THROTTLE_KEY = 'lineThrottle';
let lineQueue = Promise.resolve();

function notifyLine(reason) {
  const run = async () => {
    const saved = (await chrome.storage.local.get(LINE_KEY))[LINE_KEY];
    const state = (await chrome.storage.session.get(LINE_THROTTLE_KEY))[LINE_THROTTLE_KEY];
    // 紀錄由模組透過 persist 存：請求送出前先存（worker 在請求途中被回收也記得）、失敗再還原、略過時存計數
    const { result } = await CatworldLineNotify.notifyAlert({
      fetchImpl: fetch, settings: saved, reason, now: Date.now, state,
      persist: next => chrome.storage.session.set({ [LINE_THROTTLE_KEY]: next }),
    });
    if (result) await saveLineResult(result);
  };
  const task = lineQueue.then(run, run);
  lineQueue = task.catch(() => {});
  return task;
}

// ---- 額外的遊戲網址（臨時加進來的網站，例如 ngrok）----
// 清單在 chrome.storage.local.extraGameUrls（設定頁管理）。manifest 的 content script 只認遊戲網站，所以其他網站要用動態註冊：
// 註冊的是和 manifest 同一份 js 與 css，只註冊使用者已經授權（optional host permission）的網站。
// 動態註冊的 content script 在擴充功能更新時會被清掉，所以載入、安裝／更新、清單改變、授權改變時都重新同步；
// 同步一個接一個排隊做，連續觸發時不會交錯，最後的結果一定對應最後的清單。已經開著的分頁要重新整理才會有面板。
const EXTRA_SITES_ID = 'extra-game-sites';
async function syncExtraGameSites() {
  const { extraGameUrls } = await chrome.storage.local.get('extraGameUrls');
  const allowed = [];
  for (const pattern of CatworldGameUrls.extraPatterns(extraGameUrls)) {
    if (await chrome.permissions.contains({ origins: [pattern] })) allowed.push(pattern);
  }
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [EXTRA_SITES_ID] });
  } catch {
    // 本來就沒有註冊
  }
  if (!allowed.length) return;
  const declared = chrome.runtime.getManifest().content_scripts[0];
  await chrome.scripting.registerContentScripts([{ id: EXTRA_SITES_ID, matches: allowed, js: declared.js, css: declared.css, runAt: declared.run_at, persistAcrossSessions: true }]);
}
let extraSitesQueue = Promise.resolve();
const queueExtraSitesSync = () => {
  extraSitesQueue = extraSitesQueue.then(syncExtraGameSites).catch(error => console.error('[catworld] 額外的遊戲網址同步失敗', error));
};
queueExtraSitesSync();
chrome.runtime.onInstalled.addListener(queueExtraSitesSync);
chrome.permissions.onAdded.addListener(queueExtraSitesSync);
chrome.permissions.onRemoved.addListener(queueExtraSitesSync);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extraGameUrls) queueExtraSitesSync();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 設定頁的測試訊息：設定頁是開成分頁的（sender.tab 有值），所以看訊息是不是來自擴充功能自己的頁面（content script 的 sender.url 是遊戲網址）；
  // 要在下面「沒有 sender.tab 就略過」的檢查之前處理
  if (message?.type === 'LINE_TEST' && sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''))) {
    // 讀儲存失敗也要回應：沒回應的話設定頁會一直等
    sendLine('【CatWorld】這是一則測試訊息').catch(error => ({ at: Date.now(), ok: false, status: 0, reason: String(error?.name ?? 'Error') })).then(sendResponse);
    return true;
  }
  if (!sender.tab) return;
  if (message.type === 'TOGGLE_SETTINGS') {
    toggleSettings(sender.tab);
    return;
  }
  if (message.type !== 'ALERT') return;
  // 手機通知（LINE）：所有警報都走這個出口。notifyLine 是非同步、不會同步丟錯，先啟動它，
  // 系統通知若同步丟錯（圖示、權限問題）手機通知也不會跟著丟；LINE 失敗也不能影響系統通知
  notifyLine(message.reason).catch(() => {});
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

// 共用資料：設定頁貼的 Google 試算表連結（sharedSources：{ mob, riddle }）抓下來的共用層放在 sharedCache（存本機），兩個分頁各自快取。
// 一小時內不重抓；抓失敗就保留舊的並記下原因，幾分鐘內不再試（不然離線時每次查詢都要等逾時）；連結改了就丟掉舊快取。
// 怪物查詢的回覆在這裡套上共用路線，面板（content script）完全不碰共用層，只顯示回覆裡的 shared 標記；解謎的共用步驟由 ZAP_RIDDLE_SHARED 另外給
const SHARED_SOURCES_KEY = 'sharedSources';
const SHARED_CACHE_KEY = 'sharedCache';
const SHARED_FRESH_MS = 60 * 60 * 1000;
const SHARED_RETRY_MS = 5 * 60 * 1000;
const SHARED_TIMEOUT_MS = 15000;
// layers 是快取裡存共用層的欄位名稱（第一個是主要的）：怪物路線分頁有路線（routes）、共用表新增的怪（mobs）與修正內建怪強度（fixes）
const SHARED_SHEETS = {
  mob: { layers: ['routes', 'mobs', 'fixes'], build: (csv, data) => CatworldSharedData.buildMobRoutes(csv, data.mobs ?? []) },
  riddle: { layers: ['steps'], build: (csv, data) => CatworldSharedData.buildRiddleSteps(csv, data.riddles ?? [], data.pages ?? {}) },
};
let sharedInflight = null;

async function fetchSharedCsv(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHARED_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// 抓一個分頁，回新的快取項目（成功或失敗都回；失敗保留同一個連結的舊資料並記下原因）
async function fetchSheet(kind, url, entry, now) {
  const { layers, build } = SHARED_SHEETS[kind];
  const fail = reason => ({ url, at: null, ...Object.fromEntries(layers.map(layer => [layer, {}])), report: null, ...entry, error: { at: now, reason } });
  const checked = CatworldSharedData.checkUrl(url);
  if (!checked.ok) return fail(checked.error);
  try {
    const built = build(await fetchSharedCsv(url), await loadZapData());
    return built.ok ? { url, at: now, ...Object.fromEntries(layers.map(layer => [layer, built[layer]])), report: built.report } : fail(built.error);
  } catch (error) {
    return fail(error.name === 'AbortError' ? `逾時（${SHARED_TIMEOUT_MS / 1000} 秒）` : error.message);
  }
}

async function refreshShared(force) {
  const stored = await chrome.storage.local.get([SHARED_SOURCES_KEY, SHARED_CACHE_KEY, 'zapFeatures']);
  const cache = { ...stored[SHARED_CACHE_KEY] };
  const features = stored.zapFeatures ?? {};
  if (features.mobs !== true && features.riddles !== true) return cache;
  const now = Date.now();
  let changed = false;
  for (const kind of Object.keys(SHARED_SHEETS)) {
    const url = String(stored[SHARED_SOURCES_KEY]?.[kind] ?? '').trim();
    if (!url) {
      if (cache[kind]) {
        delete cache[kind];
        changed = true;
      }
      continue;
    }
    const entry = cache[kind]?.url === url ? cache[kind] : null;
    const fresh = entry?.at && now - entry.at < SHARED_FRESH_MS;
    const backingOff = entry?.error && now - entry.error.at < SHARED_RETRY_MS;
    if (!force && (fresh || backingOff)) continue;
    cache[kind] = await fetchSheet(kind, url, entry, now);
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [SHARED_CACHE_KEY]: cache });
  return cache;
}

// 同時有多個請求時共用同一次抓取；但「立即更新」（force）不能被一個可能直接用快取返回的進行中請求吞掉，要等它結束後再抓一次
function refreshSharedOnce(force) {
  const run = () => {
    const task = refreshShared(force).finally(() => { if (sharedInflight === task) sharedInflight = null; });
    sharedInflight = task;
    return task;
  };
  if (!sharedInflight) return run();
  return force ? sharedInflight.catch(() => {}).then(run) : sharedInflight;
}

// 儲存或網路出任何問題都不能弄壞內建資料的查詢：回空的共用層
const sharedLayer = kind => refreshSharedOnce(false).then(cache => cache[kind]?.[SHARED_SHEETS[kind].layers[0]] ?? {}, () => ({}));
// 怪物查詢要的共用資料：路線、共用表新增的怪與修正強度（舊快取沒有 mobs、fixes 欄位時當作沒有）
const NO_SHARED_MOBS = Object.freeze({ routes: {}, mobs: {}, fixes: {} });
const sharedMobData = () => refreshSharedOnce(false).then(cache => ({ routes: cache.mob?.routes ?? {}, mobs: cache.mob?.mobs ?? {}, fixes: cache.mob?.fixes ?? {} }), () => NO_SHARED_MOBS);

// 安裝或更新時，共用表連結「從來沒有設定過」（儲存裡沒有這個欄位）才帶入預設的；清空過（存了空字串）或自己填過的一律不動
chrome.runtime.onInstalled?.addListener(async () => {
  const { sharedSources } = await chrome.storage.local.get(SHARED_SOURCES_KEY);
  if (sharedSources === undefined) await chrome.storage.local.set({ [SHARED_SOURCES_KEY]: { ...CatworldSharedData.DEFAULT_SOURCES } });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 設定頁的「立即更新」：只接受擴充功能自己的頁面（和 LINE_TEST 一樣看 sender.id 與 sender.url）
  if (message?.type === 'SHARED_REFRESH' && sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''))) {
    refreshSharedOnce(true).then(cache => sendResponse({ ok: true, cache }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (!String(message?.type).startsWith('ZAP_')) return;
  if (message.type === 'ZAP_RIDDLE_SHARED') {
    sharedLayer('riddle').then(steps => sendResponse({ ok: true, steps }));
    return true;
  }
  const withShared = message.type === 'ZAP_LOOKUP' || message.type === 'ZAP_SUITABLE';
  Promise.all([loadZapData(), withShared ? sharedMobData() : NO_SHARED_MOBS])
    .then(([data, shared]) => sendResponse(
      // 先把共用表新增的怪併進怪物表再算（清單、分級、出現提示都用併好的），最後疊上共用路線
      CatworldSharedData.overlayReply(CatworldZapMobs.handleMessage(CatworldSharedData.applySharedMobs(data.mobs ?? [], shared.mobs, shared.fixes), message, data.routes ?? [], data.routeAliases ?? {}), shared.routes)
        ?? CatworldZapItems.handleMessage(data.items ?? [], message)
        ?? CatworldZapRiddles.handleMessage(data, message)
        ?? { ok: false, error: '未知的查詢' }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

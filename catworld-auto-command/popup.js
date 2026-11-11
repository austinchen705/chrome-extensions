const $ = id => document.getElementById(id);
$('version').textContent = `v${chrome.runtime.getManifest().version}`;
const Engine = CatworldTriggerEngine;

// 面板的 ⚙ 會把這一頁當成分頁開啟，網址帶 ?tab=遊戲分頁的 id：這時要控制那個遊戲分頁，
// 不是「目前的分頁」（那是設定頁自己）。遊戲分頁被關掉了就找別的遊戲分頁
// 額外的遊戲網址（設定頁的「額外的遊戲網址」）：沒填就只有內建的遊戲
const readExtraSites = async () => CatworldGameUrls.extraPatterns((await chrome.storage.local.get('extraGameUrls')).extraGameUrls);
const pageTabId = Number(new URLSearchParams(location.search).get('tab')) || null;
if (pageTabId) document.body.classList.add('page');

async function getTab() {
  if (pageTabId) {
    try { return await chrome.tabs.get(pageTabId); } catch { /* 遊戲分頁已關閉，往下找別的 */ }
    const [game] = await chrome.tabs.query({ url: CatworldGameUrls.tabPatterns(await readExtraSites()) });
    return game;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// 固定指令與隨機指令都是每個指令一列（指令、最短、最長秒數）：固定的列在 #fixedItems、隨機的在 #randomItems
function itemRow(item, placeholder) {
  const command = element('input', { type: 'text', value: item.command, placeholder, title: '指令' });
  const min = element('input', { type: 'number', min: 1, value: item.minSeconds, title: '最短秒數' });
  const max = element('input', { type: 'number', min: 1, value: item.maxSeconds, title: '最長秒數' });
  const remove = element('button', { type: 'button', className: 'x', textContent: '✕', title: '刪除這個指令' });
  const row = element('div', { className: 'ritem' }, field('command', command), field('min', min), field('max', max), remove);
  remove.addEventListener('click', () => {
    const list = row.parentElement;
    row.remove();
    updateItemSummary(list.id);
    saveTimerSettings();
  });
  return row;
}

const ITEM_LISTS = { fixedItems: { add: 'addFixed', placeholder: '例：ps;px' }, randomItems: { add: 'addRandom', placeholder: '例：look' } };

function renderItems(id, items) {
  $(id).replaceChildren(...items.map(item => itemRow(item, ITEM_LISTS[id].placeholder)));
  updateItemSummary(id);
}

// 摺疊起來也看得出設了什麼：標題寫項數與各指令
const ITEM_TITLES = { fixedItems: ['summaryFixed', '固定指令'], randomItems: ['summaryRandom', '隨機指令'] };
function updateItemSummary(id) {
  const [summaryId, title] = ITEM_TITLES[id];
  const commands = readItems(id).map(item => item.command);
  $(summaryId).textContent = commands.length ? `${title}（${commands.length} 項）：${commands.join('、')}` : `${title}（無）`;
}

function readItems(id) {
  const get = (row, name) => row.querySelector(`[data-f="${name}"]`);
  return [...$(id).children]
    .map(row => ({ command: get(row, 'command').value.trim(), minSeconds: Number(get(row, 'min').value), maxSeconds: Number(get(row, 'max').value) }))
    .filter(item => item.command);
}

Object.entries(ITEM_LISTS).forEach(([id, { add, placeholder }]) => {
  $(add).addEventListener('click', () => {
    $(id).append(itemRow({ command: '', minSeconds: CatworldTimer.DEFAULT_MIN, maxSeconds: CatworldTimer.DEFAULT_MAX }, placeholder));
  });
  $(id).addEventListener('input', () => updateItemSummary(id));
});

function readSettings() {
  return {
    fixedItems: readItems('fixedItems'),
    randomItems: readItems('randomItems'),
    commandDelayMs: Number($('commandDelayMs').value)
  };
}

// 定時、隨機的指令與指令間隔：改了就存，不用按開始（按開始時才檢查秒數是否合理；遊戲頁讀到時會再整理）
const saveTimerSettings = () => chrome.storage.local.set({ settings: readSettings() });
['timer', 'random'].forEach(name => document.querySelector(`[data-pane="${name}"]`).addEventListener('change', saveTimerSettings));

// 驗證、錯誤、警告的訊息一律用同一組顏色：error 紅、warn 琥珀、info 不上色（樣式是 popup.html 的 .msg-error／.msg-warn）
function markLevel(node, level) {
  node.classList.toggle('msg-error', level === 'error');
  node.classList.toggle('msg-warn', level === 'warn');
}
// 一行一行的 { level, text } 放進容器，每行各自上色
function showParts(container, parts) {
  container.replaceChildren(...parts.map(({ level, text }) => element('div', { className: `msg-${level}`, textContent: text })));
}
// 停止原因：空的或單純「已停止」不上色；驗證碼造成的停止是錯誤；其他原因（觸發被停用等）是警告
const stopLevel = reason => (!reason || reason === '已停止' ? 'info' : /驗證/.test(reason) ? 'error' : 'warn');
function setStatus(text, level = 'info') {
  $('status').textContent = `狀態：${text}`;
  markLevel($('status'), level);
}

async function send(message) {
  const tab = await getTab();
  if (!tab?.id || !CatworldGameUrls.isGameUrl(tab.url, await readExtraSites())) {
    throw new Error('請先切到 CatWorld Web 分頁');
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    // If CatWorld was already open when the extension was installed/reloaded,
    // the declared content script is not present yet. Inject it and retry.
    if (String(e?.message || e).includes('Receiving end does not exist')) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['trigger-engine.js', 'timer-settings.js', 'macro-wait.js', 'macro-notes.js', 'macro-io.js', 'macro-resize.js', 'captcha-art.js', 'captcha-grid.js', 'instance-guard.js', 'stop-keywords.js', 'chat-reply.js', 'chat-script.js', 'zap-mobs.js', 'map-data.js', 'map-collect.js', 'map-route.js', 'hunt-parse.js', 'map-hunt.js', 'map-hunt-ui.js', 'zap-items.js', 'zap-riddles.js', 'zap-equipment.js', 'shop-data.js', 'shop-collect.js', 'zap-panel.js', 'zap-riddle-ui.js', 'mentor-data.js', 'mentor-search.js', 'mentor-ui.js', 'zap-equipment-ui.js', 'pip-panel.js', 'stats-view.js', 'stats-block.js', 'whisper-block.js', 'skill-moves.js', 'force-cap.js', 'content.js']
      });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['macro-notes.css'] });
      return await chrome.tabs.sendMessage(tab.id, message);
    }
    throw e;
  }
}

$('start').addEventListener('click', async () => {
  try {
    const settings = readSettings();
    if (!settings.fixedItems.length) throw new Error('至少要有一個固定指令');
    const badFixed = settings.fixedItems.find(item => item.maxSeconds < item.minSeconds);
    if (badFixed) throw new Error(`固定指令「${badFixed.command}」的最長秒數不能小於最短秒數`);
    await chrome.storage.local.set({ settings });
    await send({ type: 'START', settings });
    setStatus(`執行中：固定：${settings.fixedItems.map(item => item.command).join(' / ')}`);
  } catch (e) { setStatus(e.message, 'error'); }
});

// 隨機送出：獨立的一頁，各自開始、停止
const setRandomStatus = (text, level = 'info') => {
  $('randomStatus').textContent = `狀態：${text}`;
  markLevel($('randomStatus'), level);
};
$('randomStart').addEventListener('click', async () => {
  try {
    const settings = readSettings();
    if (!settings.randomItems.length) throw new Error('至少要有一個隨機指令');
    const badRandom = settings.randomItems.find(item => item.maxSeconds < item.minSeconds);
    if (badRandom) throw new Error(`隨機指令「${badRandom.command}」的最長秒數不能小於最短秒數`);
    await chrome.storage.local.set({ settings });
    await send({ type: 'START_RANDOM', settings });
    setRandomStatus(`執行中：${settings.randomItems.map(item => item.command).join(' / ')}`);
  } catch (e) { setRandomStatus(e.message, 'error'); }
});
$('randomStop').addEventListener('click', async () => {
  try { await send({ type: 'STOP_RANDOM' }); setRandomStatus('已停止'); }
  catch (e) { setRandomStatus(e.message, 'error'); }
});

// Idle（全域暫停）：四個欄位存在 chrome.storage.local.idleSettings，按「開始」才套用
const IDLE_FIELDS = { everyMin: 'idleEveryMin', everyMax: 'idleEveryMax', durMin: 'idleDurMin', durMax: 'idleDurMax' };
const readIdleFields = () => CatworldTimer.normalizeIdle(Object.fromEntries(Object.entries(IDLE_FIELDS).map(([key, id]) => [key, $(id).value])));
const showIdleFields = idle => Object.entries(IDLE_FIELDS).forEach(([key, id]) => { $(id).value = idle[key]; });
const setIdleStatus = (text, level = 'info') => {
  $('idleStatus').textContent = `狀態：${text}`;
  markLevel($('idleStatus'), level);
};
Object.values(IDLE_FIELDS).forEach(id => $(id).addEventListener('change', () => {
  const idle = readIdleFields();
  showIdleFields(idle);
  chrome.storage.local.set({ idleSettings: idle });
}));
$('idleStart').addEventListener('click', async () => {
  try {
    const idle = readIdleFields();
    showIdleFields(idle);
    await chrome.storage.local.set({ idleSettings: idle });
    await send({ type: 'START_IDLE', settings: idle });
    setIdleStatus('Idle 中');
  } catch (e) { setIdleStatus(e.message, 'error'); }
});
$('idleStop').addEventListener('click', async () => {
  try { await send({ type: 'STOP_IDLE' }); setIdleStatus('已停止'); }
  catch (e) { setIdleStatus(e.message, 'error'); }
});

$('stop').addEventListener('click', async () => {
  try { await send({ type: 'STOP' }); setStatus('已停止'); }
  catch (e) { setStatus(e.message, 'error'); }
});

$('test').addEventListener('click', async () => {
  try {
    const result = await send({ type: 'TEST', command: 'ps' });
    setStatus(result?.ok ? '測試 ps 已送出' : (result?.error || '測試失敗'), result?.ok ? 'info' : 'error');
  } catch (e) { setStatus(e.message, 'error'); }
});

// 「一直響到確認」開關：存起來，遊戲頁的 content script 監聽 storage 變化，馬上生效
$('persistentAlert').addEventListener('change', () => {
  chrome.storage.local.set({ persistentAlert: $('persistentAlert').checked });
});
// 新版本提示：背景每天檢查一次（update-check.js），結果存在 storage；這裡只顯示，「立即檢查」才請背景現在去查
const updateTime = at => new Date(at).toLocaleString('zh-TW', { hour12: false });
async function showUpdate() {
  const U = CatworldUpdateCheck;
  const state = (await chrome.storage.local.get(U.KEY))[U.KEY];
  const view = U.describe(state, chrome.runtime.getManifest().version, updateTime);
  $('updateText').textContent = view ? view.text : '尚未檢查新版本（每天自動檢查一次）';
  markLevel($('updateText'), view?.level);
  $('updateCmd').hidden = !view?.newer;
  $('updateCommand').textContent = /Win/i.test(navigator.userAgent) ? U.COMMANDS.win : U.COMMANDS.unix;
}
$('updateNow').addEventListener('click', async () => {
  $('updateNow').disabled = true;
  $('updateText').textContent = '檢查中…';
  markLevel($('updateText'), 'info');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'UPDATE_CHECK' });
    if (!result?.ok) throw new Error(result?.error || '背景沒有回應');
  } catch (e) {
    $('updateText').textContent = `檢查新版本失敗：${e.message}`;
    markLevel($('updateText'), 'error');
    $('updateNow').disabled = false;
    return;
  }
  $('updateNow').disabled = false;
  showUpdate();
});
// 更新說明：CHANGELOG.md 不在擴充功能資料夾裡（安裝只複製 extension 資料夾），所以從 GitHub 讀；每次打開才抓，比目前新的版本標琥珀色
$('updateNotes').addEventListener('click', async () => {
  const box = $('updateNotesBox');
  if (!box.hidden) { box.hidden = true; return; }
  const U = CatworldUpdateCheck;
  box.hidden = false;
  box.replaceChildren(Object.assign(document.createElement('div'), { textContent: '讀取中…' }));
  $('updateNotes').disabled = true;
  try {
    const response = await fetch(U.CHANGELOG_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const notes = U.parseNotes(await response.text(), chrome.runtime.getManifest().version);
    if (!notes.length) throw new Error('讀不到任何版本說明');
    box.replaceChildren(...notes.flatMap(note => {
      const head = document.createElement('h4');
      head.textContent = note.newer ? `${note.title}　（新）` : note.title;
      head.classList.toggle('newer', note.newer);
      const body = document.createElement('div');
      body.className = 'notebody';
      body.textContent = note.body;
      return [head, body];
    }));
  } catch (e) {
    const error = document.createElement('div');
    error.textContent = `讀取更新說明失敗：${e.message}`;
    markLevel(error, 'error');
    box.replaceChildren(error);
  } finally {
    $('updateNotes').disabled = false;
  }
});
$('updateCopy').addEventListener('click', async () => {
  const button = $('updateCopy');
  try {
    await navigator.clipboard.writeText($('updateCommand').textContent);
    button.textContent = '已複製';
  } catch {
    button.textContent = '複製失敗，請手動選取上面的指令';
  }
  setTimeout(() => { button.textContent = '複製更新指令'; }, 3000);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[CatworldUpdateCheck.KEY]) showUpdate();
});
showUpdate();

// 摺疊區塊（details）的展開狀態：toggle 事件不冒泡，用捕獲階段聽；每次存目前全部的狀態
document.addEventListener('toggle', event => {
  if (event.target.tagName !== 'DETAILS' || !event.target.id) return;
  const folds = Object.fromEntries([...document.querySelectorAll('details[id]')].map(box => [box.id, box.open]));
  chrome.storage.local.set({ popupFolds: folds });
}, true);
// 停止關鍵字：開關與清單存成一個物件，遊戲頁監聽 storage 變化，馬上生效
const saveStopKeywords = () => chrome.storage.local.set({ [CatworldStopKeywords.KEY]: { enabled: $('stopKeywordsOn').checked, words: $('stopKeywordsList').value } });
$('stopKeywordsOn').addEventListener('change', saveStopKeywords);
$('stopKeywordsList').addEventListener('change', saveStopKeywords);
// 聊天回覆：六個欄位存成一個物件（不合法的值退回預設並寫回欄位），遊戲頁監聽 storage 變化，馬上生效
const saveChatReply = () => {
  const settings = CatworldChatReply.normalizeSettings({
    enabled: $('chatReplyOn').checked,
    threshold: $('chatThreshold').value === '' ? undefined : Number($('chatThreshold').value),
    cooldownSec: $('chatCooldown').value === '' ? undefined : Number($('chatCooldown').value),
    perHour: $('chatPerHour').value === '' ? undefined : Number($('chatPerHour').value),
    delayMin: $('chatDelayMin').value === '' ? undefined : Number($('chatDelayMin').value),
    delayMax: $('chatDelayMax').value === '' ? undefined : Number($('chatDelayMax').value),
  });
  showChatReply(settings);
  chrome.storage.local.set({ [CatworldChatReply.SETTINGS_KEY]: settings });
};
function showChatReply(settings) {
  $('chatReplyOn').checked = settings.enabled;
  $('chatThreshold').value = settings.threshold;
  $('chatCooldown').value = settings.cooldownSec;
  $('chatPerHour').value = settings.perHour;
  $('chatDelayMin').value = settings.delayMin;
  $('chatDelayMax').value = settings.delayMax;
}
['chatReplyOn', 'chatThreshold', 'chatCooldown', 'chatPerHour', 'chatDelayMin', 'chatDelayMax'].forEach(id => $(id).addEventListener('change', saveChatReply));
// 劇本對話：欄位讀存 chrome.storage.local.chatScript；「現在開一場」只有遊戲頁的角色是 A 才開得成
// 狀態行：今天幾場（儲存裡的 chatScriptState，遊戲頁寫）加目前這場（STATUS 的 chatScript；undefined＝遊戲頁沒回應）
let scriptSettings = CatworldChatScript.normalizeSettings(undefined);
let scriptDay = CatworldChatScript.normalizeState(undefined);
let scriptSession = undefined;
function renderScriptStatus() {
  $('scriptStatus').textContent = CatworldChatScript.describeStatus({ session: scriptSession, state: scriptDay, perDay: scriptSettings.perDay, today: CatworldChatScript.dayKey(Date.now()) });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[CatworldChatScript.STATE_KEY]) return;
  scriptDay = CatworldChatScript.normalizeState(changes[CatworldChatScript.STATE_KEY].newValue);
  renderScriptStatus();
});
const saveChatScript = () => {
  const settings = CatworldChatScript.normalizeSettings({
    enabled: $('scriptOn').checked,
    role: $('scriptRole').value,
    partner: $('scriptPartner').value,
    partnerName: $('scriptPartnerName').value,
    perDay: $('scriptPerDay').value,
    typoRate: $('scriptTypoRate').value,
  });
  showChatScript(settings);
  chrome.storage.local.set({ [CatworldChatScript.SETTINGS_KEY]: settings });
};
function showChatScript(settings) {
  $('scriptOn').checked = settings.enabled;
  $('scriptRole').value = settings.role;
  $('scriptPartner').value = settings.partner;
  $('scriptPartnerName').value = settings.partnerName;
  $('scriptPerDay').value = settings.perDay;
  $('scriptTypoRate').value = settings.typoRate;
  scriptSettings = settings;
  renderScriptStatus();
  $('scriptStart').disabled = settings.role !== 'A';
}
['scriptOn', 'scriptRole', 'scriptPartner', 'scriptPartnerName', 'scriptPerDay', 'scriptTypoRate'].forEach(id => $(id).addEventListener('change', saveChatScript));
function scriptMessage(text, level) { $('scriptMsg').textContent = text; markLevel($('scriptMsg'), level); }
$('scriptStart').addEventListener('click', async () => {
  try {
    const reply = await send({ type: 'START_CHAT_SCRIPT' });
    if (reply?.ok) scriptMessage(`開場了（劇本 ${reply.scriptId}）`);
    else scriptMessage(`沒有開場：${reply?.error ?? '遊戲頁沒有回應'}`, 'error');
  } catch (e) { scriptMessage(`沒有開場：${e.message}`, 'error'); }
});

// 聊天回覆的資料集：遊戲頁寫進 storage，這裡顯示筆數與清單、刪單筆、清除、匯出與匯入
const CHAT_PAIRS_KEY = CatworldChatReply.KEY;
const readChatPairs = async () => {
  const stored = (await chrome.storage.local.get(CHAT_PAIRS_KEY))[CHAT_PAIRS_KEY];
  return Array.isArray(stored) ? stored : [];
};
function chatMessage(text, level) { $('chatPairsMsg').textContent = text; markLevel($('chatPairsMsg'), level); }
async function showChatPairs() {
  const pairs = await readChatPairs();
  $('chatPairsInfo').textContent = pairs.length ? `資料集 ${pairs.length} 筆（最多 ${CatworldChatReply.MAX_PAIRS}，滿了丟最舊的）` : '還沒有資料（自己和人私聊就會自動記）';
  const list = $('chatPairsList');
  list.hidden = !pairs.length;
  list.replaceChildren(...pairs.slice().reverse().map(pair => {
    const row = document.createElement('div');
    row.className = 'chat-pair';
    const text = document.createElement('span');
    text.className = 'chat-pair-text';
    text.textContent = `${pair.said} → ${pair.reply}`;
    const remove = document.createElement('button');
    remove.textContent = '刪除';
    remove.addEventListener('click', async () => {
      const current = await readChatPairs();
      await chrome.storage.local.set({ [CHAT_PAIRS_KEY]: current.filter(item => !(item.said === pair.said && item.reply === pair.reply)) });
      showChatPairs();
    });
    row.append(text, remove);
    return row;
  }));
}
$('chatPairsCopy').addEventListener('click', async () => {
  const pairs = await readChatPairs();
  if (!pairs.length) { chatMessage('還沒有資料', 'warn'); return; }
  try { await navigator.clipboard.writeText(CatworldChatReply.exportText(pairs)); chatMessage(`已複製 ${pairs.length} 筆`); }
  catch (e) { chatMessage(`複製失敗：${e.message}`, 'error'); }
});
$('chatPairsClear').addEventListener('click', async () => {
  if (!confirm('清除全部聊天資料集？清掉就回不來了。')) return;
  await chrome.storage.local.remove(CHAT_PAIRS_KEY);
  chatMessage('已清除');
  showChatPairs();
});
$('chatPairsImportToggle').addEventListener('click', () => { $('chatPairsImportBox').hidden = !$('chatPairsImportBox').hidden; });
$('chatPairsImportApply').addEventListener('click', async () => {
  const checked = CatworldChatReply.parseImport($('chatPairsImportText').value);
  if (!checked.ok) { chatMessage(`沒有匯入：${checked.error}`, 'error'); return; }
  const merged = CatworldChatReply.mergeImported(await readChatPairs(), checked.pairs, Date.now());
  await chrome.storage.local.set({ [CHAT_PAIRS_KEY]: merged.pairs });
  $('chatPairsImportText').value = '';
  $('chatPairsImportBox').hidden = true;
  const notes = [
    merged.duplicate ? `${merged.duplicate} 筆已經有了` : '',
    merged.dropped ? `超過上限，丟掉原本最舊的 ${merged.dropped} 筆` : '',
    merged.trimmed ? `匯入的比上限多，只留最新的 ${merged.added} 筆，最舊的 ${merged.trimmed} 筆沒收` : '',
  ].filter(Boolean);
  chatMessage(`已匯入 ${merged.added} 筆` + (notes.length ? `（${notes.join('、')}）` : ''), merged.dropped || merged.trimmed ? 'warn' : undefined);
  showChatPairs();
});
showChatPairs();
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[CHAT_PAIRS_KEY]) showChatPairs(); });
// 拜師導師路線：遊戲面板「拜師」列改過的路線（chrome.storage.local.mentorRoutes），這裡顯示筆數、複製、匯入、清除
const MENTOR_KEY = 'mentorRoutes';
const MENTOR_ROWS = CatworldMentorSearch.rowsFromData(globalThis.CatworldMentorData);
const MENTOR_KNOWN = new Set(MENTOR_ROWS.map(row => CatworldMentorSearch.routeKey(row.mentor, row.skill)));
const readMentorEdits = async () => CatworldMentorSearch.parseEdits((await chrome.storage.local.get(MENTOR_KEY))[MENTOR_KEY]);
// 匯入與清除是讀改寫，排成一條佇列依序做（連點兩下才不會互相蓋掉）；遊戲頁剛好同時存的編輯仍可能被蓋掉（已知限制，同聊天回覆）
let mentorQueue = Promise.resolve();
const mentorWrite = work => { mentorQueue = mentorQueue.then(work, work); return mentorQueue; };
function mentorMessage(text, level) { $('mentorMsg').textContent = text; markLevel($('mentorMsg'), level); }
async function showMentorEdits() {
  const count = Object.keys(await readMentorEdits()).length;
  $('mentorInfo').textContent = count ? `自己改過 ${count} 個功法的路線` : '還沒有自己改過的路線';
}
$('mentorCopy').addEventListener('click', async () => {
  const edits = await readMentorEdits();
  const keys = Object.keys(edits);
  if (!keys.length) { mentorMessage('還沒有自己改過的路線', 'warn'); return; }
  // 名稱只能從內建資料找回來；內建資料沒有的（儲存的鍵已壓掉空白與大小寫）不輸出，免得交出去的名稱是錯的
  const known = Object.fromEntries(Object.entries(edits).filter(([key]) => MENTOR_KNOWN.has(key)));
  const skipped = keys.length - Object.keys(known).length;
  if (!Object.keys(known).length) { mentorMessage(`這 ${skipped} 筆都不在內建資料裡，無法輸出名稱`, 'warn'); return; }
  try {
    await navigator.clipboard.writeText(CatworldMentorSearch.exportEdits(known, MENTOR_ROWS));
    mentorMessage(`已複製 ${keys.length - skipped} 筆` + (skipped ? `（另有 ${skipped} 筆不在內建資料裡，沒有輸出）` : ''), skipped ? 'warn' : undefined);
  } catch (e) { mentorMessage(`複製失敗：${e.message}`, 'error'); }
});
$('mentorClear').addEventListener('click', async () => {
  if (!Object.keys(await readMentorEdits()).length) { mentorMessage('還沒有自己改過的路線', 'warn'); return; }
  if (!confirm('清除全部自己改過的拜師路線？會回到內建的路線，清掉就回不來了。')) return;
  await mentorWrite(async () => {
    try { await chrome.storage.local.remove(MENTOR_KEY); mentorMessage('已清除'); }
    catch (e) { mentorMessage(`清除失敗：${e.message}`, 'error'); }
  });
  showMentorEdits();
});
$('mentorImportToggle').addEventListener('click', () => { $('mentorImportBox').hidden = !$('mentorImportBox').hidden; });
$('mentorImportApply').addEventListener('click', async () => {
  const checked = CatworldMentorSearch.parseImport($('mentorImportText').value, globalThis.CatworldMacro?.parseSteps);
  if (!checked.ok) { mentorMessage(`沒有匯入：${checked.error}`, 'error'); return; }
  const unknownCount = Object.keys(checked.edits).filter(key => !MENTOR_KNOWN.has(key)).length;
  await mentorWrite(async () => {
    try {
      await chrome.storage.local.set({ [MENTOR_KEY]: { ...(await readMentorEdits()), ...checked.edits } });
    } catch (e) { mentorMessage(`匯入失敗：${e.message}`, 'error'); return; }
    $('mentorImportText').value = '';
    $('mentorImportBox').hidden = true;
    mentorMessage(`已匯入 ${Object.keys(checked.edits).length} 筆` + (unknownCount ? `（其中 ${unknownCount} 筆不在內建資料裡，面板不會顯示）` : ''), unknownCount ? 'warn' : undefined);
  });
  showMentorEdits();
});
showMentorEdits();
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[MENTOR_KEY]) showMentorEdits(); });
$('autoReward').addEventListener('change', () => {
  chrome.storage.local.set({ autoReward: $('autoReward').checked });
});

// 手機通知（LINE）：憑證只存本機，發送由 background 做（見 line-notify-ui.js）
try {
  CatworldLineNotifyUI.attach(document);
} catch (error) {
  console.error('[catworld] 手機通知區塊初始化失敗', error.name);
}

// 驗證碼樣本收集：網址只存本機（captchaSampleUrl，安裝時由 background 帶入作者的收集表），送出由 background 做，最近一次結果由 background 寫在 storage.session
const CAPTCHA_SAMPLE_URL_PREFIX = 'https://script.google.com/macros/';
try {
  const field = $('captchaSampleUrl');
  const resultBox = $('captchaSampleResult');
  const say = (text, level = 'info') => { resultBox.textContent = text; markLevel(resultBox, level); };
  const pad = value => String(value).padStart(2, '0');
  const show = result => {
    if (!result) return;
    const at = new Date(result.at);
    const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
    say(result.ok ? `${clock}　HTTP ${result.status}　已送出（${result.outcome}）` : `${clock}　沒有送出：${result.reason}`, result.ok ? 'info' : 'error');
  };
  // 載入完成前欄位先停用：否則一打字就把空欄位存回去，蓋掉已存的網址；載入失敗維持停用
  let loaded = false;
  field.disabled = true;
  chrome.storage.local.get('captchaSampleUrl').then(data => {
    field.value = data.captchaSampleUrl ?? '';
    loaded = true;
    field.disabled = false;
  }).catch(() => say('讀取設定失敗，請重新整理設定頁再試', 'error'));
  chrome.storage.session.get('captchaSampleLastResult').then(data => show(data.captchaSampleLastResult)).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.captchaSampleLastResult) show(changes.captchaSampleLastResult.newValue);
  });
  // 只收 Apps Script 網頁應用程式的網址：別的主機 background 沒有權限打，會悄悄失敗
  field.addEventListener('input', () => {
    if (!loaded) return;
    const url = field.value.trim();
    if (url && !url.startsWith(CAPTCHA_SAMPLE_URL_PREFIX)) {
      say(`沒有儲存：網址要以 ${CAPTCHA_SAMPLE_URL_PREFIX} 開頭（Apps Script 部署成網頁應用程式的網址）`, 'error');
      return;
    }
    chrome.storage.local.set({ captchaSampleUrl: url });
    say(url ? '已儲存，下次驗證碼結束就會送' : '已清空，不收集');
  });
} catch (error) {
  console.error('[catworld] 驗證碼樣本收集區塊初始化失敗', error.name);
}

// 輔助功能的開關（預設關閉）：存成一個物件，遊戲頁的面板監聽 storage 變化，馬上生效
const FEATURE_BOXES = { mobs: 'featureMobs', items: 'featureItems', riddles: 'featureRiddles', shop: 'featureShop', skills: 'featureSkills', hunt: 'featureHunt', masters: 'featureMasters', whisper: 'featureWhisper', forceCap: 'featureForceCap' };
// 缺值＝開的功能（其他都是缺值＝關）
const FEATURE_DEFAULT_ON = new Set(['whisper', 'forceCap']);
$('whisperColor').addEventListener('change', () => { chrome.storage.local.set({ whisperColor: $('whisperColor').value }); });
Object.values(FEATURE_BOXES).forEach(id => $(id).addEventListener('change', () => {
  chrome.storage.local.set({ zapFeatures: Object.fromEntries(Object.entries(FEATURE_BOXES).map(([key, box]) => [key, $(box).checked])) });
}));

// 共用資料（Google 試算表）：各分頁的連結只存本機（sharedSources：{ mob, riddle, chat }，不進匯出；劇本的欄位放在「劇本對話」區塊），抓取由 background 做，結果在 sharedCache。
// 結果文字與逐列清單的內容都由 shared-data.js 產生（有測試），這裡只負責放進畫面
const SHARED_FIELDS = {
  mob: { input: 'sharedMobUrl', result: 'sharedMobResult', detail: 'sharedMobDetail' },
  riddle: { input: 'sharedRiddleUrl', result: 'sharedRiddleResult', detail: 'sharedRiddleDetail' },
  chat: { input: 'sharedChatUrl', result: 'sharedChatResult', detail: 'sharedChatDetail' },
};
const timeText = at => new Date(at).toLocaleString('zh-TW', { hour12: false });
async function showShared() {
  const data = await chrome.storage.local.get(['sharedSources', 'sharedCache', 'zapFeatures', 'chatScript']);
  // 功能都關著時 background 不會抓，說明一下，不然看起來像壞掉
  const features = { mobs: data.zapFeatures?.mobs === true, riddles: data.zapFeatures?.riddles === true, chat: data.chatScript?.enabled === true };
  $('sharedOff').hidden = CatworldSharedData.sheetEnabled('mob', features);
  Object.entries(SHARED_FIELDS).forEach(([kind, field]) => {
    const url = data.sharedSources?.[kind] ?? '';
    if (document.activeElement !== $(field.input)) $(field.input).value = url;
    const entry = data.sharedCache?.[kind]?.url === url ? data.sharedCache[kind] : null;
    showParts($(field.result), CatworldSharedData.describeSheetParts(kind, url, entry, timeText, features));
    // 被丟掉與對不到的列逐列列出，填錯的人自己看得出要改表上哪一列
    const lines = url && CatworldSharedData.sheetEnabled(kind, features) ? CatworldSharedData.reportEntries(entry?.report) : [];
    $(field.detail).hidden = !lines.length;
    showParts($(field.detail), lines);
  });
}
// 更新中或失敗時：每個分頁的結果行換成同一段文字，舊的逐列清單先收起來（不然會和「更新中」並存）
const setAllShared = (text, level = 'info') => Object.entries(SHARED_FIELDS).forEach(([kind, field]) => {
  showParts($(field.result), [{ level, text: `${CatworldSharedData.SHEET_LABELS[kind].title}：${text}` }]);
  $(field.detail).hidden = true;
});
async function refreshShared() {
  setAllShared('更新中…');
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'SHARED_REFRESH' });
    if (!reply?.ok) setAllShared(`更新失敗：${reply?.error || '沒有回應'}`, 'error');
    else await showShared();
  } catch (error) {
    setAllShared(`更新失敗：${error.message}`, 'error');
  }
}
Object.entries(SHARED_FIELDS).forEach(([kind, field]) => {
  $(field.input).addEventListener('change', async () => {
    const text = $(field.input).value.trim();
    if (text) {
      const checked = CatworldSharedData.checkUrl(text);
      if (!checked.ok) {
        // 只收起這個分頁的舊清單，原本存的連結與結果不動
        const saved = (await chrome.storage.local.get('sharedSources')).sharedSources ?? {};
        showParts($(field.result), [{ level: 'error', text: CatworldSharedData.describeRejectedUrl(kind, checked.error, Boolean(saved[kind])) }]);
        $(field.detail).hidden = true;
        return;
      }
    }
    const saved = (await chrome.storage.local.get('sharedSources')).sharedSources ?? {};
    await chrome.storage.local.set({ sharedSources: { ...saved, [kind]: text } });
    if (text) refreshShared();
    else showShared();
  });
});
$('sharedRefresh').addEventListener('click', refreshShared);
$('sharedChatRefresh').addEventListener('click', refreshShared);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.sharedSources || changes.sharedCache || changes.zapFeatures || changes.chatScript)) showShared();
});
showShared();

// ---- 額外的遊戲網址（臨時加進來的網站，例如 ngrok）----
// 清單在 chrome.storage.local.extraGameUrls（match pattern 的陣列）。新增要先問 Chrome 授權那個網站（按了「允許」才存），
// 移除時連授權一起還給 Chrome；實際註冊或移除 content script 是 background 的事（依清單與授權同步）。
// 授權詢問要在使用者按下去的當下問，所以先在記憶體裡的清單擋掉重複與超過上限，再問授權。
// 畫面上目前的清單。新增時授權詢問前只能做同步的檢查（詢問要在按下去的手勢裡），所以用它先擋重複與超過上限
let extraSites = [];
const showExtraMessage = (level, text) => showParts($('extraMessage'), [{ level, text }]);
const siteName = pattern => pattern.replace(/\/\*$/, '');

async function extraRow(pattern) {
  const allowed = await chrome.permissions.contains({ origins: [pattern] });
  const parts = [element('span', { className: 'extra-name', textContent: siteName(pattern) }), element('span', { className: allowed ? 'extra-state' : 'extra-state msg-warn', textContent: allowed ? '已授權' : '未授權，不會生效' })];
  if (!allowed) {
    const grant = element('button', { type: 'button', className: 'extra-grant', textContent: '授權' });
    grant.addEventListener('click', () => grantExtraSite(pattern));
    parts.push(grant);
  }
  const remove = element('button', { type: 'button', className: 'extra-remove', textContent: '移除' });
  remove.addEventListener('click', () => removeExtraSite(pattern));
  parts.push(remove);
  return element('div', { className: 'extra-item' }, ...parts);
}

async function showExtraSites() {
  extraSites = await readExtraSites();
  $('extraList').replaceChildren(...await Promise.all(extraSites.map(extraRow)));
}

// Chrome 對不收的網址或權限會丟例外：顯示在畫面上，不能讓使用者按了沒反應
const guarded = action => action().catch(error => showExtraMessage('error', `操作失敗：${error?.message || error}`));

const grantExtraSite = pattern => guarded(async () => {
  const allowed = await chrome.permissions.request({ origins: [pattern] });
  if (allowed) showExtraMessage('info', `已授權 ${siteName(pattern)}，到那個網站的分頁重新整理後面板就會出現`);
  else showExtraMessage('warn', '沒有授權，這個網站還是不會生效');
  await showExtraSites();
});

// 先把存取權還給 Chrome，成功了才從清單拿掉（還不掉就留在清單裡，才看得到、才能再試）
const removeExtraSite = pattern => guarded(async () => {
  await chrome.permissions.remove({ origins: [pattern] });
  await chrome.storage.local.set({ extraGameUrls: CatworldGameUrls.remove(await readExtraSites(), pattern) });
  showExtraMessage('info', `已移除 ${siteName(pattern)}，並把存取權還給 Chrome。已經開著的分頁重新整理後面板會消失`);
  await showExtraSites();
});

$('extraAdd').addEventListener('click', () => guarded(async () => {
  const parsed = CatworldGameUrls.parse($('extraUrl').value);
  if (!parsed.ok) return showExtraMessage('error', parsed.error);
  const next = CatworldGameUrls.add(extraSites, parsed.pattern);
  if (!next.ok) return showExtraMessage('error', next.error);
  const allowed = await chrome.permissions.request({ origins: [parsed.pattern] });
  if (!allowed) return showExtraMessage('warn', '沒有授權，所以沒有新增。要用的話請再按一次，並在 Chrome 的詢問按「允許」');
  const fresh = CatworldGameUrls.add(await readExtraSites(), parsed.pattern);
  if (!fresh.ok) return showExtraMessage('error', fresh.error);
  await chrome.storage.local.set({ extraGameUrls: fresh.list });
  $('extraUrl').value = '';
  showExtraMessage('info', `已新增 ${siteName(parsed.pattern)}。到那個網站的分頁重新整理後面板就會出現`);
  await showExtraSites();
}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extraGameUrls) showExtraSites();
});
chrome.permissions.onAdded.addListener(showExtraSites);
chrome.permissions.onRemoved.addListener(showExtraSites);
showExtraSites();

// 主要武器類型：存起來，遊戲頁的面板監聽 storage 變化，馬上生效。不合法的值當成未設定
// 地圖怪物蒐集：紀錄由遊戲頁的 map-collect.js 寫進 storage，這裡只顯示筆數、複製成 Tab 分隔文字、清除
const MAP_KEY = 'mapMonsters';
const VISITED_KEY = 'mapVisited'; // 面板「掃描」走過的房間（map-hunt.js 寫入）
const mapRows = CatworldMapCollect.rows;
async function showMapCollect() {
  const rows = mapRows((await chrome.storage.local.get(MAP_KEY))[MAP_KEY]);
  const mobs = new Set(rows.flatMap(row => row.mobs));
  const builtin = Object.keys(CatworldMapCollect.builtinStore()).length;
  const visited = Object.values(CatworldMapHunt.normalizeVisited((await chrome.storage.local.get(VISITED_KEY))[VISITED_KEY]));
  const blocked = visited.filter(row => row.state === 'blocked').length;
  $('mapCollectInfo').textContent = `內建 ${builtin} 個房間；` + (rows.length ? `你自己記下 ${rows.length} 個房間、${mobs.size} 種怪物` : '你自己還沒有紀錄')
    + `；掃描走過 ${visited.length - blocked} 間` + (blocked ? `、走不到 ${blocked} 間` : '');
}
function mapMessage(text, level) { $('mapCollectMsg').textContent = text; markLevel($('mapCollectMsg'), level); }
$('mapCollectCopy').addEventListener('click', async () => {
  const rows = mapRows((await chrome.storage.local.get(MAP_KEY))[MAP_KEY]);
  if (!rows.length) { mapMessage('還沒有紀錄', 'warn'); return; }
  const text = rows.map(row => [row.area, row.areaName || '', row.room, row.mobs.join(',')].join('\t')).join('\n');
  try { await navigator.clipboard.writeText(text); mapMessage(`已複製 ${rows.length} 列`); }
  catch (e) { mapMessage(`複製失敗：${e.message}`, 'error'); }
});
$('mapCollectClear').addEventListener('click', async () => {
  if (!confirm('清除所有已蒐集的地圖怪物紀錄？清掉就回不來了。')) return;
  await chrome.storage.local.remove(MAP_KEY);
  mapMessage('已清除');
});
$('mapVisitedClear').addEventListener('click', async () => {
  if (!confirm('清除「已走過的房間」紀錄？下次按面板的「掃描」會重新走整區。怪物紀錄不受影響。')) return;
  await chrome.storage.local.remove(VISITED_KEY);
  mapMessage('已清除已走過的房間');
});
showMapCollect();
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes[MAP_KEY] || changes[VISITED_KEY])) showMapCollect(); });

// 內力可練上限的其他加成（force-cap.js 讀 forceExtras）：五個欄位每次 change 存成一個物件，存的是檢查過的值，欄位也改成存下來的樣子
const FORCE_EXTRAS_KEY = 'forceExtras';
const FORCE_NUMBER_FIELDS = { forceLevel: 'level', forceZhuguo: 'zhuguo', forceEquip: 'equip' };
const FORCE_SWITCH_FIELDS = { forceLaba: 'laba', forceDongying: 'dongying' };
function showForceExtras(raw) {
  const stored = raw && typeof raw === 'object' ? raw : {};
  const extras = CatworldForceCap.normalizeExtras(stored);
  Object.entries(FORCE_NUMBER_FIELDS).forEach(([id, key]) => { $(id).value = stored[key] === undefined ? '' : String(extras[key]); });
  Object.entries(FORCE_SWITCH_FIELDS).forEach(([id, key]) => { $(id).checked = extras[key]; });
}
async function saveForceExtras() {
  const raw = {};
  Object.entries(FORCE_NUMBER_FIELDS).forEach(([id, key]) => { raw[key] = $(id).value.trim(); });
  Object.entries(FORCE_SWITCH_FIELDS).forEach(([id, key]) => { raw[key] = $(id).checked; });
  const extras = CatworldForceCap.normalizeExtras(raw);
  showForceExtras(extras);
  await chrome.storage.local.set({ [FORCE_EXTRAS_KEY]: extras });
}
Object.keys({ ...FORCE_NUMBER_FIELDS, ...FORCE_SWITCH_FIELDS }).forEach(id => $(id).addEventListener('change', saveForceExtras));
chrome.storage.local.get(FORCE_EXTRAS_KEY).then(data => showForceExtras(data[FORCE_EXTRAS_KEY]));

// 裝備資料庫：紀錄由遊戲頁的 shop-collect.js 寫進 storage，這裡只顯示件數、複製成 Tab 分隔文字、清除
const SHOP_KEY = CatworldShopCollect.DB_KEY;
async function showShopCollect() {
  const rows = CatworldShopCollect.rows((await chrome.storage.local.get(SHOP_KEY))[SHOP_KEY]);
  const builtin = Object.keys(CatworldShopCollect.builtinDb()).length;
  $('shopInfo').textContent = `內建 ${builtin} 件；` + (rows.length ? `你自己 check 記下 ${rows.length} 件` : '你自己還沒有紀錄');
}
function shopMessage(text, level) { $('shopMsg').textContent = text; markLevel($('shopMsg'), level); }
$('shopCopy').addEventListener('click', async () => {
  const rows = CatworldShopCollect.rows((await chrome.storage.local.get(SHOP_KEY))[SHOP_KEY]);
  if (!rows.length) { shopMessage('還沒有紀錄', 'warn'); return; }
  try { await navigator.clipboard.writeText(rows.map(row => row.join('\t')).join('\n')); shopMessage(`已複製 ${rows.length} 列（名稱、類別、主要數值、佩帶經驗、屬性）`); }
  catch (e) { shopMessage(`複製失敗：${e.message}`, 'error'); }
});
$('shopClear').addEventListener('click', async () => {
  if (!confirm('清除所有已蒐集的裝備資料？清掉就回不來了。')) return;
  await chrome.storage.local.remove(SHOP_KEY);
  shopMessage('已清除');
});
// 不 check 的名稱清單：存字串（空的也是有效值＝都不略過），缺值用預設
$('shopSkipNames').value = CatworldShopCollect.DEFAULT_SKIP_NAMES;
$('shopSkipNames').addEventListener('change', () => {
  chrome.storage.local.set({ [CatworldShopCollect.SKIP_NAMES_KEY]: $('shopSkipNames').value.trim() });
});
// 快速購買的名稱清單：存字串（空的也是有效值＝不出現購買鈕），缺值用預設
$('shopBuyNames').value = CatworldShopCollect.DEFAULT_BUY_NAMES;
$('shopBuyNames').addEventListener('change', () => {
  chrome.storage.local.set({ [CatworldShopCollect.BUY_NAMES_KEY]: $('shopBuyNames').value.trim() });
});
// 批次 check 的最低價格（S）：負數、不是數字就不存，欄位還原
let shopMinSilver = CatworldShopCollect.DEFAULT_MIN_SILVER;
$('shopMinPrice').value = shopMinSilver;
$('shopMinPrice').addEventListener('change', () => {
  const raw = $('shopMinPrice').value.trim() === '' ? NaN : Number($('shopMinPrice').value);
  if (!(Number.isFinite(raw) && raw >= 0)) {
    $('shopMinPrice').value = shopMinSilver;
    setStatus('最低價格需為 0 以上的數字', 'error');
    return;
  }
  shopMinSilver = raw;
  chrome.storage.local.set({ [CatworldShopCollect.MIN_PRICE_KEY]: raw });
});
showShopCollect();
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[SHOP_KEY]) showShopCollect(); });

const weaponValue = value => (CatworldZapItems.WEAPON_TYPES.includes(value) ? value : '');
$('mainWeapon').replaceChildren(...['', ...CatworldZapItems.WEAPON_TYPES].map(type => element('option', { value: type, textContent: type || '未設定' })));
$('mainWeapon').addEventListener('change', () => {
  chrome.storage.local.set({ mainWeapon: weaponValue($('mainWeapon').value) });
});

// 附屬能力門檻：存起來，遊戲頁的面板監聽 storage 變化，馬上生效。門檻不是 1 以上的整數就不存，欄位還原
let equipmentKeep = CatworldZapEquipment.normalizeKeepRule(undefined);
function showEquipmentKeep() {
  $('keepEnabled').checked = equipmentKeep.enabled;
  $('keepMin').value = equipmentKeep.min;
}
['keepEnabled', 'keepMin'].forEach(id => $(id).addEventListener('change', () => {
  const raw = { enabled: $('keepEnabled').checked, min: Number($('keepMin').value) };
  const valid = CatworldZapEquipment.normalizeKeepRule(raw);
  if (valid.min !== raw.min) {
    showEquipmentKeep();
    setStatus('門檻需為 1 以上的整數', 'error');
    return;
  }
  equipmentKeep = valid;
  chrome.storage.local.set({ equipmentKeep });
}));

// 怪物分級門檻：存起來，遊戲頁的面板監聽 storage 變化，馬上生效。無效的值（需 1 < 綠上限 < 黃上限）不存，欄位還原
let zapThresholds = CatworldZapMobs.normalizeThresholds(undefined);
function showZapThresholds() {
  $('zapGreenMax').value = zapThresholds.greenMax;
  $('zapYellowMax').value = zapThresholds.yellowMax;
}
['zapGreenMax', 'zapYellowMax'].forEach(id => $(id).addEventListener('change', () => {
  const raw = { greenMax: Number($('zapGreenMax').value), yellowMax: Number($('zapYellowMax').value) };
  const valid = CatworldZapMobs.normalizeThresholds(raw);
  if (valid.greenMax !== raw.greenMax || valid.yellowMax !== raw.yellowMax) {
    showZapThresholds();
    setStatus('門檻需 1 < 綠上限 < 黃上限', 'error');
    return;
  }
  zapThresholds = valid;
  chrome.storage.local.set({ zapThresholds });
}));

$('beep').addEventListener('click', async () => {
  try {
    const result = await send({ type: 'TEST_BEEP' });
    setStatus(result?.played ? '提示音已播放' : '瀏覽器擋住聲音：請先在遊戲分頁點一下或輸入任何內容，再試一次', result?.played ? 'info' : 'warn');
  } catch (e) { setStatus(e.message, 'error'); }
});

// popup 失焦就會關閉，清單改在獨立分頁開啟；已開著就直接切過去，不重複開
$('skills').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('skills.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

// ---- 分頁 ----
function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.tab === name)));
  document.querySelectorAll('[data-pane]').forEach(pane => { pane.hidden = pane.dataset.pane !== name; });
  chrome.storage.local.set({ popupTab: name });
}
document.querySelector('.tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]');
  if (tab) showTab(tab.dataset.tab);
});

// ---- 觸發（戰鬥、練功兩組，各自獨立、功能完全一樣）----
const STAT_NAMES = Object.keys(Engine.STATS);
const D = Engine.DEFAULTS;
const BLANK_RULE = { enabled: true, stat: '飲水', op: 'le', unit: 'abs', value: 200, commands: [], cooldown: D.cooldown, buffer: D.buffer };

function element(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

const field = (name, el) => { el.dataset.f = name; return el; };

// 每組一個分頁：標記來自 popup.html 的 <template id="triggerPaneTemplate">，裡面所有 id 都帶 -__G__，
// 複製時換成組別，所以兩組不會撞 id。每組有自己的規則清單、開始／停止、命中延遲與安全機制，存在 triggerGroupSettings[組別]
function createTriggerPane(group) {
  const $g = name => document.getElementById(`${name}-${group.id}`);
  const root = element('div');
  root.dataset.pane = group.id;
  root.hidden = true;
  root.innerHTML = document.getElementById('triggerPaneTemplate').innerHTML.replaceAll('__G__', group.id);
  document.getElementById('triggerPanes').append(root);
  const tab = element('button', { type: 'button', textContent: `${group.name}觸發` });
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  tab.dataset.tab = group.id;
  document.querySelector('.tabs').append(tab);

  let hold = { until: 0 };
  const holdStatus = text => {
    hold = { until: Date.now() + 4000 };
    $g('trigStatus').textContent = text;
    markLevel($g('trigStatus'), 'error');
  };

  // 每張規則卡片共用：刪除、重新啟用（按卡片在清單中的順序對應引擎裡的規則）
  function wireRuleControls(card, remove, again) {
    remove.addEventListener('click', () => { card.remove(); save(); updateRulesSummary(); });
    again.addEventListener('click', async () => {
      const index = [...$g('rules').children].indexOf(card);
      try { await send({ type: 'REARM_RULE', group: group.id, index }); refreshLive(); } catch (e) { holdStatus(e.message); }
    });
  }

  // 這條規則的指令送出後就停止這一組觸發（只停這一組，定時與另一組不受影響）；數值規則與關鍵字規則都有
  const stopGroupField = rule => element('label', { className: 'check', title: '這條規則的指令送出後，這一組觸發就停止；定時送出與另一組觸發不受影響' },
    field('stopGroup', element('input', { type: 'checkbox', checked: rule.stopGroup === true })), `命中送出後停止${group.name}觸發`);

  // 這條規則命中時，指令排在所有其他指令前面，其他正在排隊與等待中的指令先暫停，等這條的指令全部送完再繼續
  const priorityField = rule => element('label', { className: 'check', title: '命中時這條規則的指令最優先送出，連已經排隊、正在 @等待 的其他指令都先暫停，送完才接著做' },
    field('priority', element('input', { type: 'checkbox', checked: rule.priority === true })), '最優先（其他指令先暫停）');

  // 這條規則最後一個指令後面加隨機數字：勾了才顯示範圍欄；欄位空白退回 50～150。只有練功組有（戰鬥組不放，回傳空陣列）
  const numberFields = rule => {
    if (group.id !== 'practice') return [];
    const on = field('numOn', element('input', { type: 'checkbox', checked: Boolean(rule.number) }));
    const min = field('numMin', element('input', { type: 'number', min: 0, value: rule.number?.min ?? 50, title: '最小數字' }));
    const max = field('numMax', element('input', { type: 'number', min: 0, value: rule.number?.max ?? 150, title: '最大數字' }));
    const range = element('span', { className: 'numrange', hidden: !on.checked }, min, '～', max);
    on.addEventListener('change', () => { range.hidden = !on.checked; });
    return [element('label', { className: 'check', title: '每次命中送出時，在最後一個指令後面加一個空白和範圍內的隨機整數，例如 pw 87，給遊戲的 alias 用' }, on, '最後一個指令後面加隨機數字', range)];
  };

  // 規則卡片預設收起：標頭（啟用、狀態、刪除）與一行摘要常駐，其餘欄位放進 body，點「展開」或摘要才看到。
  // 還沒填內容的規則（剛新增、預設空白規則）直接展開。describe 回傳摘要文字，欄位一改就更新
  function foldRule(card, head, body, describe, open) {
    const toggle = element('button', { type: 'button', className: 'linkbtn fold-toggle' });
    const summary = element('div', { className: 'rule-summary' });
    const sync = () => {
      const isOpen = card.classList.contains('open');
      body.hidden = !isOpen;
      summary.hidden = isOpen;
      toggle.textContent = isOpen ? '▾ 收起' : '▸ 展開';
    };
    const flip = () => { card.classList.toggle('open'); sync(); };
    toggle.addEventListener('click', flip);
    summary.addEventListener('click', flip);
    const refresh = () => { summary.textContent = describe(); };
    card.addEventListener('input', refresh);
    card.addEventListener('change', refresh);
    head.insertBefore(toggle, head.lastChild);
    card.classList.toggle('open', open);
    card.insertBefore(summary, body);
    sync();
    refresh();
  }
  const commandText = (card, commands) => {
    const text = commands.value.split('\n').map(x => x.trim()).filter(Boolean).join(' ; ');
    if (text) return text;
    return card.querySelector('[data-f="stopGroup"]')?.checked ? '停止這組觸發' : '（尚未填指令）';
  };
  const isBlank = rule => !(rule.commands || []).length && !rule.pattern && rule.stopGroup !== true;

  function ruleCard(rule, open = isBlank(rule)) {
    const stat = field('stat', element('select', { title: '項目' }, ...STAT_NAMES.map(name => element('option', { value: name, textContent: name, selected: name === rule.stat }))));
    const op = field('op', element('select', { title: '方向：≤ 目前值小於等於門檻就觸發，≥ 目前值大於等於門檻就觸發' },
      element('option', { value: 'le', textContent: '≤', selected: rule.op !== 'ge' }),
      element('option', { value: 'ge', textContent: '≥', selected: rule.op === 'ge' })));
    const value = field('value', element('input', { type: 'number', min: 0, value: rule.value, title: '門檻' }));
    const unit = field('unit', element('select', { title: '單位' },
      element('option', { value: 'abs', textContent: '數值', selected: rule.unit !== 'pct' }),
      element('option', { value: 'pct', textContent: '％', selected: rule.unit === 'pct' })));
    const commands = field('commands', element('textarea', { value: (rule.commands || []).join('\n'), placeholder: '例：drink（要跑巨集視窗第 3 列的內容就寫 @巨集 3）' }));
    const cooldown = field('cooldown', element('input', { type: 'number', min: Engine.MIN_COOLDOWN_SEC, value: rule.cooldown }));
    const buffer = field('buffer', element('input', { type: 'number', min: 0, value: rule.buffer }));
    const enabled = field('enabled', element('input', { type: 'checkbox', checked: rule.enabled !== false, title: '啟用這條規則' }));
    const pill = field('pill', element('span', { className: 'pill', hidden: true }));
    const again = field('again', element('button', { type: 'button', className: 'linkbtn', textContent: '重新啟用', hidden: true }));
    const remove = element('button', { type: 'button', className: 'x', textContent: '✕', title: '刪除這條規則' });
    const rearm = element('p', { className: 'rearm' });

    const head = element('div', { className: 'rule-head' }, enabled, element('span', { className: 'grow' }, pill), again, remove);
    const body = element('div', { className: 'rule-body' },
      element('div', { className: 'cond' }, stat, op, value, unit),
      element('label', { textContent: '送出的指令（一行一個，依序送出）' }), commands,
      element('div', { className: 'row' },
        element('div', {}, element('label', { textContent: '冷卻（秒，最少 1）' }), cooldown),
        element('div', {}, element('label', { textContent: '回復緩衝（％）' }), buffer)),
      rearm, ...numberFields(rule), stopGroupField(rule), priorityField(rule));
    const card = element('div', { className: 'rule' }, head, body);
    foldRule(card, head, body, () => `${stat.value} ${op.value === 'ge' ? '≥' : '≤'} ${value.value}${unit.value === 'pct' ? '％' : ''}　→　${commandText(card, commands)}`, open);

    const updateRearm = () => {
      const text = Engine.rearmText({ op: op.value, unit: unit.value, value: Number(value.value) || 0, buffer: Number(buffer.value) || 0 });
      rearm.textContent = `回復條件：${stat.value} ${text} 才會重新武裝`;
    };
    card.addEventListener('input', updateRearm);
    updateRearm();
    card.dataset.kind = 'stat';
    wireRuleControls(card, remove, again);
    return card;
  }

  // 關鍵字規則：遊戲輸出區新出現的文字含關鍵字就送出指令
  function keywordCard(rule, open = isBlank(rule)) {
    const enabled = field('enabled', element('input', { type: 'checkbox', checked: rule.enabled !== false, title: '啟用這條規則' }));
    const pill = field('pill', element('span', { className: 'pill', hidden: true }));
    const again = field('again', element('button', { type: 'button', className: 'linkbtn', textContent: '重新啟用', hidden: true }));
    const remove = element('button', { type: 'button', className: 'x', textContent: '✕', title: '刪除這條規則' });
    const pattern = field('pattern', element('textarea', { rows: 2, value: rule.pattern || '', placeholder: '例：你覺得口渴（可以貼多行）', title: '新出現的遊戲文字含這段字就觸發（不分大小寫；多行、換行與空白不影響比對）' }));
    pattern.style.minHeight = '48px';
    const commands = field('commands', element('textarea', { value: (rule.commands || []).join('\n'), placeholder: '例：drink（要跑巨集視窗第 3 列的內容就寫 @巨集 3）' }));
    const cooldown = field('cooldown', element('input', { type: 'number', min: Engine.MIN_COOLDOWN_SEC, value: rule.cooldown ?? D.cooldown }));
    const head = element('div', { className: 'rule-head' }, enabled, element('span', { className: 'kind', textContent: '關鍵字' }), element('span', { className: 'grow' }, pill), again, remove);
    const body = element('div', { className: 'rule-body' },
      element('label', { textContent: '關鍵字（遊戲新出現的文字含有就觸發，不分大小寫；可以貼多行，換行與空白不影響比對，分批印出來的也看得到）' }), pattern,
      element('label', { textContent: '送出的指令（一行一個，依序送出）' }), commands,
      element('label', { textContent: '冷卻（秒，最少 1）' }), cooldown, ...numberFields(rule), stopGroupField(rule), priorityField(rule));
    const card = element('div', { className: 'rule' }, head, body);
    foldRule(card, head, body, () => `「${pattern.value.replace(/\s+/g, ' ').trim() || '（尚未填關鍵字）'}」　→　${commandText(card, commands)}`, open);
    card.dataset.kind = 'keyword';
    wireRuleControls(card, remove, again);
    return card;
  }

  const buildCard = rule => (rule.kind === 'keyword' ? keywordCard(rule) : ruleCard(rule));

  function readSettings() {
    const get = (card, name) => card.querySelector(`[data-f="${name}"]`);
    const lines = (card, name) => get(card, name).value.split('\n').map(x => x.trim()).filter(Boolean);
    const numberOf = card => {
      if (!get(card, 'numOn')?.checked) return {};
      const bound = (name, fallback) => (get(card, name).value.trim() === '' ? fallback : Number(get(card, name).value));
      return { number: { min: bound('numMin', 50), max: bound('numMax', 150) } };
    };
    return {
      rules: [...$g('rules').children].map(card => (card.dataset.kind === 'keyword'
        ? {
          kind: 'keyword',
          enabled: get(card, 'enabled').checked,
          pattern: get(card, 'pattern').value.trim(),
          commands: lines(card, 'commands'),
          ...numberOf(card),
          cooldown: Number(get(card, 'cooldown').value),
          stopGroup: get(card, 'stopGroup').checked,
          priority: get(card, 'priority').checked,
        }
        : {
          kind: 'stat',
          enabled: get(card, 'enabled').checked,
          stat: get(card, 'stat').value,
          op: get(card, 'op').value,
          unit: get(card, 'unit').value,
          value: Number(get(card, 'value').value),
          commands: lines(card, 'commands'),
          ...numberOf(card),
          cooldown: Number(get(card, 'cooldown').value),
          buffer: Number(get(card, 'buffer').value),
          stopGroup: get(card, 'stopGroup').checked,
          priority: get(card, 'priority').checked,
        })),
      limitFires: $g('limitFires').checked,
      limitIneffective: $g('limitIneffective').checked,
      limitGlobal: $g('limitGlobal').checked,
      maxFires: Number($g('maxFires').value),
      windowMinutes: Number($g('windowMinutes').value),
      maxIneffective: Number($g('maxIneffective').value),
      globalPerMinute: Number($g('globalPerMinute').value),
      delayMax: $g('delayMax').value.trim() === '' ? D.delayMax : Number($g('delayMax').value),
      // 允許的狀態：勾的內建選項加上自己填的（、 , ， 或換行分開），整理（去空白、去重、正常一定在最前面）交給引擎
      allowedStatuses: Engine.cleanStatuses([
        ...Engine.STATUS_PRESETS.filter(name => $g('statuses').querySelector(`input[data-status="${name}"]`).checked),
        ...$g('statusCustom').value.split(/[、,，\n]/),
      ]),
    };
  }

  // 兩組存在同一個 storage key，各寫各的那一組，不覆蓋另一組
  async function save() {
    const { triggerGroupSettings } = await chrome.storage.local.get('triggerGroupSettings');
    await chrome.storage.local.set({ triggerGroupSettings: { ...triggerGroupSettings, [group.id]: readSettings() } });
  }

  // 沒勾選的限制，數字欄位反灰
  function syncLimitInputs() {
    [['limitFires', ['maxFires', 'windowMinutes']], ['limitIneffective', ['maxIneffective']], ['limitGlobal', ['globalPerMinute']]]
      .forEach(([switchId, inputs]) => inputs.forEach(id => { $g(id).disabled = !$g(switchId).checked; }));
  }

  // 規則清單收起來時，標題寫幾條、幾條關閉，以及執行中被停用的條數
  let ruleStates = [];
  function updateRulesSummary() {
    const cards = [...$g('rules').children];
    const closed = cards.filter(card => !card.querySelector('[data-f="enabled"]').checked).length;
    const stopped = ruleStates.filter(rule => rule.phase === 'disabled').length;
    const parts = [`${cards.length} 條`];
    if (closed) parts.push(`${closed} 條關閉`);
    if (stopped) parts.push(`⚠ ${stopped} 條被停用`);
    $g('rulesSummary').textContent = `觸發規則（${parts.join('，')}）`;
  }

  function render(saved) {
    const config = saved || { rules: [BLANK_RULE] };
    $g('rules').replaceChildren(...(config.rules.length ? config.rules : [BLANK_RULE]).map(buildCard));
    updateRulesSummary();
    $g('limitFires').checked = config.limitFires === true;
    $g('limitIneffective').checked = config.limitIneffective === true;
    $g('limitGlobal').checked = config.limitGlobal === true;
    syncLimitInputs();
    $g('maxFires').value = config.maxFires ?? D.maxFires;
    $g('windowMinutes').value = config.windowMinutes ?? D.windowMinutes;
    $g('maxIneffective').value = config.maxIneffective ?? D.maxIneffective;
    $g('globalPerMinute').value = config.globalPerMinute ?? D.globalPerMinute;
    $g('delayMax').value = config.delayMax ?? D.delayMax;
    // 以前有個總開關 requireNormal：關掉過（而且還沒選過清單）的，讓內建的狀態都勾起來，盡量接近它原本「不擋」的行為；選過清單的照清單
    const legacyOff = config.requireNormal === false && !Array.isArray(config.allowedStatuses);
    const allowed = Engine.cleanStatuses(legacyOff || !Array.isArray(config.allowedStatuses) ? Engine.STATUS_PRESETS : config.allowedStatuses);
    Engine.STATUS_PRESETS.forEach(name => { $g('statuses').querySelector(`input[data-status="${name}"]`).checked = allowed.includes(name); });
    $g('statusCustom').value = allowed.filter(name => name !== Engine.NORMAL_STATUS && !Engine.STATUS_PRESETS.includes(name)).join('、');
  }

  root.querySelector('.safety').addEventListener('change', syncLimitInputs);
  $g('addRule').addEventListener('click', () => { $g('rules').append(ruleCard(BLANK_RULE, true)); save(); updateRulesSummary(); });
  $g('addKeyword').addEventListener('click', () => { $g('rules').append(keywordCard({ enabled: true, pattern: '', commands: [], cooldown: D.cooldown }, true)); save(); updateRulesSummary(); });
  root.addEventListener('change', save);
  root.addEventListener('change', updateRulesSummary);

  $g('tstart').addEventListener('click', async () => {
    try {
      const config = readSettings();
      if (!Engine.hasActiveRules(config)) throw new Error('至少要有一條完整的規則（數值規則要填項目、門檻、指令；關鍵字規則要填關鍵字、指令）');
      await save();
      const result = await send({ type: 'START_TRIGGER', group: group.id, config });
      if (!result?.ok) throw new Error(result?.error || '啟動觸發失敗');
      refreshLive();
    } catch (e) { holdStatus(e.message); }
  });

  $g('tstop').addEventListener('click', async () => {
    try { await send({ type: 'STOP_TRIGGER', group: group.id }); refreshLive(); }
    catch (e) { holdStatus(e.message); }
  });

  function renderReadings(stats) {
    $g('read').replaceChildren(...STAT_NAMES.map(name => {
      const stat = stats?.[name];
      const max = stat && Number.isFinite(stat.max) ? `/${stat.max}` : '';
      return element('div', { className: stat ? 'chip' : 'chip na' }, element('b', { textContent: name }), stat ? `${stat.value}${max}` : '—');
    }));
  }

  // status 是遊戲頁回的 STATUS（連不上時是 null）。規則數量和遊戲頁正在跑的設定不同（剛改過還沒重新開始）時不顯示規則狀態
  function refresh(status) {
    renderReadings(status?.stats);
    const state = status?.triggerGroups?.[group.id];
    const cards = [...$g('rules').children];
    const states = state?.on && state.rules.length === cards.length ? state.rules : [];
    ruleStates = states;
    updateRulesSummary();
    cards.forEach((card, i) => {
      const pill = card.querySelector('[data-f="pill"]');
      const again = card.querySelector('[data-f="again"]');
      const rule = states[i];
      pill.hidden = !rule || rule.phase === 'off';
      again.hidden = !rule || rule.phase !== 'disabled';
      if (rule) { pill.textContent = rule.text; pill.className = `pill ${rule.phase}`; pill.title = rule.text; }
    });
    if (Date.now() < hold.until) return;
    $g('trigStatus').textContent = state?.on
      ? `${group.name}觸發執行中（${state.rules.filter(rule => rule.phase !== 'off').length} 條規則）`
      : (state?.note || `${group.name}觸發未啟動`);
    markLevel($g('trigStatus'), state?.on ? 'info' : stopLevel(state?.note));
  }

  return { group, root, render, refresh, readSettings };
}

const panes = Object.fromEntries(Engine.GROUPS.map(group => [group.id, createTriggerPane(group)]));
// 觸發分頁是 JS 後加的，「設定」分頁的按鈕要重新放到最後
document.querySelector('.tabs').append($('tab-settings'));

// 定時分頁的倒數：固定指令每一項的下一次、隨機指令的下一次
function renderCountdown(status) {
  const left = at => `${Math.max(0, Math.ceil((at - Date.now()) / 1000))} 秒後`;
  const parts = [];
  if (status?.running) {
    const settings = status.settings || {};
    (status.fixed || []).forEach(entry => parts.push(`固定 ${entry.command}：${left(entry.at)}`));
  }
  $('countdown').textContent = `下一輪：${parts.length ? parts.join('　') : status?.idle?.phase === 'idling' && status?.running ? 'Idle 中' : '—'}`;
  const random = status?.randomRunning
    ? (status.idle?.phase === 'idling' ? 'Idle 中' : status.nextRandomAt ? `${status.nextRandomCommand}，${left(status.nextRandomAt)}` : '—')
    : '—';
  $('randomCountdown').textContent = `下一輪：${random}`;
  const idle = status?.idle;
  if (idle) $('idleStatus').textContent = `狀態：${idle.phase === 'idling' ? 'Idle 中' : '運作中'}，${left(idle.at)}${idle.phase === 'idling' ? '繼續' : '進入 idle'}`;
}

// 每秒向遊戲頁要一次狀態，更新定時倒數與兩組觸發的讀數、規則狀態
// 定時的狀態文字平常只在按這一頁自己的按鈕時才會改；在面板或置頂面板裡開始、停止時，這裡要跟著變（只在開始／停止翻轉時改，不蓋掉錯誤訊息）
let lastTimerRunning = null;
let lastRandomRunning = null;
let lastIdle = null;
async function refreshLive() {
  let status = null;
  try { status = await send({ type: 'STATUS' }); } catch { /* 連不上遊戲頁：讀數顯示 — */ }
  if (status && lastTimerRunning !== null && Boolean(status.running) !== lastTimerRunning) setStatus(status.running ? '執行中' : (status.stopReason || '已停止'), status.running ? 'info' : stopLevel(status.stopReason));
  if (status) lastTimerRunning = Boolean(status.running);
  if (status && lastRandomRunning !== null && Boolean(status.randomRunning) !== lastRandomRunning) setRandomStatus(status.randomRunning ? '執行中' : (status.stopReason || '已停止'), status.randomRunning ? 'info' : stopLevel(status.stopReason));
  if (status) lastRandomRunning = Boolean(status.randomRunning);
  if (status && lastIdle !== null && Boolean(status.idle) !== lastIdle && !status.idle) setIdleStatus(status.stopReason && !status.running && !status.randomRunning ? status.stopReason : '已停止', 'info');
  if (status) lastIdle = Boolean(status.idle);
  scriptSession = status ? status.chatScript ?? null : undefined;
  renderScriptStatus();
  updateHints();
  renderCountdown(status);
  Object.values(panes).forEach(pane => pane.refresh(status));
}

// 遊戲巨集的匯入匯出（流程在 macro-io-ui.js）：遊戲的巨集存在遊戲分頁的 localStorage.MACROS，設定頁讀不到，
// 用 MACRO_READ／MACRO_WRITE 請這個設定頁控制的遊戲分頁（send，和其他按鈕同一條路，連不上會備援注入）代讀代寫；備註與備份在 chrome.storage，直接讀寫。
// 寫入時：遊戲分頁明確回失敗、或找不到遊戲分頁＝確定沒寫；送出後斷線、沒收到回覆＝不確定寫了沒（unknown），
// 這時不能把匯入前的備份換回舊的（新的那份可能是唯一的回頭路）
const UNREACHABLE = /Receiving end does not exist|請先切到|No tab|Could not establish connection/;
const macroError = (error, extra = {}) => Object.assign(error instanceof Error ? error : new Error(String(error)), extra);
CatworldMacroIOUI.attach(document.getElementById('sec-macro'), {
  readRaw: async () => {
    let reply;
    try { reply = await send({ type: 'MACRO_READ' }); } catch (error) { throw macroError(error, { unreachable: true }); }
    if (!reply?.ok) throw macroError(reply?.error || '遊戲分頁沒有回應');
    return reply.raw;
  },
  writeMacros: async raw => {
    let reply;
    try {
      reply = await send({ type: 'MACRO_WRITE', raw });
    } catch (error) {
      throw macroError(error, { unknown: !UNREACHABLE.test(String(error?.message || error)) });
    }
    if (!reply?.ok) throw macroError(reply?.error || '遊戲分頁沒有回應');
  },
  readNotes: async () => (await chrome.storage.local.get('macroNotes')).macroNotes,
  // 寫入者不是備註模組自己的代號，遊戲頁的備註模組才會把它當成別處的改動、直接更新畫面上的備註框
  writeNotes: notes => chrome.storage.local.set({ macroNotes: notes, macroNotesWriter: 'macro-io' }),
  // 匯入前自動留的一份備份（只留一層，只存在本機，不進匯出）
  readBackup: async () => (await chrome.storage.local.get('macroBackup')).macroBackup,
  writeBackup: backup => chrome.storage.local.set({ macroBackup: backup }),
});

// 地圖巡怪：欄位、預設值與檢查都由 map-hunt.js 的 FIELDS 決定；每改一個欄位就存整份（不合法的欄位退回預設並顯示回去）。
// 欄位依 GROUPS 分成摺疊區塊（id 是 fold-hunt-<組>，展開狀態和其他摺疊一樣記在 popupFolds），收起時標題寫出重點；
// 用不到的欄位（show 為 false）藏起來但照樣存，開始前必填但沒填的（missingFields）用琥珀色標出來
let huntSettings = CatworldMapHunt.normalizeSettings(null);
const huntGroups = {};
const showHuntSettings = () => {
  const missing = new Set(CatworldMapHunt.missingFields(huntSettings).map(field => field.key));
  CatworldMapHunt.FIELDS.forEach(item => {
    $(`hunt-${item.key}`).value = huntSettings[item.key];
    const cell = $(`hunt-${item.key}`).closest('.hfield');
    cell.hidden = !CatworldMapHunt.fieldShown(item, huntSettings);
    cell.classList.toggle('hmissing', missing.has(item.key));
  });
  document.querySelectorAll('#huntFields .hrow').forEach(row => { row.hidden = [...row.children].every(cell => cell.hidden); });
  CatworldMapHunt.GROUPS.forEach(group => {
    const { box, summary } = huntGroups[group.id];
    box.hidden = [...box.querySelectorAll('.hfield')].every(cell => cell.hidden);
    const lacking = CatworldMapHunt.FIELDS.some(item => item.group === group.id && missing.has(item.key));
    summary.textContent = `${group.title}　${lacking ? '⚠ 有必填的沒填　' : ''}${group.summary(huntSettings)}`;
    summary.classList.toggle('hlacking', lacking);
  });
};
CatworldMapHunt.GROUPS.forEach(group => {
  const box = document.createElement('details');
  box.className = 'fold';
  box.id = `fold-hunt-${group.id}`;
  const summary = document.createElement('summary');
  box.append(summary);
  huntGroups[group.id] = { box, summary };
  $('huntFields').append(box);
});
const huntRows = {};
CatworldMapHunt.FIELDS.forEach(item => {
  const cell = document.createElement('div');
  cell.className = 'hfield';
  const label = document.createElement('label');
  label.htmlFor = `hunt-${item.key}`;
  label.textContent = item.label;
  const input = item.type === 'select' ? document.createElement('select') : document.createElement('input');
  input.id = `hunt-${item.key}`;
  if (item.type === 'select') item.options.forEach(([value, text]) => input.append(new Option(text, value)));
  else if (item.type === 'number') Object.assign(input, { type: 'number', min: item.min, max: item.max, step: 1 });
  else Object.assign(input, { type: 'text', autocomplete: 'off' });
  input.addEventListener('change', () => {
    huntSettings = CatworldMapHunt.normalizeSettings({ ...huntSettings, [item.key]: input.value });
    showHuntSettings();
    chrome.storage.local.set({ [CatworldMapHunt.SETTINGS_KEY]: huntSettings });
  });
  cell.append(label, input);
  if (item.hint) {
    const hint = document.createElement('div');
    hint.className = 'hint tight';
    hint.textContent = item.hint;
    cell.append(hint);
  }
  const box = huntGroups[item.group].box;
  if (!item.row) { box.append(cell); return; }
  // 同一個 row 的欄位排同一列（例如門檻與指令）
  if (!huntRows[item.row]) {
    huntRows[item.row] = document.createElement('div');
    huntRows[item.row].className = 'hrow';
    box.append(huntRows[item.row]);
  }
  huntRows[item.row].append(cell);
});
showHuntSettings();
// 自動學到的 NPC（finger 找不到的 ID）：只顯示與清除，寫入在遊戲頁的 content.js
async function showHuntNpcs() {
  const list = (await chrome.storage.local.get(CatworldMapHunt.NPCS_KEY))[CatworldMapHunt.NPCS_KEY];
  const ids = Array.isArray(list) ? list.filter(id => typeof id === 'string') : [];
  $('huntNpcs').textContent = ids.length ? `已學到的 NPC（${ids.length}）：${ids.join('、')}` : '已學到的 NPC：尚未學到';
}
$('huntNpcClear').addEventListener('click', async () => {
  await chrome.storage.local.remove(CatworldMapHunt.NPCS_KEY);
  showHuntNpcs();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[CatworldMapHunt.NPCS_KEY]) showHuntNpcs();
});
showHuntNpcs();

// 遊戲頁裡的狀態變了（面板、置頂面板按開始／停止）會通知這裡馬上更新；設定頁開在背景分頁時自己的每秒更新會被降頻，不通知就要切回來才會對
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'STATE_CHANGED' && (!pageTabId || sender.tab?.id === pageTabId)) refreshLive();
});

(async () => {
  const data = await chrome.storage.local.get(['settings', 'idleSettings', 'triggerGroupSettings', 'triggerSettings', 'popupTab', 'persistentAlert', 'zapThresholds', 'mainWeapon', 'zapFeatures', 'equipmentKeep', 'autoReward', CatworldStopKeywords.KEY, CatworldChatReply.SETTINGS_KEY, CatworldChatScript.SETTINGS_KEY, CatworldChatScript.STATE_KEY, 'popupFolds', CatworldShopCollect.MIN_PRICE_KEY, CatworldShopCollect.BUY_NAMES_KEY, CatworldShopCollect.SKIP_NAMES_KEY, CatworldMapHunt.SETTINGS_KEY]);
  huntSettings = CatworldMapHunt.normalizeSettings(data[CatworldMapHunt.SETTINGS_KEY]);
  showHuntSettings();
  $('shopSkipNames').value = typeof data[CatworldShopCollect.SKIP_NAMES_KEY] === 'string' ? data[CatworldShopCollect.SKIP_NAMES_KEY] : CatworldShopCollect.DEFAULT_SKIP_NAMES;
  $('shopBuyNames').value = typeof data[CatworldShopCollect.BUY_NAMES_KEY] === 'string' ? data[CatworldShopCollect.BUY_NAMES_KEY] : CatworldShopCollect.DEFAULT_BUY_NAMES;
  shopMinSilver = CatworldShopCollect.normalizeMinSilver(data[CatworldShopCollect.MIN_PRICE_KEY]);
  $('shopMinPrice').value = shopMinSilver;
  Object.entries(data.popupFolds || {}).forEach(([id, open]) => {
    const box = document.getElementById(id);
    if (box?.tagName === 'DETAILS') box.open = open === true;
  });
  $('whisperColor').value = [...$('whisperColor').options].some(option => option.value === data.whisperColor) ? data.whisperColor : 'orange';
  Object.entries(FEATURE_BOXES).forEach(([key, id]) => { $(id).checked = FEATURE_DEFAULT_ON.has(key) ? data.zapFeatures?.[key] !== false : data.zapFeatures?.[key] === true; });
  $('persistentAlert').checked = data.persistentAlert === true;
  $('autoReward').checked = data.autoReward !== false;
  const stopKeywords = CatworldStopKeywords.normalize(data[CatworldStopKeywords.KEY]);
  $('stopKeywordsOn').checked = stopKeywords.enabled;
  $('stopKeywordsList').value = stopKeywords.words;
  showChatReply(CatworldChatReply.normalizeSettings(data[CatworldChatReply.SETTINGS_KEY]));
  scriptDay = CatworldChatScript.normalizeState(data[CatworldChatScript.STATE_KEY]);
  showChatScript(CatworldChatScript.normalizeSettings(data[CatworldChatScript.SETTINGS_KEY]));
  $('mainWeapon').value = weaponValue(data.mainWeapon);
  equipmentKeep = CatworldZapEquipment.normalizeKeepRule(data.equipmentKeep);
  showEquipmentKeep();
  zapThresholds = CatworldZapMobs.normalizeThresholds(data.zapThresholds);
  showZapThresholds();
  if (data.settings) $('commandDelayMs').value = data.settings.commandDelayMs ?? 500;
  // 舊格式（固定：一行一個 + 共用秒數；隨機：randomCommands + 共用秒數）由 normalizeFixedItems／normalizeRandomItems 轉成每個指令一列；
  // 固定指令從沒設定過時是預設的 ps;px
  renderItems('fixedItems', CatworldTimer.normalizeFixedItems(data.settings));
  renderItems('randomItems', CatworldTimer.normalizeRandomItems(data.settings));
  // 舊版只有一組觸發設定（triggerSettings），升級時整份放進練功
  const savedGroups = Engine.loadGroupSettings(data);
  Object.values(panes).forEach(pane => pane.render(savedGroups[pane.group.id]));
  // 舊版的分頁名稱是 trigger（現在叫練功）
  const lastTab = data.popupTab === 'trigger' ? 'practice' : data.popupTab;
  showTab(panes[lastTab] || ['random', 'idle', 'settings'].includes(lastTab) ? lastTab : 'timer');
  showIdleFields(CatworldTimer.normalizeIdle(data.idleSettings));
  try {
    const status = await send({ type: 'STATUS' });
    setStatus(status?.running ? '執行中' : (status?.stopReason || '已停止'), status?.running ? 'info' : stopLevel(status?.stopReason));
    setRandomStatus(status?.randomRunning ? '執行中' : (status?.stopReason || '已停止'), status?.randomRunning ? 'info' : stopLevel(status?.stopReason));
    setIdleStatus(status?.idle ? (status.idle.phase === 'idling' ? 'Idle 中' : '運作中') : '已停止');
  } catch {
    setStatus('請切到 CatWorld Web 分頁', 'warn');
    setRandomStatus('請切到 CatWorld Web 分頁', 'warn');
    setIdleStatus('請切到 CatWorld Web 分頁', 'warn');
  }
  updateHints();
  refreshLive();
  setInterval(refreshLive, 1000);
})();

// 功能之間的依賴提示：某個功能要靠另一個功能（或某個欄位）才會作用時，在用到它的區塊最上面寫出原因。
// warn（琥珀、「⚠」）＝現在這樣設定不會作用，區塊標題也會標 ⚠ 讓收起來時看得到；info＝只是說明。
// 條件只看畫面上的欄位，改了就即時更新；新增依賴只要加一列（先確認程式裡真的有這個前提）
const isOn = id => $(id).checked;
const blank = id => !$(id).value.trim();
const DEPENDENCIES = [
  { host: 'sec-features', anchor: () => $('whisperColor').closest('label'), warn: () => !isOn('featureWhisper'), text: '密語區塊沒開，顏色用不到。' },
  { host: 'sec-grade', warn: () => !isOn('featureMobs'), text: '「怪物查詢」沒開，面板不會用到怪物分級。' },
  { host: 'sec-weapon', warn: () => !isOn('featureItems'), text: '「無名物品鑑定提示與裝備比較」沒開，這裡的主要武器與屬性門檻用不到。' },
  { host: 'sec-mentor', warn: () => !isOn('featureMasters'), text: '「拜師導師搜尋」沒開，面板沒有「拜師」列可以修改路線；這裡只能管理已經存下來的修改。' },
  { host: 'sec-shop', warn: () => isOn('featureShop') && !isOn('featureItems'), text: '裝備資料庫已啟用，但「無名物品鑑定提示與裝備比較」沒開：面板沒有「讀取目前穿著」，商人的建議只能依等級，沒有現在穿的裝備可比。' },
  { host: 'sec-hunt', warn: () => !isOn('featureHunt'), text: '「地圖巡怪」沒開，面板不會出現「巡怪」列，下面的欄位用不到。' },
  { host: 'sec-script', warn: () => isOn('scriptOn') && blank('scriptPartner'), text: '還沒填對方的英文 ID：A 開不了場、B 認不出對方的來訊，都不會動。' },
  { host: 'sec-script', warn: () => isOn('scriptOn') && !blank('scriptPerDay') && Number($('scriptPerDay').value) === 0, text: '每天最多 0 場：不開場也不接話。' },
  { host: 'sec-script', info: () => isOn('scriptOn'), text: '劇本認領的來訊不會進密語區，也不會觸發聊天回覆；兩台電腦要填同一份試算表連結和互相的英文 ID。' },
  { host: 'sec-stopwords', warn: () => isOn('stopKeywordsOn') && blank('stopKeywordsList'), text: '關鍵字清單是空的，不會命中任何詞。' },
];
const lastHint = new Map();
const hintNodes = DEPENDENCIES.map(dep => {
  const node = element('div', { className: 'hint tight', hidden: true, textContent: `${dep.warn ? '⚠' : 'ℹ'} ${dep.text}` });
  node.dataset.dep = dep.host;
  (lastHint.get(dep.host) || dep.anchor?.() || $(dep.host).querySelector('summary')).after(node);
  lastHint.set(dep.host, node);
  return node;
});
function updateHints() {
  const warned = new Set();
  DEPENDENCIES.forEach((dep, i) => {
    const level = dep.warn?.() ? 'warn' : dep.info?.() ? 'info' : null;
    hintNodes[i].hidden = !level;
    markLevel(hintNodes[i], level);
    if (level === 'warn') warned.add(dep.host);
  });
  new Set(DEPENDENCIES.map(dep => dep.host)).forEach(host => $(host).classList.toggle('has-dep', warned.has(host)));
}
document.addEventListener('change', updateHints);
document.addEventListener('input', updateHints);

// 設定備份：匯出（區塊與機密的清單、格式在 settings-backup.js）
function backupMessage(text, level) { $('backupMsg').textContent = text; markLevel($('backupMsg'), level); }
$('backupBlocks').append(...CatworldSettingsBackup.BLOCKS.map(block => element('label', { style: 'display:block' },
  element('input', { type: 'checkbox', checked: true, id: `backupBlock-${block.id}` }), ` ${block.label}`)));
const BACKUP_KEYS = [...CatworldSettingsBackup.BLOCKS.flatMap(block => block.keys), ...CatworldSettingsBackup.SECRET_KEYS];
const selectedBlocks = () => CatworldSettingsBackup.BLOCKS.filter(block => $(`backupBlock-${block.id}`).checked);
$('backupSecrets').addEventListener('change', () => {
  $('backupSecretWarn').hidden = !$('backupSecrets').checked;
  // 取消勾選時，備援框裡可能還留著含機密的文字，一起收掉
  $('backupFallback').value = '';
  $('backupFallback').hidden = true;
});
async function buildBackup() {
  const blocks = selectedBlocks().map(block => block.id);
  const secrets = $('backupSecrets').checked;
  if (!blocks.length && !secrets) { backupMessage('請至少勾選一個區塊', 'warn'); return null; }
  try {
    const store = await chrome.storage.local.get(BACKUP_KEYS);
    return CatworldSettingsBackup.exportText(store, { blocks, secrets, version: chrome.runtime.getManifest().version });
  } catch (e) { backupMessage(`讀取設定失敗：${e.message}`, 'error'); return null; }
}
const backupSummary = () => `${selectedBlocks().length} 個區塊${$('backupSecrets').checked ? '（含機密）' : ''}`;
// 複製與下載共用：先收起備援框、取文字；做完報告，失敗就把文字放進可手動複製的框
async function runBackup(done, failed, action) {
  $('backupFallback').hidden = true;
  const text = await buildBackup();
  if (text === null) return;
  try {
    await action(text);
    backupMessage(`${done} ${backupSummary()}`, $('backupSecrets').checked ? 'warn' : undefined);
  } catch (e) {
    $('backupFallback').value = text;
    $('backupFallback').hidden = false;
    backupMessage(`${failed}：${e.message}，請從下面的框手動複製`, 'error');
  }
}
$('backupCopy').addEventListener('click', () => runBackup('已複製', '複製失敗', text => navigator.clipboard.writeText(text)));
$('backupDownload').addEventListener('click', () => runBackup('已下載', '下載失敗', text => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = element('a', { href: url, download: `catworld-settings-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}));

// 設定備份：匯入。整份檢查通過才顯示「將覆蓋哪些區塊」，玩家確認後先存備份再寫；寫完把設定頁停用（頁上的欄位是舊值，
// 不重新開啟的話，改任何一個欄位都會把舊值存回去，蓋掉剛匯入的）
let pendingImport = null;
function importMessage(text, level) { $('backupImportMsg').textContent = text; markLevel($('backupImportMsg'), level); }
function hideImportPlan() { pendingImport = null; $('backupImportPlan').hidden = true; }
function showImportPlan(result) {
  pendingImport = result;
  const labels = Object.fromEntries(CatworldSettingsBackup.BLOCKS.map(block => [block.id, block.label]));
  $('backupImportBlocks').replaceChildren(...result.blocks.map(id => element('label', { style: 'display:block' },
    element('input', { type: 'checkbox', checked: true, id: `backupImportBlock-${id}` }), ` ${labels[id]}`)));
  $('backupImportSecrets').checked = false;
  $('backupImportSecretsRow').hidden = !result.hasSecrets;
  $('backupImportPlan').hidden = false;
}
function checkImportText() {
  hideImportPlan();
  const text = $('backupImportText').value;
  if (!text.trim()) { importMessage(''); return; }
  const result = CatworldSettingsBackup.checkImport(text);
  if (!result.ok) { importMessage(result.error, 'error'); return; }
  importMessage(`檢查通過：${result.blocks.length} 個區塊${result.hasSecrets ? '，另含機密' : ''}（${result.exportedWith ? `版本 ${result.exportedWith}` : '版本不明'}匯出）`, undefined);
  showImportPlan(result);
}
$('backupImportText').addEventListener('input', checkImportText);
function clearImport() {
  hideImportPlan();
  $('backupImportText').value = '';
  $('backupImportFile').value = '';
}
$('backupImportFile').addEventListener('change', () => {
  const file = $('backupImportFile').files?.[0];
  if (!file) { clearImport(); importMessage(''); return; } // 清掉選擇＝上一份檢查結果也作廢
  const reader = new FileReader();
  reader.onload = () => { $('backupImportText').value = String(reader.result ?? ''); checkImportText(); };
  reader.onerror = () => { hideImportPlan(); importMessage('讀不到這個檔案', 'error'); };
  reader.readAsText(file);
});
$('backupImportCancel').addEventListener('click', () => { clearImport(); importMessage(''); });
// 匯入成功後把整個設定頁停用：頁上的欄位是舊值，再改任何一個都會把舊值存回去，蓋掉剛匯入的；要重新開啟設定頁才會讀到新的
let settingsFrozen = false;
function freezeSettingsPage() {
  settingsFrozen = true;
  document.querySelectorAll('input, select, textarea, button').forEach(control => { control.disabled = true; });
}
// 匯入與還原結束後一樣：清掉輸入、說明、把設定頁停用
function finishFrozen(text) {
  clearImport();
  importMessage(`${text}。這個設定頁已停用：請重新整理遊戲分頁，並把設定頁關掉再重新開啟`);
  freezeSettingsPage();
}
async function writePlan(plan) {
  if (Object.keys(plan.set).length) await chrome.storage.local.set(plan.set);
  if (plan.remove.length) await chrome.storage.local.remove(plan.remove);
}
// 「還原上一份」只在有備份時可按；備份壞掉也讓它按得下去，按了才說明哪裡壞
async function refreshRestore() {
  try {
    const stored = await chrome.storage.local.get(['settingsBackup']);
    $('backupRestore').disabled = settingsFrozen || !('settingsBackup' in stored);
  } catch { $('backupRestore').disabled = true; }
}
// 匯入寫到一半失敗：寫過東西就用新備份放回去，放得回去才把舊備份放回；放不回去就留著新備份（它才是回頭的路）。
// touched 只在 set 成功後才為真：chrome.storage.local.set 是整批一起成功或失敗，失敗代表什麼都沒寫進去
async function undoImport(backup, previousBackup, touched) {
  try {
    if (touched) await writePlan(CatworldSettingsBackup.planRestore(backup));
  } catch { return '設定可能只套用了一部分，可以按「還原上一份」回到匯入前'; }
  try {
    if (previousBackup === undefined) await chrome.storage.local.remove('settingsBackup');
    else await chrome.storage.local.set({ settingsBackup: previousBackup });
  } catch { return '設定沒有變動，但原本的備份沒能放回去（「還原上一份」會回到這次匯入前）'; }
  return '設定沒有變動，原本的備份保留';
}
$('backupImportApply').addEventListener('click', async () => {
  const pending = pendingImport; // 同步取下按確認當下檢查過的那一份，之後只用它
  if (!pending) return;
  const ids = [...$('backupImportBlocks').querySelectorAll('input:checked')].map(box => box.id.replace('backupImportBlock-', ''));
  const secrets = pending.hasSecrets && $('backupImportSecrets').checked;
  if (!ids.length && !secrets) { importMessage('請至少勾選一個區塊', 'warn'); return; }
  $('backupImportApply').disabled = true;
  $('backupRestore').disabled = true; // 匯入進行中不能同時還原
  try {
    const current = await chrome.storage.local.get([...BACKUP_KEYS, 'settingsBackup']);
    if (pendingImport !== pending) { importMessage('等待期間文字被改了，請重新檢查再匯入', 'warn'); return; }
    const plan = CatworldSettingsBackup.planImport(current, pending.data, { blocks: ids, secrets });
    const unchanged = !plan.remove.length && Object.entries(plan.set).every(([key, value]) => JSON.stringify(value) === JSON.stringify(current[key]));
    if (unchanged) { importMessage('檔案的內容和現在一樣，沒有任何變動（舊的備份沒有動）'); return; }
    const backup = CatworldSettingsBackup.makeBackup(current, plan);
    try {
      await chrome.storage.local.set({ settingsBackup: backup }); // 先備份，備份寫不進去就不匯入
    } catch (e) { importMessage(`備份寫不進去，沒有匯入：${e.message}`, 'error'); return; }
    let touched = false;
    try {
      if (Object.keys(plan.set).length) { await chrome.storage.local.set(plan.set); touched = true; }
      if (plan.remove.length) await chrome.storage.local.remove(plan.remove);
    } catch (e) {
      importMessage(`匯入失敗：${e.message}。${await undoImport(backup, current.settingsBackup, touched)}`, 'error');
      return;
    }
    finishFrozen(`已匯入 ${plan.blocks.length + (plan.secrets ? 1 : 0)} 個區塊${plan.secrets ? '（含機密）' : ''}`);
  } catch (e) {
    importMessage(`匯入失敗：${e.message}`, 'error');
  } finally {
    if (!settingsFrozen && !$('backupImportPlan').hidden) $('backupImportApply').disabled = false;
    refreshRestore();
  }
});

$('backupRestore').addEventListener('click', async () => {
  $('backupRestore').disabled = true;
  $('backupImportApply').disabled = true; // 還原進行中不能同時匯入
  try {
    const { settingsBackup } = await chrome.storage.local.get(['settingsBackup']);
    const checked = CatworldSettingsBackup.checkBackup(settingsBackup);
    if (!checked.ok) { importMessage(`備份壞了，什麼都沒有動：${checked.error}`, 'error'); return; }
    if (!confirm(`要把 ${checked.keys} 個設定項目還原成匯入前的樣子（備份時間 ${checked.at || '不明'}）嗎？匯入之後的更動會被取代。`)) return;
    await writePlan(CatworldSettingsBackup.planRestore(checked.backup));
    finishFrozen('已還原成匯入前的樣子（備份保留）');
  } catch (e) {
    importMessage(`還原失敗：${e.message}。設定可能只套用了一部分，可以再按一次「還原上一份」`, 'error');
  } finally {
    if (!settingsFrozen && !$('backupImportPlan').hidden) $('backupImportApply').disabled = false;
    refreshRestore();
  }
});
refreshRestore();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settingsBackup) refreshRestore();
  if (changes.stopReason?.newValue) setStatus(changes.stopReason.newValue, stopLevel(changes.stopReason.newValue));
  else if (changes.running) setStatus(changes.running.newValue ? '執行中' : '已停止');
});

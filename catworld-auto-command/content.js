(() => {
if (globalThis.__catworldAutoCommandInstalled) return;
globalThis.__catworldAutoCommandInstalled = true;
let running = false;
let loopTimer = null;
let queueTimer = null;
let randomTimer = null;
const queue = [];
let lastSentAt = 0;
let stopReason = '';
let nextRunAt = null;
let nextRandomAt = null;
let nextRandomCommand = null;
// 狀態觸發與定時循環各有獨立開關；驗證碼偵測、看門狗、送出佇列在任一個開著時都要作用
// 觸發有兩組（戰鬥、練功），各有自己的規則、開關、引擎與計時器，功能完全一樣
const triggerGroups = Object.fromEntries(CatworldTriggerEngine.GROUPS.map(({ id, name }) =>
  [id, { id, name, on: false, timer: null, engine: null, config: null, note: '' }]));
const groupList = Object.values(triggerGroups);
const anyTriggerOn = () => groupList.some(group => group.on);
// 遊戲巨集（含 @等待）正在執行的清單；執行中算「在跑」，驗證碼偵測與看門狗才會作用
const macroRuns = new Set();
let macroNote = null;
function active() { return running || anyTriggerOn() || macroRuns.size > 0; }
const captchaPattern = /請輸入上(?:方|面)的數字/g;
function hasCaptchaText(text) { return /請輸入上(?:方|面)的數字/.test(text || ''); }
let captchaCount = 0;
const NO_REPLY_MS = 8000;
const REPEAT_BEEP_MS = 10 * 1000;
const REPEAT_BEEP_MAX_MS = 5 * 60 * 1000;
// popup 的開關「警報提示音一直響，按確認才停」，預設關閉；存在 storage，改了馬上生效
let persistentAlert = false;
let watchdogTimer = null;
let lastCommand = '';
const BLOCK = '█';
const NOISE_MARK = '\u0001';
// 新增節點轉成可逐行判斷的文字：以背景色（B1~B7）空白 span 拼成的圖沒有可見字元，
// 改用實心方塊代表，才能和 @ $ 等符號圖用同一套規則偵測
function artText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (node.tagName === 'BR') return '\n';
  const text = node.textContent || '';
  if (!node.children.length && /\bB\d\b/.test(node.getAttribute('class') || '') && /^[ \n]+$/.test(text) && text.includes(' ')) {
    return text.replace(/ /g, BLOCK);
  }
  if (!node.children.length && /\bB\d\b/.test(node.getAttribute('class') || '') && text.trim()) {
    return NOISE_MARK + text;
  }
  const inner = Array.from(node.childNodes, artText).join('');
  return /^(DIV|P|PRE)$/.test(node.tagName) && !inner.endsWith('\n') ? `${inner}\n` : inner;
}
// 驗證碼是多行「只含同一種符號（@ $ # █ 等）與空白」的圖，不依賴提示文字；
// 圖可能與前一段回覆接在同一批文字，所以逐行找連續的同符號行（空白行不中斷）
function looksLikeAsciiArt(text) {
  let run = 0;
  let symbol = '';
  for (const line of (text || '').split('\n')) {
    const chars = line.replace(/\s/g, '');
    if (!chars) continue;
    const match = new RegExp(`^([@$#%&*${BLOCK}])\\1*$`).exec(chars);
    if (!match) { run = 0; continue; }
    run = match[1] === symbol ? run + 1 : 1;
    symbol = match[1];
    if (run >= 5) return true;
  }
  return false;
}
// 另一種驗證碼：一大塊隨機英數字亂碼，其中少數字元以背景色（B1 等）標出，沒有提示文字；
// 連續 8 行以上只含英數字與空白的長行，且帶背景色標記的字元至少 8 個
// （背景色 span 內容是空白時已轉成 █，同樣算標記）
function looksLikeNoiseCaptcha(text) {
  let run = 0;
  let marks = 0;
  for (const line of (text || '').split('\n')) {
    if (!line.trim()) continue;
    if (line.length >= 30 && new RegExp(`^[A-Za-z0-9 ${NOISE_MARK}${BLOCK}]+$`).test(line)) {
      run += 1;
      marks += (line.match(new RegExp(`[${NOISE_MARK}${BLOCK}]`, 'g')) || []).length;
      if (run >= 8 && marks >= 8) return true;
    } else {
      run = 0;
      marks = 0;
    }
  }
  return false;
}
// 自動停止時提醒使用者：系統通知（由 background 建立）、提示音、分頁標題閃爍
let titleTimer = null;
let repeatBeepTimer = null;
// 回傳是否真的發聲；頁面尚無使用者互動時，瀏覽器的自動播放限制會讓 AudioContext 停在 suspended
async function beep() {
  const ctx = new AudioContext();
  await Promise.race([ctx.resume(), new Promise(resolve => setTimeout(resolve, 200))]);
  if (ctx.state !== 'running') {
    ctx.close();
    return false;
  }
  [0, 0.3, 0.6].forEach(offset => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.2;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime + offset);
    osc.stop(ctx.currentTime + offset + 0.2);
  });
  setTimeout(() => ctx.close(), 1500);
  return true;
}
// 首響之後每 REPEAT_BEEP_MS 再響一次。
// 開關「一直響到確認」關閉（預設，原本的行為）：最多持續 REPEAT_BEEP_MAX_MS，使用者回到頁面互動或按「開始」就停；
// 開啟：沒有時間上限、點頁面或按「開始」都不會停，只有按「確認」（面板標題列或系統通知上的按鈕）才會停
function startRepeatBeep(untilConfirm) {
  const startedAt = Date.now();
  repeatBeepTimer = setInterval(() => {
    if (!untilConfirm && Date.now() - startedAt >= REPEAT_BEEP_MAX_MS) stopRepeatBeep();
    else beep();
  }, REPEAT_BEEP_MS);
}
function stopRepeatBeep() {
  clearInterval(repeatBeepTimer);
  repeatBeepTimer = null;
}
// untilConfirm：驗證碼警報的閃爍要一直閃到按「確認」；一般的提醒（例如規則被停用）使用者回到頁面互動就停
let stopFlash = null;
function flashTitle(text, untilConfirm = false) {
  if (titleTimer) {
    if (!untilConfirm) return;
    stopFlash();
  }
  const original = document.title;
  let on = false;
  titleTimer = setInterval(() => {
    on = !on;
    document.title = on ? text : original;
  }, 800);
  const clear = () => {
    clearInterval(titleTimer);
    titleTimer = null;
    stopFlash = null;
    // 原本的行為：使用者回到頁面互動，提示音也跟著停；「一直響到確認」開著（ringing）時不停
    if (!ringing) stopRepeatBeep();
    document.title = original;
    ['focus', 'pointerdown', 'keydown'].forEach(name => window.removeEventListener(name, clear));
    document.removeEventListener('visibilitychange', onVisible);
  };
  const onVisible = () => { if (!document.hidden) clear(); };
  stopFlash = clear;
  if (!untilConfirm) {
    ['focus', 'pointerdown', 'keydown'].forEach(name => window.addEventListener(name, clear));
    document.addEventListener('visibilitychange', onVisible);
  }
}
// 驗證碼警報響鈴中（提示音與標題閃爍都還沒被「確認」）
let ringing = false;
function confirmAlert() {
  stopRepeatBeep();
  if (stopFlash) stopFlash();
  ringing = false;
  renderPanel();
}
function stopAndAlert(reason) {
  stopRepeatBeep();
  beep();
  startRepeatBeep(persistentAlert);
  flashTitle('⚠ 需要驗證', persistentAlert);
  ringing = persistentAlert;
  chrome.runtime.sendMessage({ type: 'ALERT', reason, confirmable: persistentAlert });
  return stopEverything(reason);
}
// 只有某條觸發規則被停用：響一次、閃標題、跳通知，其他功能照常；原因文字不含「驗證」，不會被當成驗證碼停止
function alertOnly(reason) {
  beep();
  flashTitle('⚠ 觸發已停用');
  chrome.runtime.sendMessage({ type: 'ALERT', reason });
}
// 指令送出後遊戲通常會回覆；超時沒新輸出視為需要驗證
function armWatchdog() {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (active()) stopAndAlert(`送出指令後 ${NO_REPLY_MS / 1000} 秒沒有收到遊戲回應，疑似需要驗證，已停止；請完成驗證後再按開始`);
  }, NO_REPLY_MS);
}
function isCommandEcho(text) {
  return text.replace(/^[>\s]+/, '').trim() === lastCommand;
}
function countCaptcha() {
  const text = document.body?.textContent || '';
  return (text.match(captchaPattern) || []).length;
}
function checkCaptcha() {
  const count = countCaptcha();
  if (active() && count > captchaCount) {
    stopAndAlert('偵測到「請輸入上面的數字／請輸入上方的數字」，已停止；請完成驗證後再按開始');
    return true;
  }
  captchaCount = count;
  return false;
}
// 遊戲頁的浮動視窗（狀態 #monitor、地圖 #map_table、巨集、設定）會一直重畫，不是遊戲回覆，
// 不能拿來清掉看門狗、當驗證碼內容，也不能當關鍵字來源
function closestOf(node, selector) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(element?.closest(selector));
}
const inGameWindow = node => closestOf(node, '#monitor, #map_table, #macro_table, #setting_table');
const inContent = node => closestOf(node, '#content');
// 關鍵字觸發只看遊戲輸出區（#content）裡「新出現」的文字
function feedKeywords(records) {
  const text = records
    .filter(record => inContent(record.target))
    .flatMap(record => (record.type === 'characterData'
      ? [record.target.textContent || '']
      : Array.from(record.addedNodes, node => node.textContent || '')))
    .join('');
  if (text.trim()) groupList.forEach(group => { if (group.on) group.engine.onText(text); });
}
const captchaObserver = new MutationObserver(allRecords => {
  if (!active()) return;
  const records = allRecords.filter(record => !inGameWindow(record.target));
  if (!records.length) return;
  const addedTexts = records.flatMap(record => record.type === 'characterData'
    ? [record.target.textContent || '']
    : Array.from(record.addedNodes, artText));
  if (addedTexts.some(text => text.trim() && !isCommandEcho(text.trim()))) {
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  }
  const addedText = addedTexts.join('');
  if (looksLikeAsciiArt(addedText) || looksLikeNoiseCaptcha(addedText)) {
    stopAndAlert('偵測到驗證碼圖形，已停止；請完成驗證後再按開始');
    return;
  }
  const addedPrompt = records.some(record => {
    if (record.type === 'characterData') {
      return hasCaptchaText(record.target.textContent) &&
        !hasCaptchaText(record.oldValue);
    }
    return Array.from(record.addedNodes).some(node =>
      hasCaptchaText(node.textContent));
  });
  if (addedPrompt) stopAndAlert('偵測到「請輸入上面的數字／請輸入上方的數字」，已停止；請完成驗證後再按開始');
  else checkCaptcha();
  // 驗證碼檢查放在前面：同一批含驗證碼時上面已經停止（各組觸發都變 off），不會再比對關鍵字或送指令
  if (anyTriggerOn()) feedKeywords(records);
});
captchaObserver.observe(document.body, {
  subtree: true, childList: true, characterData: true, characterDataOldValue: true
});
let settings = {
  commands: ['ps', 'px'],
  minSeconds: 30,
  maxSeconds: 40,
  commandDelayMs: 500
  // randomItems 不放預設值：沒有這個欄位時，normalizeRandomItems 才會去讀舊格式（randomCommands），
  // 預設成空陣列會蓋掉升級前存下的隨機指令
};
const randomItems = () => CatworldTimer.normalizeRandomItems(settings);

function sendCommand(command) {
  if (checkCaptcha()) return { ok: false, error: stopReason };
  if (/驗證/.test(stopReason)) return { ok: false, error: stopReason };
  const input = document.querySelector('#input');
  if (!input || !input.form) {
    return { ok: false, error: '找不到 CatWorld 指令輸入框 #input' };
  }
  const typed = input.value;
  const selection = [input.selectionStart, input.selectionEnd];
  input.focus();
  input.value = command;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.form.requestSubmit();
  // 遊戲送出後會清空輸入框或全選剛送出的指令，把使用者原本正在輸入的文字還回去
  if (typed) {
    input.value = typed;
    input.setSelectionRange(selection[0], selection[1]);
  }
  lastCommand = command.trim();
  if (active()) armWatchdog();
  return { ok: true };
}

function clearTimers() {
  nextRunAt = null;
  nextRandomAt = null;
  nextRandomCommand = null;
  if (loopTimer) clearTimeout(loopTimer);
  if (queueTimer) clearTimeout(queueTimer);
  if (randomTimer) clearTimeout(randomTimer);
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = null;
  loopTimer = null;
  queueTimer = null;
  randomTimer = null;
  dropQueue('timer');
  // 上面清掉了送出佇列的計時器；佇列裡若還有觸發的指令，要重新排程
  pumpQueue();
}

function scheduleNextRound() {
  if (!running) return;
  const min = Math.max(1, Number(settings.minSeconds) || 30);
  const max = Math.max(min, Number(settings.maxSeconds) || min);
  const delay = (min + Math.random() * (max - min)) * 1000;
  loopTimer = setTimeout(runRound, delay);
  nextRunAt = Date.now() + delay;
  chrome.storage.local.set({ nextRunAt });
}

// 固定、隨機兩條循環與狀態觸發共用同一個送出佇列，任兩次送出至少間隔 commandDelayMs；
// 每個項目記下來源，停掉定時時只丟掉定時的項目，不影響還在跑的觸發
function enqueue(command, source = 'timer', run = null) {
  queue.push({ command, source, run });
  pumpQueue();
}

function dropQueue(source) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].source === source) queue.splice(i, 1);
  }
}

function pumpQueue() {
  if (queueTimer || !queue.length) return;
  const gap = Math.max(0, Number(settings.commandDelayMs) || 0);
  const wait = Math.max(0, lastSentAt + gap - Date.now());
  queueTimer = setTimeout(() => {
    queueTimer = null;
    if (!active() || checkCaptcha()) return;
    const entry = queue.shift();
    const result = sendCommand(entry.command);
    if (!result.ok) { stopEverything(result.error); return; }
    lastSentAt = Date.now();
    if (entry.run) {
      entry.run.pending -= 1;
      finishMacroIfDone(entry.run);
    }
    pumpQueue();
  }, wait);
}

function runRound() {
  if (!running) return;
  nextRunAt = null;
  chrome.storage.local.set({ nextRunAt: null });
  settings.commands.filter(cmd => cmd.trim()).forEach(cmd => enqueue(cmd));
  scheduleNextRound();
}

// 隨機指令：先均勻隨機挑一個，再在「它自己的」最短～最長秒數之間隨機等一段時間，到時間才送出，然後再挑下一個
function scheduleRandomCommand() {
  if (!running) return;
  const item = CatworldTimer.pickRandomItem(randomItems());
  if (!item) return;
  const delay = CatworldTimer.delayMs(item);
  randomTimer = setTimeout(() => runRandomCommand(item.command), delay);
  nextRandomAt = Date.now() + delay;
  nextRandomCommand = item.command;
}

function runRandomCommand(command) {
  if (!running) return;
  enqueue(command);
  scheduleRandomCommand();
}

// 開始任何一個功能前：停掉重複提示音（「一直響到確認」響鈴中除外，那只有「確認」能停）、清掉上一次的停止原因；沒有任何功能在跑時，
// 以目前畫面上的驗證碼數量當基準，歷史紀錄裡的提示不會被當成新的
function armDetection() {
  if (!ringing) stopRepeatBeep();
  if (!active()) {
    captchaObserver.takeRecords();
    captchaCount = countCaptcha();
  }
  stopReason = '';
}

async function start(newSettings) {
  clearTimers();
  settings = { ...settings, ...newSettings };
  armDetection();
  running = true;
  await chrome.storage.local.set({ running: true, settings, nextRunAt: null, stopReason: '' });
  if (settings.commands.length) runRound();
  scheduleRandomCommand();
  renderPanel();
}

async function stop(reason = '已停止') {
  stopReason = reason;
  running = false;
  clearTimers();
  renderPanel();
  await chrome.storage.local.set({ running: false, nextRunAt: null, stopReason });
}

// 狀態觸發：每秒讀一次 #monitor 的數值交給規則引擎判斷，要送的指令走共用佇列
function readStat(name) {
  const ids = CatworldTriggerEngine.STATS[name];
  if (!ids) return null;
  const read = id => {
    const element = document.getElementById(id);
    return element ? Number(element.textContent.replace(/[,\s]/g, '')) : NaN;
  };
  const value = read(ids.cur);
  return Number.isFinite(value) ? { value, max: read(ids.max) } : null;
}
function readAllStats() {
  return Object.fromEntries(Object.keys(CatworldTriggerEngine.STATS).map(name => [name, readStat(name)]));
}
// 角色狀態（#status）是「正常」才回 true；讀不到回 null，引擎一律當作不能觸發
function isStatusNormal() {
  const element = document.getElementById('status');
  return element ? element.textContent.trim() === '正常' : null;
}

// 兩組觸發各自獨立；送出佇列的來源記成 trigger:<組>，停掉某一組只丟掉那一組還沒送的指令
async function startTriggers(group, config) {
  if (!CatworldTriggerEngine.hasActiveRules(config)) {
    group.note = '沒有可用的觸發規則（項目、門檻、指令都要填）';
    renderPanel();
    return { ok: false, error: group.note };
  }
  stopTriggers(group, '');
  armDetection();
  group.config = config;
  group.note = '';
  group.engine = CatworldTriggerEngine.createEngine(config, {
    now: () => Date.now(),
    readStat,
    isNormal: isStatusNormal,
    send: commands => commands.forEach(command => enqueue(command, `trigger:${group.id}`)),
    onDisable: (index, label, reason) => alertOnly(`${group.name}觸發規則「${label}」已停用：${reason}`),
  });
  group.on = true;
  await saveGroupConfig(group.id, config);
  group.engine.tick();
  group.timer = setInterval(() => group.engine.tick(), 1000);
  renderPanel();
  return { ok: true };
}

// 兩組的設定存在同一個 storage key，各寫各的那一組，不覆蓋另一組
async function saveGroupConfig(id, config) {
  const { triggerGroupSettings } = await chrome.storage.local.get('triggerGroupSettings');
  await chrome.storage.local.set({ triggerGroupSettings: { ...triggerGroupSettings, [id]: config } });
}

function stopTriggers(group, note = '已停止') {
  group.on = false;
  clearInterval(group.timer);
  group.timer = null;
  dropQueue(`trigger:${group.id}`);
  group.note = note;
  renderPanel();
}

// 驗證碼或送出失敗：定時與兩組觸發、巨集一起停
function stopEverything(reason) {
  groupList.forEach(group => stopTriggers(group));
  cancelMacros();
  return stop(reason);
}

// 遊戲巨集的 @等待：按下有等待的巨集鍵時，在遊戲處理之前攔下來，自己照順序執行。
// 指令走同一個送出佇列（遵守指令間隔、驗證碼偵測、看門狗），等待時不擋住其他功能，別的來源的指令可以插進來。
// 一個巨集的「執行」要到最後一個指令真的送出才算結束（active() 才不會在最後一個指令還在排隊時就變成 false）
function startMacro(text) {
  const parsed = CatworldMacro.parseSteps(text);
  if (parsed.error) {
    macroNote = { text: `巨集沒有執行：${parsed.error}`, until: Date.now() + 8000 };
    renderPanel();
    return;
  }
  armDetection();
  macroNote = null;
  const run = { steps: parsed.steps, index: 0, pending: 0, timer: null, waitUntil: null, nextCommand: null };
  macroRuns.add(run);
  advanceMacro(run);
  renderPanel();
}

function advanceMacro(run) {
  run.timer = null;
  run.waitUntil = null;
  while (run.index < run.steps.length) {
    const step = run.steps[run.index++];
    if (step.wait) {
      const ms = CatworldMacro.waitMs(step.wait);
      run.waitUntil = Date.now() + ms;
      run.nextCommand = run.steps.slice(run.index).find(next => next.command !== undefined)?.command ?? null;
      run.timer = setTimeout(() => advanceMacro(run), ms);
      return;
    }
    run.pending += 1;
    enqueue(step.command, 'macro', run);
  }
  finishMacroIfDone(run);
}

function finishMacroIfDone(run) {
  if (run.index >= run.steps.length && run.pending === 0 && !run.timer) macroRuns.delete(run);
}

function cancelMacros() {
  macroRuns.forEach(run => clearTimeout(run.timer));
  macroRuns.clear();
  dropQueue('macro');
}

// 捕獲階段（比遊戲掛在 body 上的處理早）：條件和遊戲一樣，只在焦點在指令輸入框或 body 時處理；
// 沒有等待的巨集、不是巨集的按鍵一律不碰，交給遊戲
window.addEventListener('keydown', event => {
  if (event.target !== document.querySelector('#input') && event.target !== document.body) return;
  const value = CatworldMacro.keyValue(event);
  if (!value) return;
  const command = CatworldMacro.findMacroCommand(document, value);
  if (!command || !CatworldMacro.hasWait(command)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.repeat) startMacro(command);
}, true);

// 浮動狀態面板：放在 shadow DOM 並掛在 <html> 下，頁面層級的 MutationObserver 與 body.textContent 都看不到它，
// 面板更新文字不會被誤當成遊戲輸出或驗證碼提示
const PANEL_UI_KEY = 'panelUi';
let panel = null;
function initPanel() {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .panel { width: 310px; background: rgba(28,28,30,.93); color: #eee; border-radius: 12px;
        font: 16px/1.5 system-ui, -apple-system, "Microsoft JhengHei", sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,.4); user-select: none; }
      .head { display: flex; align-items: center; gap: 10px; padding: 9px 12px; cursor: move; }
      .dot { width: 12px; height: 12px; border-radius: 50%; background: #777; flex: none; }
      .dot.on { background: #3ecf6e; }
      .dot.alert { background: #ff5c4d; }
      .label { flex: 1; font-weight: 600; white-space: nowrap; }
      .toggle, .gear { all: unset; cursor: pointer; padding: 0 6px; color: #aaa; font-size: 20px; line-height: 1; }
      .confirm { all: unset; cursor: pointer; padding: 2px 12px; border-radius: 6px; background: #d9382c; color: #fff; font-size: 14px; font-weight: 700; }
      .confirm:hover { background: #ef4a3d; }
      .confirm[hidden] { display: none; }
      .gear { font-size: 18px; }
      .gear:hover, .toggle:hover { color: #fff; }
      .body { padding: 0 12px 12px; }
      .line { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; }
      .line .t { font-weight: 600; min-width: 40px; padding-top: 3px; }
      .line .s { flex: 1; min-width: 0; color: #bbb; font-size: 15px; overflow-wrap: anywhere; white-space: pre-line; padding-top: 4px; }
      .line .s.alert { color: #ff8a7a; }
      .mini { display: flex; gap: 6px; flex: none; }
      .mini button { all: unset; text-align: center; padding: 3px 12px; border-radius: 6px;
        background: #3a3a3e; cursor: pointer; font-size: 14px; font-weight: 600; }
      .mini button.start, .mini button.tstart { background: #2f7d4a; }
      .mini button[disabled] { opacity: .35; cursor: default; }
      .line[hidden] { display: none; }
      .collapsed .body { display: none; }
    </style>
    <div class="panel">
      <div class="head"><span class="dot"></span><span class="label"></span><button class="confirm" hidden title="停止提示音與標題閃爍">確認</button><button class="gear" title="開啟／關閉設定頁">⚙</button><button class="toggle" title="收合／展開">–</button></div>
      <div class="body">
        <div class="line"><span class="t">定時</span><span class="s timer-text"></span>
          <span class="mini"><button class="start">開始</button><button class="stop">停止</button></span></div>
        ${groupList.map(group => `<div class="line" data-group="${group.id}"><span class="t">${group.name}</span><span class="s trigger-text"></span>
          <span class="mini"><button class="tstart">開始</button><button class="tstop">停止</button></span></div>`).join('\n        ')}
        <div class="line macro-line" hidden><span class="t">巨集</span><span class="s macro-text"></span>
          <span class="mini"><button class="mstop">停止</button></span></div>
      </div>
    </div>`;
  const $ = selector => root.querySelector(selector);
  panel = {
    box: $('.panel'), dot: $('.dot'), label: $('.label'),
    timerText: $('.timer-text'),
    groups: Object.fromEntries(groupList.map(group => {
      const row = $(`[data-group="${group.id}"]`);
      return [group.id, { text: row.querySelector('.trigger-text'), start: row.querySelector('.tstart'), stop: row.querySelector('.tstop') }];
    })),
    start: $('.start'), stop: $('.stop'),
    macroLine: $('.macro-line'), macroText: $('.macro-text'), mstop: $('.mstop'),
    confirm: $('.confirm'),
  };
  // 「怪物」列：讀 #exp 列出適合打的怪、怪物出現時顯示資訊（資料由 background 提供）
  CatworldZapPanel.attach(root, { readExp: () => Number((document.getElementById('exp')?.textContent || '').replace(/[,\s]/g, '')) });

  // 點面板不要讓遊戲輸入框失去游標
  root.addEventListener('mousedown', e => e.preventDefault());
  panel.start.addEventListener('click', () => {
    if (running) return;
    if (!settings.commands.length && !randomItems().length) {
      stop('尚未設定指令，請先在 popup 設定');
      return;
    }
    start(settings);
  });
  panel.stop.addEventListener('click', () => { if (running) stop(); });
  groupList.forEach(group => {
    const row = panel.groups[group.id];
    row.start.addEventListener('click', () => {
      if (group.on) return;
      if (!group.config) {
        group.note = '尚未設定觸發規則，請先在 popup 設定';
        renderPanel();
        return;
      }
      startTriggers(group, group.config);
    });
    row.stop.addEventListener('click', () => { if (group.on) stopTriggers(group); });
  });
  panel.mstop.addEventListener('click', () => { cancelMacros(); renderPanel(); });
  panel.confirm.addEventListener('click', confirmAlert);
  // ⚙：交給背景腳本在新分頁開啟設定頁，再按一次關閉
  $('.gear').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'TOGGLE_SETTINGS' }));

  const saveUi = ui => chrome.storage.local.set({ [PANEL_UI_KEY]: { ...ui } });
  const ui = { left: null, top: null, collapsed: false };
  // 依面板目前的實際大小夾在可視範圍內（收合後尺寸會變）
  const place = (left, top) => {
    const { width, height } = host.getBoundingClientRect();
    const maxLeft = Math.max(0, (document.documentElement.clientWidth || window.innerWidth) - width);
    const maxTop = Math.max(0, (document.documentElement.clientHeight || window.innerHeight) - height);
    host.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
    host.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
    host.style.right = 'auto';
  };
  const replace = () => {
    if (ui.left !== null && ui.top !== null) place(ui.left, ui.top);
  };
  panel.replace = replace;
  // 遊戲自己的浮動視窗（地圖、狀態、巨集、設定）是玩家拖到哪就固定在哪，沒打開時是 visibility:hidden 但仍佔位置。
  // 使用者沒有自己拖過面板時，只避開「現在看得見、而且在畫面內」的視窗：先試預設位置，
  // 重疊就排到它們下方，放不下再排到左邊，都放不下才留在原位
  panel.avoidMap = () => {
    if (ui.left !== null && ui.top !== null) return;
    const viewW = document.documentElement.clientWidth || window.innerWidth;
    const viewH = document.documentElement.clientHeight || window.innerHeight;
    const { width, height } = host.getBoundingClientRect();
    const MARGIN = 12;
    const visible = ['map_table', 'monitor', 'macro_table', 'setting_table']
      .map(id => document.getElementById(id))
      .filter(el => el && getComputedStyle(el).visibility === 'visible')
      .map(el => el.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0 && r.right > 0 && r.left < viewW && r.bottom > 0 && r.top < viewH);
    const hits = (right, top) => visible.filter(r =>
      r.left < viewW - right && r.right > viewW - right - width && r.top < top + height && r.bottom > top);
    let right = MARGIN;
    let top = MARGIN;
    if (hits(right, top).length) {
      for (let guard = 0; guard <= visible.length; guard++) {
        const hit = hits(right, top);
        if (!hit.length) break;
        top = Math.ceil(Math.max(...hit.map(r => r.bottom))) + 8;
      }
      if (top + height > viewH - MARGIN) {
        top = MARGIN;
        const leftmost = Math.min(...hits(right, top).map(r => r.left));
        const candidate = viewW - leftmost + 8;
        if (viewW - candidate - width >= 0 && !hits(candidate, top).length) right = candidate;
      }
    }
    host.style.top = `${top}px`;
    host.style.right = `${right}px`;
  };
  window.addEventListener('resize', () => { replace(); panel.avoidMap(); });
  $('.toggle').addEventListener('click', () => {
    ui.collapsed = !ui.collapsed;
    panel.box.classList.toggle('collapsed', ui.collapsed);
    $('.toggle').textContent = ui.collapsed ? '+' : '–';
    replace();
    saveUi(ui);
  });
  $('.head').addEventListener('pointerdown', e => {
    if (e.target.closest('.toggle, .gear, .confirm')) return;
    const rect = host.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    const move = ev => place(ev.clientX - offsetX, ev.clientY - offsetY);
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      const moved = host.getBoundingClientRect();
      ui.left = moved.left;
      ui.top = moved.top;
      saveUi(ui);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });

  chrome.storage.local.get(PANEL_UI_KEY).then(data => {
    Object.assign(ui, data[PANEL_UI_KEY]);
    if (ui.left !== null && ui.top !== null) place(ui.left, ui.top);
    panel.box.classList.toggle('collapsed', ui.collapsed);
    $('.toggle').textContent = ui.collapsed ? '+' : '–';
  });

  document.documentElement.append(host);
  setInterval(renderPanel, 1000);
  renderPanel();
}

function triggerSummary(group) {
  if (!group.on) return { text: group.note || '未啟動', alert: false, disabled: 0 };
  const rules = group.engine.snapshot().rules.filter(rule => rule.phase !== 'off');
  const disabled = rules.filter(rule => rule.phase === 'disabled');
  if (disabled.length) return { text: `「${disabled[0].label}」${disabled[0].text}`, alert: true, disabled: disabled.length };
  // 命中後等待延遲的規則：每條一行，顯示還有幾秒、要執行哪些指令
  const pending = rules.filter(rule => rule.pendingSeconds !== null);
  if (pending.length) {
    return { text: pending.map(rule => `${rule.label} → ${rule.pendingSeconds} 秒後：${rule.commands.join(' → ')}`).join('\n'), alert: false, disabled: 0 };
  }
  const waiting = rules.find(rule => rule.phase === 'waiting');
  if (waiting) return { text: `${waiting.label} → ${waiting.text}`, alert: false, disabled: 0 };
  return { text: `${rules.length} 條待命`, alert: false, disabled: 0 };
}

// 巨集列：有巨集在跑就顯示「還有幾秒、下一個指令」，格式錯誤沒有執行時顯示原因 8 秒；都沒有就整列隱藏
function macroSummary() {
  if (!macroRuns.size) {
    if (macroNote && Date.now() < macroNote.until) return { text: macroNote.text, alert: true };
    macroNote = null;
    return null;
  }
  const run = [...macroRuns][0];
  const more = macroRuns.size > 1 ? `（共 ${macroRuns.size} 個巨集）` : '';
  if (run.waitUntil) {
    const left = Math.max(0, Math.ceil((run.waitUntil - Date.now()) / 1000));
    return { text: `等待 ${left} 秒後${run.nextCommand === null ? '結束' : `：${run.nextCommand}`}${more}`, alert: false };
  }
  return { text: `送出中…${more}`, alert: false };
}

function renderPanel() {
  if (!panel) return;
  const captchaStopped = !active() && /驗證/.test(stopReason);
  const summaries = groupList.map(group => triggerSummary(group));
  const anyAlert = summaries.some(summary => summary.alert);
  const disabledTotal = summaries.reduce((total, summary) => total + summary.disabled, 0);
  panel.dot.className = `dot ${anyAlert || captchaStopped ? 'alert' : active() ? 'on' : ''}`;
  const label = anyAlert ? `觸發已停用 ${disabledTotal} 條` : active() ? '執行中' : '已停止';
  panel.label.textContent = ringing ? `${label}・響鈴中` : label;
  panel.confirm.hidden = !ringing;
  let timerText = stopReason || '未啟動';
  if (running) {
    // 倒數與「到時候要執行哪些指令」：固定指令一輪依序送出，隨機指令是被挑中的那一個
    const left = at => `${Math.max(0, Math.ceil((at - Date.now()) / 1000))} 秒後`;
    const fixed = settings.commands.map(command => command.trim()).filter(Boolean);
    const lines = [];
    if (fixed.length) lines.push(nextRunAt ? `固定 ${left(nextRunAt)}：${fixed.join(' → ')}` : '固定 送出中…');
    if (nextRandomAt) lines.push(`隨機 ${left(nextRandomAt)}：${nextRandomCommand}`);
    timerText = lines.join('\n') || '執行中';
  }
  let changed = panel.timerText.textContent !== timerText;
  panel.timerText.textContent = timerText;
  groupList.forEach((group, index) => {
    const row = panel.groups[group.id];
    if (row.text.textContent !== summaries[index].text) changed = true;
    row.text.textContent = summaries[index].text;
    row.text.classList.toggle('alert', summaries[index].alert);
    row.start.disabled = group.on;
    row.stop.disabled = !group.on;
  });
  if (changed) panel.replace();
  const macro = macroSummary();
  panel.macroLine.hidden = !macro;
  if (macro && panel.macroText.textContent !== macro.text) {
    panel.macroText.textContent = macro.text;
    panel.replace();
  }
  panel.macroText.classList.toggle('alert', Boolean(macro?.alert));
  panel.mstop.disabled = !macroRuns.size;
  panel.avoidMap();
  panel.timerText.classList.toggle('alert', captchaStopped);
  panel.start.disabled = running;
  panel.stop.disabled = !running;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START') {
    start(message.settings).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'STOP') {
    stop().then(() => sendResponse({ ok: true }));
    return true;
  }
  // 觸發相關的訊息都要帶 group（combat／practice）
  const group = triggerGroups[message.group];
  if (message.type === 'START_TRIGGER') {
    if (!group) { sendResponse({ ok: false, error: '未知的觸發組' }); return; }
    startTriggers(group, message.config).then(sendResponse);
    return true;
  }
  if (message.type === 'STOP_TRIGGER') {
    if (group) stopTriggers(group);
    sendResponse({ ok: Boolean(group) });
  }
  if (message.type === 'REARM_RULE') {
    if (group?.engine) group.engine.rearm(message.index);
    renderPanel();
    sendResponse({ ok: Boolean(group) });
  }
  if (message.type === 'CONFIRM_ALERT') {
    confirmAlert();
    sendResponse({ ok: true });
  }
  if (message.type === 'STATUS') {
    sendResponse({
      running,
      ringing,
      settings,
      stopReason,
      nextRunAt,
      nextRandomAt,
      nextRandomCommand,
      macros: macroRuns.size,
      stats: readAllStats(),
      triggerGroups: Object.fromEntries(groupList.map(item => [item.id, { on: item.on, note: item.note, rules: item.on ? item.engine.snapshot().rules : [] }])),
    });
  }
  if (message.type === 'TEST') {
    sendResponse(sendCommand(message.command || 'ps'));
  }
  if (message.type === 'TEST_BEEP') {
    beep().then(played => sendResponse({ played }));
    return true;
  }
});

// popup 改了「一直響到確認」開關，不用重新整理遊戲頁就生效
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.persistentAlert) persistentAlert = changes.persistentAlert.newValue === true;
});

chrome.storage.local.get(['running', 'settings', 'triggerGroupSettings', 'triggerSettings', 'persistentAlert']).then(data => {
  persistentAlert = data.persistentAlert === true;
  if (data.settings) settings = { ...settings, ...data.settings };
  // 規則設定會留著，但開關不會：重新整理遊戲頁後觸發不會自己恢復。舊版只有一組設定，升級時放進練功
  const savedGroups = CatworldTriggerEngine.loadGroupSettings(data);
  groupList.forEach(item => { item.config = savedGroups[item.id]; });
  // Safety choice: a page reload does not silently resume automation.
  running = false;
  if (data.running) chrome.storage.local.set({ running: false, nextRunAt: null, stopReason });
  renderPanel();
});

initPanel();

})();

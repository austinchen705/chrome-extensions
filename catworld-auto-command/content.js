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
const captchaPattern = /請輸入上(?:方|面)的數字/g;
function hasCaptchaText(text) { return /請輸入上(?:方|面)的數字/.test(text || ''); }
let captchaCount = 0;
const NO_REPLY_MS = 8000;
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
function flashTitle(text) {
  if (titleTimer) return;
  const original = document.title;
  let on = false;
  titleTimer = setInterval(() => {
    on = !on;
    document.title = on ? text : original;
  }, 800);
  const clear = () => {
    clearInterval(titleTimer);
    titleTimer = null;
    document.title = original;
    ['focus', 'pointerdown', 'keydown'].forEach(name => window.removeEventListener(name, clear));
    document.removeEventListener('visibilitychange', onVisible);
  };
  const onVisible = () => { if (!document.hidden) clear(); };
  ['focus', 'pointerdown', 'keydown'].forEach(name => window.addEventListener(name, clear));
  document.addEventListener('visibilitychange', onVisible);
}
function stopAndAlert(reason) {
  beep();
  flashTitle('⚠ 需要驗證');
  chrome.runtime.sendMessage({ type: 'ALERT', reason });
  return stop(reason);
}
// 指令送出後遊戲通常會回覆；超時沒新輸出視為需要驗證
function armWatchdog() {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (running) stopAndAlert(`送出指令後 ${NO_REPLY_MS / 1000} 秒沒有收到遊戲回應，疑似需要驗證，已停止；請完成驗證後再按開始`);
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
  if (running && count > captchaCount) {
    stopAndAlert('偵測到「請輸入上面的數字／請輸入上方的數字」，已停止；請完成驗證後再按開始');
    return true;
  }
  captchaCount = count;
  return false;
}
const captchaObserver = new MutationObserver(records => {
  if (!running) return;
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
});
captchaObserver.observe(document.body, {
  subtree: true, childList: true, characterData: true, characterDataOldValue: true
});
let settings = {
  commands: ['ps', 'px'],
  minSeconds: 30,
  maxSeconds: 40,
  commandDelayMs: 500,
  randomCommands: [],
  randomMinSeconds: 30,
  randomMaxSeconds: 40
};

function sendCommand(command) {
  if (checkCaptcha()) return { ok: false, error: stopReason };
  if (/驗證/.test(stopReason)) return { ok: false, error: stopReason };
  const input = document.querySelector('#input');
  if (!input || !input.form) {
    return { ok: false, error: '找不到 CatWorld 指令輸入框 #input' };
  }
  input.focus();
  input.value = command;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.form.requestSubmit();
  lastCommand = command.trim();
  if (running) armWatchdog();
  return { ok: true };
}

function clearTimers() {
  if (loopTimer) clearTimeout(loopTimer);
  if (queueTimer) clearTimeout(queueTimer);
  if (randomTimer) clearTimeout(randomTimer);
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = null;
  loopTimer = null;
  queueTimer = null;
  randomTimer = null;
  queue.length = 0;
}

function scheduleNextRound() {
  if (!running) return;
  const min = Math.max(1, Number(settings.minSeconds) || 30);
  const max = Math.max(min, Number(settings.maxSeconds) || min);
  const delay = (min + Math.random() * (max - min)) * 1000;
  loopTimer = setTimeout(runRound, delay);
  chrome.storage.local.set({ nextRunAt: Date.now() + delay });
}

// 固定與隨機兩條循環共用同一個送出佇列，任兩次送出至少間隔 commandDelayMs
function enqueue(command) {
  queue.push(command);
  pumpQueue();
}

function pumpQueue() {
  if (queueTimer || !queue.length) return;
  const gap = Math.max(0, Number(settings.commandDelayMs) || 0);
  const wait = Math.max(0, lastSentAt + gap - Date.now());
  queueTimer = setTimeout(() => {
    queueTimer = null;
    if (!running || checkCaptcha()) return;
    const result = sendCommand(queue.shift());
    if (!result.ok) { stop(result.error); return; }
    lastSentAt = Date.now();
    pumpQueue();
  }, wait);
}

function runRound() {
  if (!running) return;
  chrome.storage.local.set({ nextRunAt: null });
  settings.commands.filter(cmd => cmd.trim()).forEach(enqueue);
  scheduleNextRound();
}

function scheduleRandomCommand() {
  if (!running) return;
  const min = Math.max(1, Number(settings.randomMinSeconds) || 30);
  const max = Math.max(min, Number(settings.randomMaxSeconds) || min);
  randomTimer = setTimeout(runRandomCommand, (min + Math.random() * (max - min)) * 1000);
}

function runRandomCommand() {
  if (!running) return;
  const pool = settings.randomCommands;
  enqueue(pool[Math.floor(Math.random() * pool.length)]);
  scheduleRandomCommand();
}

async function start(newSettings) {
  clearTimers();
  settings = { ...settings, ...newSettings };
  captchaObserver.takeRecords();
  captchaCount = countCaptcha();
  stopReason = '';
  running = true;
  await chrome.storage.local.set({ running: true, settings, nextRunAt: null, stopReason: '' });
  if (settings.commands.length) runRound();
  if (settings.randomCommands.length) scheduleRandomCommand();
}

async function stop(reason = '已停止') {
  stopReason = reason;
  running = false;
  clearTimers();
  await chrome.storage.local.set({ running: false, nextRunAt: null, stopReason });
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
  if (message.type === 'STATUS') {
    sendResponse({ running, settings, stopReason });
  }
  if (message.type === 'TEST') {
    sendResponse(sendCommand(message.command || 'ps'));
  }
  if (message.type === 'TEST_BEEP') {
    beep().then(played => sendResponse({ played }));
    return true;
  }
});

chrome.storage.local.get(['running', 'settings']).then(data => {
  if (data.settings) settings = { ...settings, ...data.settings };
  // Safety choice: a page reload does not silently resume automation.
  running = false;
  if (data.running) chrome.storage.local.set({ running: false, nextRunAt: null, stopReason });
});

})();

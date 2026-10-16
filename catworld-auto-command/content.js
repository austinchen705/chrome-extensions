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
// 狀態觸發與定時循環各有獨立開關；驗證碼偵測、看門狗、送出佇列在任一個開著時都要作用
let triggersOn = false;
let triggerTimer = null;
let triggerEngine = null;
let triggerConfig = null;
let triggerNote = '';
function active() { return running || triggersOn; }
const captchaPattern = /請輸入上(?:方|面)的數字/g;
function hasCaptchaText(text) { return /請輸入上(?:方|面)的數字/.test(text || ''); }
let captchaCount = 0;
const NO_REPLY_MS = 8000;
const REPEAT_BEEP_MS = 10 * 1000;
const REPEAT_BEEP_MAX_MS = 5 * 60 * 1000;
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
// 首響之後每 REPEAT_BEEP_MS 再響一次，最久持續 REPEAT_BEEP_MAX_MS，直到使用者回到頁面互動或重新開始
function startRepeatBeep() {
  const startedAt = Date.now();
  repeatBeepTimer = setInterval(() => {
    if (Date.now() - startedAt >= REPEAT_BEEP_MAX_MS) stopRepeatBeep();
    else beep();
  }, REPEAT_BEEP_MS);
}
function stopRepeatBeep() {
  clearInterval(repeatBeepTimer);
  repeatBeepTimer = null;
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
    stopRepeatBeep();
    document.title = original;
    ['focus', 'pointerdown', 'keydown'].forEach(name => window.removeEventListener(name, clear));
    document.removeEventListener('visibilitychange', onVisible);
  };
  const onVisible = () => { if (!document.hidden) clear(); };
  ['focus', 'pointerdown', 'keydown'].forEach(name => window.addEventListener(name, clear));
  document.addEventListener('visibilitychange', onVisible);
}
function stopAndAlert(reason) {
  stopRepeatBeep();
  beep();
  startRepeatBeep();
  flashTitle('⚠ 需要驗證');
  chrome.runtime.sendMessage({ type: 'ALERT', reason });
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
// 遊戲頁的即時狀態區塊（#monitor）會一直更新數值，不是遊戲回覆，不能拿來清掉看門狗或當驗證碼內容
function inMonitor(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(element?.closest('#monitor'));
}
const captchaObserver = new MutationObserver(allRecords => {
  if (!active()) return;
  const records = allRecords.filter(record => !inMonitor(record.target));
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
  if (active()) armWatchdog();
  return { ok: true };
}

function clearTimers() {
  nextRunAt = null;
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
function enqueue(command, source = 'timer') {
  queue.push({ command, source });
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
    const result = sendCommand(queue.shift().command);
    if (!result.ok) { stopEverything(result.error); return; }
    lastSentAt = Date.now();
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

// 開始任何一個功能前：停掉重複提示音、清掉上一次的停止原因；兩個功能都還沒在跑時，
// 以目前畫面上的驗證碼數量當基準，歷史紀錄裡的提示不會被當成新的
function armDetection() {
  stopRepeatBeep();
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
  if (settings.randomCommands.length) scheduleRandomCommand();
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

async function startTriggers(config) {
  if (!CatworldTriggerEngine.hasActiveRules(config)) {
    triggerNote = '沒有可用的觸發規則（項目、門檻、指令都要填）';
    renderPanel();
    return { ok: false, error: triggerNote };
  }
  stopTriggers('');
  armDetection();
  triggerConfig = config;
  triggerNote = '';
  triggerEngine = CatworldTriggerEngine.createEngine(config, {
    now: () => Date.now(),
    readStat,
    isNormal: isStatusNormal,
    send: commands => commands.forEach(command => enqueue(command, 'trigger')),
    onDisable: (index, label, reason) => alertOnly(`觸發規則「${label}」已停用：${reason}`),
  });
  triggersOn = true;
  await chrome.storage.local.set({ triggerSettings: config });
  triggerEngine.tick();
  triggerTimer = setInterval(() => triggerEngine.tick(), 1000);
  renderPanel();
  return { ok: true };
}

function stopTriggers(note = '已停止') {
  triggersOn = false;
  clearInterval(triggerTimer);
  triggerTimer = null;
  dropQueue('trigger');
  triggerNote = note;
  renderPanel();
}

// 驗證碼或送出失敗：定時與觸發一起停
function stopEverything(reason) {
  stopTriggers();
  return stop(reason);
}

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
      .toggle { all: unset; cursor: pointer; padding: 0 6px; color: #aaa; font-size: 20px; line-height: 1; }
      .body { padding: 0 12px 12px; }
      .line { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; }
      .line .t { font-weight: 600; min-width: 40px; padding-top: 3px; }
      .line .s { flex: 1; min-width: 0; color: #bbb; font-size: 15px; overflow-wrap: anywhere; padding-top: 4px; }
      .line .s.alert { color: #ff8a7a; }
      .mini { display: flex; gap: 6px; flex: none; }
      .mini button { all: unset; text-align: center; padding: 3px 12px; border-radius: 6px;
        background: #3a3a3e; cursor: pointer; font-size: 14px; font-weight: 600; }
      .mini button.start, .mini button.tstart { background: #2f7d4a; }
      .mini button[disabled] { opacity: .35; cursor: default; }
      .collapsed .body { display: none; }
    </style>
    <div class="panel">
      <div class="head"><span class="dot"></span><span class="label"></span><button class="toggle" title="收合／展開">–</button></div>
      <div class="body">
        <div class="line"><span class="t">定時</span><span class="s timer-text"></span>
          <span class="mini"><button class="start">開始</button><button class="stop">停止</button></span></div>
        <div class="line"><span class="t">觸發</span><span class="s trigger-text"></span>
          <span class="mini"><button class="tstart">開始</button><button class="tstop">停止</button></span></div>
      </div>
    </div>`;
  const $ = selector => root.querySelector(selector);
  panel = {
    box: $('.panel'), dot: $('.dot'), label: $('.label'),
    timerText: $('.timer-text'), triggerText: $('.trigger-text'),
    start: $('.start'), stop: $('.stop'), tstart: $('.tstart'), tstop: $('.tstop'),
  };

  // 點面板不要讓遊戲輸入框失去游標
  root.addEventListener('mousedown', e => e.preventDefault());
  panel.start.addEventListener('click', () => {
    if (running) return;
    if (!settings.commands.length && !settings.randomCommands.length) {
      stop('尚未設定指令，請先在 popup 設定');
      return;
    }
    start(settings);
  });
  panel.stop.addEventListener('click', () => { if (running) stop(); });
  panel.tstart.addEventListener('click', () => {
    if (triggersOn) return;
    if (!triggerConfig) {
      triggerNote = '尚未設定觸發規則，請先在 popup 設定';
      renderPanel();
      return;
    }
    startTriggers(triggerConfig);
  });
  panel.tstop.addEventListener('click', () => { if (triggersOn) stopTriggers(); });

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
    if (e.target.closest('.toggle')) return;
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

function triggerSummary() {
  if (!triggersOn) return { text: triggerNote || '未啟動', alert: false, disabled: 0 };
  const rules = triggerEngine.snapshot().rules.filter(rule => rule.phase !== 'off');
  const disabled = rules.filter(rule => rule.phase === 'disabled');
  if (disabled.length) return { text: `「${disabled[0].label}」${disabled[0].text}`, alert: true, disabled: disabled.length };
  const waiting = rules.find(rule => rule.phase === 'waiting');
  if (waiting) return { text: `${waiting.label} → ${waiting.text}`, alert: false, disabled: 0 };
  return { text: `${rules.length} 條待命`, alert: false, disabled: 0 };
}

function renderPanel() {
  if (!panel) return;
  const captchaStopped = !active() && /驗證/.test(stopReason);
  const trigger = triggerSummary();
  panel.dot.className = `dot ${trigger.alert || captchaStopped ? 'alert' : active() ? 'on' : ''}`;
  panel.label.textContent = trigger.alert ? `觸發已停用 ${trigger.disabled} 條` : active() ? '執行中' : '已停止';
  let timerText = stopReason || '未啟動';
  if (running) {
    timerText = nextRunAt ? `下一輪：${Math.max(0, Math.ceil((nextRunAt - Date.now()) / 1000))} 秒後` : '指令送出中…';
  }
  if (panel.timerText.textContent !== timerText || panel.triggerText.textContent !== trigger.text) {
    panel.timerText.textContent = timerText;
    panel.triggerText.textContent = trigger.text;
    panel.replace();
  }
  panel.avoidMap();
  panel.timerText.classList.toggle('alert', captchaStopped);
  panel.triggerText.classList.toggle('alert', trigger.alert);
  panel.start.disabled = running;
  panel.stop.disabled = !running;
  panel.tstart.disabled = triggersOn;
  panel.tstop.disabled = !triggersOn;
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
  if (message.type === 'START_TRIGGER') {
    startTriggers(message.config).then(sendResponse);
    return true;
  }
  if (message.type === 'STOP_TRIGGER') {
    stopTriggers();
    sendResponse({ ok: true });
  }
  if (message.type === 'REARM_RULE') {
    if (triggerEngine) triggerEngine.rearm(message.index);
    renderPanel();
    sendResponse({ ok: true });
  }
  if (message.type === 'STATUS') {
    sendResponse({
      running,
      settings,
      stopReason,
      triggers: { on: triggersOn, note: triggerNote, rules: triggersOn ? triggerEngine.snapshot().rules : [], stats: readAllStats() },
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

chrome.storage.local.get(['running', 'settings', 'triggerSettings']).then(data => {
  if (data.settings) settings = { ...settings, ...data.settings };
  // 規則設定會留著，但開關不會：重新整理遊戲頁後觸發不會自己恢復
  if (data.triggerSettings) triggerConfig = data.triggerSettings;
  // Safety choice: a page reload does not silently resume automation.
  running = false;
  if (data.running) chrome.storage.local.set({ running: false, nextRunAt: null, stopReason });
  renderPanel();
});

initPanel();

})();

(() => {
if (globalThis.__catworldAutoCommandInstalled) return;
globalThis.__catworldAutoCommandInstalled = true;
let running = false;
// 隨機指令獨立於定時（固定指令）：各自開始、停止
let randomRunning = false;
// idle（全域暫停）：idleState 是 { phase: 'idling' | 'working', at, timer }，idlePaused 在 idle 中為 true；
// idle 中定時、隨機、兩組觸發都不送指令，結束後自動繼續
let idleState = null;
let idlePaused = false;
let idleSettings = null;
let queueTimer = null;
let randomTimer = null;
const queue = [];
let lastSentAt = 0;
let stopReason = '';
// 固定指令每一項各自循環：{ item, timer, at }，at 是下一次送出的時間
let fixedRuns = [];
let nextRandomAt = null;
let nextRandomCommand = null;
// 狀態觸發與定時循環各有獨立開關；看門狗、送出佇列、關鍵字在任一個開著時都要作用；驗證碼偵測與自動辨識閒置時也作用
// 觸發有兩組（戰鬥、練功），各有自己的規則、開關、引擎與計時器，功能完全一樣
const triggerGroups = Object.fromEntries(CatworldTriggerEngine.GROUPS.map(({ id, name }) =>
  [id, { id, name, on: false, timer: null, engine: null, config: null, note: '' }]));
const groupList = Object.values(triggerGroups);
const anyTriggerOn = () => groupList.some(group => group.on);
// 遊戲巨集（含 @等待）正在執行的清單；執行中算「在跑」，驗證碼偵測與看門狗才會作用
const macroRuns = new Set();
let macroNote = null;
// 地圖巡怪（map-hunt.js）：在 startMacro 之後建立；執行中算 active()
let hunt = null;
// 設定頁開在背景分頁時自己的每秒更新會被 Chrome 降頻，所以任何功能開始或停止（面板、置頂面板裡按的也算）就主動通知它
let panelHost = null;
// 擴充功能重新載入後留在頁面上的舊程式（chrome.runtime.id 失效）：停掉所有計時器與送出、拿掉面板與置頂視窗，
// 不然它會繼續送指令、留著一個不同步的面板，設定頁備援注入的新程式也會和它重複送
let retired = false;
function retire() {
  if (retired) return;
  retired = true;
  running = false;
  randomRunning = false;
  cancelIdle({ resume: false });
  clearTimers();
  groupList.forEach(group => stopTriggers(group, ''));
  hunt?.stop('');
  cancelMacros();
  cancelChatReplies();
  cancelScript();
  queue.length = 0;
  if (watchdogTimer) clearTimeout(watchdogTimer);
  cancelReward();
  captchaObserver.disconnect();
  presenceObserver?.disconnect();
  stopRepeatBeep();
  try {
    globalThis.documentPictureInPicture?.window?.close();
  } catch {
    // 沒有置頂視窗
  }
  panelHost?.remove();
}
let lastStateKey = null;
function notifyStateChanged() {
  try {
    chrome.runtime.sendMessage({ type: 'STATE_CHANGED' }).catch(() => {});
  } catch {
    // 擴充功能剛重新載入，這個頁面的連線已失效
  }
}
function active() { return running || randomRunning || anyTriggerOn() || macroRuns.size > 0 || (hunt?.on() ?? false); }

// 在線獎勵：看到「在線獎勵： N分鐘後可領取」（自己打 sc 的輸出）就排一個 N+1 分鐘後的計時，已經排著的就不再排；時間到先下 sc，隔 REWARD_AFTER_SC_MS 的隨機時間才下 reward。
// 閒置時也作用（不走送出佇列，佇列只在 active() 時送）；開關是設定頁的 autoReward（缺值＝開）。
// 送不出去（驗證碼辨識中、因驗證停止）隔 REWARD_RETRY_MS 再試，最多 REWARD_TRIES 次，之後放棄；等的期間（含 sc 之後等 reward 的那段）rewardTimer 一直有值，所以再打 sc 也不會重複排
const REWARD_PATTERN = /在線獎勵[：:]\s*(\d+)\s*分鐘後可領取/;
const REWARD_RETRY_MS = 10000;
const REWARD_TRIES = 3;
const REWARD_AFTER_SC_MS = [5000, 10000]; // 時間到先下 sc，隔這個範圍的隨機時間才下 reward
let autoReward = true;
let rewardTimer = null;
// 面板「獎勵」那一行的資料：at＝預定送出的時間，retry＝正在第幾次重試（兩者都沒有就不顯示）
let rewardView = null;
function cancelReward() {
  clearTimeout(scTimer);
  scTimer = null;
  clearTimeout(rewardTimer);
  rewardTimer = null;
  rewardView = null;
}
function watchReward(text) {
  if (!autoReward || rewardTimer) return;
  const match = REWARD_PATTERN.exec(text);
  if (!match) return;
  const wait = (Number(match[1]) + 1) * 60 * 1000;
  rewardTimer = setTimeout(() => rewardDue(1), wait);
  rewardView = { at: Date.now() + wait };
  renderPanel();
}
// 倒數到了：先下 sc，隨機 REWARD_AFTER_SC_MS 後才下 reward（sc 的回應若還寫著幾分鐘，因為 rewardTimer 有值，不會再排第二個）；sc 送不出去的重試規則和 reward 一樣
function rewardDue(attempt) {
  rewardTimer = null;
  rewardView = null;
  if (retired) return;
  const result = sendCommand('sc');
  if (result.ok) {
    lastScAt = Date.now();
    const gap = Math.round(REWARD_AFTER_SC_MS[0] + (REWARD_AFTER_SC_MS[1] - REWARD_AFTER_SC_MS[0]) * Math.random());
    rewardTimer = setTimeout(() => sendReward(1), gap);
    rewardView = { at: Date.now() + gap };
  } else if (attempt >= REWARD_TRIES) {
    console.info('[catworld] 在線獎勵：sc 送不出去，放棄', result.error);
  } else {
    rewardTimer = setTimeout(() => rewardDue(attempt + 1), REWARD_RETRY_MS);
    rewardView = { retry: attempt + 1 };
  }
  renderPanel();
}
function sendReward(attempt) {
  rewardTimer = null;
  rewardView = null;
  if (retired) return;
  const result = sendCommand('reward');
  if (result.ok) scheduleSc(SC_AFTER_REWARD_MS);
  if (!result.ok) {
    if (attempt >= REWARD_TRIES) console.info('[catworld] 在線獎勵：reward 送不出去，放棄', result.error);
    else {
      rewardTimer = setTimeout(() => sendReward(attempt + 1), REWARD_RETRY_MS);
      rewardView = { retry: attempt + 1 };
    }
  }
  renderPanel();
}
// 自動下 sc 取得下一次獎勵倒數（不是人觸發）：領完獎（送出 reward）後等 SC_AFTER_REWARD_MS，驗證碼還在處理就每 SC_RECHECK_MS 再看一次（最多 SC_MAX_TRIES 次）；
// 開始定時或隨機時若還沒有倒數也下一次。只在「在線獎勵自動領取」開著時；SC_MIN_GAP_MS 內不重複下，已經有倒數排程就不下
const SC_AFTER_REWARD_MS = 20000;
const SC_RECHECK_MS = 10000;
const SC_MAX_TRIES = 12;
const SC_MIN_GAP_MS = 30000;
let scTimer = null;
let lastScAt = -Infinity;
function scheduleSc(delay, tries = 0) {
  clearTimeout(scTimer);
  scTimer = setTimeout(() => {
    scTimer = null;
    if (retired || !autoReward) return;
    if (captcha || checkCaptcha()) {
      if (tries < SC_MAX_TRIES) scheduleSc(SC_RECHECK_MS, tries + 1);
      return;
    }
    if (!rewardTimer) sendCommand('sc');
    lastScAt = Date.now();
  }, delay);
}
// 開始定時／隨機時：沒有倒數、最近也沒下過 sc 才下一次，走送出佇列（遵守指令間隔）
function requestScAtStart(owner) {
  if (!autoReward || rewardTimer || scTimer || Date.now() - lastScAt < SC_MIN_GAP_MS) return;
  lastScAt = Date.now();
  queueCommand('sc', owner);
}
function rewardSummary() {
  if (!rewardView) return '';
  if (rewardView.retry) return `領獎指令送不出去，重試中（第 ${rewardView.retry} 次）`;
  const seconds = Math.max(0, Math.ceil((rewardView.at - Date.now()) / 1000));
  return `在線獎勵 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 後自動領取`;
}
// 提示要在行首才算：收集表裡 259 筆真正的提示都在行首，「> 請輸入上面的數字」是有人把提示文字當指令送進遊戲的回聲，不是遊戲出的題
const captchaPattern = /(?:^|\n)[ \t]*請輸入上(?:方|面)的數字/g;
function hasCaptchaText(text) { return /(?:^|\n)[ \t]*請輸入上(?:方|面)的數字/.test(text || ''); }
let captchaCount = 0;
const NO_REPLY_MS = 8000;
const REPEAT_BEEP_MS = 10 * 1000;
const REPEAT_BEEP_MAX_MS = 5 * 60 * 1000;
// popup 的開關「警報提示音一直響，按確認才停」，預設關閉；存在 storage，改了馬上生效
let persistentAlert = false;
// 停止關鍵字（設定頁，缺值＝開、清單 jrealm）：遊戲輸出含清單裡的詞就停掉所有功能並警報；同一個命中後 STOP_KEYWORD_COOLDOWN_MS 內不重複
let stopKeywords = CatworldStopKeywords.normalize(undefined);
let lastStopKeywordAt = -Infinity;
// 輸出常分批到、也會在行中間換行：和驗證碼偵測一樣把最近幾秒的新增文字接起來比對，比對時忽略空白與換行
const stopKeywordWatcher = CatworldStopKeywords.createWatcher();
const STOP_KEYWORD_COOLDOWN_MS = 10000;
// 聊天回覆：別人對我說的話與我的回覆配成一筆筆存進 chatPairs（一律記錄，不受自動回覆開關影響）。
// 自動回覆（設定 chatReply，預設關）：別人對我說的話和資料集裡某句夠相似，就隨機等幾秒後送 reply 加我以前的回覆；
// 走 startMacro（巨集在跑算 active()，閒置時也送得出去）。等待中的回覆記在 chatTimers，關掉開關、停止一切（含驗證碼）、retire 都會取消
const chatTimers = new Map(); // 計時器 → 限流的票（取消時額度還回去）
const cancelChatReplies = () => {
  chatTimers.forEach((ticket, timer) => {
    clearTimeout(timer);
    chatLimiter.refund(ticket);
  });
  chatTimers.clear();
};
let chatReply = CatworldChatReply.normalizeSettings(undefined);
const chatLimiter = CatworldChatReply.createLimiter();
// 置頂浮窗的「密語」區塊（whisper-block.js），initPanel 建立；有人私聊就先交給它顯示，再看要不要自動回覆
let whisperBlock = null;
const onIncomingChat = info => {
  console.log('[catworld] 密語：收到私聊', info.name);
  try {
    whisperBlock?.add(info);
  } catch (error) {
    console.error('[catworld] 密語區塊更新失敗', error);
  }
  return answerChat(info);
};
const chatRecorder = CatworldChatReply.createRecorder({ onIncoming: onIncomingChat, isOwn: chatLimiter.isOwn, claim: hearScript });
let chatSave = Promise.resolve();
async function answerChat({ name, text }) {
  if (!chatReply.enabled || !CatworldChatReply.worthAnswering(text)) return;
  try {
    const stored = (await chrome.storage.local.get(CatworldChatReply.KEY))[CatworldChatReply.KEY];
    const hit = CatworldChatReply.bestReply(Array.isArray(stored) ? stored : [], text, chatReply.threshold);
    const ticket = hit && chatLimiter.take(name, text, chatReply);
    if (!ticket) return;
    const timer = setTimeout(() => {
      chatTimers.delete(timer);
      // 驗證碼辨識中、或因驗證停止：這句回覆過時了，不送
      if (captcha || /驗證/.test(stopReason) || !startMacro(`reply ${hit.reply}`, 'chat')) {
        chatLimiter.refund(ticket);
        return;
      }
      chatLimiter.confirm(ticket);
      chatLimiter.noteSent(hit.reply);
    }, CatworldChatReply.replyDelayMs(chatReply));
    chatTimers.set(timer, ticket);
  } catch {
    // 連不上儲存（孤兒程式）：這次不回
  }
}
function recordChat(pairs) {
  if (!pairs.length) return;
  chatSave = chatSave.then(async () => {
    const stored = (await chrome.storage.local.get(CatworldChatReply.KEY))[CatworldChatReply.KEY];
    let all = Array.isArray(stored) ? stored : [];
    pairs.forEach(pair => { all = CatworldChatReply.addPair(all, pair); });
    await chrome.storage.local.set({ [CatworldChatReply.KEY]: all });
  }).catch(() => {}); // 連不上儲存（孤兒程式）就是沒記到
}
// 輸出分批到、行要收到換行才算完整；最後一行如果沒有換行，等 CHAT_QUIET_MS 沒有新輸出就當完整的一行（不然最後一句私聊要等下一批輸出才出現）
const CHAT_QUIET_MS = 1500;
let chatQuietTimer = null;
const feedChat = text => {
  recordChat(chatRecorder.feed(text));
  clearTimeout(chatQuietTimer);
  chatQuietTimer = setTimeout(() => recordChat(chatRecorder.flush()), CHAT_QUIET_MS);
};
// 劇本對話（chat-script.js，設定 chatScript，預設關）：A 按「現在開一場」先說第一輪，B 看到對方傳來的 tell 像某份劇本的第一輪就接話，之後一人一輪。
// 劇本由 background 回（共用加內建），這裡快取 SCRIPT_CACHE_MS；每一輪用 tell 送出，走 startMacro（來源 script，算 active()、遵守指令間隔、
// 驗證碼與停止一切會取消）。聊天記錄器先問 hearScript：被劇本認領的來訊不記成資料、不進密語區、不觸發自動回覆；
// 送出的台詞登記在 chatLimiter.noteSent，遊戲回印的「你告訴…」行才會被認成自己送的（不配成我的回覆）。
let chatScript = CatworldChatScript.normalizeSettings(undefined);
let scriptCache = { scripts: [], at: 0 };
let scriptLoading = null;
let scriptSession = null;
let scriptWaitTimer = null; // 等對方下一輪的逾時
let scriptState = CatworldChatScript.normalizeState(undefined); // 今天開了幾場、最近用過的劇本（存在 chatScriptState）
const scriptTimers = new Set();
const SCRIPT_CACHE_MS = 5 * 60 * 1000;
const SCRIPT_WAIT_MS = 3 * 60 * 1000; // 等對方下一輪等這麼久就放棄這一場
const CORRECTION_WINDOW_MS = 15 * 1000; // 劇本剛收到對方一則的這段時間內，對方的「*字」更正算這一場的
let scriptHeardAt = 0;
const characterName = () => (/ - /.test(document.title) ? document.title.split(' - ')[0].trim() : '');
// 靜默結束這一場：清掉等待中的計時器、排在佇列裡還沒送出的台詞，不補送任何收尾
function cancelScript() {
  clearTimeout(scriptWaitTimer);
  scriptWaitTimer = null;
  scriptTimers.forEach(clearTimeout);
  scriptTimers.clear();
  scriptSession = null;
  cancelMacros('script');
}
// 向 background 要劇本；同時只有一個請求在跑（快取過期時一句接一句的來訊不會每句都要一次）
function loadScripts() {
  scriptLoading ??= (async () => {
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'CHAT_SCRIPTS' });
      // 背景沒答好（沒回應、ok 不是 true）：沿用手上的、時間不更新，下一句來訊會再問；不能把「沒拿到」記成「沒有劇本」
      if (reply?.ok !== true) return;
      scriptCache = { scripts: CatworldChatScript.usableScripts(reply?.scripts), at: Date.now() };
    } catch {
      // 連不上背景（孤兒程式）：沒有劇本就不開場也不接話
    }
  })().finally(() => { scriptLoading = null; });
  return scriptLoading;
}
const scriptToday = () => CatworldChatScript.dayKey(Date.now());
const scriptPlayedToday = () => CatworldChatScript.todayCount(scriptState, scriptToday());
// 開了一場（A 開場、B 開始接話）就記一場，連同用的劇本
function recordScriptStart(scriptId) {
  scriptRollsSinceStart = 0;
  scriptState = CatworldChatScript.recordStart(scriptState, scriptToday(), scriptId);
  try {
    chrome.storage.local.set({ [CatworldChatScript.STATE_KEY]: scriptState }).catch(() => {});
  } catch {
    // 連不上儲存（孤兒程式）：這一頁的記憶體裡還是有計數
  }
}
// 一輪的每一則各排一個計時器（出錯字時那一則後面多一則更正）：每一則都比前一個動作（收到對方的訊息、或上一則送出）晚 sendDelayMs（依這一則的字數）才送，錯字後補的更正只晚 correctionDelayMs；finalTurn：這是我說的最後一輪，
// 最後一則送出之後這一場才算結束（等待送出的這段時間場次還在，不會被當成沒有進行中）
function sayTurn(parts, finalTurn) {
  const name = chatScript.partnerName || chatScript.partner;
  const texts = CatworldChatScript.addTypo(parts.map(part => CatworldChatScript.fill(part, name)), chatScript.typoRate);
  let at = 0;
  texts.forEach((text, index) => {
    at += index > 0 && CatworldChatScript.isCorrection(text) ? CatworldChatScript.correctionDelayMs() : CatworldChatScript.sendDelayMs(text);
    const timer = setTimeout(() => {
      scriptTimers.delete(timer);
      sendPart(text, index === texts.length - 1, finalTurn);
    }, at);
    scriptTimers.add(timer);
  });
}
function sendPart(text, lastPart, finalTurn) {
  // 驗證碼辨識中、或因驗證停止：這一輪過時了，整場放棄
  if (captcha || /驗證/.test(stopReason) || !startMacro(CatworldChatScript.tellCommand(chatScript.partner, text), 'script')) {
    cancelScript();
    return;
  }
  chatLimiter.noteSent(text);
  if (!lastPart) return;
  if (finalTurn) {
    scriptSession = null;
    return;
  }
  scriptWaitTimer = setTimeout(cancelScript, SCRIPT_WAIT_MS);
}
// 這句來訊是不是劇本的下一句：是就回 true（並排好我要說的下一輪）；不是（或功能沒開、不是對方）回 false，交給一般私聊的流程
function hearScript({ name, text }) {
  if (!chatScript.enabled || !chatScript.partner || CatworldChatScript.partnerIdOf(name) !== chatScript.partner.toLowerCase()) return false;
  // 對方的更正（*字）：這一場進行中、或剛收到對方一則的幾秒內，收下就好（不回、不動計時）
  if (CatworldChatScript.isCorrection(text) && (scriptSession || Date.now() - scriptHeardAt < CORRECTION_WINDOW_MS)) return true;
  if (Date.now() - scriptCache.at > SCRIPT_CACHE_MS) loadScripts();
  const ownName = characterName();
  let session = scriptSession;
  let step = session ? session.hear(text) : null;
  let isNew = false;
  if (!step) {
    // 沒有進行中的一場，或這句不是目前這場的下一句：B 看這句像不像哪份劇本的開場。A 重新開了一場時 B 可能還停在上一場
    // （最久等 SCRIPT_WAIT_MS），新的開場句要當作新場的開頭，不能被舊的那場擋掉
    if (chatScript.role !== 'B') return false;
    if (scriptPlayedToday() >= chatScript.perDay) { console.log('[catworld] 劇本：對方的來訊沒接話（今天的場數用完了）'); return false; } // 今天的場數用完了：不接新場
    const script = CatworldChatScript.bestStart(scriptCache.scripts, chatScript.role, text, ownName);
    if (!script) { console.log(`[catworld] 劇本：對方的來訊沒接話（和 ${scriptCache.scripts.length} 份劇本的開場都對不上${scriptCache.scripts.length ? '' : '，可能還沒載入劇本'}）`); return false; }
    const fresh = CatworldChatScript.createSession({ script, role: chatScript.role, ownName });
    step = fresh.hear(text);
    if (!step) return false;
    if (session) cancelScript(); // 舊的一場作廢：計時器與排隊中的台詞
    session = fresh;
    isNew = true;
  }
  if (isNew) recordScriptStart(session.scriptId);
  scriptHeardAt = Date.now();
  clearTimeout(scriptWaitTimer);
  if (step.partial) {
    // 對方這一輪還沒說完的前幾則：收下、不回，繼續等後面的
    scriptSession = session;
    scriptWaitTimer = setTimeout(cancelScript, SCRIPT_WAIT_MS);
    return true;
  }
  scriptSession = step.send.length ? session : null;
  if (step.send.length) sayTurn(step.send, step.done);
  return true;
}
// 自動開場（autoEveryMin > 0、這台是 A、有對方 ID、「練功」觸發組開著才作用）：開始後先暖機 AUTO_WARMUP_MS，之後每 AUTO_ROLL_MS 擲一次骰子，
// 機率 1÷autoEveryMin；抽中就等於按了「現在開一場」（startScript 自己會擋已有一場在進行、今天場數用完、沒有劇本）。
// 兩場開始（手動或自動）之間至少隔 AUTO_MIN_GAP_ROLLS 次擲骰；Idle 暫停、驗證碼處理中或因驗證停止時這次放棄，下一次照常再抽。
// 條件消失（停止練功、關功能、改角色或對方 ID、autoEveryMin 改成 0）時 syncScriptAuto 就把計時器清掉，再開始會重新暖機
let scriptAutoWarm = null;
let scriptAutoRoll = null;
let scriptAutoWarmAt = 0; // 暖機開始的時間（只給 STATUS 算還剩幾秒）
let scriptRollsSinceStart = CatworldChatScript.AUTO_MIN_GAP_ROLLS; // 剛載入的頁面不受最小間隔限制
const scriptAutoWanted = () => chatScript.enabled && chatScript.role === 'A' && !!chatScript.partner && chatScript.autoEveryMin > 0 && triggerGroups.practice?.on === true;
function stopScriptAuto() {
  clearTimeout(scriptAutoWarm);
  clearInterval(scriptAutoRoll);
  scriptAutoWarm = null;
  scriptAutoRoll = null;
}
function rollScriptAuto() {
  if (!scriptAutoWanted()) { stopScriptAuto(); return; }
  scriptRollsSinceStart += 1;
  if (Math.random() >= CatworldChatScript.autoChance(chatScript.autoEveryMin)) return;
  if (scriptRollsSinceStart < CatworldChatScript.AUTO_MIN_GAP_ROLLS) return;
  if (idlePaused || captcha || /驗證/.test(stopReason) || presenceOpen()) return;
  startScript();
}
function syncScriptAuto() {
  if (!scriptAutoWanted()) { stopScriptAuto(); return; }
  if (scriptAutoWarm || scriptAutoRoll) return;
  scriptAutoWarmAt = Date.now();
  scriptAutoWarm = setTimeout(() => {
    scriptAutoWarm = null;
    scriptAutoRoll = setInterval(rollScriptAuto, CatworldChatScript.AUTO_ROLL_MS);
  }, CatworldChatScript.AUTO_WARMUP_MS);
}
// 現在不能開場的原因（可以開回 null）
function startBlock() {
  if (!chatScript.enabled) return '劇本對話沒有開';
  if (chatScript.role !== 'A') return '這台的角色不是 A（開場）';
  if (!chatScript.partner) return '還沒填對方的英文 ID';
  if (scriptSession) return '已經有一場在進行';
  const played = scriptPlayedToday();
  return played >= chatScript.perDay ? `今天已經開了 ${played} 場，到上限了（每天 ${chatScript.perDay} 場）` : null;
}
async function startScript() {
  let blocked = startBlock();
  if (blocked) return { ok: false, error: blocked };
  if (!scriptCache.scripts.length || Date.now() - scriptCache.at > SCRIPT_CACHE_MS) await loadScripts();
  blocked = startBlock(); // 等劇本的時候設定或場次可能變了
  if (blocked) return { ok: false, error: blocked };
  const choices = scriptCache.scripts.filter(script => script.lines[0].who === 'A');
  if (!choices.length) return { ok: false, error: '沒有可用的劇本' };
  const script = CatworldChatScript.pickScript(choices, scriptState.recent);
  recordScriptStart(script.id);
  const session = CatworldChatScript.createSession({ script, role: 'A', ownName: characterName() });
  const step = session.start();
  scriptSession = session;
  sayTurn(step.send, step.done);
  return { ok: true, scriptId: script.id };
}
let watchdogTimer = null;
let lastCommand = '';
// 驗證碼自動辨識（閒置時也作用，手動打 reward 領獎也會幫忙輸入）：偵測到圖或提示後暫停送出佇列，等圖印完（CAPTCHA_QUIET_MS 內沒有新輸出）
// 用 CatworldCaptchaGrid 解出數字，再隨機等 CAPTCHA_SEND_DELAY_MS 範圍內的時間才送出（像人看完圖再打字、每次快慢不同；等的期間的一般輸出只接進樣本、照原定時間送出，又偵測到一張新圖才取消重來）。
// 答錯時遊戲不會有任何回應，所以「送出答案後 NO_REPLY_MS 沒有新輸出」就是答錯：重送同一個答案，滿 CAPTCHA_MAX_ATTEMPTS 次才停止並警報；
// 送出後任何新輸出（不是驗證碼、不是回聲）就當作通過，恢復送出。解不出來（沒看過的字形、沒有數字）直接停止並警報，
// 字形矩陣印在 console（[catworld]），貼進 captcha-grid.js 的 LIBRARY 就能擴充
const CAPTCHA_QUIET_MS = 1000;
const CAPTCHA_SEND_DELAY_MS = [3000, 10000]; // [最短, 最長]
const CAPTCHA_MAX_ATTEMPTS = 3;
let captcha = null; // { html, read, sendSeconds, answer, attempts, quietTimer, sendTimer }：answer 為空表示圖還在收或還沒送；read 是讀到、等著送的數字，sendSeconds 是這次抽到要等幾秒
const { artText, createWatcher, describeBatch, isArtLike } = globalThis.CatworldCaptchaArt;
const { HOST_ATTR, contextAlive, removeStalePanels } = globalThis.CatworldInstanceGuard;
// 驗證碼圖形偵測的緩衝：新增文字分批到達時要接在一起判斷（見 captcha-art.js）
const artWatcher = createWatcher();
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
// 玩家的互動來源：遊戲視窗，加上面板所在的置頂浮窗（面板在浮窗裡時，玩家的操作只發生在那裡）
const interactionHub = CatworldPip.createInteractionHub(window);
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
  let stopWatching = null;
  const clear = () => {
    clearInterval(titleTimer);
    titleTimer = null;
    stopFlash = null;
    // 原本的行為：使用者回到頁面互動，提示音也跟著停；「一直響到確認」開著（ringing）時不停
    if (!ringing) stopRepeatBeep();
    document.title = original;
    stopWatching?.();
    document.removeEventListener('visibilitychange', onVisible);
  };
  const onVisible = () => { if (!document.hidden) clear(); };
  stopFlash = clear;
  if (!untilConfirm) {
    stopWatching = interactionHub.watch(['focus', 'pointerdown', 'keydown'], clear);
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
  try {
    chrome.runtime.sendMessage({ type: 'ALERT', reason, confirmable: persistentAlert });
  } catch {
    // 擴充功能剛重新載入，通知送不出去：停止絕對不能因此被跳過
  }
  return stopEverything(reason);
}
// 只有某條觸發規則被停用：響一次、閃標題、跳通知，其他功能照常；原因文字不含「驗證」，不會被當成驗證碼停止
function alertOnly(reason, title = '⚠ 觸發已停用') {
  beep();
  flashTitle(title);
  try {
    chrome.runtime.sendMessage({ type: 'ALERT', reason });
  } catch {
    // 擴充功能剛重新載入，通知送不出去
  }
}
// 有人從別處連線取代目前的人物：這個分頁已經不是在控制角色，全部停下並提醒一次（原因不含「驗證」，之後可以直接再按開始）
const takeoverPattern = /有人從別處[\s\S]{0,40}?連線取代你所控制的人物/;
function stopForTakeover() {
  const reason = '遊戲顯示有人從別處連線取代你所控制的人物，已停止';
  alertOnly(reason, '⚠ 連線被取代');
  return stopEverything(reason);
}
// 輸出裡出現停止關鍵字：全部停下並提醒一次（原因不含「驗證」，之後可以直接再按開始）
function stopForKeyword(word) {
  const shown = word.replace(/\s+/g, ' ');
  const reason = `遊戲輸出出現關鍵字「${shown.length > 40 ? `${shown.slice(0, 40)}…` : shown}」，已全部停止`;
  alertOnly(reason, '⚠ 命中關鍵字');
  return stopEverything(reason);
}
// 指令送出後遊戲通常會回覆；超時沒新輸出視為需要驗證。送的是驗證碼答案時，沒回應＝答錯，交給重送
function armWatchdog() {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (captcha?.answer) retryCaptcha();
    else if (active()) stopAndAlert(`送出指令後 ${NO_REPLY_MS / 1000} 秒沒有收到遊戲回應，疑似需要驗證，已停止；請完成驗證後再按開始`);
  }, NO_REPLY_MS);
}
function isCommandEcho(text) {
  return text.replace(/^[>\s]+/, '').trim() === lastCommand;
}
function countCaptcha() {
  const text = document.body?.textContent || '';
  return (text.match(captchaPattern) || []).length;
}
// 畫面上的提示文字變多＝新的驗證碼：開始自動辨識（圖的內容取偵測器最近看到的文字）
function checkCaptcha() {
  const count = countCaptcha();
  if (count > captchaCount) {
    beginCaptcha(artWatcher.recentHtml());
    return true;
  }
  captchaCount = count;
  return false;
}
// 開始或延續一輪自動辨識：圖還在收就把新批次接上去並重新等靜默；答完又來一張就換新圖、次數延續。
// 讀到數字等著送的期間，聊天、房間訊息、領獎提示那行都只接進樣本，不動送出時間（忙碌的房間每幾秒就有輸出，重抽會一直送不出去）；
// 只有偵測器又看到一張圖（newImage）才取消送出、重新辨識
// 畫面上的提示數量在這裡就當成新基準，答案送出後遊戲回應時 checkCaptcha 才不會把同一個提示再當成新的驗證碼
function beginCaptcha(html, { newImage = false } = {}) {
  cancelScript();
  captchaCount = countCaptcha();
  if (captcha?.answer) {
    captcha.html = '';
    captcha.answer = '';
  }
  captcha ??= { html: '', read: '', sendSeconds: 0, answer: '', attempts: 0, quietTimer: null, sendTimer: null };
  captcha.html += html;
  if (captcha.sendTimer) {
    if (!newImage) {
      renderPanel();
      return;
    }
    clearTimeout(captcha.sendTimer);
    captcha.sendTimer = null;
    captcha.read = '';
  }
  if (captcha.quietTimer) clearTimeout(captcha.quietTimer);
  captcha.quietTimer = setTimeout(solveCaptcha, CAPTCHA_QUIET_MS);
  renderPanel();
}
function solveCaptcha() {
  captcha.quietTimer = null;
  const result = CatworldCaptchaGrid.decodeHtml(captcha.html);
  if (!result.text || result.digits.some(digit => !digit.confident)) {
    console.info('[catworld] 驗證碼自動辨識失敗，字形矩陣（確認後可貼進 captcha-grid.js 的 LIBRARY）：\n' + CatworldCaptchaGrid.describeDigits(result.digits));
    // 原始 HTML 一起印：新版面的樣本要靠這個放進 tests/fixtures/captcha/
    console.info('[catworld] 這次收到的驗證碼 HTML：\n' + captcha.html);
    reportSample('unknown', result.text);
    stopAndAlert(`驗證碼自動辨識失敗（${result.text || '沒有讀到數字'}），已停止；請完成驗證後再按開始`);
    return;
  }
  // 成功也印矩陣：模糊比對猜中的字形可以從 console 核對、貼進模板庫，不用等它哪天猜錯
  const [minDelay, maxDelay] = CAPTCHA_SEND_DELAY_MS;
  const delay = minDelay + Math.random() * (maxDelay - minDelay);
  captcha.read = result.text;
  captcha.sendSeconds = Math.round(delay / 1000);
  console.info(`[catworld] 驗證碼自動辨識：讀到 ${result.text}，${captcha.sendSeconds} 秒後送出，字形矩陣：\n` + CatworldCaptchaGrid.describeDigits(result.digits));
  captcha.sendTimer = setTimeout(() => {
    captcha.sendTimer = null;
    captcha.answer = captcha.read;
    submitCaptcha();
  }, delay);
  renderPanel();
}
function submitCaptcha() {
  captcha.attempts += 1;
  console.info(`[catworld] 驗證碼自動辨識：送出 ${captcha.answer}（第 ${captcha.attempts} 次）`);
  const result = sendCommand(captcha.answer, { answer: true });
  if (!result.ok) {
    stopEverything(result.error);
    return;
  }
  lastSentAt = Date.now();
  // 偵測器的視窗清掉：答完若再來一張圖，從它自己的第一行開始接，不會接到這張的尾巴
  artWatcher.clear();
  renderPanel();
}
// 答案送出後 NO_REPLY_MS 沒有任何回應＝答錯：同一個答案再送，滿次數才停
function retryCaptcha() {
  if (captcha.attempts >= CAPTCHA_MAX_ATTEMPTS) {
    reportSample('silent');
    stopAndAlert(`驗證碼自動辨識送出 ${captcha.answer} ${CAPTCHA_MAX_ATTEMPTS} 次都沒有收到遊戲回應，已停止；請完成驗證後再按開始`);
    return;
  }
  submitCaptcha();
}
// 答案送出後遊戲有新輸出＝通過：以現在畫面上的提示數量當新基準，恢復送出佇列
function endCaptcha() {
  console.info(`[catworld] 驗證碼自動辨識：${captcha.answer} 通過`);
  reportSample('passed');
  clearCaptcha();
  captchaCount = countCaptcha();
  artWatcher.clear();
  renderPanel();
  pumpQueue();
}
function clearCaptcha() {
  if (captcha?.quietTimer) clearTimeout(captcha.quietTimer);
  if (captcha?.sendTimer) clearTimeout(captcha.sendTimer);
  captcha = null;
}
// 每一回合的結果連同這張圖的 HTML 交給 background 送去收集（設定頁填了收集網址才會送出，網址 content script 不讀）：
// passed＝通過、silent＝送滿次數都沒回應（答案猜錯）、unknown＝讀不出數字（answer 是帶 ? 的結果）。送不出去不影響任何流程
function reportSample(outcome, answer = captcha.answer) {
  try {
    chrome.runtime.sendMessage({ type: 'CAPTCHA_SAMPLE', sample: { outcome, answer, attempts: captcha.attempts, html: captcha.html } }).catch(() => {});
  } catch {
    // 擴充功能剛重新載入，孤兒 content script 送不出訊息
  }
}
// 遊戲回覆只在輸出區 #content 裡。頁面上其他一直在變的東西（右上角每秒跳的時鐘 #uptime、狀態 #monitor、地圖、巨集、設定視窗、
// 重連倒數 #notice）都不是遊戲回覆，不能拿來清掉看門狗、當驗證碼內容，也不能當關鍵字來源；時鐘每秒一跳，漏掉它看門狗永遠不會響
function closestOf(node, selector) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(element?.closest(selector));
}
const escapeHtml = text => text.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
const inContent = node => closestOf(node, '#content');
// 關鍵字觸發只看遊戲輸出區（#content）裡「新出現」的文字
function feedKeywords(records) {
  const text = records
    .filter(record => inContent(record.target))
    .flatMap(record => (record.type === 'characterData'
      ? [record.target.textContent || '']
      : Array.from(record.addedNodes, node => node.textContent || '')))
    .join('');
  if (text.trim() && !idlePaused) groupList.forEach(group => { if (group.on) group.engine.onText(text); });
}
const captchaObserver = new MutationObserver(allRecords => {
  if (!contextAlive(chrome)) {
    retire();
    return;
  }
  const records = allRecords.filter(record => inContent(record.target));
  if (!records.length) return;
  const addedTexts = records.flatMap(record => record.type === 'characterData'
    ? [record.target.textContent || '']
    : Array.from(record.addedNodes, artText));
  const meaningful = addedTexts.some(text => text.trim() && !isCommandEcho(text.trim()));
  if (meaningful && watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  const addedText = addedTexts.join('');
  watchReward(addedText);
  // 停止關鍵字閒置時也作用（只看新出現的、不是自己打的回聲）
  const keywordHit = stopKeywords.enabled ? stopKeywordWatcher.feed(addedText, stopKeywords.words) : null;
  if (keywordHit && Date.now() - lastStopKeywordAt > STOP_KEYWORD_COOLDOWN_MS) {
    lastStopKeywordAt = Date.now();
    stopForKeyword(keywordHit);
  }
  feedChat(addedText);
  // 自動辨識要原始 HTML（背景色 span 裡的亂碼文字也是方塊）：元素取 outerHTML，文字節點照 HTML 規則跳脫
  const addedHtml = records.map(record => (record.type === 'characterData'
    ? escapeHtml(record.target.textContent || '')
    : Array.from(record.addedNodes, node => (node.nodeType === Node.ELEMENT_NODE ? node.outerHTML : escapeHtml(node.textContent || ''))).join(''))).join('');
  const artHit = artWatcher.feed(addedText, addedHtml);
  if (artHit || isArtLike(addedText)) console.info('[catworld] 疑似驗證碼的批次', describeBatch(addedText), artHit ? '→ 偵測到，交給自動辨識' : '→ 規則還不成立（可能分批，會和前幾秒的新增文字一起判斷）');
  const addedPrompt = records.some(record => {
    if (record.type === 'characterData') {
      return hasCaptchaText(record.target.textContent) &&
        !hasCaptchaText(record.oldValue);
    }
    return Array.from(record.addedNodes).some(node =>
      hasCaptchaText(node.textContent));
  });
  // 圖還在收時每一批都接上去（偵測器命中那一刻已含這一批，不能再接一次）；新的一張圖從偵測器看到的文字開始
  if (artHit || addedPrompt) {
    beginCaptcha(captcha && !captcha.answer ? addedHtml : artHit ? artWatcher.lastHitHtml() : artWatcher.recentHtml(), { newImage: artHit });
    return;
  }
  if (checkCaptcha()) return;
  if (captcha) {
    if (meaningful) {
      if (captcha.answer) endCaptcha();
      else beginCaptcha(addedHtml);
    }
    return;
  }
  // 驗證碼的偵測與自動辨識到這裡為止，閒置時也作用（手動打 reward 領獎也會幫忙輸入）；連線被取代與關鍵字只在有功能在跑時才看
  if (!active()) return;
  if (takeoverPattern.test(addedText)) {
    stopForTakeover();
    return;
  }
  // 驗證碼檢查放在前面：同一批含驗證碼時已交給自動辨識（送出佇列暫停），不會再比對關鍵字或送指令
  if (anyTriggerOn()) feedKeywords(records);
});
// 遊戲的「真人驗證」（點選和左側範例相同的圖形，60 秒內）：伺服器推 presence.challenge 後，遊戲把 #presence 的 invisible 拿掉。
// 圖在 #content 之外、也不會出現在文字輸出裡，而且是要真人點的（遊戲會檢查點擊是不是真的滑鼠事件、答題時間與 Turnstile），所以不辨識、不代點，
// 只在它出現的那一刻停下一切並警報（原因含「驗證」，之後要玩家手動按開始才會再送指令）；解除後不自動恢復。只看從隱藏變成顯示，其他 class 變動或重複顯示不再警報；
// 載入時就顯示著的不算「出現」、不警報，但開著的期間 sendCommand 一律不送（見 presenceOpen）。
const presenceElement = document.getElementById('presence');
const presenceOpen = () => !!presenceElement && !presenceElement.classList.contains('invisible');
// 真人驗證一出現，把那一塊（#presence）的內容收進樣本表（結果欄 presence，和驗證碼樣本同一個收集網址與分頁）：只存檔，不辨識、不代點。
// 圖的格式沒有樣本：<img> 或 <canvas> 能轉成 data URL 就嵌進去（圖是遊戲另外要的，只存網址事後多半打不開），轉不了（跨來源）就留原本的網址；
// 試算表一格最多 50000 字，太大就退回不嵌圖的版本。遊戲是先拿掉 invisible、圖才載入，所以等圖載好（最多 PRESENCE_IMAGE_WAIT_MS）再收。
const PRESENCE_SAMPLE_MAX = 45000;
const PRESENCE_IMAGE_WAIT_MS = 5000;
function presenceSampleHtml(embed) {
  const clone = presenceElement.cloneNode(true);
  if (!embed) return clone.outerHTML;
  const copies = [...clone.querySelectorAll('img, canvas')];
  [...presenceElement.querySelectorAll('img, canvas')].forEach((node, index) => {
    try {
      let url;
      if (node.tagName === 'CANVAS') {
        url = node.toDataURL('image/png');
        copies[index].setAttribute('data-catworld-image', url);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = node.naturalWidth;
      canvas.height = node.naturalHeight;
      canvas.getContext('2d').drawImage(node, 0, 0);
      url = canvas.toDataURL('image/png');
      if (typeof url === 'string' && url.startsWith('data:')) {
        copies[index].setAttribute('data-catworld-src', node.getAttribute('src') ?? '');
        copies[index].setAttribute('src', url);
      }
    } catch (error) {
      console.log('[catworld] 真人驗證樣本：圖轉不成資料網址，留原本的網址', error?.name ?? error);
    }
  });
  return clone.outerHTML;
}
function reportPresenceSample() {
  const started = Date.now();
  const imagesReady = () => [...presenceElement.querySelectorAll('img')].every(img => img.getAttribute('src') && img.complete && img.naturalWidth > 0);
  const attempt = () => {
    if (!contextAlive(chrome)) return;
    if (!imagesReady() && Date.now() - started < PRESENCE_IMAGE_WAIT_MS) {
      setTimeout(attempt, 200);
      return;
    }
    let html = presenceSampleHtml(true);
    if (html.length > PRESENCE_SAMPLE_MAX) html = presenceSampleHtml(false);
    if (html.length > PRESENCE_SAMPLE_MAX) {
      console.log(`[catworld] 真人驗證樣本太大（${html.length} 字），不收`);
      return;
    }
    console.log(`[catworld] 真人驗證樣本：送出 ${html.length} 字`);
    try {
      chrome.runtime.sendMessage({ type: 'CAPTCHA_SAMPLE', sample: { outcome: 'presence', answer: '', attempts: 0, html } }).catch(() => {});
    } catch {
      // 擴充功能剛重新載入，孤兒 content script 送不出訊息
    }
  };
  attempt();
}
let presenceShown = false;
const presenceObserver = presenceElement ? new MutationObserver(() => {
  if (!contextAlive(chrome)) {
    retire();
    return;
  }
  const shown = !presenceElement.classList.contains('invisible');
  if (shown && !presenceShown) {
    stopAndAlert('遊戲要求點選圖形的真人驗證（60 秒內），已全部停止；請自己完成驗證後再按開始');
    reportPresenceSample(); // 警報之後才收樣本，收不到也不影響停止
  }
  presenceShown = shown;
}) : null;
if (presenceElement) {
  presenceShown = !presenceElement.classList.contains('invisible'); // 載入時就顯示著的不算新出現
  presenceObserver.observe(presenceElement, { attributes: true, attributeFilter: ['class'] });
}
// 歷史紀錄裡已有的提示不是新的驗證碼：先以載入時畫面上的數量當基準
captchaCount = countCaptcha();
captchaObserver.observe(document.body, {
  subtree: true, childList: true, characterData: true, characterDataOldValue: true
});
let settings = {
  commandDelayMs: 500
  // fixedItems、randomItems 不放預設值：沒有這個欄位時，normalizeFixedItems／normalizeRandomItems 才會去讀舊格式
  //（commands + minSeconds／maxSeconds、randomCommands），預設成空陣列會蓋掉升級前存下的指令；固定指令從沒設定過時由 normalizeFixedItems 給預設的 ps;px
};
const fixedItems = () => CatworldTimer.normalizeFixedItems(settings);
const randomItems = () => CatworldTimer.normalizeRandomItems(settings);

// answer：送的是驗證碼答案，不受「辨識中暫停送出」和「因驗證停止後不送指令」限制（停止後手動打 reward 的圖也要幫忙答）
function sendCommand(command, { answer = false } = {}) {
  if (!contextAlive(chrome)) {
    retire();
    return { ok: false, error: '擴充功能已重新載入，請重新整理遊戲頁' };
  }
  if (!answer && (captcha || checkCaptcha())) return { ok: false, error: '驗證碼自動辨識中，先不送出指令' };
  if (!answer && /驗證/.test(stopReason)) return { ok: false, error: stopReason };
  // 真人驗證還開著（例如驗證倒數中重新整理頁面、載入時就顯示著，不會有「出現」的那一刻）：任何入口都不送，送出被拒會讓 pumpQueue 停下一切
  if (!answer && presenceOpen()) return { ok: false, error: '遊戲正在要求真人驗證，先不送出指令；請完成驗證後再按開始' };
  const input = document.querySelector('#input');
  if (!input || !input.form) {
    return { ok: false, error: '找不到 CatWorld 指令輸入框 #input' };
  }
  const typed = input.value;
  const selection = [input.selectionStart, input.selectionEnd];
  input.focus();
  input.value = CatworldTimer.commandText(command);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.form.requestSubmit();
  // 遊戲送出後會清空輸入框或全選剛送出的指令，把使用者原本正在輸入的文字還回去
  if (typed) {
    input.value = typed;
    input.setSelectionRange(selection[0], selection[1]);
  }
  lastCommand = command.trim();
  // 驗證碼答案閒置時也送，看門狗同樣要上（沒回應＝答錯）。送出的是空白行（Enter：指令結尾多的 ;、<enter>）時不上：
  // 遊戲對空白行只回一個「> 」回聲，沒有真正的回應，上了會在 8 秒後誤判成需要驗證而停掉一切
  if ((active() || answer) && CatworldTimer.commandText(command).trim() !== '') armWatchdog();
  return { ok: true };
}

function clearFixedTimers() {
  fixedRuns.forEach(run => clearTimeout(run.timer));
  fixedRuns = [];
}
function clearRandomTimers() {
  nextRandomAt = null;
  nextRandomCommand = null;
  if (randomTimer) clearTimeout(randomTimer);
  randomTimer = null;
}
function clearTimers() {
  clearFixedTimers();
  clearRandomTimers();
  if (queueTimer) clearTimeout(queueTimer);
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = null;
  clearCaptcha();
  queueTimer = null;
  dropQueue('timer');
  dropQueue('random');
  cancelMacros('timer');
  cancelMacros('random');
  // 上面清掉了送出佇列的計時器；佇列裡若還有觸發的指令，要重新排程
  pumpQueue();
}

// 固定、隨機兩條循環與狀態觸發共用同一個送出佇列，任兩次送出至少間隔 commandDelayMs；
// 每個項目記下來源，停掉定時時只丟掉定時的項目，不影響還在跑的觸發
function enqueue(command, source = 'timer', run = null, onSent = null) {
  queue.push({ command, source, run, onSent });
  pumpQueue();
}

// 定時、隨機、觸發的指令入口：單一指令照舊直接排進佇列；含 ; 或 @等待 的交給巨集執行器拆開依序送，
// 並記下是誰啟動的（owner），停止那個功能時才能只取消它自己的巨集
// onSent：指令真的送出時呼叫（巨集沒有單一的送出時刻，開始時就呼叫）
function queueCommand(command, owner, onSent = null) {
  if (CatworldMacro.isSequence(command)) {
    startMacro(command, owner);
    onSent?.();
  } else enqueue(command, owner, null, onSent);
}

function dropQueue(source) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].source === source) queue.splice(i, 1);
  }
}

// 最優先：命中時勾了「最優先」的規則，指令包成 priority 巨集。最前面那個（先命中的）放行，
// 其他來源排隊的指令不送、等待中的巨集暫停（剩餘的等待時間凍結），它整段做完（含 @等待）才一起繼續；已經送出的收不回來
const currentPriority = () => [...macroRuns].find(run => run.priority) ?? null;
const isHeld = run => {
  const current = currentPriority();
  return current !== null && run !== current;
};
function startWait(run, ms) {
  run.waitUntil = Date.now() + ms;
  run.timer = setTimeout(() => advanceMacro(run), ms);
}
// 最優先的巨集開始或結束後呼叫：被壓住的巨集凍結等待，放行後接著把剩下的等待時間算完
function syncHold() {
  macroRuns.forEach(run => {
    if (isHeld(run) && run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
      run.frozen = true;
      run.remaining = Math.max(0, run.waitUntil - Date.now());
      run.waitUntil = null;
    } else if (!isHeld(run) && run.frozen) {
      run.frozen = false;
      startWait(run, run.remaining);
    }
  });
}
function nextQueued() {
  const current = currentPriority();
  return current ? queue.findIndex(entry => entry.run === current) : (queue.length ? 0 : -1);
}

// 巡怪的指令（單一指令或巡怪巨集拆出來的）另外再隔巡怪自己設的隨機間隔，和共用的 commandDelayMs 取較大的
let huntSettings = CatworldMapHunt.normalizeSettings(undefined);
const isHuntEntry = entry => entry.source === 'hunt' || entry.run?.owner === 'hunt';
function pumpQueue() {
  if (queueTimer || nextQueued() < 0) return;
  const next = queue[nextQueued()];
  const gap = Math.max(0, Number(settings.commandDelayMs) || 0, isHuntEntry(next) ? CatworldMapHunt.gapMs(huntSettings) : 0);
  const wait = Math.max(0, lastSentAt + gap - Date.now());
  queueTimer = setTimeout(() => {
    queueTimer = null;
    // 驗證碼辨識中先不送（通過後 endCaptcha 會再 pumpQueue）
    if (!active() || captcha || checkCaptcha()) return;
    const at = nextQueued();
    if (at < 0) return;
    const [entry] = queue.splice(at, 1);
    const result = sendCommand(entry.command);
    if (!result.ok) { stopEverything(result.error); return; }
    lastSentAt = Date.now();
    entry.onSent?.();
    if (entry.run) {
      entry.run.pending -= 1;
      finishMacroIfDone(entry.run);
    }
    pumpQueue();
  }, wait);
}

// 固定指令：每一項各自循環，開始時先送一次，之後在「它自己的」最短～最長秒數之間隨機等一段時間再送，彼此不等
function startFixedItems() {
  if (idlePaused) return;
  fixedRuns = fixedItems().map(item => ({ item, timer: null, at: null }));
  fixedRuns.forEach(runFixedItem);
}

function runFixedItem(run) {
  if (!running) return;
  queueCommand(run.item.command, 'timer');
  const delay = CatworldTimer.delayMs(run.item);
  run.timer = setTimeout(() => runFixedItem(run), delay);
  run.at = Date.now() + delay;
}

// 隨機指令：先均勻隨機挑一個，再在「它自己的」最短～最長秒數之間隨機等一段時間，到時間才送出，然後再挑下一個
function scheduleRandomCommand() {
  if (!randomRunning || idlePaused) return;
  const item = CatworldTimer.pickRandomItem(randomItems());
  if (!item) return;
  const delay = CatworldTimer.delayMs(item);
  randomTimer = setTimeout(() => runRandomCommand(item.command), delay);
  nextRandomAt = Date.now() + delay;
  nextRandomCommand = item.command;
}

function runRandomCommand(command) {
  if (!randomRunning) return;
  queueCommand(command, 'random');
  scheduleRandomCommand();
}

// 開始任何一個功能前：停掉重複提示音（「一直響到確認」響鈴中除外，那只有「確認」能停）、清掉上一次的停止原因；沒有任何功能在跑時，
// 以目前畫面上的驗證碼數量當基準，歷史紀錄裡的提示不會被當成新的
function armDetection() {
  if (!ringing) stopRepeatBeep();
  if (!active()) {
    captchaObserver.takeRecords();
    artWatcher.clear();
    captchaCount = countCaptcha();
  }
  stopReason = '';
}

// 定時（固定指令）：只管固定指令；隨機指令是獨立的 startRandom／stopRandom
async function start(newSettings) {
  clearFixedTimers();
  dropQueue('timer');
  cancelMacros('timer');
  settings = { ...settings, ...newSettings };
  armDetection();
  running = true;
  await chrome.storage.local.set({ running: true, settings, stopReason: '' });
  requestScAtStart('timer');
  startFixedItems();
  renderPanel();
}

// 定時或隨機停止：只停自己的；兩個都沒在跑、也沒有觸發等功能時才清共用的計時器與驗證碼狀態（和以前一個開關時一樣）
function finishStop() {
  if (active()) pumpQueue();
  else clearTimers();
}
async function stop(reason = '已停止') {
  stopReason = reason;
  running = false;
  clearFixedTimers();
  dropQueue('timer');
  cancelMacros('timer');
  finishStop();
  renderPanel();
  await chrome.storage.local.set({ running: false, stopReason });
}

async function startRandom(newSettings) {
  clearRandomTimers();
  dropQueue('random');
  cancelMacros('random');
  settings = { ...settings, ...newSettings };
  armDetection();
  randomRunning = true;
  await chrome.storage.local.set({ randomRunning: true, settings, stopReason: '' });
  requestScAtStart('random');
  scheduleRandomCommand();
  renderPanel();
}

async function stopRandom(reason = '已停止') {
  stopReason = reason;
  randomRunning = false;
  clearRandomTimers();
  dropQueue('random');
  cancelMacros('random');
  finishStop();
  renderPanel();
  await chrome.storage.local.set({ randomRunning: false, stopReason });
}

// idle：進入時暫停定時、隨機與兩組觸發（只是不再送新指令，已經在跑的巨集照做完），idle 持續 durMin～durMax 分鐘後自動繼續，
// 再隔 everyMin～everyMax 分鐘又 idle。按「開始」就先 idle 一次
function pauseForIdle() {
  idlePaused = true;
  clearFixedTimers();
  clearRandomTimers();
}
function resumeFromIdle() {
  idlePaused = false;
  if (running) startFixedItems();
  if (randomRunning) scheduleRandomCommand();
  groupList.forEach(group => { if (group.on) group.engine.tick(); });
}
function beginIdling() {
  const ms = CatworldTimer.idleMs(idleSettings.durMin, idleSettings.durMax);
  pauseForIdle();
  idleState = { phase: 'idling', at: Date.now() + ms, timer: setTimeout(endIdling, ms) };
  renderPanel();
}
function endIdling() {
  if (retired || !idleState) return;
  resumeFromIdle();
  const ms = CatworldTimer.idleMs(idleSettings.everyMin, idleSettings.everyMax);
  idleState = { phase: 'working', at: Date.now() + ms, timer: setTimeout(beginIdling, ms) };
  renderPanel();
}
function startIdle(raw) {
  cancelIdle();
  idleSettings = CatworldTimer.normalizeIdle(raw);
  armDetection();
  beginIdling();
}
// resume：停止 idle 時是否讓暫停的功能繼續（全部停止或頁面作廢時不繼續）
function cancelIdle({ resume = true } = {}) {
  if (idleState) clearTimeout(idleState.timer);
  idleState = null;
  if (idlePaused) {
    idlePaused = false;
    if (resume && !retired) resumeFromIdle();
  }
  renderPanel();
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
// 遊戲狀態視窗裡的數字（逗號、空白去掉）；讀不到是 NaN
function readGameNumber(id) {
  const text = (document.getElementById(id)?.textContent || '').replace(/[,\s]/g, '');
  return text ? Number(text) : NaN;
}
// 遊戲狀態視窗裡包住每一項「目前值／上限」的元素：遊戲的 vitals.js 依滿度替它們換顏色
const STAT_COLOR_IDS = { 精: 'gin_w1', 氣: 'kee_w1', 神: 'sen_w1', 靈力: 'atman_w', 內力: 'force_w', 法力: 'mana_w', 食物: 'food_w', 飲水: 'water_w' };
// 遊戲狀態視窗（#monitor）與經驗（#exp）實際生效的顏色：數值區塊用它，隨遊戲設定的色彩主題與半透明一起變；
// 找不到元素就給空的，由 themeFrom 回到預設值，不能因此讓更新出錯
function readMonitorTheme() {
  const monitor = document.getElementById('monitor');
  const exp = document.getElementById('exp');
  // 每一項數字在遊戲裡此刻的顏色（遊戲依滿度換色）：讀對應那個包住「目前值／上限」的元素
  const statStyles = Object.fromEntries(Object.entries(STAT_COLOR_IDS).map(([name, id]) => {
    const element = document.getElementById(id);
    return [name, element && getComputedStyle(element)];
  }));
  return CatworldStatsBlock.themeFrom(monitor && getComputedStyle(monitor), exp && getComputedStyle(exp), statStyles);
}
// 遊戲的冷卻條（#perform 特攻、#busy 忙碌）：伺服器送 GMCP cooldown 時，遊戲 web.js 的 cooldown() 把元素的 innerHTML 換成一個新的子 div，
// 帶 animation-duration（web.css 的 @keyframes cooldown 從寬 100% 跑到 0，跑一次）。子 div 的 CSS 動畫還在跑＝冷卻中；讀不到元素或動畫＝不在冷卻
function cooldownRunning(id) {
  const inner = document.getElementById(id)?.firstElementChild;
  try { return Boolean(inner?.getAnimations?.().some(animation => animation.playState === 'running')); } catch { return false; }
}
function readAllStats() {
  return Object.fromEntries(Object.keys(CatworldTriggerEngine.STATS).map(name => [name, readStat(name)]));
}
// 角色狀態（#status）的文字；讀不到回 null，引擎一律當作不能觸發。哪些狀態可以觸發由規則組的 allowedStatuses 決定（預設只有「正常」）
function readStatus() {
  const element = document.getElementById('status');
  return element ? element.textContent.trim() : null;
}

// 遊戲存的巨集原文（localStorage.MACROS）；讀不到（沒有權限、頁面剛換）當作沒存過
function readGameMacros() {
  try {
    return window.localStorage.getItem('MACROS');
  } catch {
    return null;
  }
}

// 那一格的巨集文字能不能被巨集執行器解析（例如 @等待 寫錯）：不能回說明，可以回 null
const macroProblem = text => CatworldMacro.parseSteps(text).error ?? null;
// 這一組現在讀不到的 @巨集 N（規則啟用中才算），給面板的觸發列一直顯示；沒有任何 @巨集 時完全不讀遊戲存的巨集
function macroWarnings(group) {
  if (!group.on) return [];
  const rules = group.engine.snapshot().rules.filter(rule => rule.phase !== 'off' && rule.commands.some(command => CatworldMacroIO.containsMacroRef(command)));
  if (!rules.length) return [];
  const raw = readGameMacros();
  return rules.flatMap(rule => CatworldMacroIO.expandMacroRefs(rule.commands, raw, macroProblem).errors.map(error => `規則「${rule.label}」${error}`));
}

// 巡怪的指令欄（打完後、回家、吃藥、待命、整理…）也能寫「@巨集 N」：送出的當下才讀遊戲存的那一格換成它的指令；
// 讀不到的拿掉並在面板的巨集列說明原因，其他指令照送。沒有 @巨集 時原樣回傳、完全不讀遊戲存的巨集
function expandHuntCommand(command) {
  if (!CatworldMacroIO.containsMacroRef(command)) return command;
  const expanded = CatworldMacroIO.expandMacroRefs([command], readGameMacros(), macroProblem);
  if (expanded.errors.length) {
    macroNote = { text: `巡怪的指令有讀不到的 @巨集：${expanded.errors.join('；')}`, until: Date.now() + 8000 };
    renderPanel();
  }
  return expanded.commands.join(';');
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
    status: readStatus,
    send: (rawCommands, index) => {
      // 指令欄的「@巨集 N」在命中的當下才讀遊戲存的那一格換成它的指令（讀不到的拿掉、在面板的巨集列說明原因，其他指令照送）；隨機數字加在換完之後的最後一個指令
      const expanded = CatworldMacroIO.expandMacroRefs(rawCommands, readGameMacros(), macroProblem);
      if (expanded.errors.length) {
        macroNote = { text: `規則「${group.engine.snapshot().rules[index]?.label ?? ''}」的指令沒有送出：${expanded.errors.join('；')}`, until: Date.now() + 8000 };
        renderPanel();
      }
      // 最後一個指令是 @巨集 時不加隨機數字（加在整格巨集的結尾可能弄壞 @等待，要加就寫在規則自己的最後一個指令）
      const lastIsRef = rawCommands.length > 0 && CatworldMacroIO.containsMacroRef(rawCommands[rawCommands.length - 1]);
      const commands = lastIsRef ? expanded.commands : CatworldTriggerEngine.withNumber(expanded.commands, config.rules[index]?.number);
      const hasMacroRef = expanded.used > 0;
      const stops = config.rules[index]?.stopGroup === true;
      const priority = config.rules[index]?.priority === true;
      if (!stops && group.on) {
        if (priority && commands.length) startMacro(commands.join(';'), `trigger:${group.id}`, { priority: true });
        // 有 @巨集 的規則整條接成一個巨集依序送（格子裡的 ; 與 @等待 才會讓後面的指令等它做完）；沒有的照舊一個指令一個指令排
        else if (hasMacroRef) { if (commands.length) startMacro(commands.join(';'), `trigger:${group.id}`); }
        else commands.forEach(command => queueCommand(command, `trigger:${group.id}`));
        return;
      }
      // 規則勾了「命中送出後停止這組觸發」：先停這一組（stopTriggers 會丟掉這一組還沒送的指令，所以要在排指令之前停），
      // 再把這次的指令當巨集送出：巨集執行中算 active()，定時與另一組都沒在跑時最後一個指令才送得出去。
      // 同一輪有好幾條規則一起送出時只停一次（再 stopTriggers 會把前一條剛啟動的巨集取消掉），
      // 停了之後同一輪才送出的其他規則也走巨集，它們的指令才送得出去；只勾停止、沒填指令的規則就只停止
      if (group.on) stopTriggers(group, `規則「${group.engine.snapshot().rules[index].label}」命中，已依設定停止${group.name}觸發`);
      if (commands.length) startMacro(commands.join(';'), `trigger:${group.id}`, { priority });
    },
    onDisable: (index, label, reason) => alertOnly(`${group.name}觸發規則「${label}」已停用：${reason}`),
  });
  group.on = true;
  syncScriptAuto();
  await saveGroupConfig(group.id, config);
  if (!idlePaused) group.engine.tick();
  group.timer = setInterval(() => { if (!idlePaused) group.engine.tick(); }, 1000);
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
  syncScriptAuto();
  clearInterval(group.timer);
  group.timer = null;
  dropQueue(`trigger:${group.id}`);
  cancelMacros(`trigger:${group.id}`);
  group.note = note;
  renderPanel();
}

// 驗證碼或送出失敗：定時與兩組觸發、巨集一起停
function stopEverything(reason) {
  cancelIdle({ resume: false });
  groupList.forEach(group => stopTriggers(group));
  hunt?.stop(reason);
  cancelMacros();
  cancelChatReplies();
  cancelScript();
  stopRandom(reason);
  return stop(reason);
}

// 遊戲巨集的 @等待：按下有等待的巨集鍵時，在遊戲處理之前攔下來，自己照順序執行。
// 指令走同一個送出佇列（遵守指令間隔、驗證碼偵測、看門狗），等待時不擋住其他功能，別的來源的指令可以插進來。
// 一個巨集的「執行」要到最後一個指令真的送出才算結束（active() 才不會在最後一個指令還在排隊時就變成 false）
function startMacro(text, owner = 'user', { priority = false } = {}) {
  const parsed = CatworldMacro.parseSteps(text);
  if (parsed.error) {
    macroNote = { text: `巨集沒有執行：${parsed.error}`, until: Date.now() + 8000 };
    renderPanel();
    return false;
  }
  armDetection();
  macroNote = null;
  const run = { owner, priority, steps: parsed.steps, index: 0, pending: 0, timer: null, waitUntil: null, nextCommand: null, frozen: false, remaining: 0 };
  macroRuns.add(run);
  syncHold();
  advanceMacro(run);
  renderPanel();
  return true;
}

function advanceMacro(run) {
  run.timer = null;
  run.waitUntil = null;
  run.frozen = false;
  while (run.index < run.steps.length) {
    const step = run.steps[run.index++];
    if (step.wait) {
      const ms = CatworldMacro.waitMs(step.wait);
      run.waitUntil = Date.now() + ms;
      run.nextCommand = run.steps.slice(run.index).find(next => next.command !== undefined)?.command ?? null;
      if (isHeld(run)) {
        run.frozen = true;
        run.remaining = ms;
      } else {
        startWait(run, ms);
      }
      return;
    }
    run.pending += 1;
    enqueue(step.command, 'macro', run);
  }
  finishMacroIfDone(run);
}

function finishMacroIfDone(run) {
  if (run.index >= run.steps.length && run.pending === 0 && !run.timer && !run.frozen) {
    macroRuns.delete(run);
    syncHold();
    pumpQueue();
  }
}

// 不帶 owner 就全部取消（驗證碼、停止一切）；帶 owner 只取消那個功能啟動的（停止定時時不能順手取消使用者按的巨集）
function cancelMacros(owner) {
  const gone = [...macroRuns].filter(run => owner === undefined || run.owner === owner);
  gone.forEach(run => { clearTimeout(run.timer); macroRuns.delete(run); });
  syncHold();
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].run && gone.includes(queue[i].run)) queue.splice(i, 1);
  }
  if (owner === undefined) dropQueue('macro');
  pumpQueue();
}

// 蒐集到的怪物位置：內建加個人（只在讀取時合併）
const mapStore = async () => CatworldMapCollect.withBuiltin((await chrome.storage.local.get('mapMonsters')).mapMonsters);
// 送一個指令給遊戲並收它的回應文字（巡怪的 l 與 finger 用）：收集 #content 新增的文字，出現 ASK_PATTERN 的內容之後再安靜
// ASK_QUIET_MS 就交出去；一直等不到就在 ASK_MAX_MS 後交出目前收到的（可能是空的）。指令走共用送出佇列（來源 hunt）
const ASK = {
  look: { pattern: /出口是/, quietMs: 400 },
  finger: { pattern: /權限等級|找不到/, quietMs: 250 },
  time: { pattern: /台北時間為/, quietMs: 250 },
  inventory: { pattern: /載重\s*\d+/, quietMs: 400 },
  secure: { pattern: /標記|沒有|找不到|什麼/, quietMs: 250 },
  give: { pattern: /你給|沒有|找不到|什麼|不在|太重/, quietMs: 250 },
  sell: { pattern: /賣掉|沒有|什麼|不能/, quietMs: 1000 },
};
const ASK_MAX_MS = 8000;
const addedText = records => CatworldZapMobs.textFromAdded(records.flatMap(record => (record.type === 'characterData'
  ? [record.target.textContent || '']
  : Array.from(record.addedNodes, node => node.textContent || ''))));
function askGame(command, kind) {
  return new Promise(resolve => {
    let text = '';
    let sent = false;
    let quiet = null;
    let limit = null;
    const done = () => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(limit);
      resolve(text);
    };
    const observer = new MutationObserver(records => {
      if (!sent) return;
      text += addedText(records);
      if (ASK[kind].pattern.test(text)) {
        clearTimeout(quiet);
        quiet = setTimeout(done, ASK[kind].quietMs);
      }
    });
    observer.observe(document.getElementById('content'), { subtree: true, childList: true, characterData: true });
    limit = setTimeout(done, ASK_MAX_MS);
    enqueue(command, 'hunt', null, () => { sent = true; });
  });
}
// 不算「別人」的 ID：設定頁的白名單加上自動學到的 NPC
async function learnedNpcs() {
  const list = (await chrome.storage.local.get(CatworldMapHunt.NPCS_KEY))[CatworldMapHunt.NPCS_KEY];
  return Array.isArray(list) ? list.filter(id => typeof id === 'string') : [];
}
// 回傳小寫的 ID 集合（英文 ID 不分大小寫）
async function huntNpcs() {
  const { [CatworldMapHunt.SETTINGS_KEY]: saved } = await chrome.storage.local.get(CatworldMapHunt.SETTINGS_KEY);
  return new Set([...CatworldMapHunt.splitIds(CatworldMapHunt.normalizeSettings(saved).npcWhitelist), ...await learnedNpcs()].map(id => id.toLowerCase()));
}
async function learnHuntNpc(id) {
  const learned = await learnedNpcs();
  const name = id.toLowerCase();
  if (!learned.some(known => known.toLowerCase() === name)) await chrome.storage.local.set({ [CatworldMapHunt.NPCS_KEY]: [...learned, name] });
}
// 掃描走過的房間：讀改寫排成一條佇列（連續幾間很快，各自先讀再寫會互相蓋掉）
let visitedWrite = Promise.resolve();
function markHuntVisited(key, state) {
  visitedWrite = visitedWrite.catch(() => {}).then(async () => {
    const stored = CatworldMapHunt.normalizeVisited((await chrome.storage.local.get(CatworldMapHunt.VISITED_KEY))[CatworldMapHunt.VISITED_KEY]);
    await chrome.storage.local.set({ [CatworldMapHunt.VISITED_KEY]: { ...stored, [key]: { at: Date.now(), state } } });
  });
  return visitedWrite;
}
// 手動蒐集的觀察器在巡怪、掃描進行中暫停（見 map-collect.js 的 setSuspended）
CatworldMapCollect.setSuspended(() => hunt?.on() ?? false);
// 地圖巡怪：目標是面板「選怪」勾選的怪（map-hunt-ui.js，依區域記在 mapHuntPicks）與地圖目前顯示的區域；指令走共用送出佇列（來源 hunt）
hunt = CatworldMapHunt.create({
  target: async () => {
    const area = CatworldMapHuntUI.visibleArea(document);
    const { mapHuntPicks } = await chrome.storage.local.get(CatworldMapHuntUI.PICKS_KEY);
    // 儲存裡留著、但這個區域已經沒有蒐集到的怪（資料清掉了）不算
    const here = CatworldMapHuntUI.mobsOfArea(await mapStore(), area);
    return { area, mobs: CatworldMapHuntUI.pickedFor(mapHuntPicks, area).filter(mob => here.includes(mob)) };
  },
  room: () => CatworldMapCollect.currentRoom(document)?.key ?? null,
  areaHtml: area => document.getElementById(`m-${area}`)?.innerHTML ?? '',
  readStore: mapStore,
  learnVisit: async (key, seen, picked) => {
    const storageKey = CatworldMapCollect.STORAGE_KEY;
    const at = key.indexOf('/');
    const store = (await chrome.storage.local.get(storageKey))[storageKey] || {};
    // picked 是 null＝掃描：這間記錄的每一隻怪都要驗證（沒看到就累計，連續三次才拿掉）
    const checked = picked ?? (CatworldMapCollect.withBuiltin(store)[key]?.mobs || []);
    const result = CatworldMapCollect.visit(store, { key, area: key.slice(0, at), room: key.slice(at + 1) }, seen, checked, Date.now());
    if (result.changed) {
      await chrome.storage.local.set({ [storageKey]: result.store });
      console.log('[catworld] 巡怪修正位置：', key, result.removed.length ? `移除 ${result.removed.join('、')}` : '', result.added.length ? `新增 ${result.added.join('、')}` : '');
    }
    return result;
  },
  visited: async () => (await chrome.storage.local.get(CatworldMapHunt.VISITED_KEY))[CatworldMapHunt.VISITED_KEY] ?? {},
  markVisited: markHuntVisited,
  ask: askGame,
  // 整理用：從鑑定輸出裡挑出要留的裝備名稱（比現在穿的好或屬性達門檻、沒基準的，武器只留主要武器職業的）
  keepers: async text => {
    const E = CatworldZapEquipment;
    const data = await chrome.storage.local.get(['wornEquipment', 'mainWeapon', 'equipmentKeep']);
    const worn = data.wornEquipment?.[characterName()];
    return E.pickKeepers(E.parseEquipmentBlocks(text), { baselineOf: category => worn?.[category], mainWeapon: data.mainWeapon, exp: readGameNumber('exp'), keep: E.normalizeKeepRule(data.equipmentKeep) }).map(block => block.name);
  },
  npcs: huntNpcs,
  learnNpc: learnHuntNpc,
  // 遊戲的冷卻條（#perform 特攻、#busy 忙碌）：伺服器送 GMCP cooldown 時，遊戲 web.js 的 cooldown() 把元素的 innerHTML 換成一個新的子 div，
  // 帶 animation-duration（web.css 的 @keyframes cooldown 從寬 100% 跑到 0，跑一次）。子 div 的 CSS 動畫還在跑＝冷卻中；讀不到元素或動畫＝不在冷卻
  cooling: cooldownRunning,
  // 角色忙碌：狀態欄（#status）是「忙碌」開頭（遊戲可能寫「忙碌:3」），或忙碌冷卻條（#busy）在跑
  busy: () => /^忙碌/.test(readStatus() ?? '') || cooldownRunning('busy'),
  now: () => Date.now(),
  macroRunning: () => [...macroRuns].some(run => run.owner === 'hunt'),
  exits: async () => (await chrome.storage.local.get(CatworldMapHunt.EXITS_KEY))[CatworldMapHunt.EXITS_KEY] ?? {},
  saveExits: learned => chrome.storage.local.set({ [CatworldMapHunt.EXITS_KEY]: learned }),
  // 巡怪開始時讀的設定，間隔也在這時更新（送出佇列用 huntSettings）
  settings: async () => (huntSettings = CatworldMapHunt.normalizeSettings((await chrome.storage.local.get(CatworldMapHunt.SETTINGS_KEY))[CatworldMapHunt.SETTINGS_KEY])),
  watch: handler => {
    const observer = new MutationObserver(records => handler(addedText(records)));
    observer.observe(document.getElementById('content'), { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  },
  // 精、神這類讀數的百分比（和觸發規則讀同一份）；讀不到回 NaN
  percent: name => {
    const stat = readStat(name);
    return stat && stat.max > 0 ? (stat.value / stat.max) * 100 : NaN;
  },
  // 精氣神的傷勢 %（有效÷最大）：遊戲狀態區 #max_gin、#max_kee、#max_sen 那格顯示的就是這個百分比（遊戲 vitals.js 的 get_percent）；讀不到回 NaN
  injury: name => readGameNumber({ 精: 'max_gin', 氣: 'max_kee', 神: 'max_sen' }[name]),
  kee: () => {
    const stat = readStat('氣');
    return stat && stat.max > 0 ? (stat.value / stat.max) * 100 : NaN;
  },
  send: (command, onSent) => {
    const text = expandHuntCommand(command);
    if (text.trim()) queueCommand(text, 'hunt', onSent);
    return true;
  },
  // 停止後才送的回家指令：用巨集（執行中算 active()，佇列才送得出去），owner 不是 hunt，所以停止巡怪時不會被一起取消
  sendAfterStop: command => {
    const text = expandHuntCommand(command);
    return text.trim() ? startMacro(text, 'hunt-home') : false;
  },
  dropQueue: () => { dropQueue('hunt'); cancelMacros('hunt'); },
  alert: reason => alertOnly(reason, '⚠ 巡怪已停止'),
  notify: () => renderPanel(),
});

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
// 置頂浮窗上次調整後的大小：只存在這台瀏覽器的本機儲存
const PIP_SIZE_KEY = 'pipSize';
let panel = null;
// 面板最上方的「數值」區塊（stats-block.js）
let statsBlock = null;
let statsRenderFailed = false;
function initPanel() {
  // 頁面上殘留的面板（舊程式留下的孤兒）先拿掉，不要疊出第二個；它如果把面板搬進了置頂視窗，那個視窗也關掉
  removeStalePanels(document);
  try {
    globalThis.documentPictureInPicture?.window?.close();
  } catch {
    // 沒有置頂視窗
  }
  const host = document.createElement('div');
  host.setAttribute(HOST_ATTR, '');
  panelHost = host;
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
      .toggle, .gear, .pip { all: unset; cursor: pointer; padding: 0 6px; color: #aaa; font-size: 20px; line-height: 1; }
      /* 置頂按鈕是「彈出」圖示（方框加往右上的箭頭）；面板在浮窗裡時換成箭頭往回的圖示 */
      .pip { display: inline-flex; }
      .pip svg { width: 16px; height: 16px; display: block; }
      .pip .in, .pip[data-open] .out { display: none; }
      .pip[data-open] .in { display: block; }
      .pip[hidden] { display: none; }
      .confirm { all: unset; cursor: pointer; padding: 2px 12px; border-radius: 6px; background: #d9382c; color: #fff; font-size: 14px; font-weight: 700; }
      .confirm:hover { background: #ef4a3d; }
      .confirm[hidden] { display: none; }
      .gear { font-size: 18px; }
      .gear:hover, .toggle:hover, .pip:hover { color: #fff; }
      .body { padding: 0 12px 12px; }
      .line { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; }
      .line .t { font-weight: 600; min-width: 40px; padding-top: 3px; }
      .line .s { flex: 1; min-width: 0; color: #bbb; font-size: 15px; overflow-wrap: anywhere; white-space: pre-line; padding-top: 4px; }
      .line .s.alert { color: #ff8a7a; }
      .line .s.warn { color: #ffb347; }
      /* 巡怪、巨集這兩行有按鈕：文字跟按鈕擠在同一列會被擠成又窄又高的一條，所以標籤與按鈕在第一列、狀態文字獨佔下面一整列 */
      .line.hunt-line, .line.macro-line { flex-wrap: wrap; row-gap: 2px; }
      .hunt-line .s, .macro-line .s { order: 3; flex: 1 1 100%; padding-top: 0; }
      .hunt-line .mini, .macro-line .mini { margin-left: auto; }
      .macro-line .s:empty { display: none; }
      .mini { display: flex; gap: 6px; flex: none; }
      .mini button { all: unset; text-align: center; padding: 3px 12px; border-radius: 6px;
        background: #3a3a3e; cursor: pointer; font-size: 14px; font-weight: 600; }
      .mini button.start, .mini button.tstart, .mini button.rstart, .mini button.istart { background: #2f7d4a; }
      .mini button[disabled] { opacity: .35; cursor: default; }
      .line[hidden] { display: none; }
      .hunt-pick-list { max-height: 150px; overflow-y: auto; font-size: 14px; }
      .hunt-pick-list label { display: block; cursor: pointer; }
      .collapsed .body { display: none; }
      /* 面板在置頂浮窗裡（宿主帶 data-pip）：拖曳與收合沒有意義（視窗可以自己縮放），而且收合過的面板在浮窗裡不能卡在收合 */
      :host([data-pip]) .toggle { display: none; }
      :host([data-pip]) .head { cursor: default; }
      :host([data-pip]) .collapsed .body { display: block; }
    </style>
    <div class="panel">
      <div class="head"><span class="dot"></span><span class="label"></span><button class="confirm" hidden title="停止提示音與標題閃爍">確認</button><button class="pip" title="用永遠置頂的小視窗顯示面板" aria-label="置頂"><svg class="out" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3H3.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V9"/><path d="M9.5 2.5h4v4M13.5 2.5l-6 6"/></svg><svg class="in" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3H3.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V9"/><path d="M11.5 8.5h-4v-4M7.5 8.5l6-6"/></svg></button><button class="gear" title="開啟／關閉設定頁">⚙</button><button class="toggle" title="收合／展開">–</button></div>
      <div class="body">
        <div class="line"><span class="t">定時</span><span class="s timer-text"></span>
          <span class="mini"><button class="start">開始</button><button class="stop">停止</button></span></div>
        <div class="line"><span class="t">隨機</span><span class="s random-text"></span>
          <span class="mini"><button class="rstart">開始</button><button class="rstop">停止</button></span></div>
        <div class="line"><span class="t">Idle</span><span class="s idle-text"></span>
          <span class="mini"><button class="istart">開始</button><button class="istop">停止</button></span></div>
        ${groupList.map(group => `<div class="line" data-group="${group.id}"><span class="t">${group.name}</span><span class="s trigger-text"></span>
          <span class="mini"><button class="tstart">開始</button><button class="tstop">停止</button></span></div>`).join('\n        ')}
        <div class="line macro-line"><span class="t">巨集</span><span class="s macro-text"></span>
          <span class="mini"><button class="mstop">停止</button></span></div>
        <div class="line hunt-line"><span class="t">巡怪</span><span class="s hunt-text"></span>
          <span class="mini"><button class="hstart" title="巡視勾選的怪出現過的房間">開始</button><button class="hscan" title="街景模式：不用選怪，走這一區還沒走過的每一間，看一眼並記下有哪些怪（不打）">掃描</button><button class="hstop">停止</button></span></div>
        <div class="line reward-line" hidden><span class="t">獎勵</span><span class="s reward-text"></span></div>
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
    randomText: $('.random-text'), rstart: $('.rstart'), rstop: $('.rstop'),
    idleText: $('.idle-text'), istart: $('.istart'), istop: $('.istop'),
    macroText: $('.macro-text'), mstop: $('.mstop'),
    huntText: $('.hunt-text'), hstart: $('.hstart'), hscan: $('.hscan'), hstop: $('.hstop'),
    rewardLine: $('.reward-line'), rewardText: $('.reward-text'),
    confirm: $('.confirm'),
  };
  // 「數值」區塊放在面板最上方；壞了不能牽連後面開始／停止按鈕的綁定
  try {
    statsBlock = CatworldStatsBlock.attach(root);
  } catch (error) {
    console.error('[catworld] 數值區塊初始化失敗', error);
  }
  // 「密語」區塊（只在置頂浮窗顯示）放在數值區塊上面；壞了一樣不能牽連後面的綁定
  try {
    whisperBlock = CatworldWhisperBlock.attach(root);
    // 配色（設定頁選，缺值＝橘）：啟動時讀一次，之後設定頁改了馬上跟著變
    chrome.storage.local.get('whisperColor').then(data => whisperBlock?.setColor(data.whisperColor)).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.whisperColor) whisperBlock?.setColor(changes.whisperColor.newValue);
    });
  } catch (error) {
    console.error('[catworld] 密語區塊初始化失敗', error);
  }
  // 「怪物」列：讀 #exp 列出適合打的怪、怪物出現時顯示資訊（資料由 background 提供）
  // 怪物列壞了不能牽連後面開始／停止按鈕的綁定
  let zapPanel = null;
  try {
    zapPanel = CatworldZapPanel.attach(root, { startSteps: text => startMacro(text), readExp: () => Number((document.getElementById('exp')?.textContent || '').replace(/[,\s]/g, '')) });
  } catch (error) {
    console.error('[catworld] 怪物列初始化失敗', error);
  }
  // 「解謎」列：狀態讀不到要給 NaN（不是 0），否則會被當成「經驗／內力不夠」；「送出」走巨集（算 active()、驗證碼時取消）
  const readNumber = readGameNumber;
  let riddleUI = null;
  try {
    riddleUI = CatworldZapRiddleUI.attach(root, {
      readStats: () => ({ exp: readNumber('exp'), force: readNumber('max_force') }),
      startSteps: text => startMacro(text),
    });
  } catch (error) {
    console.error('[catworld] 解謎列初始化失敗', error);
  }
  // 「拜師」列：搜導師、功法、心法（資料內建，不經 background）；壞了不能牽連後面按鈕的綁定
  let mentorUI = null;
  try {
    mentorUI = CatworldMentorUI.attach(root, { startSteps: text => startMacro(text) });
  } catch (error) {
    console.error('[catworld] 拜師列初始化失敗', error);
  }
  // 「裝備」列：借用怪物列的浮層區段；讀取目前穿著送的 i／view 也走巨集
  let equipmentUI = null;
  try {
    if (!zapPanel) throw new Error('怪物列沒有初始化，裝備列借用不到浮層');
    equipmentUI = CatworldZapEquipmentUI.attach(root, {
      overlay: { section: zapPanel.sections.equipment, touchHint: zapPanel.touchHint, el: zapPanel.el },
      readExp: () => readNumber('exp'),
      startSteps: text => startMacro(text),
    });
  } catch (error) {
    console.error('[catworld] 裝備列初始化失敗', error);
  }
  // 怪物／鑑定（含裝備比較）／解謎三組功能的開關，預設全關；popup 設定頁改了馬上生效
  const applyZapFeatures = features => {
    zapPanel?.setEnabled({ mobs: features?.mobs === true, items: features?.items === true });
    equipmentUI?.setEnabled(features?.items === true);
    riddleUI?.setEnabled(features?.riddles === true);
    mentorUI?.setEnabled(features?.masters === true);
    whisperBlock?.setEnabled(features?.whisper !== false);
    // 地圖巡怪：預設關閉，關著時整個「巡怪」列（含選怪清單）藏起來；關掉時正在巡就停下來
    const huntOn = features?.hunt === true;
    root.querySelector('.hunt-line').hidden = !huntOn;
    if (!huntOn) {
      const pickBox = root.querySelector('.hunt-pick');
      if (pickBox) pickBox.hidden = true;
      if (hunt.on()) hunt.stop('巡怪功能已在設定頁關閉，已停止');
    }
  };
  applyZapFeatures(null);
  chrome.storage.local.get('zapFeatures').then(data => applyZapFeatures(data.zapFeatures)).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.zapFeatures) applyZapFeatures(changes.zapFeatures.newValue);
  });

  // 點面板不要讓遊戲輸入框失去游標
  root.addEventListener('mousedown', e => e.preventDefault());
  // 面板的「開始」每次都重新讀儲存的設定：設定頁每改一個欄位就存，但這裡的 settings 與 group.config 只在頁面載入時讀過一次，
  // 直接用會跑到改之前的舊設定
  panel.start.addEventListener('click', async () => {
    if (running) return;
    const { settings: saved } = await chrome.storage.local.get('settings');
    if (saved) settings = { ...settings, ...saved };
    if (running) return;
    if (!fixedItems().length) {
      stop('尚未設定固定指令，請先在 popup 設定');
      return;
    }
    start(settings);
  });
  panel.stop.addEventListener('click', () => { if (running) stop(); });
  panel.rstart.addEventListener('click', async () => {
    if (randomRunning) return;
    const { settings: saved } = await chrome.storage.local.get('settings');
    if (saved) settings = { ...settings, ...saved };
    if (randomRunning) return;
    if (!randomItems().length) {
      stopRandom('尚未設定隨機指令，請先在 popup 設定');
      return;
    }
    startRandom(settings);
  });
  panel.rstop.addEventListener('click', () => { if (randomRunning) stopRandom(); });
  panel.istart.addEventListener('click', async () => {
    if (idleState) return;
    const { idleSettings: saved } = await chrome.storage.local.get('idleSettings');
    if (!idleState) startIdle(saved);
  });
  panel.istop.addEventListener('click', () => { if (idleState) cancelIdle(); });
  groupList.forEach(group => {
    const row = panel.groups[group.id];
    row.start.addEventListener('click', async () => {
      if (group.on) return;
      const saved = CatworldTriggerEngine.loadGroupSettings(await chrome.storage.local.get(['triggerGroupSettings', 'triggerSettings']));
      if (saved[group.id]) group.config = saved[group.id];
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
  // 「選怪」：勾選清單；壞了不能牽連後面按鈕的綁定
  try {
    CatworldMapHuntUI.attach(root, {
      readStore: mapStore,
      readPicks: async () => (await chrome.storage.local.get(CatworldMapHuntUI.PICKS_KEY))[CatworldMapHuntUI.PICKS_KEY],
      writePicks: picks => chrome.storage.local.set({ [CatworldMapHuntUI.PICKS_KEY]: picks }),
      relayout: () => panel.replace(),
    });
  } catch (error) {
    console.error('[catworld] 選怪清單初始化失敗', error);
  }
  panel.hstart.addEventListener('click', async () => {
    if (hunt.on()) return;
    armDetection();
    await hunt.start();
  });
  panel.hscan.addEventListener('click', async () => {
    if (hunt.on()) return;
    armDetection();
    await hunt.start({ scan: true });
  });
  panel.hstop.addEventListener('click', () => hunt.stop());
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
    // 面板在置頂浮窗裡時，主頁面的視窗大小與位置計算都不能碰它
    if (host.ownerDocument !== document) return;
    if (ui.left !== null && ui.top !== null) place(ui.left, ui.top);
  };
  panel.replace = replace;
  // 遊戲自己的浮動視窗（地圖、狀態、巨集、設定）是玩家拖到哪就固定在哪，沒打開時是 visibility:hidden 但仍佔位置。
  // 使用者沒有自己拖過面板時，只避開「現在看得見、而且在畫面內」的視窗：先試預設位置，
  // 重疊就排到它們下方，放不下再排到左邊，都放不下才留在原位
  panel.avoidMap = () => {
    if (host.ownerDocument !== document) return;
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
  // 置頂浮窗：把整個面板搬進永遠置頂的小視窗（Document Picture-in-Picture），關掉就搬回來。
  // 沒有這個 API（舊瀏覽器、或擴充功能環境不給）就隱藏按鈕；開不了的原因顯示在巨集列的提示區
  let pipWindow = null;
  const pip = CatworldPip.create({
    host,
    pipApi: globalThis.documentPictureInPicture,
    sizeStore: {
      load: async () => (await chrome.storage.local.get(PIP_SIZE_KEY))[PIP_SIZE_KEY],
      save: size => chrome.storage.local.set({ [PIP_SIZE_KEY]: size }),
    },
    notify: text => { macroNote = { text, until: Date.now() + 8000 }; renderPanel(); },
    onChange: (open, win) => {
      $('.pip').toggleAttribute('data-open', open);
      $('.pip').title = open ? '收回面板到遊戲頁' : '用永遠置頂的小視窗顯示面板';
      $('.pip').setAttribute('aria-label', open ? '收回' : '置頂');
      // 浮窗裡的互動也算玩家有互動（警報提示靠它停止）；關掉時把它拿掉
      if (open) { pipWindow = win; interactionHub.addWindow(win); }
      else if (pipWindow) { interactionHub.removeWindow(pipWindow); pipWindow = null; }
      // 搬回來之後重新排：面板在浮窗期間主視窗可能被縮小過，不重排會跑到畫面外或蓋住遊戲視窗
      if (!open) { replace(); panel.avoidMap(); }
    },
  });
  $('.pip').hidden = !pip.supported;
  if (!pip.supported) console.info('[catworld] 這個環境沒有 documentPictureInPicture，已隱藏「置頂」按鈕');
  $('.pip').addEventListener('click', () => { pip.toggle(); });
  $('.toggle').addEventListener('click', () => {
    ui.collapsed = !ui.collapsed;
    panel.box.classList.toggle('collapsed', ui.collapsed);
    $('.toggle').textContent = ui.collapsed ? '+' : '–';
    replace();
    saveUi(ui);
  });
  $('.head').addEventListener('pointerdown', e => {
    if (e.target.closest('.toggle, .gear, .confirm, .pip')) return;
    // 面板在置頂浮窗裡時不能拖：座標是浮窗的，會被存成面板位置、之後主頁面的位置就壞了
    if (host.ownerDocument !== document) return;
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

// 這一組有讀不到的 @巨集 N 時，把警告放在觸發列最前面（紅字，一直顯示；每秒重算，巨集修好就消失）
function triggerSummary(group) {
  const summary = triggerSummaryBase(group);
  const warnings = macroWarnings(group);
  return warnings.length ? { ...summary, text: `⚠ ${warnings.join('；')}\n${summary.text}`, alert: true } : summary;
}
function triggerSummaryBase(group) {
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

// 巨集列：有巨集在跑就顯示「還有幾秒、下一個指令」，格式錯誤沒有執行時顯示原因 8 秒；都沒有就只剩列上的按鈕（匯出等），狀態文字是空的
function macroSummary() {
  if (!macroRuns.size) {
    if (macroNote && Date.now() < macroNote.until) return { text: macroNote.text, alert: true };
    macroNote = null;
    return null;
  }
  const run = [...macroRuns][0];
  const more = macroRuns.size > 1 ? `（共 ${macroRuns.size} 個巨集）` : '';
  if (run.frozen) return { text: `暫停中（最優先的指令執行中）${more}`, alert: false };
  if (run.waitUntil) {
    const left = Math.max(0, Math.ceil((run.waitUntil - Date.now()) / 1000));
    return { text: `等待 ${left} 秒後${run.nextCommand === null ? '結束' : `：${run.nextCommand}`}${more}`, alert: false };
  }
  return { text: `送出中…${more}`, alert: false };
}

function renderPanel() {
  if (!panel) return;
  if (!contextAlive(chrome)) {
    retire();
    return;
  }
  // 數值區塊：和觸發規則讀的是同一份（readAllStats 用的就是引擎的 readStat）；壞了不能影響面板其他部分
  try {
    if (statsBlock) {
      statsBlock.setTheme(readMonitorTheme());
      statsBlock.render(readAllStats(), readGameNumber('exp'));
    }
  } catch (error) {
    // 每秒都會跑：出錯只印第一次，不要洗版
    if (!statsRenderFailed) console.error('[catworld] 數值區塊更新失敗', error);
    statsRenderFailed = true;
  }
  const captchaStopped = !active() && /驗證/.test(stopReason);
  const summaries = groupList.map(group => triggerSummary(group));
  const anyAlert = summaries.some(summary => summary.alert);
  const disabledTotal = summaries.reduce((total, summary) => total + summary.disabled, 0);
  panel.dot.className = `dot ${anyAlert || captchaStopped ? 'alert' : active() ? 'on' : ''}`;
  const label = anyAlert ? `觸發已停用 ${disabledTotal} 條` : active() ? '執行中' : '已停止';
  panel.label.textContent = ringing ? `${label}・響鈴中` : label;
  panel.confirm.hidden = !ringing;
  let timerText = stopReason || '未啟動';
  let randomText = timerText;
  const left = at => `${Math.max(0, Math.ceil((at - Date.now()) / 1000))} 秒後`;
  if (running) {
    // 倒數與「到時候要執行哪些指令」：固定指令每一項一行
    timerText = idlePaused ? 'Idle 中，暫停' : fixedRuns.map(run => `固定 ${left(run.at)}：${run.item.command}`).join('\n') || '執行中';
  }
  if (randomRunning) randomText = idlePaused ? 'Idle 中，暫停' : nextRandomAt ? `隨機 ${left(nextRandomAt)}：${nextRandomCommand}` : '執行中';
  const idleText = !idleState ? '未啟動' : idleState.phase === 'idling' ? `Idle 中，${left(idleState.at)}繼續` : `${left(idleState.at)}進入 idle`;
  if (captcha) {
    timerText = captcha.answer ? `驗證碼：已送出 ${captcha.answer}（第 ${captcha.attempts} 次），等遊戲回應…`
      : captcha.sendTimer ? `驗證碼：讀到 ${captcha.read}，${captcha.sendSeconds} 秒後送出…`
        : '驗證碼：等圖印完再自動辨識…';
  }
  let changed = panel.timerText.textContent !== timerText;
  panel.timerText.textContent = timerText;
  if (panel.randomText.textContent !== randomText) changed = true;
  panel.randomText.textContent = randomText;
  if (panel.idleText.textContent !== idleText) changed = true;
  panel.idleText.textContent = idleText;
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
  const macroText = macro?.text ?? '';
  if (panel.macroText.textContent !== macroText) {
    panel.macroText.textContent = macroText;
    panel.replace();
  }
  panel.macroText.classList.toggle('alert', Boolean(macro?.alert));
  const rewardText = rewardSummary();
  if (panel.rewardText.textContent !== rewardText) {
    panel.rewardText.textContent = rewardText;
    panel.rewardLine.hidden = !rewardText;
    panel.replace();
  }
  const huntInfo = hunt.summary();
  if (panel.huntText.textContent !== huntInfo.text) {
    panel.huntText.textContent = huntInfo.text;
    panel.replace();
  }
  panel.huntText.classList.toggle('alert', huntInfo.alert);
  panel.huntText.title = huntInfo.detail || '';
  panel.hstart.disabled = hunt.on();
  panel.hscan.disabled = hunt.on();
  panel.hstop.disabled = !hunt.on();
  panel.mstop.disabled = !macroRuns.size;
  panel.avoidMap();
  panel.timerText.classList.toggle('alert', captchaStopped);
  panel.start.disabled = running;
  panel.stop.disabled = !running;
  panel.rstart.disabled = randomRunning;
  panel.rstop.disabled = !randomRunning;
  panel.istart.disabled = Boolean(idleState);
  panel.istop.disabled = !idleState;
  const stateKey = [running, randomRunning, idleState?.phase, ...groupList.map(group => group.on), macroRuns.size > 0, hunt.on()].join();
  if (lastStateKey !== null && stateKey !== lastStateKey) notifyStateChanged();
  lastStateKey = stateKey;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 設定頁的巨集匯入匯出：遊戲把巨集存在這個頁面的 localStorage.MACROS，設定頁（擴充功能自己的頁面）讀不到，由這裡代讀代寫。
  // 寫入不檢查內容：還原上一份時要原樣寫回遊戲讀不懂的備份（設定頁已經先警告過）。閒置時也要能用，所以不看 active()
  // 設定頁「複製巡怪紀錄」：紀錄在這個頁面的巡怪引擎裡，由這裡代讀
  if (message.type === 'HUNT_LOG') {
    sendResponse({ ok: true, text: hunt?.exportLog?.() ?? '' });
    return;
  }
  if (message.type === 'MACRO_READ') {
    try {
      sendResponse({ ok: true, raw: window.localStorage.getItem('MACROS') });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return;
  }
  if (message.type === 'MACRO_WRITE') {
    if (typeof message.raw !== 'string') { sendResponse({ ok: false, error: '沒有要寫的巨集文字' }); return; }
    try {
      window.localStorage.setItem('MACROS', message.raw);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return;
  }
  if (message.type === 'START') {
    start(message.settings).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'STOP') {
    stop().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'START_RANDOM') {
    startRandom(message.settings).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'STOP_RANDOM') {
    stopRandom().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'START_IDLE') {
    startIdle(message.settings);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'STOP_IDLE') {
    cancelIdle();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'START_CHAT_SCRIPT') {
    // 只接受擴充功能自己的頁面（設定頁是開成分頁的，所以看 sender.id 與 sender.url，不能看 sender.tab）
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) { sendResponse({ ok: false, error: '不接受這個來源的訊息' }); return; }
    startScript().then(sendResponse);
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
      randomRunning,
      idle: idleState ? { phase: idleState.phase, at: idleState.at } : null,
      ringing,
      settings,
      stopReason,
      fixed: fixedRuns.map(run => ({ command: run.item.command, at: run.at })),
      nextRandomAt,
      nextRandomCommand,
      macros: macroRuns.size,
      hunt: hunt.snapshot(),
      chatScript: scriptSession ? { ...scriptSession.status(), phase: scriptTimers.size ? 'say' : 'wait' } : null,
      chatScriptAuto: scriptAutoWarm ? { phase: 'warmup', secondsLeft: Math.max(0, Math.round((scriptAutoWarmAt + CatworldChatScript.AUTO_WARMUP_MS - Date.now()) / 1000)) } : scriptAutoRoll ? { phase: 'rolling' } : null,
      stats: readAllStats(),
      triggerGroups: Object.fromEntries(groupList.map(item => [item.id, { on: item.on, note: item.note, warning: macroWarnings(item).join('；'), rules: item.on ? item.engine.snapshot().rules : [] }])),
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

// 裝備資料庫的「批次 check」：玩家在 list 摘要按了確認之後，shop-collect.js 才會呼叫這個，交給巨集執行器依序送出
globalThis.CatworldShopCollect?.setSender?.(text => startMacro(text, 'shop'));

// popup 改了「一直響到確認」開關，不用重新整理遊戲頁就生效
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.persistentAlert) persistentAlert = changes.persistentAlert.newValue === true;
  if (area === 'local' && changes[CatworldStopKeywords.KEY]) stopKeywords = CatworldStopKeywords.normalize(changes[CatworldStopKeywords.KEY].newValue);
  if (area === 'local' && changes[CatworldChatReply.SETTINGS_KEY]) {
    chatReply = CatworldChatReply.normalizeSettings(changes[CatworldChatReply.SETTINGS_KEY].newValue);
    if (!chatReply.enabled) cancelChatReplies();
  }
  if (area === 'local' && changes[CatworldChatScript.SETTINGS_KEY]) {
    const before = chatScript;
    chatScript = CatworldChatScript.normalizeSettings(changes[CatworldChatScript.SETTINGS_KEY].newValue);
    // 關掉、換角色、換對方：進行中的一場作廢
    if (!chatScript.enabled || chatScript.role !== before.role || chatScript.partner.toLowerCase() !== before.partner.toLowerCase()) cancelScript();
    if (chatScript.enabled) loadScripts();
    syncScriptAuto();
  }
  if (area === 'local' && changes[CatworldChatScript.STATE_KEY]) scriptState = CatworldChatScript.normalizeState(changes[CatworldChatScript.STATE_KEY].newValue); // 別的遊戲分頁開了一場
  if (area === 'local' && changes.autoReward) {
    autoReward = changes.autoReward.newValue !== false;
    if (!autoReward) cancelReward();
  }
});

chrome.storage.local.get(['running', 'randomRunning', 'settings', 'triggerGroupSettings', 'triggerSettings', 'persistentAlert', 'autoReward', CatworldStopKeywords.KEY, CatworldChatReply.SETTINGS_KEY, CatworldChatScript.SETTINGS_KEY, CatworldChatScript.STATE_KEY]).then(data => {
  persistentAlert = data.persistentAlert === true;
  chatReply = CatworldChatReply.normalizeSettings(data[CatworldChatReply.SETTINGS_KEY]);
  chatScript = CatworldChatScript.normalizeSettings(data[CatworldChatScript.SETTINGS_KEY]);
  scriptState = CatworldChatScript.normalizeState(data[CatworldChatScript.STATE_KEY]);
  if (chatScript.enabled) loadScripts();
  stopKeywords = CatworldStopKeywords.normalize(data[CatworldStopKeywords.KEY]);
  autoReward = data.autoReward !== false;
  if (data.settings) settings = { ...settings, ...data.settings };
  // 規則設定會留著，但開關不會：重新整理遊戲頁後觸發不會自己恢復。舊版只有一組設定，升級時放進練功
  const savedGroups = CatworldTriggerEngine.loadGroupSettings(data);
  groupList.forEach(item => { item.config = savedGroups[item.id]; });
  // Safety choice: a page reload does not silently resume automation.
  running = false;
  randomRunning = false;
  if (data.running) chrome.storage.local.set({ running: false, stopReason });
  if (data.randomRunning) chrome.storage.local.set({ randomRunning: false, stopReason });
  renderPanel();
});

initPanel();

})();

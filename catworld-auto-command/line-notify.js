// 手機通知（LINE Messaging API 的 Push）：不碰 DOM、不直接碰 chrome.*，fetch、時間與紀錄的持久化都由呼叫端注入，
// background 與測試共用。token 與 userId 是機密：不得出現在回傳的結果、console 或任何錯誤訊息裡。
(() => {
if (globalThis.CatworldLineNotify) return;

const ENDPOINT = 'https://api.line.me/v2/bot/message/push';
const REASON_MAX = 200;
const SEND_TIMEOUT_MS = 15 * 1000;
const ALERT_MAX = 300;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DEFAULT_DEDUPE_MINUTES = 10;
const DEFAULT_HOURLY_LIMIT = 10;
// 設定值的上限：沒有上限的話 1e308 分鐘會讓去重永遠不過期、每小時上限等於關掉
const MAX_DEDUPE_MINUTES = 24 * 60;
const MAX_HOURLY_LIMIT = 100;
const MAX_REASONS = 50;
const pad = value => String(value).padStart(2, '0');

// 把訊息裡的 token 與 userId 換掉：LINE 的錯誤回應與網路錯誤都可能把它們原樣帶出來
function scrub(text, secrets) {
  let result = String(text ?? '');
  secrets.filter(Boolean).forEach(secret => { result = result.split(secret).join('***'); });
  return result.slice(0, REASON_MAX);
}

// LINE 的錯誤回應是 {"message": "..."}；讀不出來就只留狀態碼
async function shortReason(response) {
  try {
    const message = JSON.parse(await response.text())?.message;
    return typeof message === 'string' ? message : '';
  } catch {
    return '';
  }
}

// 請求加逾時：LINE 掛住不回應時，不能讓後面排隊的警報跟著永遠送不出去
async function send({ fetchImpl, token, userId, text, now, timeoutMs = SEND_TIMEOUT_MS }) {
  const cleanToken = String(token ?? '').trim();
  const cleanUserId = String(userId ?? '').trim();
  const secrets = [cleanToken, cleanUserId, token, userId];
  if (!cleanToken || !cleanUserId) {
    return { at: now(), ok: false, status: 0, reason: '請先填 token 與 userId' };
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${cleanToken}` },
      body: JSON.stringify({ to: cleanUserId, messages: [{ type: 'text', text }] }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    return { at: now(), ok: response.ok, status: response.status, reason: response.ok ? '' : scrub(await shortReason(response), secrets) };
  } catch (error) {
    const reason = timedOut ? `逾時（${Math.round(timeoutMs / 1000)} 秒沒有回應）` : scrub(`${error?.name ?? 'Error'}: ${error?.message ?? ''}`, secrets);
    return { at: now(), ok: false, status: 0, reason };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 設定裡的數字不合理（空、0、負數、不是數字、布林之類）就用預設值，太大就夾到上限
function limit(value, fallback, max) {
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  const number = Number(value);
  if (value === '' || !Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(number, max);
}

// 去重與每小時上限的紀錄（放在 storage.session）：每個原因最後一次推播的時間、滾動一小時內推播的時間、被略過的則數
function emptyThrottle() {
  return { lastByReason: {}, sent: [], skipped: 0 };
}

function normalizeThrottle(state) {
  return {
    lastByReason: { ...(state?.lastByReason ?? {}) },
    sent: Array.isArray(state?.sent) ? [...state.sent] : [],
    skipped: Number(state?.skipped) > 0 ? Number(state.skipped) : 0,
  };
}

// 警報推播的判斷：總開關開著、token 與 userId 都有填才算「要發」；再依去重與每小時上限決定真的發或略過。
// 訊息是「【CatWorld】原因（時:分:秒）」，不帶角色名與帳號資訊（手機鎖定畫面旁人也看得到）；原因過長就截短。
// 回傳 { send, text?, state, undo? }：state 是（已記下這一則的）更新後紀錄，被限流略過的會累計進 skipped；
// 開關關閉不算略過；undo 是「這一則沒發成功」時要還原成的紀錄（發送失敗不該佔用窗口與額度）
function decide({ settings, reason, now, state }) {
  const current = normalizeThrottle(state);
  if (!settings?.enabled || !String(settings.token ?? '').trim() || !String(settings.userId ?? '').trim()) return { send: false, state: current };

  const dedupeMs = limit(settings.dedupeMinutes, DEFAULT_DEDUPE_MINUTES, MAX_DEDUPE_MINUTES) * MINUTE_MS;
  const hourlyLimit = Math.max(1, Math.floor(limit(settings.hourlyLimit, DEFAULT_HOURLY_LIMIT, MAX_HOURLY_LIMIT)));
  // 過了視窗的就忘掉，紀錄才不會越長越大；時間在「未來」的（時鐘被往回調）也丟掉，不然會一直卡住
  const within = (time, window) => now - time >= 0 && now - time < window;
  const sent = current.sent.filter(time => within(time, HOUR_MS));
  const lastByReason = Object.fromEntries(Object.entries(current.lastByReason).filter(([, time]) => within(time, dedupeMs)));
  const key = String(reason ?? '');

  if (key in lastByReason || sent.length >= hourlyLimit) {
    return { send: false, state: { lastByReason, sent, skipped: current.skipped + 1 } };
  }
  const undo = { lastByReason: { ...lastByReason }, sent: [...sent], skipped: current.skipped };
  lastByReason[key] = now;
  sent.push(now);
  // 原因文字可能帶變動內容（座標、計數），鍵數要有上限：超過就丟最舊的
  Object.entries(lastByReason).sort((a, b) => a[1] - b[1]).slice(0, Math.max(0, Object.keys(lastByReason).length - MAX_REASONS))
    .forEach(([oldKey]) => { delete lastByReason[oldKey]; });
  const time = new Date(now);
  const shown = key.length > ALERT_MAX ? `${key.slice(0, ALERT_MAX)}…` : key;
  return {
    send: true,
    text: `【CatWorld】${shown}（${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}）`,
    state: { lastByReason, sent, skipped: current.skipped },
    undo,
  };
}

// 一則警報：不該發就 result 為 null（完全不碰網路）；send 本身不會丟錯，結果標上來源「alert」給設定頁分辨。
// persist(state) 由呼叫端提供：在請求送出「之前」先把紀錄存起來（worker 在請求途中被回收也記得），
// 發送失敗再存回還原後的紀錄；persist 壞了不能擋住警報。一律回傳最後的 state
async function notifyAlert({ fetchImpl, settings, reason, now, state, persist, timeoutMs }) {
  const decision = decide({ settings, reason, now: now(), state });
  const save = async next => { try { await persist?.(next); } catch { /* 存不進去也要把警報送出去 */ } };
  if (!decision.send) {
    // 被限流略過會讓計數增加，要存；開關關閉或憑證沒填什麼都沒變，不存
    if (decision.state.skipped > normalizeThrottle(state).skipped) await save(decision.state);
    return { result: null, state: decision.state };
  }
  await save(decision.state);
  const result = await send({ fetchImpl, token: settings.token, userId: settings.userId, text: decision.text, now, timeoutMs });
  if (!result.ok) {
    await save(decision.undo);
    return { result: { ...result, source: 'alert' }, state: decision.undo };
  }
  return { result: { ...result, source: 'alert' }, state: decision.state };
}

globalThis.CatworldLineNotify = {
  ENDPOINT, DEFAULT_DEDUPE_MINUTES, DEFAULT_HOURLY_LIMIT, MAX_DEDUPE_MINUTES, MAX_HOURLY_LIMIT,
  send, decide, notifyAlert, emptyThrottle, limit,
};
})();

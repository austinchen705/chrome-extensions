// 手機通知（LINE Messaging API 的 Push）：不碰 DOM、不直接碰 chrome.*，fetch 與時間都由呼叫端注入，
// background 與測試共用。token 與 userId 是機密：不得出現在回傳的結果、console 或任何錯誤訊息裡。
(() => {
if (globalThis.CatworldLineNotify) return;

const ENDPOINT = 'https://api.line.me/v2/bot/message/push';
const REASON_MAX = 200;

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

async function send({ fetchImpl, token, userId, text, now }) {
  const cleanToken = String(token ?? '').trim();
  const cleanUserId = String(userId ?? '').trim();
  const secrets = [cleanToken, cleanUserId, token, userId];
  if (!cleanToken || !cleanUserId) {
    return { at: now(), ok: false, status: 0, reason: '請先填 token 與 userId' };
  }
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${cleanToken}` },
      body: JSON.stringify({ to: cleanUserId, messages: [{ type: 'text', text }] }),
    });
    return { at: now(), ok: response.ok, status: response.status, reason: response.ok ? '' : scrub(await shortReason(response), secrets) };
  } catch (error) {
    return { at: now(), ok: false, status: 0, reason: scrub(`${error?.name ?? 'Error'}: ${error?.message ?? ''}`, secrets) };
  }
}

const ALERT_MAX = 300;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DEFAULT_DEDUPE_MINUTES = 10;
const DEFAULT_HOURLY_LIMIT = 10;
const pad = value => String(value).padStart(2, '0');

// 設定裡的數字不合理（空、0、負數、不是數字）就用預設值
function positive(value, fallback) {
  const number = Number(value);
  return value !== null && value !== '' && Number.isFinite(number) && number > 0 ? number : fallback;
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
// 回傳 { send, text?, state }：state 是更新後的紀錄，被限流略過的會累計進 skipped；開關關閉不算略過。
function decide({ settings, reason, now, state }) {
  const current = normalizeThrottle(state);
  if (!settings?.enabled || !String(settings.token ?? '').trim() || !String(settings.userId ?? '').trim()) return { send: false, state: current };

  const dedupeMs = positive(settings.dedupeMinutes, DEFAULT_DEDUPE_MINUTES) * MINUTE_MS;
  const hourlyLimit = Math.max(1, Math.floor(positive(settings.hourlyLimit, DEFAULT_HOURLY_LIMIT)));
  // 過了視窗的就忘掉，紀錄才不會越長越大
  const sent = current.sent.filter(time => now - time < HOUR_MS);
  const lastByReason = Object.fromEntries(Object.entries(current.lastByReason).filter(([, time]) => now - time < dedupeMs));
  const key = String(reason ?? '');

  if (key in lastByReason || sent.length >= hourlyLimit) {
    return { send: false, state: { lastByReason, sent, skipped: current.skipped + 1 } };
  }
  lastByReason[key] = now;
  sent.push(now);
  const time = new Date(now);
  const shown = key.length > ALERT_MAX ? `${key.slice(0, ALERT_MAX)}…` : key;
  return {
    send: true,
    text: `【CatWorld】${shown}（${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}）`,
    state: { lastByReason, sent, skipped: current.skipped },
  };
}

// 一則警報：不該發就 result 為 null（完全不碰網路）；send 本身不會丟錯，結果標上來源「alert」給設定頁分辨。
// 一律回傳更新後的 state，呼叫端負責存起來
async function notifyAlert({ fetchImpl, settings, reason, now, state }) {
  const decision = decide({ settings, reason, now: now(), state });
  if (!decision.send) return { result: null, state: decision.state };
  const result = await send({ fetchImpl, token: settings.token, userId: settings.userId, text: decision.text, now });
  return { result: { ...result, source: 'alert' }, state: decision.state };
}

globalThis.CatworldLineNotify = { ENDPOINT, DEFAULT_DEDUPE_MINUTES, DEFAULT_HOURLY_LIMIT, send, decide, notifyAlert, emptyThrottle };
})();

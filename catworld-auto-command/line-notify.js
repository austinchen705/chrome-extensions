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
const pad = value => String(value).padStart(2, '0');

// 警報推播的判斷：總開關開著、token 與 userId 都有填才發；訊息是「【CatWorld】原因（時:分:秒）」，
// 不帶角色名與帳號資訊（手機鎖定畫面旁人也看得到）；原因過長就截短
function decide({ settings, reason, now }) {
  if (!settings?.enabled || !String(settings.token ?? '').trim() || !String(settings.userId ?? '').trim()) return { send: false };
  const time = new Date(now);
  const clipped = String(reason ?? '');
  const shown = clipped.length > ALERT_MAX ? `${clipped.slice(0, ALERT_MAX)}…` : clipped;
  return { send: true, text: `【CatWorld】${shown}（${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}）` };
}

// 一則警報：不該發就回 null（完全不碰網路）；send 本身不會丟錯，結果標上來源「alert」給設定頁分辨
async function notifyAlert({ fetchImpl, settings, reason, now }) {
  const decision = decide({ settings, reason, now: now() });
  if (!decision.send) return null;
  const result = await send({ fetchImpl, token: settings.token, userId: settings.userId, text: decision.text, now });
  return { ...result, source: 'alert' };
}

globalThis.CatworldLineNotify = { ENDPOINT, send, decide, notifyAlert };
})();

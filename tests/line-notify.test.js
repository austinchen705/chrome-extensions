const test = require('node:test');
const assert = require('node:assert/strict');
require('../catworld-auto-command/line-notify.js');

const L = globalThis.CatworldLineNotify;
const TOKEN = 'tok/en+abc==';
const USER_ID = 'U0123456789abcdef0123456789abcdef';
const NOW = Date.UTC(2026, 9, 21, 4, 5, 6);

// 假的 fetch：記下請求、回傳指定的狀態與內容
function fakeFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { fetchImpl, calls };
}

test('a successful push goes to LINE as a bearer-authenticated text message and reports success', async () => {
  const { fetchImpl, calls } = fakeFetch(200, '{"sentMessages":[{"id":"1"}]}');
  const result = await L.send({ fetchImpl, token: TOKEN, userId: USER_ID, text: '測試', now: () => NOW });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/push');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { to: USER_ID, messages: [{ type: 'text', text: '測試' }] });
  assert.deepEqual(result, { at: NOW, ok: true, status: 200, reason: '' });
});

test('a failed push reports the status and the short reason LINE gave', async () => {
  const { fetchImpl } = fakeFetch(401, '{"message":"Authentication failed due to the following reason: invalid token."}');
  const result = await L.send({ fetchImpl, token: TOKEN, userId: USER_ID, text: 'x', now: () => NOW });
  assert.deepEqual(result, { at: NOW, ok: false, status: 401, reason: 'Authentication failed due to the following reason: invalid token.' });
});

test('a failed push with no readable message keeps just the status', async () => {
  const { fetchImpl } = fakeFetch(500, '<html>oops</html>');
  const result = await L.send({ fetchImpl, token: TOKEN, userId: USER_ID, text: 'x', now: () => NOW });
  assert.deepEqual(result, { at: NOW, ok: false, status: 500, reason: '' });
});

test('the result never contains the token or the userId, even when LINE echoes them back', async () => {
  const { fetchImpl } = fakeFetch(401, JSON.stringify({ message: `bad token ${TOKEN} for user ${USER_ID}` }));
  const result = await L.send({ fetchImpl, token: TOKEN, userId: USER_ID, text: 'x', now: () => NOW });
  const dump = JSON.stringify(result);
  assert.equal(dump.includes(TOKEN), false);
  assert.equal(dump.includes(USER_ID), false);
  assert.equal(result.status, 401);
});

test('a network error is reported without leaking the credentials either', async () => {
  const fetchImpl = async () => { throw new TypeError(`Failed to fetch https://api.line.me with ${TOKEN} and ${USER_ID}`); };
  const result = await L.send({ fetchImpl, token: TOKEN, userId: USER_ID, text: 'x', now: () => NOW });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  const dump = JSON.stringify(result);
  assert.equal(dump.includes(TOKEN), false);
  assert.equal(dump.includes(USER_ID), false);
  assert.ok(result.reason.length > 0, 'the user still sees that something failed');
});

test('missing credentials are not sent at all', async () => {
  const { fetchImpl, calls } = fakeFetch(200, '{}');
  for (const creds of [{ token: '', userId: USER_ID }, { token: TOKEN, userId: '' }, { token: '  ', userId: '  ' }, {}]) {
    const result = await L.send({ fetchImpl, ...creds, text: 'x', now: () => NOW });
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.match(result.reason, /token|userId/);
  }
  assert.equal(calls.length, 0);
});

test('a token pasted with surrounding spaces is still scrubbed from what LINE echoes back', async () => {
  const { fetchImpl, calls } = fakeFetch(401, JSON.stringify({ message: `bad token ${TOKEN}` }));
  const result = await L.send({ fetchImpl, token: `  ${TOKEN}\n`, userId: ` ${USER_ID} `, text: 'x', now: () => NOW });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`, 'the request uses the trimmed token');
});

// 串接檢查：這些是漏掉就整個功能無聲失效的接線
const fs = require('node:fs');
const path = require('node:path');
const ext = file => fs.readFileSync(path.join(__dirname, '..', 'catworld-auto-command', file), 'utf8');

test('wiring: LINE host permission, popup markup and scripts, background handler', () => {
  const manifest = JSON.parse(ext('manifest.json'));
  assert.ok(manifest.host_permissions.includes('https://api.line.me/*'));
  const popup = ext('popup.html');
  ['lineToken', 'lineUserId', 'lineTest', 'lineResult'].forEach(id => assert.match(popup, new RegExp(`id="${id}"`), id));
  assert.match(popup, /src="line-notify-ui\.js"/);
  assert.match(popup, /CatworldLineNotifyUI\.attach|line-notify-ui\.js/);
  assert.match(ext('popup.js'), /CatworldLineNotifyUI\.attach\(document\)/);
  const background = ext('background.js');
  assert.match(background, /importScripts\([^)]*'line-notify\.js'/);
  assert.match(background, /LINE_TEST/);
  // 設定頁是開成分頁的（sender.tab 有值），所以不能用「沒有 sender.tab」判斷；要看訊息是不是來自擴充功能自己的頁面
  const handler = background.split(/\r?\n/).find(line => line.includes("message?.type === 'LINE_TEST'")) ?? '';
  assert.doesNotMatch(handler, /!sender\.tab/);
  assert.match(handler, /sender\.url/);
  assert.match(handler, /chrome\.runtime\.getURL/);
});

test('wiring: the popup stores credentials in local storage only and never logs them', () => {
  const source = ext('line-notify-ui.js') + ext('line-notify.js') + ext('background.js');
  assert.doesNotMatch(source, /chrome\.storage\.sync/);
  assert.doesNotMatch(source, /console\.[a-z]+\([^)]*(token|userId|Token|UserId)/);
});

test('guard: content scripts never touch the LINE credentials', () => {
  // storage.local 預設內容 script 也讀得到（而且 onChanged 會把新值送給每個監聽者），所以只能靠「內容 script 完全不碰它」守住
  ['content.js', 'macro-notes.js', 'macro-wait.js', 'zap-panel.js', 'zap-riddle-ui.js', 'zap-equipment-ui.js', 'zap-mobs.js', 'zap-items.js', 'zap-riddles.js', 'zap-equipment.js', 'trigger-engine.js', 'timer-settings.js']
    .forEach(file => assert.doesNotMatch(ext(file), /lineNotify|lineLastResult|line-notify|CatworldLineNotify/, file));
});

test('wiring: the background always answers LINE_TEST and only trusts the extension itself', () => {
  const background = ext('background.js');
  const condition = background.split(/\r?\n/).find(line => line.includes("message?.type === 'LINE_TEST'")) ?? '';
  assert.match(condition, /sender\.id === chrome\.runtime\.id/);
  const start = background.indexOf("message?.type === 'LINE_TEST'");
  const block = background.slice(start, background.indexOf('return true;', start));
  assert.match(block, /\.catch\(/, 'a rejected storage read must still answer, or the page waits forever');
  assert.doesNotMatch(block, /console\./);
});

test('wiring: a failure in the LINE block cannot stop the rest of the popup from wiring up', () => {
  assert.match(ext('popup.js'), /try \{\s*CatworldLineNotifyUI\.attach\(document\);\s*\} catch/);
});

// ---- 通知判斷：警報要不要推到手機、訊息長什麼樣 ----
const at = (h, m, s) => new Date(2026, 9, 21, h, m, s).getTime();
const ON = { enabled: true, token: TOKEN, userId: USER_ID };

test('an alert becomes 【CatWorld】<reason>（time） only when the switch is on and both credentials are filled', () => {
  const decision = L.decide({ settings: ON, reason: '偵測到請輸入上方的數字，已停止', now: at(4, 5, 6) });
  assert.deepEqual(decision, { send: true, text: '【CatWorld】偵測到請輸入上方的數字，已停止（04:05:06）' });
});

test('nothing is sent when the switch is off or a credential is missing', () => {
  const base = { reason: 'x', now: at(1, 2, 3) };
  assert.deepEqual(L.decide({ ...base, settings: { ...ON, enabled: false } }), { send: false });
  assert.deepEqual(L.decide({ ...base, settings: { ...ON, token: '' } }), { send: false });
  assert.deepEqual(L.decide({ ...base, settings: { ...ON, userId: '   ' } }), { send: false });
  assert.deepEqual(L.decide({ ...base, settings: undefined }), { send: false });
  assert.deepEqual(L.decide({ ...base, settings: {} }), { send: false });
});

test('a very long reason is shortened so the push stays small', () => {
  const { text } = L.decide({ settings: ON, reason: '長'.repeat(1000), now: at(0, 0, 0) });
  assert.ok(text.length < 400, `got ${text.length}`);
  assert.match(text, /^【CatWorld】長+…（00:00:00）$/);
});

test('notifyAlert sends nothing and touches no network when the feature is off', async () => {
  const { fetchImpl, calls } = fakeFetch(200, '{}');
  const result = await L.notifyAlert({ fetchImpl, settings: { ...ON, enabled: false }, reason: 'x', now: () => at(1, 2, 3) });
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test('notifyAlert pushes the formatted alert and labels the result as coming from an alert', async () => {
  const { fetchImpl, calls } = fakeFetch(200, '{}');
  const result = await L.notifyAlert({ fetchImpl, settings: ON, reason: '觸發規則「氣」已停用', now: () => at(4, 5, 6) });
  assert.equal(JSON.parse(calls[0].init.body).messages[0].text, '【CatWorld】觸發規則「氣」已停用（04:05:06）');
  assert.equal(result.source, 'alert');
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
});

test('notifyAlert never throws: a failed push comes back as a failed alert result without secrets', async () => {
  const fetchImpl = async () => { throw new TypeError(`offline ${TOKEN}`); };
  const result = await L.notifyAlert({ fetchImpl, settings: ON, reason: 'x', now: () => at(4, 5, 6) });
  assert.equal(result.ok, false);
  assert.equal(result.source, 'alert');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('wiring: the popup has the master switch', () => {
  assert.match(ext('popup.html'), /id="lineEnabled"[^>]*type="checkbox"|type="checkbox"[^>]*id="lineEnabled"/);
});

test('wiring: every ALERT also goes to LINE after the system notification, and a LINE failure cannot affect it', () => {
  const background = ext('background.js');
  const start = background.indexOf("if (message.type !== 'ALERT') return;");
  assert.ok(start > 0, 'ALERT handler found');
  const block = background.slice(start, background.indexOf('chrome.notifications.onButtonClicked', start));
  const notification = block.indexOf('chrome.notifications.create');
  const line = block.indexOf('notifyLine(');
  assert.ok(notification >= 0 && line > notification, 'the system notification is created first, LINE second');
  assert.match(background, /CatworldLineNotify\.notifyAlert/);
  assert.match(background, /LINE_RESULT_KEY/);
  assert.match(block, /notifyLine\([^)]*\)\.catch\(/, 'a rejected push must never reach the ALERT handler');
});

test('wiring: results written by the test button are labelled as tests', () => {
  assert.match(ext('background.js'), /source: 'test'/);
});

test('guard: an alert is sent to the background exactly once, so the phone gets one push even while the ring repeats', () => {
  const content = ext('content.js');
  const sends = content.match(/type: 'ALERT'/g) ?? [];
  assert.equal(sends.length, 2, 'only stopAndAlert and alertOnly send ALERT');
  // 重複響鈴（startRepeatBeep）只負責響，不得再送 ALERT
  const beep = content.slice(content.indexOf('function startRepeatBeep'), content.indexOf('function startRepeatBeep') + 800);
  assert.doesNotMatch(beep, /ALERT/);
});

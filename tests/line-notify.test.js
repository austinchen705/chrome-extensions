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
  ['lineToken', 'lineUserId', 'lineTest', 'lineResult', 'lineDedupe', 'lineHourly', 'lineSkipped'].forEach(id => assert.match(popup, new RegExp(`id="${id}"`), id));
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


test('wiring: a failure in the LINE block cannot stop the rest of the popup from wiring up', () => {
  assert.match(ext('popup.js'), /try \{\s*CatworldLineNotifyUI\.attach\(document\);\s*\} catch/);
});

// ---- 通知判斷：警報要不要推到手機、訊息長什麼樣 ----
const at = (h, m, s) => new Date(2026, 9, 21, h, m, s).getTime();
const ON = { enabled: true, token: TOKEN, userId: USER_ID };

test('an alert becomes 【CatWorld】<reason>（time） only when the switch is on and both credentials are filled', () => {
  const decision = L.decide({ settings: ON, reason: '偵測到請輸入上方的數字，已停止', now: at(4, 5, 6) });
  assert.equal(decision.send, true);
  assert.equal(decision.text, '【CatWorld】偵測到請輸入上方的數字，已停止（04:05:06）');
});

test('nothing is sent when the switch is off or a credential is missing', () => {
  const base = { reason: 'x', now: at(1, 2, 3) };
  for (const settings of [{ ...ON, enabled: false }, { ...ON, token: '' }, { ...ON, userId: '   ' }, undefined, {}]) {
    const decision = L.decide({ ...base, settings });
    assert.equal(decision.send, false);
    assert.equal(decision.state.skipped, 0, 'being switched off is not a throttled skip');
  }
});

test('a very long reason is shortened so the push stays small', () => {
  const { text } = L.decide({ settings: ON, reason: '長'.repeat(1000), now: at(0, 0, 0) });
  assert.ok(text.length < 400, `got ${text.length}`);
  assert.match(text, /^【CatWorld】長+…（00:00:00）$/);
});

test('notifyAlert sends nothing and touches no network when the feature is off', async () => {
  const { fetchImpl, calls } = fakeFetch(200, '{}');
  const { result } = await L.notifyAlert({ fetchImpl, settings: { ...ON, enabled: false }, reason: 'x', now: () => at(1, 2, 3) });
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test('notifyAlert pushes the formatted alert and labels the result as coming from an alert', async () => {
  const { fetchImpl, calls } = fakeFetch(200, '{}');
  const { result } = await L.notifyAlert({ fetchImpl, settings: ON, reason: '觸發規則「氣」已停用', now: () => at(4, 5, 6) });
  assert.equal(JSON.parse(calls[0].init.body).messages[0].text, '【CatWorld】觸發規則「氣」已停用（04:05:06）');
  assert.equal(result.source, 'alert');
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
});

test('notifyAlert never throws: a failed push comes back as a failed alert result without secrets', async () => {
  const fetchImpl = async () => { throw new TypeError(`offline ${TOKEN}`); };
  const { result } = await L.notifyAlert({ fetchImpl, settings: ON, reason: 'x', now: () => at(4, 5, 6) });
  assert.equal(result.ok, false);
  assert.equal(result.source, 'alert');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('wiring: the popup has the master switch', () => {
  assert.match(ext('popup.html'), /id="lineEnabled"[^>]*type="checkbox"|type="checkbox"[^>]*id="lineEnabled"/);
});



test('guard: an alert is sent to the background exactly once, so the phone gets one push even while the ring repeats', () => {
  const content = ext('content.js');
  const sends = content.match(/type: 'ALERT'/g) ?? [];
  assert.equal(sends.length, 2, 'only stopAndAlert and alertOnly send ALERT');
  // 重複響鈴（startRepeatBeep）只負責響，不得再送 ALERT
  const beep = content.slice(content.indexOf('function startRepeatBeep'), content.indexOf('function startRepeatBeep') + 800);
  assert.doesNotMatch(beep, /ALERT/);
});

// ---- 去重與每小時上限 ----
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 21, 0, 0, 0);

// 連續餵警報，回傳每一則的判斷與最後的 state（時間以毫秒偏移 T0）
function feed(events, settings = ON) {
  let state;
  return events.map(([offset, reason]) => {
    const decision = L.decide({ settings, reason, now: T0 + offset, state });
    state = decision.state;
    return decision;
  });
}

test('the same reason within the dedupe window is sent once; after the window it can go again', () => {
  const [a, b, c, d] = feed([[0, 'A'], [9 * MIN + 59000, 'A'], [10 * MIN, 'A'], [10 * MIN + 1, 'A']]);
  assert.equal(a.send, true);
  assert.equal(b.send, false, '9:59 later is still inside the 10 minute window');
  assert.equal(c.send, true, 'exactly 10 minutes after the last push it goes again');
  assert.equal(d.send, false, 'and the window restarts from that push');
});

test('different reasons do not suppress each other', () => {
  const [a, b] = feed([[0, 'A'], [1000, 'B']]);
  assert.deepEqual([a.send, b.send], [true, true]);
});

test('at most N pushes per rolling hour; the (N+1)th is skipped, and slots free up as the hour rolls', () => {
  const settings = { ...ON, hourlyLimit: 3 };
  const events = [[0, 'a'], [MIN, 'b'], [2 * MIN, 'c'], [3 * MIN, 'd'], [HOUR - 1, 'e'], [HOUR, 'f']];
  const sends = feed(events, settings).map(decision => decision.send);
  assert.deepEqual(sends, [true, true, true, false, false, true], 'the push at minute 0 leaves the window exactly one hour later');
});

test('skipped alerts are counted, whether they hit the dedupe window or the hourly cap', () => {
  const decisions = feed([[0, 'A'], [1000, 'A'], [2000, 'A']]);
  assert.equal(decisions[2].state.skipped, 2);
  const capped = feed([[0, 'a'], [1, 'b'], [2, 'c']], { ...ON, hourlyLimit: 2 });
  assert.equal(capped[2].send, false);
  assert.equal(capped[2].state.skipped, 1);
});

test('the dedupe minutes and the hourly cap come from the settings, and nonsense values fall back to 10 and 10', () => {
  assert.equal(feed([[0, 'A'], [2 * MIN, 'A']], { ...ON, dedupeMinutes: 1 })[1].send, true);
  assert.equal(feed([[0, 'A'], [2 * MIN, 'A']], { ...ON, dedupeMinutes: 5 })[1].send, false);
  for (const bad of [0, -3, 'abc', null, NaN]) {
    assert.equal(feed([[0, 'A'], [5 * MIN, 'A']], { ...ON, dedupeMinutes: bad })[1].send, false, `dedupeMinutes ${String(bad)} falls back to 10`);
  }
  const eleven = feed(Array.from({ length: 11 }, (_, i) => [i, `r${i}`]), { ...ON, hourlyLimit: 'x' });
  assert.equal(eleven[9].send, true);
  assert.equal(eleven[10].send, false, 'the default cap is 10');
});

test('the bookkeeping stays small: old reasons are forgotten once their window has passed', () => {
  let state;
  for (let i = 0; i < 200; i += 1) state = L.decide({ settings: ON, reason: `reason ${i}`, now: T0 + i * 11 * MIN, state }).state;
  assert.ok(Object.keys(state.lastByReason).length <= 2, `kept ${Object.keys(state.lastByReason).length}`);
  assert.ok(state.sent.length <= 10);
});

test('notifyAlert returns the new state, sends only what decide allows, and never counts a skipped alert as sent', async () => {
  const { fetchImpl, calls } = fakeFetch(200, '{}');
  let state;
  const run = async reason => {
    const out = await L.notifyAlert({ fetchImpl, settings: ON, reason, now: () => T0, state });
    state = out.state;
    return out;
  };
  const first = await run('A');
  const second = await run('A');
  assert.equal(first.result.ok, true);
  assert.equal(second.result, null);
  assert.equal(calls.length, 1);
  assert.equal(state.skipped, 1);
});

// ---- code-review 發現的強化 ----
const okFetch2 = fakeFetch(200, '{}');
const clone = value => JSON.parse(JSON.stringify(value));

test('a failed push does not use up the dedupe window or the hourly allowance', async () => {
  let state;
  const run = async fetchImpl => {
    const out = await L.notifyAlert({ fetchImpl, settings: ON, reason: 'A', now: () => T0, state });
    state = out.state;
    return out;
  };
  const failed = await run(fakeFetch(500, '{}').fetchImpl);
  assert.equal(failed.result.ok, false);
  assert.deepEqual(state.sent, []);
  assert.deepEqual(state.lastByReason, {});
  const retried = await run(okFetch2.fetchImpl);
  assert.equal(retried.result.ok, true, 'the same alert can go right after the failure is fixed');
  assert.equal(state.skipped, 0, 'and it was never counted as skipped');
});

test('the record is persisted before the request goes out, and rolled back only if the push fails', async () => {
  const persisted = [];
  let seenDuringFetch;
  const fetchImpl = async () => { seenDuringFetch = clone(persisted.at(-1)); return { ok: false, status: 503, text: async () => '{}' }; };
  await L.notifyAlert({ fetchImpl, settings: ON, reason: 'A', now: () => T0, persist: state => persisted.push(clone(state)) });
  assert.deepEqual(Object.keys(seenDuringFetch.lastByReason), ['A'], 'a worker killed mid-request still remembers the push');
  assert.equal(persisted.length, 2);
  assert.deepEqual(persisted[1].lastByReason, {}, 'rolled back after the failure');
  const successPersists = [];
  await L.notifyAlert({ fetchImpl: okFetch2.fetchImpl, settings: ON, reason: 'A', now: () => T0, persist: state => successPersists.push(clone(state)) });
  assert.equal(successPersists.length, 1, 'a successful push is persisted once and not rolled back');
});

test('a broken persist callback never stops the alert from being sent', async () => {
  const { fetchImpl, calls } = fakeFetch(200, '{}');
  const { result } = await L.notifyAlert({ fetchImpl, settings: ON, reason: 'A', now: () => T0, persist: async () => { throw new Error('storage gone'); } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test('a request that never answers is cut off, so it cannot block the alerts behind it', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  });
  const result = await L.send({ fetchImpl, token: TOKEN, userId: USER_ID, text: 'x', now: () => NOW, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.match(result.reason, /逾時/);
});

test('the dedupe minutes and the hourly cap are capped, and odd types fall back to the defaults', () => {
  assert.equal(feed([[0, 'A'], [1441 * MIN, 'A']], { ...ON, dedupeMinutes: 1e308 })[1].send, true, 'one day at most');
  assert.equal(feed([[0, 'A'], [1000 * MIN, 'A']], { ...ON, dedupeMinutes: 1e308 })[1].send, false);
  const many = feed(Array.from({ length: 101 }, (_, i) => [i, `r${i}`]), { ...ON, hourlyLimit: 1e9 });
  assert.equal(many[99].send, true);
  assert.equal(many[100].send, false, 'never more than 100 an hour');
  for (const odd of [true, false, [], {}, '12abc']) {
    assert.equal(feed([[0, 'A'], [5 * MIN, 'A']], { ...ON, dedupeMinutes: odd })[1].send, false, `dedupeMinutes ${JSON.stringify(odd)} uses the default 10`);
  }
});

test('a clock that jumps backwards does not leave old records alive', () => {
  const [a, b] = feed([[0, 'A'], [-5 * MIN, 'A']]);
  assert.equal(a.send, true);
  assert.equal(b.send, true, 'the record from the "future" is dropped instead of blocking forever');
});

test('the per-reason memory is capped even when every alert has a different text', () => {
  const settings = { ...ON, hourlyLimit: 100 };
  const decisions = feed(Array.from({ length: 80 }, (_, i) => [i, `座標 ${i}`]), settings);
  assert.ok(Object.keys(decisions.at(-1).state.lastByReason).length <= 50);
});

test('persist is also called when an alert is skipped (the counter changes) but never when the feature is off', async () => {
  const persisted = [];
  const persist = state => persisted.push(clone(state));
  const base = { fetchImpl: okFetch2.fetchImpl, reason: 'A', now: () => T0, persist };
  const first = await L.notifyAlert({ ...base, settings: ON });
  persisted.length = 0;
  await L.notifyAlert({ ...base, settings: ON, state: first.state });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].skipped, 1);
  persisted.length = 0;
  await L.notifyAlert({ ...base, settings: { ...ON, enabled: false } });
  assert.equal(persisted.length, 0, 'off: nothing changed, nothing written');
});

test('wiring: the popup loads the core module before the settings script that reads its limits', () => {
  const popup = ext('popup.html');
  const core = popup.indexOf('src="line-notify.js"');
  const ui = popup.indexOf('src="line-notify-ui.js"');
  assert.ok(core >= 0 && ui > core);
});

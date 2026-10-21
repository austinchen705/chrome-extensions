// 設定頁「手機通知（LINE）」區塊的介面測試（jsdom，Chrome API 用假的）。需要 jsdom（devDependency）；沒裝就跳過。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // 沒裝 jsdom：整批跳過
}
const ui = JSDOM ? test : test.skip;

const root = path.join(__dirname, '..', 'catworld-auto-command');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
};

const TOKEN = 'tok/en+abc==';
const USER_ID = 'U0123456789abcdef0123456789abcdef';

const HTML = `<html><body>
  <input id="lineToken" type="password">
  <input id="lineUserId" type="password">
  <input id="lineEnabled" type="checkbox">
  <input id="lineDedupe" type="number">
  <input id="lineHourly" type="number">
  <div id="lineSkipped"></div>
  <button id="lineTest">發送測試訊息</button>
  <div id="lineResult"></div>
</body></html>`;

function boot({ local = {}, session = {}, reply = { at: 0, ok: true, status: 200, reason: '' }, gate = null, sendError = null } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only' });
  const w = dom.window;
  const writes = { local: [], sync: [], session: [] };
  const sent = [];
  const listeners = [];
  const area = (name, store) => ({
    get: async keys => {
      if (name === 'local' && gate) await gate;
      return Object.fromEntries([].concat(keys).map(key => [key, store[key]]).filter(([, value]) => value !== undefined));
    },
    set: async values => { writes[name].push(JSON.parse(JSON.stringify(values))); Object.assign(store, JSON.parse(JSON.stringify(values))); },
  });
  w.chrome = {
    storage: { local: area('local', { ...local }), session: area('session', { ...session }), sync: area('sync', {}), onChanged: { addListener: fn => listeners.push(fn) } },
    runtime: { sendMessage: async message => { sent.push(message); if (sendError) throw new Error(sendError); return reply; } },
  };
  w.eval(fs.readFileSync(path.join(root, 'line-notify-ui.js'), 'utf8'));
  w.CatworldLineNotifyUI.attach(w.document);
  const $ = id => w.document.getElementById(id);
  const type = (id, value) => { $(id).value = value; $(id).dispatchEvent(new w.Event('input', { bubbles: true })); };
  return { w, $, type, writes, sent, listeners };
}

ui('saved credentials come back into the masked fields, and typing saves them to local storage only', async () => {
  const { $, type, writes } = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID } } });
  assert.ok(await waitFor(() => $('lineToken').value === TOKEN));
  assert.equal($('lineUserId').value, USER_ID);
  assert.equal($('lineToken').type, 'password');
  assert.equal($('lineUserId').type, 'password');
  type('lineToken', '  newtoken ');
  assert.ok(await waitFor(() => writes.local.length > 0));
  assert.equal(JSON.stringify(writes.local.at(-1)), JSON.stringify({ lineNotify: { token: 'newtoken', userId: USER_ID, enabled: false, dedupeMinutes: 10, hourlyLimit: 10 } }));
  assert.equal(writes.sync.length, 0, 'never written to sync storage');
});

const clock = (h, m, s) => new Date(2026, 9, 21, h, m, s).getTime();

ui('the test button asks the background to send and shows a success result', async () => {
  const { $, sent } = boot({
    local: { lineNotify: { token: TOKEN, userId: USER_ID } },
    reply: { at: clock(4, 5, 6), ok: true, status: 200, reason: '' },
  });
  assert.ok(await waitFor(() => $('lineToken').value === TOKEN));
  $('lineTest').click();
  assert.ok(await waitFor(() => /成功/.test($('lineResult').textContent)));
  assert.equal(JSON.stringify(sent), JSON.stringify([{ type: 'LINE_TEST' }]), 'the credentials stay in storage, they are not put in the message');
  assert.match($('lineResult').textContent, /04:05:06/);
  assert.match($('lineResult').textContent, /HTTP 200/);
  assert.match($('lineResult').textContent, /成功/);
});

ui('a failed send shows the status and the short reason', async () => {
  const { $ } = boot({
    local: { lineNotify: { token: TOKEN, userId: USER_ID } },
    reply: { at: clock(4, 5, 6), ok: false, status: 401, reason: 'Authentication failed' },
  });
  assert.ok(await waitFor(() => $('lineToken').value === TOKEN));
  $('lineTest').click();
  assert.ok(await waitFor(() => /失敗/.test($('lineResult').textContent)));
  assert.match($('lineResult').textContent, /HTTP 401/);
  assert.match($('lineResult').textContent, /Authentication failed/);
});

ui('with an empty token or userId the button explains why and sends nothing', async () => {
  for (const creds of [{ token: '', userId: USER_ID }, { token: TOKEN, userId: '' }]) {
    const { $, sent } = boot({ local: { lineNotify: creds } });
    await sleep(30);
    $('lineTest').click();
    assert.ok(await waitFor(() => /token 與 userId/.test($('lineResult').textContent)));
    assert.equal(sent.length, 0);
  }
});

ui('the last result stored by the background is shown when the page opens and follows later changes', async () => {
  const { $, listeners } = boot({ session: { lineLastResult: { at: clock(9, 8, 7), ok: false, status: 400, reason: 'bad userId' } } });
  assert.ok(await waitFor(() => /bad userId/.test($('lineResult').textContent)));
  assert.match($('lineResult').textContent, /09:08:07/);
  listeners.forEach(listener => listener({ lineLastResult: { newValue: { at: clock(10, 0, 1), ok: true, status: 200, reason: '' } } }, 'session'));
  assert.ok(await waitFor(() => /10:00:01/.test($('lineResult').textContent)));
  assert.match($('lineResult').textContent, /成功/);
});

ui('the fields stay disabled until the saved credentials have loaded, so early typing cannot overwrite them', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { $, writes } = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID } }, gate });
  assert.equal($('lineToken').disabled, true);
  assert.equal($('lineUserId').disabled, true);
  $('lineToken').value = 'x';
  $('lineToken').dispatchEvent(new (new JSDOM('').window.Event)('input', { bubbles: true }));
  await sleep(20);
  assert.equal(writes.local.length, 0, 'nothing is written before the load finishes');
  release();
  assert.ok(await waitFor(() => $('lineToken').value === TOKEN));
  assert.equal($('lineToken').disabled, false);
  assert.equal($('lineUserId').disabled, false);
  assert.equal($('lineUserId').value, USER_ID, 'the stored userId survived');
});

ui('a failing storage load keeps the fields locked and says why, so nothing stored can be overwritten', async () => {
  const gate = Promise.reject(new Error('storage down'));
  gate.catch(() => {});
  const { $, writes } = boot({ gate });
  assert.ok(await waitFor(() => /讀取設定失敗/.test($('lineResult').textContent)));
  assert.equal($('lineToken').disabled, true);
  assert.equal($('lineUserId').disabled, true);
  assert.equal($('lineEnabled').disabled, true);
  $('lineToken').dispatchEvent(new (new JSDOM('').window.Event)('input', { bubbles: true }));
  await sleep(20);
  assert.equal(writes.local.length, 0);
});

ui('when the background cannot be reached the box says so instead of staying on "sending"', async () => {
  const { $ } = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID } }, sendError: 'Receiving end does not exist' });
  assert.ok(await waitFor(() => $('lineToken').value === TOKEN));
  $('lineTest').click();
  assert.ok(await waitFor(() => /沒有回應/.test($('lineResult').textContent)));
  assert.match($('lineResult').textContent, /Receiving end does not exist/);
  assert.equal($('lineTest').disabled, false, 'the button works again');
});

ui('the test button is disabled while a send is in flight, so rapid clicks cannot spend the push quota', async () => {
  let finish;
  const { $, sent, w } = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID } } });
  w.chrome.runtime.sendMessage = message => new Promise(resolve => { sent.push(message); finish = () => resolve({ at: clock(1, 2, 3), ok: true, status: 200, reason: '' }); });
  assert.ok(await waitFor(() => $('lineToken').value === TOKEN));
  $('lineTest').click();
  assert.ok(await waitFor(() => $('lineTest').disabled === true));
  $('lineTest').click();
  $('lineTest').click();
  await sleep(20);
  assert.equal(sent.length, 1, 'only one message went out');
  finish();
  assert.ok(await waitFor(() => /成功/.test($('lineResult').textContent)));
  assert.equal($('lineTest').disabled, false);
});

ui('the switch is off by default, and cannot be turned on until both the token and the userId are filled', async () => {
  const { $, writes } = boot({ local: { lineNotify: { token: TOKEN, userId: '' } } });
  assert.ok(await waitFor(() => $('lineToken').value === TOKEN));
  assert.equal($('lineEnabled').checked, false, 'off by default');
  $('lineEnabled').click();
  assert.equal($('lineEnabled').checked, false, 'it refuses to turn on');
  assert.match($('lineResult').textContent, /token 與 userId/);
  assert.equal(writes.local.length, 0, 'nothing saved');
});

ui('turning the switch on saves it next to the credentials, and typing afterwards does not switch it off', async () => {
  const { $, type, writes } = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID } } });
  assert.ok(await waitFor(() => $('lineToken').value === TOKEN));
  $('lineEnabled').click();
  assert.ok(await waitFor(() => writes.local.length === 1));
  assert.equal(JSON.stringify(writes.local[0]), JSON.stringify({ lineNotify: { token: TOKEN, userId: USER_ID, enabled: true, dedupeMinutes: 10, hourlyLimit: 10 } }));
  type('lineToken', `${TOKEN}2`);
  assert.ok(await waitFor(() => writes.local.length === 2));
  assert.equal(JSON.stringify(writes.local[1]), JSON.stringify({ lineNotify: { token: `${TOKEN}2`, userId: USER_ID, enabled: true, dedupeMinutes: 10, hourlyLimit: 10 } }));
});

ui('a saved enabled switch comes back checked, and turning it off keeps the credentials', async () => {
  const { $, writes } = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID, enabled: true } } });
  assert.ok(await waitFor(() => $('lineEnabled').checked === true));
  $('lineEnabled').click();
  assert.ok(await waitFor(() => writes.local.length === 1));
  assert.equal(JSON.stringify(writes.local[0]), JSON.stringify({ lineNotify: { token: TOKEN, userId: USER_ID, enabled: false, dedupeMinutes: 10, hourlyLimit: 10 } }));
});

ui('the switch is locked until the saved settings have loaded', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { $ } = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID, enabled: true } }, gate });
  assert.equal($('lineEnabled').disabled, true);
  release();
  assert.ok(await waitFor(() => $('lineEnabled').disabled === false));
  assert.equal($('lineEnabled').checked, true);
});

ui('the result says whether it came from the test button or from an alert', async () => {
  const { $, listeners } = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID } } });
  assert.ok(await waitFor(() => $('lineToken').value === TOKEN));
  listeners.forEach(listener => listener({ lineLastResult: { newValue: { at: clock(4, 5, 6), ok: true, status: 200, reason: '', source: 'alert' } } }, 'session'));
  assert.ok(await waitFor(() => /04:05:06/.test($('lineResult').textContent)));
  assert.match($('lineResult').textContent, /警報/);
  listeners.forEach(listener => listener({ lineLastResult: { newValue: { at: clock(4, 6, 6), ok: true, status: 200, reason: '', source: 'test' } } }, 'session'));
  assert.ok(await waitFor(() => /04:06:06/.test($('lineResult').textContent)));
  assert.match($('lineResult').textContent, /測試/);
  assert.doesNotMatch($('lineResult').textContent, /警報/);
});

ui('emptying a credential while the switch is on turns the switch off visibly, instead of silently dropping alerts', async () => {
  const { $, type, writes } = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID, enabled: true } } });
  assert.ok(await waitFor(() => $('lineEnabled').checked === true));
  type('lineToken', '');
  assert.equal($('lineEnabled').checked, false);
  assert.match($('lineResult').textContent, /已自動關閉/);
  assert.ok(await waitFor(() => writes.local.length > 0));
  assert.equal(JSON.stringify(writes.local.at(-1)), JSON.stringify({ lineNotify: { token: '', userId: USER_ID, enabled: false, dedupeMinutes: 10, hourlyLimit: 10 } }));
});

ui('the dedupe minutes and the hourly cap show 10 and 10 by default, and saved values come back', async () => {
  const fresh = boot({ local: {} });
  assert.ok(await waitFor(() => fresh.$('lineToken').disabled === false));
  assert.equal(fresh.$('lineDedupe').value, '10');
  assert.equal(fresh.$('lineHourly').value, '10');
  const saved = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID, dedupeMinutes: 3, hourlyLimit: 7 } } });
  assert.ok(await waitFor(() => saved.$('lineDedupe').value === '3'));
  assert.equal(saved.$('lineHourly').value, '7');
});

ui('editing the limits saves numbers next to the credentials and the switch', async () => {
  const { $, type, writes } = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID, enabled: true } } });
  assert.ok(await waitFor(() => $('lineEnabled').checked === true));
  type('lineDedupe', '5');
  assert.ok(await waitFor(() => writes.local.length === 1));
  assert.equal(JSON.stringify(writes.local[0]), JSON.stringify({ lineNotify: { token: TOKEN, userId: USER_ID, enabled: true, dedupeMinutes: 5, hourlyLimit: 10 } }));
  type('lineHourly', '3');
  assert.ok(await waitFor(() => writes.local.length === 2));
  assert.equal(JSON.stringify(writes.local[1]), JSON.stringify({ lineNotify: { token: TOKEN, userId: USER_ID, enabled: true, dedupeMinutes: 5, hourlyLimit: 3 } }));
});

ui('a blank or nonsense limit is saved as empty so the background falls back to the default', async () => {
  const { $, type, writes } = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID } } });
  assert.ok(await waitFor(() => $('lineToken').value === TOKEN));
  type('lineDedupe', '');
  assert.ok(await waitFor(() => writes.local.length === 1));
  assert.equal(writes.local[0].lineNotify.dedupeMinutes, null);
  type('lineHourly', '-4');
  assert.ok(await waitFor(() => writes.local.length === 2));
  assert.equal(writes.local[1].lineNotify.hourlyLimit, null);
});

ui('the number of skipped alerts is shown when the page opens and follows later changes', async () => {
  const { $, listeners } = boot({ session: { lineThrottle: { skipped: 4 } } });
  assert.ok(await waitFor(() => /已略過 4 則/.test($('lineSkipped').textContent)));
  listeners.forEach(listener => listener({ lineThrottle: { newValue: { skipped: 5 } } }, 'session'));
  assert.ok(await waitFor(() => /已略過 5 則/.test($('lineSkipped').textContent)));
});

ui('with nothing recorded the page says 0 skipped', async () => {
  const { $ } = boot({});
  assert.ok(await waitFor(() => /已略過 0 則/.test($('lineSkipped').textContent)));
});

ui('the limit fields are locked until the saved settings have loaded', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { $ } = boot({ local: { lineNotify: { token: TOKEN, userId: USER_ID, dedupeMinutes: 3 } }, gate });
  assert.equal($('lineDedupe').disabled, true);
  assert.equal($('lineHourly').disabled, true);
  release();
  assert.ok(await waitFor(() => $('lineDedupe').disabled === false));
  assert.equal($('lineDedupe').value, '3');
});

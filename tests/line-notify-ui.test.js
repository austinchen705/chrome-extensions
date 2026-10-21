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
  <button id="lineTest">發送測試訊息</button>
  <div id="lineResult"></div>
</body></html>`;

function boot({ local = {}, session = {}, reply = { at: 0, ok: true, status: 200, reason: '' } } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only' });
  const w = dom.window;
  const writes = { local: [], sync: [], session: [] };
  const sent = [];
  const listeners = [];
  const area = (name, store) => ({
    get: async keys => Object.fromEntries([].concat(keys).map(key => [key, store[key]]).filter(([, value]) => value !== undefined)),
    set: async values => { writes[name].push(JSON.parse(JSON.stringify(values))); Object.assign(store, JSON.parse(JSON.stringify(values))); },
  });
  w.chrome = {
    storage: { local: area('local', { ...local }), session: area('session', { ...session }), sync: area('sync', {}), onChanged: { addListener: fn => listeners.push(fn) } },
    runtime: { sendMessage: async message => { sent.push(message); return reply; } },
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
  assert.equal(JSON.stringify(writes.local.at(-1)), JSON.stringify({ lineNotify: { token: 'newtoken', userId: USER_ID } }));
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

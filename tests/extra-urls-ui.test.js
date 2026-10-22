// 設定頁的「額外的遊戲網址（臨時）」：在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的），
// 檢查新增（要先通過檢查、Chrome 的授權詢問按了允許才存）、移除（連授權一起收回）、清單顯示授權狀態，
// 以及設定頁開始／停止的檢查會認得這些網站。需要 jsdom；沒裝就跳過。
const test = require('node:test');
const assert = require('node:assert/strict');
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
    if (await condition()) return true;
    await sleep(10);
  }
  return Boolean(await condition());
};

const NGROK_URL = 'https://1234-203-0-113-9.ngrok-free.app/web?x=1';
const NGROK = 'https://1234-203-0-113-9.ngrok-free.app/*';
const OTHER = 'https://other.example.com/*';

// allow：授權詢問的結果（true 允許、false 拒絕）；granted：一開始已經授權的網站；tab：?tab= 指到的那個分頁
async function boot({ stored, granted = [], allow = true, tab = null, gone = false } = {}) {
  const store = stored === undefined ? {} : { extraGameUrls: stored };
  const permissions = new Set(granted);
  const calls = { request: [], remove: [], sent: [], queries: [] };
  const changeListeners = [];
  const permissionListeners = [];
  const dom = await JSDOM.fromFile(path.join(root, 'popup.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `file://${root.split(path.sep).join('/')}/popup.html${tab ? `?tab=${tab.id}` : ''}`,
    beforeParse(window) {
      window.chrome = {
        runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: file => file, onMessage: { addListener() {} }, sendMessage: async () => ({}) },
        storage: {
          local: {
            get: async keys => Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, JSON.parse(JSON.stringify(store[key]))])),
            set: async values => {
              const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: JSON.parse(JSON.stringify(value)) }]));
              Object.assign(store, JSON.parse(JSON.stringify(values)));
              changeListeners.forEach(listener => listener(changes, 'local'));
            },
          },
          sync: { get: async () => ({}), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener: fn => changeListeners.push(fn) },
        },
        permissions: {
          contains: async ({ origins }) => origins.every(origin => permissions.has(origin)),
          request: async ({ origins }) => {
            calls.request.push([...origins]); // 頁面裡的陣列和測試不同 realm，換成測試自己的陣列才能比對
            if (allow) origins.forEach(origin => permissions.add(origin));
            return allow;
          },
          remove: async ({ origins }) => {
            calls.remove.push([...origins]);
            origins.forEach(origin => permissions.delete(origin));
            return true;
          },
          onAdded: { addListener: fn => permissionListeners.push(fn) },
          onRemoved: { addListener: fn => permissionListeners.push(fn) },
        },
        tabs: {
          query: async filter => { calls.queries.push([...filter.url]); return tab ? [tab] : []; },
          get: async id => { if (tab && id === tab.id && !gone) return tab; throw new Error('no tab'); },
          sendMessage: async (id, message) => { calls.sent.push(message.type); return { running: false }; },
          create: async () => {},
          update: async () => {},
        },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  const $ = id => doc.getElementById(id);
  const rows = () => [...doc.querySelectorAll('#extraList .extra-item')];
  const message = () => ({ text: $('extraMessage').textContent, error: $('extraMessage').querySelector('.msg-error') !== null, warn: $('extraMessage').querySelector('.msg-warn') !== null });
  const add = async text => {
    $('extraUrl').value = text;
    $('extraAdd').click();
    await sleep(40);
  };
  if (!await waitFor(() => $('extraAdd'), 1500)) {
    dom.window.close(); // 設定頁的計時器會讓程序一直活著，失敗時也要關掉
    assert.fail('the settings page has the extra sites section');
  }
  await sleep(40);
  return { dom, $, rows, message, add, store, permissions, calls, changeListeners, close: () => dom.window.close() };
}

ui('the list shows each stored site with whether the user has allowed it', async () => {
  const page = await boot({ stored: [NGROK, OTHER], granted: [NGROK] });
  try {
    assert.ok(await waitFor(() => page.rows().length === 2));
    const [first, second] = page.rows();
    assert.match(first.textContent, /1234-203-0-113-9\.ngrok-free\.app/);
    assert.match(first.textContent, /已授權/);
    assert.match(second.textContent, /other\.example\.com/);
    assert.match(second.textContent, /未授權/);
    assert.ok(second.querySelector('.msg-warn'), 'a site that is not allowed is marked as a warning');
  } finally {
    page.close();
  }
});

ui('adding a good address asks Chrome for permission for that whole site, stores it once allowed, and says to refresh the tab', async () => {
  const page = await boot();
  try {
    await page.add(NGROK_URL);
    assert.deepEqual(page.calls.request, [[NGROK]], 'one permission question, for the whole host');
    assert.deepEqual(page.store.extraGameUrls, [NGROK]);
    assert.ok(await waitFor(() => page.rows().length === 1));
    assert.match(page.rows()[0].textContent, /已授權/);
    const message = page.message();
    assert.match(message.text, /重新整理/);
    assert.equal(message.error || message.warn, false, 'a plain message, not a warning');
    assert.equal(page.$('extraUrl').value, '', 'the box is emptied');
  } finally {
    page.close();
  }
});

ui('when the user does not allow the site in Chrome\'s question, nothing is stored and the page says so', async () => {
  const page = await boot({ allow: false });
  try {
    await page.add(NGROK_URL);
    assert.equal(page.calls.request.length, 1);
    assert.equal(page.store.extraGameUrls, undefined);
    assert.equal(page.rows().length, 0);
    assert.equal(page.message().warn, true);
    assert.match(page.message().text, /沒有授權/);
  } finally {
    page.close();
  }
});

ui('an address that is not a plain web site is refused with the reason and Chrome is not even asked', async () => {
  const page = await boot();
  try {
    for (const bad of ['abc', 'file:///C:/game.html', 'https://*.example.com', 'https://catworld.muds.tw/web']) {
      await page.add(bad);
      assert.equal(page.message().error, true, bad);
    }
    assert.match(page.message().text, /內建/, 'the last one is the built-in game');
    assert.equal(page.calls.request.length, 0);
    assert.equal(page.store.extraGameUrls, undefined);
  } finally {
    page.close();
  }
});

ui('a site that is already in the list is not asked about again', async () => {
  const page = await boot({ stored: [NGROK], granted: [NGROK] });
  try {
    assert.ok(await waitFor(() => page.rows().length === 1));
    await page.add(NGROK_URL);
    assert.equal(page.calls.request.length, 0);
    assert.equal(page.message().error, true);
    assert.match(page.message().text, /已經/);
    assert.deepEqual(page.store.extraGameUrls, [NGROK]);
  } finally {
    page.close();
  }
});

ui('removing a site takes it out of the list and gives the permission back', async () => {
  const page = await boot({ stored: [NGROK, OTHER], granted: [NGROK, OTHER] });
  try {
    assert.ok(await waitFor(() => page.rows().length === 2));
    page.rows()[0].querySelector('.extra-remove').click();
    assert.ok(await waitFor(() => page.rows().length === 1));
    assert.deepEqual(page.calls.remove, [[NGROK]]);
    assert.deepEqual(page.store.extraGameUrls, [OTHER]);
    assert.equal(page.permissions.has(NGROK), false);
    assert.match(page.rows()[0].textContent, /other\.example\.com/);
    assert.match(page.message().text, /移除/);
  } finally {
    page.close();
  }
});

ui('a site whose permission was taken back has a button to allow it again, without adding it twice', async () => {
  const page = await boot({ stored: [NGROK], granted: [] });
  try {
    assert.ok(await waitFor(() => page.rows().length === 1));
    page.rows()[0].querySelector('.extra-grant').click();
    assert.ok(await waitFor(() => /已授權/.test(page.rows()[0]?.textContent ?? '')));
    assert.deepEqual(page.calls.request, [[NGROK]]);
    assert.deepEqual(page.store.extraGameUrls, [NGROK], 'still one entry');
    assert.equal(page.rows()[0].querySelector('.extra-grant'), null, 'no allow button once it is allowed');
  } finally {
    page.close();
  }
});

ui('a change of the list made elsewhere (another settings tab) shows up here', async () => {
  const page = await boot({ stored: [], granted: [NGROK] });
  try {
    assert.equal(page.rows().length, 0);
    page.store.extraGameUrls = [NGROK];
    page.changeListeners.forEach(listener => listener({ extraGameUrls: { newValue: [NGROK] } }, 'local'));
    assert.ok(await waitFor(() => page.rows().length === 1));
  } finally {
    page.close();
  }
});

ui('the settings page treats a tab on a listed site as the game: the status is asked of it', async () => {
  const tab = { id: 5, url: 'https://1234-203-0-113-9.ngrok-free.app/play' };
  const page = await boot({ stored: [NGROK], granted: [NGROK], tab });
  try {
    assert.ok(await waitFor(() => page.calls.sent.includes('STATUS')), 'the page sent a message to the tab');
    assert.doesNotMatch(page.$('status').textContent, /請切到/);
  } finally {
    page.close();
  }
});

ui('a tab on a site that is not in the list is still not the game', async () => {
  const tab = { id: 5, url: 'https://1234-203-0-113-9.ngrok-free.app/play' };
  const page = await boot({ stored: [], tab });
  try {
    assert.ok(await waitFor(() => /請切到/.test(page.$('status').textContent)));
    assert.equal(page.calls.sent.length, 0);
  } finally {
    page.close();
  }
});

ui('when the game tab the settings page was opened for is closed, it looks for another game tab on the built-in game or a listed site', async () => {
  const other = { id: 5, url: 'https://1234-203-0-113-9.ngrok-free.app/play' };
  const page = await boot({ stored: [NGROK], granted: [NGROK], tab: other, gone: true });
  try {
    assert.ok(await waitFor(() => page.calls.queries.length > 0), 'it searched for a game tab');
    assert.deepEqual(page.calls.queries[0], ['https://catworld.muds.tw/web*', NGROK]);
    assert.ok(await waitFor(() => page.calls.sent.includes('STATUS')), 'and talked to the one it found');
  } finally {
    page.close();
  }
});

// 新版本提示：純函式（update-check.js）、背景的排程與抓取（在記憶體裡實際執行 background.js，假的 chrome.alarms 與 fetch）、
// 設定頁的顯示（jsdom 載入真正的 popup.html）。需要 jsdom 的部分沒裝就跳過
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionDir = path.join(__dirname, '..', 'catworld-auto-command');
require(path.join(extensionDir, 'update-check.js'));
const U = globalThis.CatworldUpdateCheck;
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const HOUR = 60 * 60 * 1000;

test('parseVersion reads the version out of a manifest and refuses anything else', () => {
  assert.equal(U.parseVersion('{"name":"x","version":"1.100.0"}'), '1.100.0');
  assert.equal(U.parseVersion('{"version":"2.0"}'), '2.0');
  for (const bad of ['', 'not json', '{}', '{"version":5}', '{"version":"1.x"}', '{"version":"<script>"}', null, undefined]) assert.equal(U.parseVersion(bad), null, String(bad));
});

test('compareVersions compares each part as a number, missing parts count as 0, bad input is "same"', () => {
  assert.equal(U.compareVersions('1.100.0', '1.99.1'), 1);
  assert.equal(U.compareVersions('1.99.1', '1.100.0'), -1);
  assert.equal(U.compareVersions('1.99', '1.99.0'), 0);
  assert.equal(U.compareVersions('2.0.0', '1.999.999'), 1);
  assert.equal(U.compareVersions('x', '1.0.0'), 0);
  assert.equal(U.compareVersions('1.0.0', undefined), 0);
});

test('shouldCheck: never checked, a day passed, recent success, recent failure, clock moved back', () => {
  const now = 1000 * HOUR;
  assert.equal(U.shouldCheck(undefined, now), true);
  assert.equal(U.shouldCheck({ checkedAt: now - 25 * HOUR, latest: '1.0.0' }, now), true);
  assert.equal(U.shouldCheck({ checkedAt: now - 2 * HOUR, latest: '1.0.0' }, now), false);
  assert.equal(U.shouldCheck({ checkedAt: now - 30 * HOUR, error: { at: now - 10 * 60 * 1000, message: 'x' } }, now), false, 'a failure backs off for an hour');
  assert.equal(U.shouldCheck({ checkedAt: now - 30 * HOUR, error: { at: now - 2 * HOUR, message: 'x' } }, now), true);
  assert.equal(U.shouldCheck({ checkedAt: now + HOUR, latest: '1.0.0' }, now), true, 'a time in the future is not trusted');
});

test('describe: nothing recorded or a silent automatic failure shows nothing; newer is a warning; same is plain; a manual failure is an error', () => {
  const time = () => 'T';
  assert.equal(U.describe(undefined, '1.0.0', time), null);
  assert.equal(U.describe({ checkedAt: 1, error: { at: 2, message: 'offline', manual: false } }, '1.0.0', time), null, 'an automatic failure with no known version is silent');
  const newer = U.describe({ checkedAt: 1, latest: '1.1.0' }, '1.0.0', time);
  assert.equal(newer.level, 'warn');
  assert.equal(newer.newer, true);
  assert.match(newer.text, /v1\.1\.0/);
  assert.match(newer.text, /v1\.0\.0/);
  const same = U.describe({ checkedAt: 1, latest: '1.0.0' }, '1.0.0', time);
  assert.equal(same.level, 'info');
  assert.equal(same.newer, false);
  assert.match(same.text, /T/);
  assert.equal(U.describe({ checkedAt: 1, latest: '0.9.0' }, '1.0.0', time).newer, false, 'an older remote is not an update');
  const failed = U.describe({ checkedAt: 1, latest: '1.0.0', error: { at: 2, message: 'HTTP 404', manual: true } }, '1.0.0', time);
  assert.equal(failed.level, 'error');
  assert.match(failed.text, /HTTP 404/);
  assert.equal(U.describe({ checkedAt: 5, latest: '1.1.0', error: { at: 2, message: 'old', manual: true } }, '1.0.0', time).newer, true, 'a later success hides an older manual failure');
  assert.equal(U.describe({ checkedAt: 1, latest: '1.1.0', error: { at: 2, message: 'offline', manual: false } }, '1.0.0', time).newer, true, 'a silent failure keeps showing the last known version');
});

test('the update commands are the README install commands', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(readme.includes(U.COMMANDS.win));
  assert.ok(readme.includes(U.COMMANDS.unix));
  assert.ok(U.MANIFEST_URL.startsWith('https://raw.githubusercontent.com/'));
});

test('wiring: the permissions and files the check needs are declared', () => {
  assert.ok(manifest.permissions.includes('alarms'));
  assert.ok(manifest.host_permissions.includes('https://raw.githubusercontent.com/*'));
  assert.match(fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8'), /importScripts\([^)]*'update-check\.js'/);
  assert.match(fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8'), /<script src="update-check\.js"><\/script>\s*<script src="popup\.js">/);
  const scripts = manifest.content_scripts.flatMap(entry => entry.js);
  assert.ok(!scripts.includes('update-check.js'), 'content scripts never load it');
});

// ---------- 背景 ----------
globalThis.importScripts = (...names) => names.forEach(name => require(path.join(extensionDir, name)));

async function loadBackground({ stored = {}, response = { ok: true, text: async () => JSON.stringify({ version: '9.9.9' }) }, withAlarms = true } = {}) {
  const store = structuredClone(stored);
  const fetches = [];
  const alarms = [];
  const hooks = { alarm: [], message: [] };
  const noop = { addListener() {} };
  globalThis.fetch = async (url, options) => {
    fetches.push(url);
    if (response instanceof Error) throw response;
    return response;
  };
  globalThis.chrome = {
    runtime: { id: 'me', onMessage: { addListener: fn => hooks.message.push(fn) }, onInstalled: noop, getURL: file => `chrome-extension://me/${file}`, getManifest: () => manifest },
    tabs: { onRemoved: noop },
    notifications: { onButtonClicked: noop, onClicked: noop },
    storage: {
      session: {},
      local: {
        get: async keys => Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, structuredClone(store[key])])),
        set: async values => { Object.assign(store, structuredClone(values)); },
      },
      onChanged: noop,
    },
    permissions: { contains: async () => false, onAdded: noop, onRemoved: noop },
    scripting: { registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
  };
  if (withAlarms) {
    globalThis.chrome.alarms = {
      get: async name => alarms.find(alarm => alarm.name === name),
      create: (name, info) => { alarms.push({ name, ...info }); },
      onAlarm: { addListener: fn => hooks.alarm.push(fn) },
    };
  }
  delete require.cache[require.resolve(path.join(extensionDir, 'background.js'))];
  require(path.join(extensionDir, 'background.js'));
  await sleep(30);
  const ask = message => new Promise(resolve => {
    const handled = hooks.message.map(fn => fn(message, { id: 'me', url: 'chrome-extension://me/popup.html' }, resolve)).some(result => result === true);
    if (!handled) setTimeout(() => resolve(undefined), 50);
  });
  return { store, fetches, alarms, hooks, ask };
}

test('background: on load it checks once when never checked, stores the latest version, and creates one daily alarm', async () => {
  const bg = await loadBackground();
  assert.equal(bg.fetches.length, 1);
  assert.equal(bg.fetches[0], U.MANIFEST_URL);
  assert.equal(bg.store.updateCheck.latest, '9.9.9');
  assert.ok(bg.store.updateCheck.checkedAt > 0);
  assert.deepEqual(bg.alarms.map(alarm => [alarm.name, alarm.periodInMinutes]), [['update-check', 1440]]);
});

test('background: a recent check is not repeated, and the alarm only checks when a day has passed', async () => {
  const fresh = { updateCheck: { checkedAt: Date.now() - HOUR, latest: '1.0.0' } };
  const bg = await loadBackground({ stored: fresh });
  assert.equal(bg.fetches.length, 0, 'no request while the last check is recent');
  bg.hooks.alarm.forEach(fn => fn({ name: 'update-check' }));
  await sleep(30);
  assert.equal(bg.fetches.length, 0, 'the alarm firing early does not check either');
  bg.hooks.alarm.forEach(fn => fn({ name: 'other' }));
  const old = await loadBackground({ stored: { updateCheck: { checkedAt: Date.now() - 25 * HOUR, latest: '1.0.0' } } });
  assert.equal(old.fetches.length, 1, 'a day later it checks again');
});

test('background: an existing alarm is not recreated (that would restart its period each time the worker wakes)', async () => {
  const bg = await loadBackground({ stored: { updateCheck: { checkedAt: Date.now(), latest: '1.0.0' } } });
  assert.equal(bg.alarms.length, 1);
});

test('background: an automatic failure is silent and backs off, a manual one is recorded as manual', async () => {
  const bg = await loadBackground({ response: new Error('Failed to fetch') });
  assert.equal(bg.store.updateCheck.error.manual, false);
  assert.equal(bg.store.updateCheck.latest, undefined);
  assert.equal(U.describe(bg.store.updateCheck, '1.0.0'), null, 'nothing shown for an automatic failure');
  const second = await loadBackground({ stored: bg.store, response: new Error('Failed to fetch') });
  assert.equal(second.fetches.length, 0, 'it does not retry within the hour');
  const manual = await second.ask({ type: 'UPDATE_CHECK' });
  assert.equal(manual.ok, true);
  assert.equal(second.fetches.length, 1, 'a manual check goes out anyway');
  assert.equal(second.store.updateCheck.error.manual, true);
  assert.match(U.describe(second.store.updateCheck, '1.0.0').text, /Failed to fetch/);
});

test('background: HTTP errors and a manifest without a version are failures, a good answer clears an earlier error', async () => {
  const notFound = await loadBackground({ response: { ok: false, status: 404, text: async () => '' } });
  assert.match(notFound.store.updateCheck.error.message, /404/);
  const noVersion = await loadBackground({ response: { ok: true, text: async () => '{"name":"x"}' } });
  assert.match(noVersion.store.updateCheck.error.message, /版本/);
  const recovered = await loadBackground({ stored: { updateCheck: { checkedAt: 1, latest: '1.0.0', error: { at: 2, message: 'old', manual: true } } } });
  const result = await recovered.ask({ type: 'UPDATE_CHECK' });
  assert.equal(result.state.latest, '9.9.9');
  assert.equal('error' in recovered.store.updateCheck, false);
});

test('background: only the extension\'s own pages can ask for a check, and without alarms nothing starts by itself', async () => {
  const bg = await loadBackground();
  const outsider = await new Promise(resolve => {
    const handled = bg.hooks.message.map(fn => fn({ type: 'UPDATE_CHECK' }, { id: 'other', url: 'https://evil.example/' }, resolve)).some(result => result === true);
    if (!handled) setTimeout(() => resolve(undefined), 50);
  });
  assert.equal(outsider, undefined);
  const noAlarms = await loadBackground({ withAlarms: false });
  assert.equal(noAlarms.fetches.length, 0, 'no network at load when alarms is missing (test fakes)');
});

// ---------- 設定頁 ----------
let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // 沒裝 jsdom
}
const ui = JSDOM ? test : test.skip;

async function bootPopup({ store = {}, version = '1.0.0', reply = { ok: true }, platform = 'Windows', fetchImpl = null } = {}) {
  const listeners = [];
  const messages = [];
  const clipboard = [];
  const waitUntil = async (condition, ms = 3000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (condition()) return true;
      await sleep(5);
    }
    return condition();
  };
  const dom = await JSDOM.fromFile(path.join(extensionDir, 'popup.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `file://${extensionDir.split(path.sep).join('/')}/popup.html`,
    beforeParse(window) {
      if (fetchImpl) window.fetch = fetchImpl;
      Object.defineProperty(window.navigator, 'userAgent', { value: `Mozilla/5.0 (${platform})`, configurable: true });
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async text => { clipboard.push(text); } }, configurable: true });
      window.chrome = {
        runtime: {
          getManifest: () => ({ version }),
          getURL: file => file,
          onMessage: { addListener() {} },
          sendMessage: async message => {
            messages.push(message);
            if (message.type === 'UPDATE_CHECK' && typeof reply === 'function') return reply(store);
            return message.type === 'UPDATE_CHECK' ? reply : {};
          },
        },
        storage: {
          local: {
            get: async keys => Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, structuredClone(store[key])])),
            set: async values => { Object.assign(store, structuredClone(values)); },
            remove: async key => { delete store[key]; },
          },
          sync: { get: async () => ({}), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener: listener => listeners.push(listener) },
        },
        tabs: { query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => { throw new Error('no tab'); }, create: async () => {}, update: async () => {} },
        permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  assert.ok(await waitUntil(() => doc.getElementById('idleEveryMin').value !== ''), 'the settings page loaded');
  return { dom, doc, store, listeners, messages, clipboard, waitUntil };
}
const text = page => page.doc.getElementById('updateText').textContent;

ui('the settings page says nothing is known yet, then shows a newer version as a warning with the right command to copy', async () => {
  const page = await bootPopup();
  try {
    assert.match(text(page), /尚未檢查/);
    assert.equal(page.doc.getElementById('updateCmd').hidden, true);
    page.store.updateCheck = { checkedAt: Date.now(), latest: '1.1.0' };
    page.listeners.forEach(listener => listener({ updateCheck: {} }, 'local'));
    assert.ok(await page.waitUntil(() => /有新版本 v1\.1\.0/.test(text(page))), 'a change in storage shows without reopening');
    assert.equal(page.doc.getElementById('updateText').classList.contains('msg-warn'), true);
    assert.equal(page.doc.getElementById('updateCmd').hidden, false);
    assert.equal(page.doc.getElementById('updateCommand').textContent, U.COMMANDS.win);
    page.doc.getElementById('updateCopy').click();
    assert.ok(await page.waitUntil(() => page.clipboard.length === 1));
    assert.equal(page.clipboard[0], U.COMMANDS.win);
  } finally {
    page.dom.window.close();
  }
});

ui('on macOS or Linux the shell command is shown, and an up to date version hides the command', async () => {
  const page = await bootPopup({ platform: 'Macintosh; Intel Mac OS X', store: { updateCheck: { checkedAt: Date.now(), latest: '1.1.0' } } });
  try {
    assert.ok(await page.waitUntil(() => /有新版本/.test(text(page))));
    assert.equal(page.doc.getElementById('updateCommand').textContent, U.COMMANDS.unix);
  } finally {
    page.dom.window.close();
  }
  const same = await bootPopup({ store: { updateCheck: { checkedAt: Date.now(), latest: '1.0.0' } } });
  try {
    assert.ok(await same.waitUntil(() => /已是最新版本/.test(text(same))));
    assert.equal(same.doc.getElementById('updateText').classList.contains('msg-warn'), false);
    assert.equal(same.doc.getElementById('updateCmd').hidden, true);
  } finally {
    same.dom.window.close();
  }
});

ui('"立即檢查" asks the background, then shows the result; a failed check is a red message', async () => {
  const page = await bootPopup({ reply: store => { store.updateCheck = { checkedAt: Date.now(), latest: '2.0.0' }; return { ok: true }; } });
  try {
    page.doc.getElementById('updateNow').click();
    assert.ok(await page.waitUntil(() => /有新版本 v2\.0\.0/.test(text(page))));
    assert.equal(page.messages.filter(message => message.type === 'UPDATE_CHECK').length, 1);
    assert.equal(page.doc.getElementById('updateNow').disabled, false);
  } finally {
    page.dom.window.close();
  }
  const failing = await bootPopup({ reply: { ok: false, error: '背景壞了' } });
  try {
    failing.doc.getElementById('updateNow').click();
    assert.ok(await failing.waitUntil(() => /檢查新版本失敗：背景壞了/.test(text(failing))));
    assert.equal(failing.doc.getElementById('updateText').classList.contains('msg-error'), true);
    assert.equal(failing.doc.getElementById('updateNow').disabled, false);
  } finally {
    failing.dom.window.close();
  }
});

const CHANGELOG = `# 版本紀錄

說明文字，不是版本。

## 1.2.0（2026-11-06）

- **新功能**。用 \`hp\` 看。

## 1.1.0（2026-11-05）

- 修正。

## 1.0.0（2026-11-01）

- 第一版。
`;

test('parseNotes lists the versions newest first, marks the ones newer than the current, and drops markdown marks', () => {
  const notes = U.parseNotes(CHANGELOG.replace(/\n/g, '\r\n'), '1.1.0');
  assert.deepEqual(notes.map(note => [note.version, note.newer]), [['1.2.0', true], ['1.1.0', false], ['1.0.0', false]]);
  assert.equal(notes[0].title, '1.2.0（2026-11-06）');
  assert.equal(notes[0].body, '- 新功能。用 hp 看。');
  assert.deepEqual(U.parseNotes('沒有任何版本', '1.0.0'), []);
  assert.deepEqual(U.parseNotes(null, '1.0.0'), []);
  const many = Array.from({ length: 30 }, (_, i) => `## 1.${30 - i}.0（d）\n\n- x\n`).join('\n');
  assert.equal(U.parseNotes(many, '1.0.0').length, U.NOTES_MAX, 'only the latest few');
});

ui('"更新說明" fetches the changelog, shows newer versions marked, and a second click hides it', async () => {
  const urls = [];
  const page = await bootPopup({ version: '1.1.0', fetchImpl: async url => { urls.push(url); return { ok: true, text: async () => CHANGELOG }; } });
  try {
    const box = page.doc.getElementById('updateNotesBox');
    assert.equal(box.hidden, true);
    page.doc.getElementById('updateNotes').click();
    assert.ok(await page.waitUntil(() => box.querySelectorAll('h4').length === 3));
    assert.deepEqual(urls, [U.CHANGELOG_URL]);
    const heads = Array.from(box.querySelectorAll('h4'));
    assert.match(heads[0].textContent, /1\.2\.0.*（新）/);
    assert.equal(heads[0].classList.contains('newer'), true);
    assert.equal(heads[1].classList.contains('newer'), false);
    assert.match(box.textContent, /新功能。用 hp 看。/);
    page.doc.getElementById('updateNotes').click();
    assert.equal(box.hidden, true);
  } finally {
    page.dom.window.close();
  }
});

ui('"更新說明" shows a red message when the changelog cannot be read', async () => {
  const page = await bootPopup({ fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) });
  try {
    page.doc.getElementById('updateNotes').click();
    assert.ok(await page.waitUntil(() => /讀取更新說明失敗：HTTP 404/.test(page.doc.getElementById('updateNotesBox').textContent)));
    assert.equal(page.doc.getElementById('updateNotesBox').querySelector('.msg-error') !== null, true);
    assert.equal(page.doc.getElementById('updateNotes').disabled, false);
  } finally {
    page.dom.window.close();
  }
});

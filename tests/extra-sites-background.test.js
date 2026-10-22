// 額外的遊戲網址在 background 的行為：在記憶體裡實際執行 background.js，假的 chrome（storage、permissions、scripting），
// 檢查什麼時候註冊或移除「臨時網址」的 content script：只註冊使用者已授權的網站，清單、授權或擴充功能更新時重新同步。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionDir = path.join(__dirname, '..', 'catworld-auto-command');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
const NGROK = 'https://1234-203-0-113-9.ngrok-free.app/*';
const OTHER = 'https://other.example.com/*';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

globalThis.importScripts = (...names) => names.forEach(name => require(path.join(extensionDir, name)));

// 每個測試重新載入一次 background.js（它在載入時就會同步一次），回傳假的 chrome 的記錄與觸發事件的方法
async function load({ stored, granted = [], registered = false } = {}) {
  const state = { store: stored === undefined ? {} : { extraGameUrls: stored }, granted: new Set(granted), registered, calls: [], failRegister: false };
  const hooks = { storage: [], installed: [], added: [], removed: [] };
  const noop = { addListener() {} };
  globalThis.chrome = {
    runtime: {
      id: 'me',
      onMessage: noop,
      onInstalled: { addListener: fn => hooks.installed.push(fn) },
      getURL: file => file,
      getManifest: () => manifest,
    },
    tabs: { onRemoved: noop },
    notifications: { onButtonClicked: noop, onClicked: noop },
    storage: {
      session: {},
      local: {
        get: async keys => Object.fromEntries([].concat(keys).filter(key => key in state.store).map(key => [key, structuredClone(state.store[key])])),
        set: async values => { Object.assign(state.store, structuredClone(values)); },
      },
      onChanged: { addListener: fn => hooks.storage.push(fn) },
    },
    permissions: {
      contains: async ({ origins }) => origins.every(origin => state.granted.has(origin)),
      onAdded: { addListener: fn => hooks.added.push(fn) },
      onRemoved: { addListener: fn => hooks.removed.push(fn) },
    },
    scripting: {
      registerContentScripts: async scripts => {
        state.calls.push(['register', structuredClone(scripts)]);
        if (state.failRegister) throw new Error('Duplicate script ID');
        state.registered = true;
      },
      unregisterContentScripts: async filter => {
        state.calls.push(['unregister', structuredClone(filter)]);
        if (!state.registered) throw new Error('Nonexistent script ID');
        state.registered = false;
      },
    },
  };
  delete require.cache[require.resolve(path.join(extensionDir, 'background.js'))];
  require(path.join(extensionDir, 'background.js'));
  await sleep(30);
  const registers = () => state.calls.filter(call => call[0] === 'register').map(call => call[1][0]);
  return {
    state,
    registers,
    lastMatches: () => registers().at(-1)?.matches,
    changeList: async list => {
      state.store.extraGameUrls = list;
      hooks.storage.forEach(fn => fn({ extraGameUrls: { newValue: list } }, 'local'));
      await sleep(30);
    },
    fire: async name => {
      hooks[name].forEach(fn => fn({ origins: [NGROK] }));
      await sleep(30);
    },
    hooks,
  };
}

test('with nothing in the list no content script is registered for another site, and a leftover one is taken away', async () => {
  const none = await load({ registered: true });
  assert.equal(none.registers().length, 0);
  assert.deepEqual(none.state.calls, [['unregister', { ids: ['extra-game-sites'] }]]);
  assert.equal(none.state.registered, false, 'the old registration is gone');
});

test('a listed site the user has allowed gets the very same scripts and styles the manifest gives the game page', async () => {
  const page = await load({ stored: [NGROK], granted: [NGROK] });
  assert.equal(page.registers().length, 1);
  const script = page.registers()[0];
  const declared = manifest.content_scripts[0];
  assert.deepEqual([script.id, script.matches, script.js, script.css, script.runAt, script.persistAcrossSessions], ['extra-game-sites', [NGROK], declared.js, declared.css, 'document_idle', true]);
});

test('a listed site the user has not allowed (or has taken the permission back from) is not registered', async () => {
  const page = await load({ stored: [NGROK, OTHER], granted: [OTHER] });
  assert.deepEqual(page.lastMatches(), [OTHER]);
  const none = await load({ stored: [NGROK], granted: [] });
  assert.equal(none.registers().length, 0);
});

test('stored values that this feature would never have written are ignored, so storage cannot widen where the scripts run', async () => {
  const page = await load({ stored: ['<all_urls>', 'https://*/*', 5, null, NGROK], granted: ['<all_urls>', 'https://*/*', NGROK] });
  assert.deepEqual(page.lastMatches(), [NGROK]);
  const notAList = await load({ stored: 'https://a.example.com/*', granted: ['https://a.example.com/*'] });
  assert.equal(notAList.registers().length, 0);
});

test('changing the list registers again for the new list; a change to anything else does nothing', async () => {
  const page = await load({ stored: [NGROK], granted: [NGROK, OTHER] });
  const before = page.state.calls.length;
  await page.changeList([NGROK, OTHER]);
  assert.deepEqual(page.lastMatches(), [NGROK, OTHER]);
  assert.deepEqual(page.state.calls.slice(before).map(call => call[0]), ['unregister', 'register'], 'the old registration is removed first, then the new one made');
  const quiet = page.state.calls.length;
  page.hooks.storage.forEach(fn => fn({ somethingElse: { newValue: 1 } }, 'local'));
  page.hooks.storage.forEach(fn => fn({ extraGameUrls: { newValue: [] } }, 'sync'));
  await sleep(30);
  assert.equal(page.state.calls.length, quiet);
  await page.changeList([]);
  assert.equal(page.state.registered, false, 'an empty list leaves nothing registered');
});

test('allowing or taking back a permission registers again for what is allowed now', async () => {
  const page = await load({ stored: [NGROK], granted: [] });
  assert.equal(page.registers().length, 0);
  page.state.granted.add(NGROK);
  await page.fire('added');
  assert.deepEqual(page.lastMatches(), [NGROK]);
  page.state.granted.delete(NGROK);
  await page.fire('removed');
  assert.equal(page.state.registered, false);
});

test('after the extension is installed, updated or reloaded the registration is made again (an update clears the dynamic scripts)', async () => {
  const page = await load({ stored: [NGROK], granted: [NGROK] });
  page.state.registered = false;
  await page.fire('installed');
  assert.deepEqual(page.lastMatches(), [NGROK]);
  assert.equal(page.state.registered, true);
});

test('several triggers in a row are handled one after another, so the registration ends up matching the last list', async () => {
  const page = await load({ stored: [], granted: [NGROK, OTHER] });
  const before = page.state.calls.length;
  page.state.store.extraGameUrls = [NGROK];
  page.hooks.storage.forEach(fn => fn({ extraGameUrls: { newValue: [NGROK] } }, 'local'));
  page.state.store.extraGameUrls = [NGROK, OTHER];
  page.hooks.storage.forEach(fn => fn({ extraGameUrls: { newValue: [NGROK, OTHER] } }, 'local'));
  page.state.store.extraGameUrls = [OTHER];
  page.hooks.storage.forEach(fn => fn({ extraGameUrls: { newValue: [OTHER] } }, 'local'));
  await sleep(80);
  assert.deepEqual(page.lastMatches(), [OTHER]);
  const kinds = page.state.calls.slice(before).map(call => call[0]);
  kinds.forEach((kind, index) => { if (kind === 'register') assert.equal(kinds[index - 1], 'unregister', 'never two registrations without a removal between them'); });
});

test('a registration that fails is logged and does not stop later changes from working', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const page = await load({ stored: [NGROK], granted: [NGROK, OTHER] });
    page.state.failRegister = true;
    await page.changeList([NGROK, OTHER]);
    assert.ok(errors.some(text => /額外的遊戲網址/.test(text)), 'the failure is reported');
    page.state.failRegister = false;
    await page.changeList([OTHER]);
    assert.deepEqual(page.lastMatches(), [OTHER]);
  } finally {
    console.error = original;
  }
});

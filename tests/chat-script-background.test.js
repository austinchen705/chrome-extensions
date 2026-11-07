// 劇本對話：background 回劇本給遊戲頁（目前只有內建的備援劇本）。在記憶體裡執行 background.js，假的 chrome。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const extensionDir = path.join(__dirname, '..', 'catworld-auto-command');
const listeners = [];
globalThis.importScripts = (...names) => names.forEach(name => require(path.join(extensionDir, name)));
const noop = { addListener() {} };
globalThis.chrome = {
  runtime: { onMessage: { addListener: fn => listeners.push(fn) }, onInstalled: noop, getURL: file => file },
  tabs: { onRemoved: noop },
  notifications: { onButtonClicked: noop, onClicked: noop },
  storage: { session: {}, local: { get: async () => ({}), set: async () => {} }, onChanged: noop },
  permissions: { contains: async () => false, onAdded: noop, onRemoved: noop },
  scripting: { registerContentScripts: async () => {}, unregisterContentScripts: async () => { throw new Error('Nonexistent script ID'); } },
};
require(path.join(extensionDir, 'background.js'));
require(path.join(extensionDir, 'chat-reply.js'));
require(path.join(extensionDir, 'chat-script.js'));

const ask = message => new Promise(resolve => {
  let answered = false;
  listeners.forEach(listener => listener(message, { tab: { id: 1 } }, reply => { answered = true; resolve(reply); }));
  if (!answered) setTimeout(() => resolve(undefined), 50);
});

test('CHAT_SCRIPTS answers with built-in scripts the game page accepts, and every one opens with A', async () => {
  const reply = await ask({ type: 'CHAT_SCRIPTS' });
  assert.equal(reply.ok, true);
  const usable = globalThis.CatworldChatScript.usableScripts(reply.scripts);
  assert.ok(usable.length >= 1, 'at least one built-in script');
  assert.equal(usable.length, reply.scripts.length, 'none of them is thrown away by the game page');
  usable.forEach(script => assert.equal(script.lines[0].who, 'A', script.id));
});

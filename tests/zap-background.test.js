const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const extensionDir = path.join(__dirname, '..', 'catworld-auto-command');
const listeners = [];
let fetchCalls = 0;
let failNextFetch = false;
const mobs = [{ name: '甲(a)', id: 'a', exp: 250000, location: '蒙古', note: '', source: 'zap' }];
const items = [{ name: '明朝古董木雕', level: 1, note: '', weapon: '' }];
const riddles = [{ id: '技能類/獨孤九劍', name: '獨孤九劍', page: 'qu1-1.htm' }];
const pages = { 'qu1-1.htm': { steps: [], text: 't' } };

globalThis.importScripts = (...names) => names.forEach(name => require(path.join(extensionDir, name)));
globalThis.fetch = async url => {
  fetchCalls += 1;
  if (failNextFetch) {
    failNextFetch = false;
    throw new Error('network down');
  }
  assert.equal(url, 'zap-data.json');
  return { ok: true, json: async () => ({ mobs, items, riddles, pages }) };
};
const noop = { addListener() {} };
globalThis.chrome = {
  runtime: { onMessage: { addListener: fn => listeners.push(fn) }, onInstalled: noop, getURL: file => file },
  tabs: { onRemoved: noop },
  notifications: { onButtonClicked: noop, onClicked: noop },
  storage: { session: {}, local: { get: async () => ({}), set: async () => {} }, onChanged: noop },
  permissions: { contains: async () => false, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
  scripting: { registerContentScripts: async () => {}, unregisterContentScripts: async () => { throw new Error('Nonexistent script ID'); } },
};
require(path.join(extensionDir, 'background.js'));

const ask = message => new Promise(resolve => {
  const handled = listeners.map(listener => listener(message, { tab: { id: 1 } }, resolve)).some(result => result === true);
  assert.equal(handled, true, 'a listener must return true to answer asynchronously');
});

test('background loads the data lazily and answers ZAP_SUITABLE', async () => {
  assert.equal(fetchCalls, 0);
  const reply = await ask({ type: 'ZAP_SUITABLE', exp: 414748 });
  assert.equal(reply.ok, true);
  assert.equal(reply.items[0].mob.name, '甲(a)');
  await ask({ type: 'ZAP_LOOKUP', exp: 414748, names: [{ name: '甲(a)', count: 2 }] });
  assert.equal(fetchCalls, 1, 'the data is fetched once and cached');
});

test('background reports a load failure and retries on the next message', async () => {
  const fresh = path.join(extensionDir, 'background.js');
  delete require.cache[fresh];
  listeners.length = 0;
  fetchCalls = 0;
  failNextFetch = true;
  require(fresh);
  const failed = await ask({ type: 'ZAP_SUITABLE', exp: 414748 });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /network down/);
  const retried = await ask({ type: 'ZAP_SUITABLE', exp: 414748 });
  assert.equal(retried.ok, true);
  assert.equal(fetchCalls, 2);
});

test('background ignores messages that are not ZAP_*', () => {
  const answered = listeners.some(listener => listener({ type: 'START' }, { tab: { id: 1 } }, () => {}) === true);
  assert.equal(answered, false);
});

test('background answers ZAP_ITEM from the same loaded data', async () => {
  const before = fetchCalls;
  const reply = await ask({ type: 'ZAP_ITEM', sentences: ['一尊明朝古董木雕'], mainWeapon: '劍' });
  assert.equal(reply.ok, true);
  assert.equal(reply.results[0].candidates[0].advice.action, 'sell');
  assert.equal(fetchCalls, before, 'no extra fetch once the data is loaded');
});

test('background answers ZAP_RIDDLES from the same loaded data', async () => {
  const before = fetchCalls;
  const reply = await ask({ type: 'ZAP_RIDDLES' });
  assert.equal(reply.ok, true);
  assert.equal(reply.riddles[0].name, '獨孤九劍');
  assert.equal(reply.pages['qu1-1.htm'].text, 't');
  assert.equal(fetchCalls, before, 'no extra fetch once the data is loaded');
});

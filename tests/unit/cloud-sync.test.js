const test = require('node:test');
const assert = require('node:assert/strict');
require('../../catworld-auto-command/cloud-sync.js');

const CS = globalThis.CatworldCloudSync;
const URL = 'https://script.google.com/macros/s/abc/exec';
const reply = (body, init = {}) => async () => ({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => { if (body instanceof Error) throw body; return body; } });

test('the character is the part of the game tab title before " - "; no separator means unknown', () => {
  assert.equal(CS.characterFromTitle('小貓 - CatWorld'), '小貓');
  assert.equal(CS.characterFromTitle('  Neko  - a - b'), 'Neko');
  assert.equal(CS.characterFromTitle('CatWorld'), '');
  assert.equal(CS.characterFromTitle(undefined), '');
});

test('the built-in url is empty until the author deploys', () => {
  assert.equal(CS.DEFAULT_URL, '');
});

test('call posts text/plain JSON (no CORS preflight) with only the fields given', async () => {
  let seen;
  const result = await CS.call(async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ ok: true, updatedAt: 'x' }) }; },
    { url: ` ${URL} `, action: 'info', account: 'a', password: 'p' });
  assert.deepEqual(result, { ok: true, updatedAt: 'x' });
  assert.equal(seen.url, URL);
  assert.equal(seen.init.method, 'POST');
  assert.match(seen.init.headers['Content-Type'], /^text\/plain/);
  assert.deepEqual(JSON.parse(seen.init.body), { action: 'info', account: 'a', password: 'p' });
  await CS.call(async (url, init) => { seen = init; return { ok: true, json: async () => ({ ok: true }) }; }, { url: URL, action: 'upload', account: 'a', password: 'p', payload: { settings: {} } });
  assert.deepEqual(JSON.parse(seen.body).payload, { settings: {} });
});

test('an empty or foreign url sends nothing', async () => {
  const never = async () => { throw new Error('should not fetch'); };
  assert.deepEqual(await CS.call(never, { url: '  ', action: 'info' }), { ok: false, error: 'no-url' });
  assert.deepEqual(await CS.call(never, { url: 'https://example.com/x', action: 'info' }), { ok: false, error: 'bad-url' });
});

test('server error codes come back as they are; local failures get their own codes', async () => {
  const run = fetchImpl => CS.call(fetchImpl, { url: URL, action: 'info', account: 'a', password: 'p' });
  assert.deepEqual(await run(reply({ ok: false, error: 'bad-password' })), { ok: false, error: 'bad-password' });
  assert.equal((await run(async () => { throw new TypeError('Failed to fetch'); })).error, 'network');
  assert.equal((await run(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; })).error, 'timeout');
  assert.deepEqual(await run(reply({}, { ok: false, status: 502 })), { ok: false, error: 'http', detail: '502' });
  assert.equal((await run(reply(new SyntaxError('Unexpected token <')))).error, 'bad-reply');
  assert.equal((await run(reply('hello'))).error, 'bad-reply');
  assert.equal((await run(reply({ updatedAt: 'x' }))).error, 'bad-reply');
});

test('every error has its own text; the account is named for not-found', () => {
  const codes = ['no-url', 'bad-url', 'bad-password', 'not-found', 'too-large', 'bad-request', 'server-error', 'network', 'timeout', 'http', 'bad-reply', 'weird'];
  const texts = codes.map(error => CS.errorText({ error, detail: 'd' }, '小貓'));
  assert.equal(new Set(texts).size, codes.length);
  assert.equal(CS.errorText({ error: 'no-url' }), '雲端同步網址還沒設定');
  assert.equal(CS.errorText({ error: 'bad-password' }), '同步密碼不對');
  assert.equal(CS.errorText({ error: 'not-found' }, '小貓'), '雲端還沒有 小貓 的設定');
});

test('formatTime shows a local date and clock, and says unknown for garbage', () => {
  assert.match(CS.formatTime('2026-11-25T08:09:10.000Z'), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(CS.formatTime('nope'), '不明');
});

// 額外的遊戲網址（臨時加進來的網站，例如 ngrok）的純函式：檢查使用者貼的網址、清單的新增與移除、判斷一個分頁網址算不算遊戲頁。
// 不碰 DOM 與 chrome.*，background、設定頁與測試共用。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require(path.join(__dirname, '..', 'catworld-auto-command', 'game-urls.js'));
const G = globalThis.CatworldGameUrls;

const NGROK = 'https://1234-203-0-113-9.ngrok-free.app';
const NGROK_PATTERN = `${NGROK}/*`;

test('a pasted address becomes a match pattern for the whole host, whatever path, query, hash or port it came with', () => {
  [NGROK, `${NGROK}/`, `${NGROK}/web`, `${NGROK}/web?x=1#top`, `  ${NGROK}/web  `, NGROK.toUpperCase().replace('HTTPS', 'https')].forEach(text => {
    const result = G.parse(text);
    assert.equal(result.ok, true, text);
    assert.equal(result.pattern, NGROK_PATTERN, text);
  });
  assert.equal(G.parse('http://localhost:8080/web').pattern, 'http://localhost/*', 'Chrome ignores the port in a match pattern, so it is dropped');
  assert.equal(G.parse('http://192.168.1.5:3000').pattern, 'http://192.168.1.5/*');
});

test('addresses that are not a plain web site are refused with a reason', () => {
  ['', '   ', 'abc', 'ngrok-free.app', 'ftp://example.com', 'file:///C:/game.html', 'javascript:alert(1)', 'chrome://extensions',
    'chrome-extension://abc/popup.html', 'https://', 'https://*.example.com', 'https://exa*mple.com', 'https://user:pw@example.com', '*://*/*', '<all_urls>']
    .forEach(text => {
      const result = G.parse(text);
      assert.equal(result.ok, false, JSON.stringify(text));
      assert.ok(result.error.length > 3, 'says why');
    });
});

test('the game site that is built in is refused as an extra: it is already there', () => {
  const result = G.parse('https://catworld.muds.tw/web');
  assert.equal(result.ok, false);
  assert.match(result.error, /內建/);
});

test('adding puts a pattern in the list without touching the old list, and refuses duplicates and too many', () => {
  const list = [];
  const added = G.add(list, NGROK_PATTERN);
  assert.deepEqual([added.ok, added.list], [true, [NGROK_PATTERN]]);
  assert.deepEqual(list, [], 'the input list is not changed');
  const again = G.add(added.list, NGROK_PATTERN);
  assert.equal(again.ok, false);
  assert.match(again.error, /已經/);
  let full = [];
  for (let i = 0; i < G.MAX_EXTRA; i += 1) full = G.add(full, `https://site${i}.example.com/*`).list;
  const over = G.add(full, 'https://one-more.example.com/*');
  assert.equal(over.ok, false);
  assert.match(over.error, new RegExp(String(G.MAX_EXTRA)));
});

test('removing takes one pattern out, and an unknown one changes nothing', () => {
  const list = [NGROK_PATTERN, 'https://b.example.com/*'];
  assert.deepEqual(G.remove(list, NGROK_PATTERN), ['https://b.example.com/*']);
  assert.deepEqual(G.remove(list, 'https://nope.example.com/*'), list);
  assert.deepEqual(list, [NGROK_PATTERN, 'https://b.example.com/*'], 'the input list is not changed');
});

test('only patterns this feature makes are believed when they are read back: a stored value cannot widen where the scripts run', () => {
  assert.equal(G.isExtraPattern(NGROK_PATTERN), true);
  assert.equal(G.isExtraPattern('http://localhost/*'), true);
  ['<all_urls>', '*://*/*', 'https://*/*', 'https://*.example.com/*', 'https://a.example.com/web*', 'https://a.example.com', 'ftp://a.example.com/*', '', 5, null, undefined]
    .forEach(value => assert.equal(G.isExtraPattern(value), false, String(value)));
});

test('a tab address is a game page when it is the built-in game, or a site in the extra list, on that host whatever the port', () => {
  ['https://catworld.muds.tw/web', 'https://catworld.muds.tw/web?x=1', 'https://catworld.muds.tw/web/index.html'].forEach(url => assert.equal(G.isGameUrl(url), true, url));
  ['https://catworld.muds.tw/other', 'https://catworld.muds.tw/', 'https://example.com/web', '', undefined, null, 'not a url']
    .forEach(url => assert.equal(G.isGameUrl(url, [NGROK_PATTERN]), false, String(url)));
  assert.equal(G.isGameUrl(`${NGROK}/anything/at/all`, [NGROK_PATTERN]), true);
  assert.equal(G.isGameUrl(`${NGROK}/`, [NGROK_PATTERN]), true);
  assert.equal(G.isGameUrl('http://localhost:8080/game', ['http://localhost/*']), true, 'the port is ignored like Chrome does');
  assert.equal(G.isGameUrl(`${NGROK}/web`), false, 'not in the list, so not a game page');
  assert.equal(G.isGameUrl(`http://1234-203-0-113-9.ngrok-free.app/web`, [NGROK_PATTERN]), false, 'http is not https');
  assert.equal(G.isGameUrl('https://evil.example.com/?next=https://1234-203-0-113-9.ngrok-free.app/', [NGROK_PATTERN]), false, 'the address is only looked at where the host is');
  assert.equal(G.isGameUrl('https://1234-203-0-113-9.ngrok-free.app.evil.com/', [NGROK_PATTERN]), false, 'a longer host that merely starts with it');
});

test('the patterns to look for game tabs are the built-in game plus the extra ones, and a bad stored value is left out', () => {
  assert.deepEqual(G.tabPatterns([]), ['https://catworld.muds.tw/web*']);
  assert.deepEqual(G.tabPatterns([NGROK_PATTERN]), ['https://catworld.muds.tw/web*', NGROK_PATTERN]);
  assert.deepEqual(G.tabPatterns(['<all_urls>', NGROK_PATTERN, 7]), ['https://catworld.muds.tw/web*', NGROK_PATTERN]);
  assert.deepEqual(G.tabPatterns(undefined), ['https://catworld.muds.tw/web*']);
});

test('a host name Chrome would refuse is refused here first, with a reason, so Chrome is never asked about it', () => {
  ['https://a..b/', 'https://-x/', 'https://x-/', 'https://.a.com/', 'https://a.com./', 'https://catworld.muds.tw./web', 'https://a_.com/', 'https://' + 'a'.repeat(64) + '.com/', 'https://' + 'a.'.repeat(130) + 'com/']
    .forEach(text => {
      const result = G.parse(text);
      assert.equal(result.ok, false, text);
      assert.match(result.error, /主機名稱/, text);
    });
});

test('ordinary host names are accepted: dashes inside a label, digits, punycode, a single label, an address', () => {
  ['https://my-site.example.com', 'https://1234-203-0-113-9.ngrok-free.app', 'https://xn--fiq228c.com', 'http://localhost', 'http://192.168.1.5', 'https://a.b.c.d.example.co.uk', 'https://my_host.local']
    .forEach(text => assert.equal(G.parse(text).ok, true, text));
});

test('a stored pattern is only believed when its host name is well formed too', () => {
  ['https://a..b/*', 'https://-x/*', 'https://a.com./*', 'https://.a.com/*'].forEach(pattern => assert.equal(G.isExtraPattern(pattern), false, pattern));
  assert.equal(G.isExtraPattern('https://my-site.example.com/*'), true);
});

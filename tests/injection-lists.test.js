// popup 的備援注入（遊戲分頁開著時才安裝或重新載入 extension，宣告的 content script 還沒進去）
// 載入的檔案與樣式，要和 manifest 的 content script 一模一樣，順序也一樣；漏了一個，面板就少一塊功能或出錯。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'catworld-auto-command');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const script = manifest.content_scripts[0];

const listAfter = (marker) => {
  const start = popup.indexOf(marker);
  assert.ok(start >= 0, `popup.js has ${marker}`);
  const open = popup.indexOf('[', start);
  const close = popup.indexOf(']', open);
  return popup.slice(open + 1, close).split(',').map(item => item.trim().replace(/^'|'$/g, '')).filter(Boolean);
};

test('the files popup.js injects into an already open game page are the manifest content scripts, in the same order', () => {
  assert.deepEqual(listAfter('files:'), script.js);
});

test('the style sheets popup.js injects are the manifest content script styles', () => {
  assert.deepEqual(listAfter('chrome.scripting.insertCSS({ target: { tabId: tab.id }, files:'), script.css);
});

test('every file the manifest content script lists exists', () => {
  [...script.js, ...script.css].forEach(file => assert.ok(fs.existsSync(path.join(root, file)), file));
});

// ---- 額外的遊戲網址要用到的載入與權限 ----
test('the pages that use the extra game site helpers load them: the settings page before popup.js, the background through importScripts', () => {
  const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
  const helper = html.indexOf('<script src="game-urls.js"></script>');
  assert.ok(helper >= 0, 'popup.html loads game-urls.js');
  assert.ok(helper < html.indexOf('<script src="popup.js"></script>'), 'and before popup.js, which uses it as it loads');
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(background, /importScripts\([^)]*'game-urls\.js'/);
  assert.equal(script.js.includes('game-urls.js'), false, 'the content script does not need it');
});

test('the manifest lets the extension ask for permission on any http or https site, because the user picks the site; asking is the only way to get it', () => {
  assert.deepEqual([...manifest.optional_host_permissions].sort(), ['http://*/*', 'https://*/*']);
  const required = manifest.host_permissions;
  assert.equal(required.some(host => host === '<all_urls>' || host === 'https://*/*' || host === 'http://*/*'), false, 'nothing broad is granted without asking');
});

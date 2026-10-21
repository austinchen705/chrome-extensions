// 孤兒偵測與殘留面板清理（jsdom）。需要 jsdom（devDependency）；沒裝就跳過 DOM 那一項。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // 沒裝 jsdom
}

require(path.join(__dirname, '..', 'catworld-auto-command', 'instance-guard.js'));
const Guard = globalThis.CatworldInstanceGuard;

test('the context counts as alive only while chrome.runtime.id is readable and non-empty', () => {
  assert.equal(Guard.contextAlive({ runtime: { id: 'abc' } }), true);
  assert.equal(Guard.contextAlive({ runtime: { id: undefined } }), false, 'cleared after the extension was reloaded');
  assert.equal(Guard.contextAlive({ runtime: {} }), false);
  assert.equal(Guard.contextAlive({}), false);
  assert.equal(Guard.contextAlive(undefined), false);
  const throwing = { get runtime() { throw new Error('Extension context invalidated.'); } };
  assert.equal(Guard.contextAlive(throwing), false, 'a throwing getter is a dead context, not a crash');
});

(JSDOM ? test : test.skip)('removeStalePanels removes every marked panel host and the pin strip, and leaves the rest of the page alone', () => {
  const { document } = new JSDOM(`<html><body><div id="game"></div>
    <div ${Guard.HOST_ATTR}></div><div ${Guard.HOST_ATTR}></div><div id="${Guard.PLACEHOLDER_ID}"></div></body></html>`).window;
  Guard.removeStalePanels(document);
  assert.equal(document.querySelectorAll(`[${Guard.HOST_ATTR}]`).length, 0);
  assert.equal(document.getElementById(Guard.PLACEHOLDER_ID), null);
  assert.ok(document.getElementById('game'), 'unrelated elements stay');
  Guard.removeStalePanels(document);
});

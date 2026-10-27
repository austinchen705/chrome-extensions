// 設定頁「驗證碼樣本收集」區的畫面測試：在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的），
// 檢查網址欄位載入已存的值、只收 Apps Script 的網址、最近一次結果的文字與顏色等級。需要 jsdom；沒裝就跳過。
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
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
};

const GOOD = 'https://script.google.com/macros/s/AKfycb-example/exec';

async function boot({ local = {}, session = {} } = {}) {
  const writes = [];
  const listeners = [];
  const area = store => ({
    get: async keys => Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, JSON.parse(JSON.stringify(store[key]))])),
    set: async values => { writes.push(values); Object.assign(store, values); },
  });
  const dom = await JSDOM.fromFile(path.join(root, 'popup.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `file://${root.split(path.sep).join('/')}/popup.html`,
    beforeParse(window) {
      window.chrome = {
        runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: file => file, onMessage: { addListener() {} }, sendMessage: async () => ({}) },
        storage: { local: area(local), sync: area({}), session: area(session), onChanged: { addListener: fn => listeners.push(fn) } },
        tabs: { query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => { throw new Error('no tab'); }, create: async () => {}, update: async () => {} },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  const field = doc.getElementById('captchaSampleUrl');
  assert.ok(await waitFor(() => doc.getElementById('version').textContent === 'v0.0.0'), 'popup.js ran');
  assert.ok(await waitFor(() => !field.disabled), 'the field unlocks once the saved url is loaded');
  const result = () => {
    const box = doc.getElementById('captchaSampleResult');
    return { text: box.textContent, error: box.classList.contains('msg-error'), warn: box.classList.contains('msg-warn') };
  };
  const type = value => { field.value = value; field.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const urlWrites = () => writes.filter(values => 'captchaSampleUrl' in values).map(values => values.captchaSampleUrl);
  return { dom, field, result, type, urlWrites, listeners };
}

ui('the saved url is shown; only an Apps Script url is saved, anything else shows a red message and leaves the saved value alone', async () => {
  const { dom, field, result, type, urlWrites } = await boot({ local: { captchaSampleUrl: GOOD } });
  try {
    assert.equal(field.value, GOOD);
    type('https://example.com/collect');
    assert.deepEqual(urlWrites(), []);
    assert.equal(result().error, true);
    assert.match(result().text, /script\.google\.com\/macros\//);
    type(`${GOOD}2`);
    assert.deepEqual(urlWrites(), [`${GOOD}2`]);
    assert.deepEqual([result().error, result().warn], [false, false]);
    type('');
    assert.deepEqual(urlWrites(), [`${GOOD}2`, '']);
    assert.match(result().text, /不收集/);
  } finally {
    dom.window.close();
  }
});

ui('the last upload result written by the background is shown, and a later failure turns the line red', async () => {
  const at = new Date(2026, 9, 27, 18, 2, 3).getTime();
  const { dom, result, listeners } = await boot({ session: { captchaSampleLastResult: { at, ok: true, status: 200, reason: '', outcome: 'passed' } } });
  try {
    assert.ok(await waitFor(() => result().text.includes('HTTP 200')));
    assert.match(result().text, /^18:02:03　HTTP 200　已送出（passed）$/);
    assert.equal(result().error, false);
    listeners.forEach(listener => listener({ captchaSampleLastResult: { newValue: { at, ok: false, status: 0, reason: 'Failed to fetch', outcome: 'silent' } } }, 'session'));
    assert.match(result().text, /沒有送出：Failed to fetch/);
    assert.equal(result().error, true);
  } finally {
    dom.window.close();
  }
});

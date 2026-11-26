// 設定頁的書生出沒紀錄（在 jsdom 載入真正的 popup.html 與 popup.js，Chrome API 用假的）：最近的在上、顯示時間／距重生／位置／說的話，清除要先確認。需要 jsdom；沒裝就跳過。
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

const root = path.join(__dirname, '..', '..', '..', 'catworld-auto-command');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
};

async function boot(store = {}, { game = null } = {}) {
  const dom = await JSDOM.fromFile(path.join(root, 'popup.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `file://${root.split(path.sep).join('/')}/popup.html`,
    beforeParse(window) {
      window.chrome = {
        runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: file => file, onMessage: { addListener() {} }, sendMessage: async () => ({}) },
        storage: {
          local: {
            get: async keys => Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, JSON.parse(JSON.stringify(store[key]))])),
            set: async values => { Object.assign(store, JSON.parse(JSON.stringify(values))); },
            remove: async keys => { [].concat(keys).forEach(key => { delete store[key]; }); },
          },
          sync: { get: async () => ({}), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener() {} },
        },
        tabs: game
          ? { query: async () => [{ id: 7, url: 'https://catworld.muds.tw/web' }], get: async () => ({ id: 7, url: 'https://catworld.muds.tw/web' }), sendMessage: async (id, message) => game(message), create: async () => {}, update: async () => {} }
          : { query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => { throw new Error('no tab'); }, create: async () => {}, update: async () => {} },
        permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  assert.ok(await waitFor(() => doc.getElementById('scholarSightingsInfo').textContent !== ''), 'the sightings list was drawn');
  return { dom, doc, store };
}

const T = new Date(2026, 10, 26, 13, 5, 9).getTime();
const records = [
  { at: T, sinceSpawnSec: 201, area: 'plain', areaName: '平原', room: 'a1', said: ['落魄書生說道：誰能給我甲呢？', '落魄書生說道：誰能給我乙呢？'], matched: null, result: null },
  { at: T + 60000, sinceSpawnSec: null, area: null, areaName: '', room: null, said: [], matched: null, result: null },
];

ui('the sightings are listed newest first with time, seconds since respawn, place and what the scholar said', async () => {
  const { dom, doc } = await boot({ scholarSightings: records });
  try {
    assert.ok(await waitFor(() => doc.querySelectorAll('#scholarSightingsList li').length === 2));
    const [newest, oldest] = [...doc.querySelectorAll('#scholarSightingsList li')].map(li => li.textContent);
    assert.equal(newest, '11/26 13:06:09　距重生 --:--　位置不明');
    assert.equal(oldest, '11/26 13:05:09　距重生 3:21　平原／a1　落魄書生說道：誰能給我甲呢？ ／ 落魄書生說道：誰能給我乙呢？');
    assert.match(doc.getElementById('scholarSightingsInfo').textContent, /2 筆/);
  } finally {
    dom.window.close();
  }
});

ui('clear removes the sightings only after the confirm', async () => {
  const { dom, doc, store } = await boot({ scholarSightings: records });
  try {
    assert.ok(await waitFor(() => doc.querySelectorAll('#scholarSightingsList li').length === 2));
    dom.window.confirm = () => false;
    doc.getElementById('scholarSightingsClear').click();
    await sleep(50);
    assert.equal(store.scholarSightings.length, 2);
    dom.window.confirm = () => true;
    doc.getElementById('scholarSightingsClear').click();
    assert.ok(await waitFor(() => !('scholarSightings' in store) && doc.querySelectorAll('#scholarSightingsList li').length === 0));
    assert.match(doc.getElementById('scholarSightingsInfo').textContent, /尚無紀錄/);
  } finally {
    dom.window.close();
  }
});

ui('the map section lists outdoor and indoor room counts per area, and clear removes them only after the confirm', async () => {
  const outdoor = { 'plain/a1': { outdoor: true, at: T }, 'plain/a2': { outdoor: true, at: T }, 'plain/a3': { outdoor: false, at: T }, 'hall/h1': { outdoor: false, at: T } };
  const { dom, doc, store } = await boot({ mapOutdoor: outdoor });
  try {
    assert.ok(await waitFor(() => doc.querySelectorAll('#mapOutdoorList li').length === 2));
    assert.deepEqual([...doc.querySelectorAll('#mapOutdoorList li')].map(li => li.textContent), ['plain：戶外 2 格、室內 1 格', 'hall：戶外 0 格、室內 1 格']);
    dom.window.confirm = () => false;
    doc.getElementById('mapOutdoorClear').click();
    await sleep(50);
    assert.equal(Object.keys(store.mapOutdoor).length, 4);
    dom.window.confirm = () => true;
    doc.getElementById('mapOutdoorClear').click();
    assert.ok(await waitFor(() => !('mapOutdoor' in store) && doc.querySelectorAll('#mapOutdoorList li').length === 0));
    assert.match(doc.getElementById('mapOutdoorInfo').textContent, /尚無紀錄/);
  } finally {
    dom.window.close();
  }
});

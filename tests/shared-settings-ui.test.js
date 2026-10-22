// 設定頁「共用資料」區的畫面測試：在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的），
// 檢查結果行與逐列清單的文字和顏色等級（msg-error 紅、msg-warn 琥珀）真的放進畫面。需要 jsdom；沒裝就跳過。
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
require(path.join(root, 'zap-mobs.js'));
require(path.join(root, 'shared-data.js'));
const S = globalThis.CatworldSharedData;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
};

const URL_MOB = 'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=0&single=true&output=csv';
const BUILT_IN = [{ name: '老虎(tiger)', id: 'tiger', exp: 100, location: '桃花島' }];
const KING = '橫霸四方 忽必烈(king)';

async function boot(csvLines, features = { mobs: true, riddles: false }) {
  const built = S.buildMobRoutes(['怪物名稱,位置,強度,指令,備註,更新者,更新時間', ...csvLines].join('\n'), BUILT_IN);
  const store = {
    sharedSources: { mob: URL_MOB, riddle: '' },
    sharedCache: { mob: { url: URL_MOB, at: Date.now(), routes: built.routes, mobs: built.mobs, fixes: built.fixes, report: built.report } },
    zapFeatures: features,
  };
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
            set: async () => {},
          },
          sync: { get: async () => ({}), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener() {} },
        },
        tabs: { query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => { throw new Error('no tab'); }, create: async () => {}, update: async () => {} },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  const rows = id => [...doc.getElementById(id).children].map(node => ({ text: node.textContent, error: node.classList.contains('msg-error'), warn: node.classList.contains('msg-warn') }));
  assert.ok(await waitFor(() => doc.getElementById('sharedMobResult').textContent.includes('上次更新')), 'the settings page showed the summary');
  return { dom, summary: () => rows('sharedMobResult'), detail: () => rows('sharedMobDetail'), hidden: () => doc.getElementById('sharedMobDetail').hidden };
}

ui('the settings page shows the new and fixed counts, red lines for dropped rows and amber lines for unmatched ones', async () => {
  const { dom, summary, detail } = await boot([
    `${KING},蒙古,250000,run e,,甲,`,
    '老虎(tiger),桃花島,5000,,,乙,',
    '缺括號 忽必烈,蒙古,250000,run e,,甲,',
    '寫錯(wrong),蒙古,很強,run e,,乙,',
    '打錯字(typo),,,run e,,丁,',
  ]);
  try {
    const [line] = summary();
    assert.match(line.text, /生效 3 隻，新增 1 隻、修正強度 1 隻，丟掉 2 列，對不到怪物 1 筆/);
    // 打錯字的列路線照樣保留，所以也算在「生效」裡
    assert.deepEqual([line.error, line.warn], [false, true], 'the summary is amber while rows were dropped or unmatched');
    const lines = detail();
    assert.deepEqual(lines.map(item => [item.error, item.warn]), [[true, false], [true, false], [false, true]]);
    assert.match(lines[0].text, /^第 4 列：丟掉（新怪的名稱要寫成/);
    assert.match(lines[1].text, /^第 5 列：丟掉（強度「很強」看不懂/);
    assert.match(lines[2].text, /^第 6 列：打錯字\(typo\)　資料裡沒有這個怪物$/);
  } finally {
    dom.window.close();
  }
});

ui('when every row goes through the summary is plain and there is no detail list', async () => {
  const { dom, summary, hidden } = await boot([`${KING},蒙古,250000,run e,,甲,`, '老虎(tiger),桃花島,5000,,,乙,']);
  try {
    const [line] = summary();
    assert.match(line.text, /生效 2 隻，新增 1 隻、修正強度 1 隻，丟掉 0 列，對不到怪物 0 筆/);
    assert.deepEqual([line.error, line.warn], [false, false]);
    assert.equal(hidden(), true);
  } finally {
    dom.window.close();
  }
});

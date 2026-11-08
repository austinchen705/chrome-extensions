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

// ---- 劇本對話的試算表連結與結果 ----
const URL_CHAT = 'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=88&single=true&output=csv';
const chatEntry = lines => {
  const built = S.buildChatScripts(['劇本ID,順序,誰,台詞,備註,週', ...lines].join('\n'), new Date(2026, 10, 10).getTime());
  return { url: URL_CHAT, at: Date.now(), scripts: built.scripts, report: built.report };
};
const GOOD = ['s1,1,A,嗨,,', 's1,2,B,嗨嗨,,'];

async function bootChat(lines, { chatOn = true, sources = { mob: URL_MOB, riddle: '', chat: URL_CHAT } } = {}) {
  const store = { sharedSources: sources, chatScript: { enabled: chatOn }, zapFeatures: { mobs: true } };
  if (lines) store.sharedCache = { chat: chatEntry(lines) };
  const sent = [];
  const dom = await JSDOM.fromFile(path.join(root, 'popup.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `file://${root.split(path.sep).join('/')}/popup.html`,
    beforeParse(window) {
      window.chrome = {
        runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: file => file, onMessage: { addListener() {} }, sendMessage: async message => { sent.push(message.type); return {}; } },
        storage: {
          local: {
            get: async keys => Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, JSON.parse(JSON.stringify(store[key]))])),
            set: async values => { Object.assign(store, JSON.parse(JSON.stringify(values))); },
          },
          sync: { get: async () => ({}), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener() {} },
        },
        tabs: { query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => { throw new Error('no tab'); }, create: async () => {}, update: async () => {} },
        permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  const rows = id => [...doc.getElementById(id).children].map(node => ({ text: node.textContent, error: node.classList.contains('msg-error'), warn: node.classList.contains('msg-warn') }));
  const resultId = 'sharedChatResult';
  assert.ok(await waitFor(() => doc.getElementById(resultId).children.length > 0), 'the settings page showed the chat result');
  const change = value => {
    doc.getElementById('sharedChatUrl').value = value;
    doc.getElementById('sharedChatUrl').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  return { dom, doc, store, sent, change, summary: () => rows(resultId), detail: () => rows('sharedChatDetail'), hidden: () => doc.getElementById('sharedChatDetail').hidden };
}

ui('the script section shows its own link, the summary with amber and red lines for expired scripts and dropped ones', async () => {
  const { dom, doc, summary, detail } = await bootChat([...GOOD, 'old,1,A,嗨,,2026-01-05', 'old,2,B,好,,', 'bad,1,A,有;分號,,', 'bad,2,B,好,,']);
  try {
    assert.equal(doc.getElementById('sharedChatUrl').value, URL_CHAT);
    const [line] = summary();
    assert.match(line.text, /^劇本對話：上次更新 .*共 6 列，生效 1 份，丟掉 1 筆，不在適用週 1 份$/);
    assert.deepEqual([line.error, line.warn], [false, true]);
    assert.deepEqual(detail().map(item => [item.error, item.warn]), [[false, true], [true, false]]);
    assert.match(detail()[0].text, /^第 4 列：old　已過期/);
    assert.match(detail()[1].text, /^第 6 列：丟掉（劇本 bad 整份丟掉：台詞不能有分號/);
  } finally {
    dom.window.close();
  }
});

ui('with every script good the summary is plain and there is no detail list', async () => {
  const { dom, summary, hidden } = await bootChat(GOOD);
  try {
    assert.deepEqual([summary()[0].error, summary()[0].warn, hidden()], [false, false, true]);
  } finally {
    dom.window.close();
  }
});

ui('with the script feature off the chat result says it is not fetched, and shows no list', async () => {
  const { dom, summary, hidden } = await bootChat(['bad,1,A,有;分號,,', 'bad,2,B,好,,'], { chatOn: false });
  try {
    assert.equal(summary()[0].text, '劇本對話：功能沒開，不會抓取');
    assert.equal(hidden(), true);
  } finally {
    dom.window.close();
  }
});

ui('a chat link that was never set shows "not set"', async () => {
  const { dom, summary } = await bootChat(null, { sources: { mob: URL_MOB, riddle: '' } });
  try {
    assert.equal(summary()[0].text, '劇本對話：尚未設定');
  } finally {
    dom.window.close();
  }
});

ui('saving the chat link keeps the mob and riddle links, asks for an update, and a bad link is refused without saving', async () => {
  const { dom, doc, store, sent, change, summary } = await bootChat(null, { sources: { mob: URL_MOB, riddle: URL_MOB } });
  try {
    change('https://example.com/x.csv');
    assert.ok(await waitFor(() => summary()[0].error), 'a refusal in red');
    assert.deepEqual(store.sharedSources, { mob: URL_MOB, riddle: URL_MOB }, 'nothing was saved');
    change(URL_CHAT);
    assert.ok(await waitFor(() => store.sharedSources.chat === URL_CHAT));
    assert.deepEqual(store.sharedSources, { mob: URL_MOB, riddle: URL_MOB, chat: URL_CHAT }, 'the other two links stay');
    assert.ok(await waitFor(() => sent.includes('SHARED_REFRESH')), 'an update is asked for');
    doc.getElementById('sharedChatRefresh').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    assert.ok(await waitFor(() => sent.filter(type => type === 'SHARED_REFRESH').length === 2), 'the button next to it updates too');
    // 更新的回覆（這裡的假 background 沒有回應）處理完才結束，視窗關掉後才跑的畫面更新會丟例外
    assert.ok(await waitFor(() => summary()[0]?.text.includes('更新失敗')));
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    dom.window.close();
  }
});

ui('saving the mob link from the other section keeps the chat link', async () => {
  const { dom, doc, store } = await bootChat(GOOD);
  try {
    doc.getElementById('sharedMobUrl').value = '';
    doc.getElementById('sharedMobUrl').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.ok(await waitFor(() => store.sharedSources.mob === ''));
    assert.equal(store.sharedSources.chat, URL_CHAT);
  } finally {
    dom.window.close();
  }
});

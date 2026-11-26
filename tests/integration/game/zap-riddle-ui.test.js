// 解謎面板顯示共用步驟（jsdom）。需要 jsdom（devDependency）；沒裝就跳過。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

const riddles = [{ id: 'a/獨孤九劍', category: 'a', name: '獨孤九劍', condition: '無', difficulty: '易', reward: '技能', hint: '', page: 'qu1.htm', shared: [] }];
const pages = { 'qu1.htm': { preamble: '', text: '', steps: [{ no: 1, text: '第一步', commands: 'run site' }, { no: 2, text: '第二步', commands: '' }, { no: 3, text: '第三步', commands: 'run site3' }] } };

function boot({ shared, personal = {}, calls = [], started = [], sharedGate = null, changeListeners = [], sharedNow = () => shared, startResult = true, inventory = null, who = '小貓', store = {}, runMacro = null, stopMacros = () => {} }) {
  const dom = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.chrome = {
    storage: { local: { get: async () => ({ riddleCommands: personal, riddleDone: {}, ...store }), set: async values => { Object.assign(store, values); } }, onChanged: { addListener: fn => changeListeners.push(fn) } },
    runtime: {
      sendMessage: async message => {
        calls.push(message.type);
        if (message.type === 'ZAP_RIDDLES') return { ok: true, riddles, pages };
        if (message.type === 'ZAP_RIDDLE_SHARED') {
          if (sharedGate) await sharedGate;
          return { ok: true, steps: sharedNow() };
        }
        return { ok: false };
      },
    },
  };
  ['zap-riddles.js', 'hunt-parse.js', 'scholar-items-data.js', 'scholar.js', 'zap-riddle-ui.js'].forEach(file => w.eval(fs.readFileSync(path.join(root, file), 'utf8')));
  const host = w.document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div class="panel"><div class="head"></div><div class="body"></div></div>';
  w.document.documentElement.append(host);
  const api = w.CatworldZapRiddleUI.attach(shadow, { readStats: () => ({ exp: 1000000, force: 1000 }), startSteps: text => { started.push(text); return startResult; }, readInventory: async () => { started.push('i'); return inventory ?? ''; }, characterName: () => who, runMacro: runMacro ?? (async text => { started.push(text); return true; }), stopMacros });
  api.setEnabled(true);
  shadow.querySelector('.rd-open').click();
  return { shadow, started, calls, changeListeners };
}

const openRiddle = async shadow => {
  assert.ok(await waitFor(() => shadow.querySelector('.rd-row')));
  shadow.querySelector('.rd-row').click();
  assert.ok(await waitFor(() => shadow.querySelector('.rd-step')));
  return [...shadow.querySelectorAll('.rd-step')];
};

ui('a shared step shows who wrote it and the note, and send uses its command', async () => {
  const dom = boot({ shared: { 'qu1.htm': { 2: { command: 'run shared;push stone', by: '小明', note: '先買水', n: 3 } } } });
  const steps = await openRiddle(dom.shadow);
  assert.match(steps[1].querySelector('.rd-cmd').textContent, /指令（共用，小明）：run shared;push stone/);
  assert.match(steps[1].textContent, /備註：先買水/);
  assert.equal(steps[1].querySelector('.rd-warn'), null, 'the step count matches');
  assert.match(steps[0].querySelector('.rd-cmd').textContent, /指令（網站）：run site/, 'steps without a shared row keep the site command');
  [...steps[1].querySelectorAll('.rd-btn')].find(button => button.textContent === '送出').click();
  assert.deepEqual(dom.started, ['run shared;push stone']);
  assert.ok(dom.calls.includes('ZAP_RIDDLE_SHARED'));
});

ui('a shared step whose step count differs from the page now is flagged', async () => {
  const dom = boot({ shared: { 'qu1.htm': { 1: { command: 'run shared', by: '小明', note: '', n: 9 } } } });
  const steps = await openRiddle(dom.shadow);
  assert.match(steps[0].querySelector('.rd-warn').textContent, /步驟已變動/);
});

ui('a shared 停用 hides the command and the send button is off', async () => {
  const dom = boot({ shared: { 'qu1.htm': { 3: { command: '', disabled: true, by: '小華', note: '錯的' } } } });
  const steps = await openRiddle(dom.shadow);
  assert.match(steps[2].querySelector('.rd-cmd').textContent, /共用（小華）已停用這一步的指令　備註：錯的/);
  assert.doesNotMatch(steps[2].textContent, /run site3/);
  assert.equal([...steps[2].querySelectorAll('.rd-btn')].find(button => button.textContent === '送出').disabled, true);
});

ui('your own supplement beats the shared one', async () => {
  const personal = { 'qu1.htm': { n: 3, cmds: { 2: 'run mine' } } };
  const dom = boot({ shared: { 'qu1.htm': { 2: { command: 'run shared', by: '小明', note: '' } } }, personal });
  const steps = await openRiddle(dom.shadow);
  assert.match(steps[1].querySelector('.rd-cmd').textContent, /指令（已補）：run mine/);
});

ui('the panel still works when the shared layer cannot be fetched', async () => {
  const dom = boot({ shared: undefined });
  const steps = await openRiddle(dom.shadow);
  assert.match(steps[0].querySelector('.rd-cmd').textContent, /指令（網站）：run site/);
});

ui('every step is labelled with the number to put in the step column', async () => {
  const dom = boot({ shared: {} });
  const steps = await openRiddle(dom.shadow);
  assert.deepEqual(steps.map(node => /共用表步驟欄填：(\d+)/.exec(node.textContent)?.[1]), ['1', '2', '3']);
});

ui('on a page that prints the same number twice the labels are still 1, 2, 3, 4', async () => {
  const savedSteps = pages['qu1.htm'].steps;
  pages['qu1.htm'].steps = [{ no: 1, text: 'a', commands: '' }, { no: 2, text: 'b', commands: '' }, { no: 1, text: 'c', commands: '' }, { no: 2, text: 'd', commands: '' }];
  try {
    const dom = boot({ shared: {} });
    const steps = await openRiddle(dom.shadow);
    assert.deepEqual(steps.map(node => /共用表步驟欄填：(\d+)/.exec(node.textContent)?.[1]), ['1', '2', '3', '4']);
  } finally {
    pages['qu1.htm'].steps = savedSteps;
  }
});

ui('the list shows at once even when the shared steps have not come back yet, and they appear when they do', async () => {
  let release;
  const sharedGate = new Promise(resolve => { release = resolve; });
  const dom = boot({ shared: { 'qu1.htm': { 1: { command: 'run late', by: '小明', note: '', n: 3 } } }, sharedGate });
  const steps = await openRiddle(dom.shadow);
  assert.match(steps[0].querySelector('.rd-cmd').textContent, /指令（網站）：run site/, 'site data until the shared layer arrives');
  release();
  assert.ok(await waitFor(() => /指令（共用，小明）：run late/.test(dom.shadow.querySelector('.rd-step .rd-cmd')?.textContent ?? '')));
});

ui('in the whole-page view only the riddle own steps carry a label, numbered inside that riddle', async () => {
  const savedRiddles = riddles.slice();
  const savedSteps = pages['qu1.htm'].steps;
  riddles[0] = { ...riddles[0], name: '彈指神通', shared: ['玉蕭劍法'] };
  pages['qu1.htm'].steps = [{ no: 1, text: 'j1', commands: '', heading: '玉蕭劍法：' }, { no: 2, text: 'j2', commands: '' }, { no: 1, text: 'f1', commands: '', heading: '彈指神通：' }, { no: 2, text: 'f2', commands: '' }];
  try {
    const dom = boot({ shared: {} });
    let steps = await openRiddle(dom.shadow);
    assert.equal(steps.length, 2, 'only the riddle own section by default');
    const toggle = [...dom.shadow.querySelectorAll('.rd-btn')].find(button => button.textContent === '顯示整頁步驟');
    toggle.click();
    assert.ok(await waitFor(() => dom.shadow.querySelectorAll('.rd-step').length === 4));
    steps = [...dom.shadow.querySelectorAll('.rd-step')];
    assert.deepEqual(steps.map(node => /共用表步驟欄填：(\d+)/.exec(node.textContent)?.[1] ?? null), [null, null, '1', '2']);
  } finally {
    riddles.splice(0, riddles.length, ...savedRiddles);
    pages['qu1.htm'].steps = savedSteps;
  }
});

ui('a step being viewed picks up shared steps when the cache changes in another tab', async () => {
  let current = {};
  const dom = boot({ shared: {}, sharedNow: () => current });
  const steps = await openRiddle(dom.shadow);
  assert.match(steps[0].querySelector('.rd-cmd').textContent, /指令（網站）：run site/);
  current = { 'qu1.htm': { 1: { command: 'run changed', by: '小華', note: '', n: 3 } } };
  dom.changeListeners.forEach(listener => listener({ sharedCache: { newValue: {} } }, 'local'));
  assert.ok(await waitFor(() => /指令（共用，小華）：run changed/.test(dom.shadow.querySelector('.rd-step .rd-cmd')?.textContent ?? '')));
});

ui('other storage changes do not ask for the shared steps again', async () => {
  const dom = boot({ shared: {} });
  await openRiddle(dom.shadow);
  const before = dom.calls.filter(type => type === 'ZAP_RIDDLE_SHARED').length;
  dom.changeListeners.forEach(listener => listener({ riddleDone: {} }, 'local'));
  dom.changeListeners.forEach(listener => listener({ sharedCache: {} }, 'sync'));
  await sleep(50);
  assert.equal(dom.calls.filter(type => type === 'ZAP_RIDDLE_SHARED').length, before);
});

// 驗證、錯誤、警告的訊息：錯誤紅（rd-bad）、警告維持琥珀（rd-note）、一般訊息灰（rd-ok）
const levelOfNote = node => (node.classList.contains('rd-bad') ? 'error' : node.classList.contains('rd-ok') ? 'info' : 'warn');
const message = shadow => shadow.querySelector('.rd-box > .rd-note');

ui('a failed import is an error line and a successful one is plain', async () => {
  const dom = boot({ shared: {} });
  assert.ok(await waitFor(() => dom.shadow.querySelector('.rd-row')));
  const apply = () => [...dom.shadow.querySelectorAll('.rd-btn')].find(button => button.textContent === '確認匯入').click();
  dom.shadow.querySelector('.rd-io textarea').value = 'not json';
  apply();
  assert.match(message(dom.shadow).textContent, /匯入失敗/);
  assert.equal(levelOfNote(message(dom.shadow)), 'error');
  dom.shadow.querySelector('.rd-io textarea').value = '{"riddleCommands":{},"riddleDone":{}}';
  apply();
  assert.match(message(dom.shadow).textContent, /已匯入/);
  assert.equal(levelOfNote(message(dom.shadow)), 'info');
});

ui('a step that could not be sent is an error line, and a sent one is plain', async () => {
  const refused = boot({ shared: {}, startResult: false });
  const steps = await openRiddle(refused.shadow);
  [...steps[0].querySelectorAll('.rd-btn')].find(button => button.textContent === '送出').click();
  assert.match(message(refused.shadow).textContent, /沒有送出/);
  assert.equal(levelOfNote(message(refused.shadow)), 'error');
  const sent = boot({ shared: {} });
  const okSteps = await openRiddle(sent.shadow);
  [...okSteps[0].querySelectorAll('.rd-btn')].find(button => button.textContent === '送出').click();
  assert.match(message(sent.shadow).textContent, /已送出第/);
  assert.equal(levelOfNote(message(sent.shadow)), 'info');
});

ui('the six-vein page has an item list tab: rows show how and category, read-body sends i and marks what is on the character and stores the ids per character', async () => {
  const savedRiddles = riddles.slice();
  const savedPages = pages['qu1-7.htm'];
  riddles[0] = { ...riddles[0], name: '習得六脈神劍', page: 'qu1-7.htm' };
  pages['qu1-7.htm'] = { preamble: '', text: '網站原文', steps: [] };
  try {
    const store = { scholarItemIds: { 別人: { 玄鐵石: 'xx' } } };
    const dom = boot({ shared: {}, store, inventory: ['你身上帶著下列這些東西( 載重 28% ):', ' *  一顆玄鐵石(stone)', '  紙皮水袋(waterskin)', ' *  四十四把竹劍(bamboo sword)', ' *ˇ一件粗布衣(cloth) [view][remove]'].join('\n') });
    assert.ok(await waitFor(() => dom.shadow.querySelector('.rd-row')));
    dom.shadow.querySelector('.rd-row').click();
    assert.ok(await waitFor(() => dom.shadow.querySelector('.rd-text')));
    assert.match(dom.shadow.querySelector('.rd-text').textContent, /網站原文/, 'the page text tab is first');
    const tab = label => [...dom.shadow.querySelectorAll('.rd-btn')].find(button => button.textContent === label);
    tab('物品清單').click();
    const rows = () => [...dom.shadow.querySelectorAll('.rd-step')];
    assert.ok(rows().length >= 65);
    const row = name => rows().find(item => item.textContent.includes(name));
    assert.match(row('玄鐵石').textContent, /\[解謎\]/);
    assert.match(row('玄鐵石').textContent, /火燄山：漁夫/);
    assert.match(row('桃符紙').textContent, /長安：.*華山：/, 'every way of a merged item');
    assert.doesNotMatch(row('玄鐵石').textContent, /✓|缺/, 'not read yet');
    tab('讀身上').click();
    assert.ok(await waitFor(() => /✓/.test(dom.shadow.querySelector('.rd-step').parentNode.textContent)));
    assert.deepEqual(dom.started, ['i']);
    assert.match(row('玄鐵石').textContent, /✓ ×1/);
    assert.match(row('竹劍').textContent, /✓ ×44/);
    assert.match(row('白金盔甲').textContent, /缺/);
    assert.match(row('白金盔甲').querySelector('.rd-warn').textContent, /缺/);
    assert.match(message(dom.shadow).textContent, /身上有 4 樣，缺 \d+ 樣/);
    assert.equal(levelOfNote(message(dom.shadow)), 'warn');
    assert.deepEqual(JSON.parse(JSON.stringify(store.scholarItemIds)), { 別人: { 玄鐵石: 'xx' }, 小貓: { 玄鐵石: 'stone', 紙皮水袋: 'waterskin', 竹劍: 'bamboo sword', 粗布衣: 'cloth' } });
    tab('網站文字').click();
    assert.match(dom.shadow.querySelector('.rd-text').textContent, /網站原文/);
  } finally {
    riddles.splice(0, riddles.length, ...savedRiddles);
    if (savedPages) pages['qu1-7.htm'] = savedPages;
    else delete pages['qu1-7.htm'];
  }
});

ui('a read that gets no inventory is an error and marks nothing', async () => {
  const savedRiddles = riddles.slice();
  riddles[0] = { ...riddles[0], page: 'qu1-7.htm' };
  pages['qu1-7.htm'] = { preamble: '', text: '網站原文', steps: [] };
  try {
    const dom = boot({ shared: {}, inventory: '' });
    assert.ok(await waitFor(() => dom.shadow.querySelector('.rd-row')));
    dom.shadow.querySelector('.rd-row').click();
    assert.ok(await waitFor(() => dom.shadow.querySelector('.rd-text')));
    [...dom.shadow.querySelectorAll('.rd-btn')].find(button => button.textContent === '物品清單').click();
    [...dom.shadow.querySelectorAll('.rd-btn')].find(button => button.textContent === '讀身上').click();
    assert.ok(await waitFor(() => /沒有讀到/.test(message(dom.shadow).textContent)));
    assert.equal(levelOfNote(message(dom.shadow)), 'error');
    assert.doesNotMatch(dom.shadow.querySelector('.rd-main').textContent, /✓|缺　/);
  } finally {
    riddles.splice(0, riddles.length, ...savedRiddles);
    delete pages['qu1-7.htm'];
  }
});

const INVENTORY = ['你身上帶著下列這些東西( 載重 28% ):', ' *  一顆玄鐵石(stone)', ' *  四十四把竹劍(bamboo sword)'].join('\n');
async function openItems(options) {
  const savedRiddles = riddles.slice();
  riddles[0] = { ...riddles[0], name: '習得六脈神劍', page: 'qu1-7.htm' };
  pages['qu1-7.htm'] = { preamble: '', text: '網站原文', steps: [] };
  const dom = boot({ shared: {}, inventory: INVENTORY, ...options });
  const restore = () => { riddles.splice(0, riddles.length, ...savedRiddles); delete pages['qu1-7.htm']; };
  assert.ok(await waitFor(() => dom.shadow.querySelector('.rd-row')));
  dom.shadow.querySelector('.rd-row').click();
  assert.ok(await waitFor(() => dom.shadow.querySelector('.rd-text')));
  const button = label => [...dom.shadow.querySelectorAll('.rd-btn')].find(item => item.textContent === label);
  button('物品清單').click();
  const row = name => [...dom.shadow.querySelectorAll('.rd-step')].find(item => item.textContent.includes(name));
  const fill = (name, value) => {
    const input = row(name).querySelector('.rd-buy');
    input.value = value;
    input.dispatchEvent(new dom.shadow.ownerDocument.defaultView.Event('input'));
    input.dispatchEvent(new dom.shadow.ownerDocument.defaultView.Event('change'));
  };
  const runButton = name => [...row(name).querySelectorAll('.rd-btn')].find(item => item.textContent === '執行');
  return { dom, restore, button, row, fill, runButton };
}

ui('item list rows have a command field that is saved, the run button shows only when it is filled', async () => {
  const store = {};
  const page = await openItems({ store });
  try {
    assert.equal(page.runButton('燒酒螺').hidden, true);
    page.fill('燒酒螺', ' buy a;@巨集 3 ');
    assert.equal(page.runButton('燒酒螺').hidden, false);
    assert.deepEqual(JSON.parse(JSON.stringify(store.scholarBuyMacros)), { 燒酒螺: 'buy a;@巨集 3' });
    page.fill('燒酒螺', '');
    assert.equal(page.runButton('燒酒螺').hidden, true);
    assert.deepEqual(JSON.parse(JSON.stringify(store.scholarBuyMacros)), {});
  } finally { page.restore(); }
});

ui('the run button sends recall and the command as one macro, then reads i again', async () => {
  const page = await openItems({ store: { scholarBuyMacros: { 燒酒螺: 'nw;buy a' } } });
  try {
    page.runButton('燒酒螺').click();
    assert.ok(await waitFor(() => page.dom.started.includes('i')));
    assert.deepEqual(page.dom.started, ['recall;nw;buy a', 'i']);
    assert.ok(await waitFor(() => /身上有/.test(message(page.dom.shadow).textContent)));
  } finally { page.restore(); }
});

ui('run all missing skips owned rows and rows without a command, runs the rest in list order, then reads i', async () => {
  const store = { scholarBuyMacros: { 燒酒螺: 'buy a', 熊皮: 'kill bear', 竹劍: 'buy sword', 唐詩三百首: ' ' } };
  const page = await openItems({ store });
  try {
    page.button('把缺的都跑一遍').click();
    assert.match(message(page.dom.shadow).textContent, /先按「讀身上」/);
    assert.deepEqual(page.dom.started, []);
    page.button('讀身上').click();
    assert.ok(await waitFor(() => /身上有/.test(message(page.dom.shadow).textContent)));
    page.dom.started.length = 0;
    page.button('把缺的都跑一遍').click();
    assert.ok(await waitFor(() => page.dom.started.length === 3));
    assert.deepEqual(page.dom.started, ['recall;kill bear', 'recall;buy a', 'i'], 'list order: 熊皮 comes before 燒酒螺; 竹劍 is owned; 唐詩三百首 has no command');
  } finally { page.restore(); }
});

ui('stop cancels the running macro and nothing more is sent, no re-read', async () => {
  const sent = [];
  let release = null;
  let stops = 0;
  const runMacro = text => { sent.push(text); return new Promise(resolve => { release = resolve; }); };
  const page = await openItems({ store: { scholarBuyMacros: { 燒酒螺: 'buy a', 熊皮: 'kill bear' } }, runMacro, stopMacros: () => { stops += 1; release(false); } });
  try {
    page.button('讀身上').click();
    assert.ok(await waitFor(() => /身上有/.test(message(page.dom.shadow).textContent)));
    page.dom.started.length = 0;
    page.button('把缺的都跑一遍').click();
    assert.ok(await waitFor(() => sent.length === 1));
    assert.equal(page.button('停止').hidden, false);
    page.button('停止').click();
    assert.ok(await waitFor(() => /已停止/.test(message(page.dom.shadow).textContent)));
    await sleep(50);
    assert.deepEqual(sent, ['recall;kill bear']);
    assert.deepEqual(page.dom.started, [], 'no i read after stop');
    assert.equal(stops, 1);
    assert.equal(page.button('停止').hidden, true);
  } finally { page.restore(); }
});

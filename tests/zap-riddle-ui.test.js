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

const riddles = [{ id: 'a/獨孤九劍', category: 'a', name: '獨孤九劍', condition: '無', difficulty: '易', reward: '技能', hint: '', page: 'qu1.htm', shared: [] }];
const pages = { 'qu1.htm': { preamble: '', text: '', steps: [{ no: 1, text: '第一步', commands: 'run site' }, { no: 2, text: '第二步', commands: '' }, { no: 3, text: '第三步', commands: 'run site3' }] } };

function boot({ shared, personal = {}, calls = [], started = [] }) {
  const dom = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.chrome = {
    storage: { local: { get: async () => ({ riddleCommands: personal, riddleDone: {} }), set: async () => {} }, onChanged: { addListener() {} } },
    runtime: {
      sendMessage: async message => {
        calls.push(message.type);
        if (message.type === 'ZAP_RIDDLES') return { ok: true, riddles, pages };
        if (message.type === 'ZAP_RIDDLE_SHARED') return { ok: true, steps: shared };
        return { ok: false };
      },
    },
  };
  ['zap-riddles.js', 'zap-riddle-ui.js'].forEach(file => w.eval(fs.readFileSync(path.join(root, file), 'utf8')));
  const host = w.document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div class="panel"><div class="head"></div><div class="body"></div></div>';
  w.document.documentElement.append(host);
  const api = w.CatworldZapRiddleUI.attach(shadow, { readStats: () => ({ exp: 1000000, force: 1000 }), startSteps: text => { started.push(text); return true; } });
  api.setEnabled(true);
  shadow.querySelector('.rd-open').click();
  return { shadow, started, calls };
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
  assert.match(steps[1].querySelector('.rd-cmd').textContent, /指令（共用（小明）：先買水）：run shared;push stone/);
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
  assert.match(steps[2].querySelector('.rd-cmd').textContent, /共用（小華）：錯的　已停用這一步的指令/);
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

// 置頂浮窗的「密語」區塊：區塊本身（jsdom 假面板）、整個 content script 收到私聊後面板上出現的內容、載入清單與樣式的串接。
// 需要 jsdom 的部分沒裝就跳過。動畫與 :host 樣式 jsdom 算不出來，只檢查有沒有掛上對應的 class 與樣式文字
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // 沒裝 jsdom
}
const ui = JSDOM ? test : test.skip;
const gamePage = JSDOM ? require('./helpers/game-page') : null;

const root = path.join(__dirname, '..', 'catworld-auto-command');
const source = fs.readFileSync(path.join(root, 'whisper-block.js'), 'utf8');

function boot() {
  const dom = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(source);
  const host = w.document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div class="panel"><div class="body"><div class="stats">數值</div></div></div>';
  w.document.body.append(host);
  const block = w.CatworldWhisperBlock.attach(shadow);
  const $ = selector => shadow.querySelector(selector);
  const items = () => [...shadow.querySelectorAll('.whisper-item')].map(item => item.textContent);
  return { w, shadow, block, $, items };
}

ui('the block is hidden and above the stats until someone whispers', () => {
  const { $, shadow } = boot();
  assert.equal($('.whisper').hidden, true);
  assert.equal(shadow.querySelector('.body').firstElementChild, $('.whisper'));
});

ui('a whisper shows as name and text, flashes, and the newest is on top', () => {
  const { block, $, items } = boot();
  block.add({ name: '有氣質', text: '你好嗎' });
  assert.equal($('.whisper').hidden, false);
  assert.deepEqual(items(), ['有氣質：你好嗎']);
  assert.equal($('.whisper').classList.contains('fresh'), true);
  block.add({ name: '路人', text: '在嗎' });
  assert.deepEqual(items(), ['路人：在嗎', '有氣質：你好嗎']);
});

ui('only the latest five are kept, and clear empties and hides the block', () => {
  const { block, $, items } = boot();
  for (let i = 1; i <= 7; i++) block.add({ name: `人${i}`, text: `話${i}` });
  assert.deepEqual(items(), ['人7：話7', '人6：話6', '人5：話5', '人4：話4', '人3：話3']);
  $('.whisper-clear').click();
  assert.deepEqual(items(), []);
  assert.equal($('.whisper').hidden, true);
  assert.equal($('.whisper').classList.contains('fresh'), false);
});

ui('text is shown as text only, whitespace squeezed, long text cut, blank text ignored', () => {
  const { block, $, items } = boot();
  block.add({ name: 'x', text: '<img src=x onerror=alert(1)>   a\n b' });
  assert.equal($('.whisper img'), null, 'no markup from the game output');
  assert.deepEqual(items(), ['x：<img src=x onerror=alert(1)> a b']);
  block.add({ name: 'y', text: '   ' });
  assert.equal(items().length, 1);
  block.add({ name: 'z', text: 'a'.repeat(500) });
  assert.equal(items()[0].length, 'z：'.length + 200);
});

ui('a new whisper restarts the flash', () => {
  const { block, $ } = boot();
  block.add({ name: 'a', text: '1' });
  $('.whisper').classList.remove('fresh');
  block.add({ name: 'b', text: '2' });
  assert.equal($('.whisper').classList.contains('fresh'), true);
});

ui('the whole content script: a private message shows in the panel, a public line and an echo do not, and it works with auto reply off', async () => {
  const { boot: bootGame, waitFor } = gamePage;
  const page = await bootGame({ scale: 10 });
  try {
    const shadow = page.hosts()[0].shadowRoot;
    const items = () => [...shadow.querySelectorAll('.whisper-item')].map(item => item.textContent);
    assert.equal(shadow.querySelector('.whisper').hidden, true);
    page.output('<span>[P]有氣質回答你：你好嗎</span>\n');
    assert.ok(await waitFor(() => items().length === 1, 1500));
    assert.deepEqual(items(), ['有氣質：你好嗎']);
    assert.equal(shadow.querySelector('.whisper').hidden, false);
    page.output('<span>[P]你說道：大家好</span>\n<span>> tell 有氣質 假的</span>\n');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(items().length, 1, 'public chat and echoed command lines are not whispers');
  } finally {
    page.close();
  }
});

// ---- 串接檢查（不依賴 jsdom）----
const ext = file => fs.readFileSync(path.join(root, file), 'utf8');

test('wiring: loaded in the manifest and the popup fallback after the stats block and before content.js, panel creates it safely', () => {
  const manifest = JSON.parse(ext('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(entry => entry.js);
  const fallback = ext('popup.js').match(/files: \[('trigger-engine\.js'[^\]]*)\]/)?.[1].split(',').map(item => item.trim().replace(/'/g, '')) ?? [];
  for (const list of [scripts, fallback]) {
    assert.ok(list.includes('whisper-block.js'), 'loaded');
    assert.ok(list.indexOf('stats-block.js') < list.indexOf('whisper-block.js') && list.indexOf('whisper-block.js') < list.indexOf('content.js'));
  }
  const content = ext('content.js');
  assert.match(content, /try \{\s*whisperBlock = CatworldWhisperBlock\.attach\(root\);[\s\S]*?\} catch \(error\) \{\s*console\.error\('\[catworld\] 密語區塊初始化失敗'/, 'a broken block must not stop the rest of the panel');
  assert.match(content, /onIncoming: onIncomingChat/);
});

test('wiring: shown only in the floating window, and the flash is a keyframe animation on the fresh class', () => {
  assert.match(source, /:host\(:not\(\[data-pip\]\)\) \.whisper \{ display: none; \}/);
  assert.match(source, /\.whisper\.fresh \{ animation: whisper-flash/);
  assert.match(source, /@keyframes whisper-flash/);
});

ui('the switch: off clears and hides the block and stops collecting, on shows new ones again', () => {
  const { block, $, items } = boot();
  block.add({ name: 'a', text: '1' });
  block.setEnabled(false);
  assert.deepEqual(items(), []);
  assert.equal($('.whisper').hidden, true);
  block.add({ name: 'b', text: '2' });
  assert.deepEqual(items(), [], 'nothing is collected while off');
  block.setEnabled(true);
  block.add({ name: 'c', text: '3' });
  assert.deepEqual(items(), ['c：3']);
  block.setEnabled(undefined);
  block.add({ name: 'd', text: '4' });
  assert.equal(items().length, 2, 'a missing value means on');
});

ui('a whisper whose line has no trailing newline still shows once the output goes quiet', async () => {
  const { boot: bootGame, waitFor } = gamePage;
  const page = await bootGame({ scale: 10 });
  try {
    const shadow = page.hosts()[0].shadowRoot;
    page.output('<span>[P]有氣質回答你：最後一句沒有換行</span>');
    assert.ok(await waitFor(() => shadow.querySelectorAll('.whisper-item').length === 1, 2500));
  } finally {
    page.close();
  }
});

ui('the switch in storage turns the block off in the real panel and back on', async () => {
  const { boot: bootGame, waitFor } = gamePage;
  const page = await bootGame({ scale: 10, initialStore: { zapFeatures: { whisper: false } } });
  try {
    const shadow = page.hosts()[0].shadowRoot;
    const items = () => shadow.querySelectorAll('.whisper-item').length;
    page.output('<span>[P]有氣質回答你：你好</span>\n');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(items(), 0, 'switched off in storage');
    page.store.zapFeatures = { whisper: true };
    page.changeListeners.forEach(listener => listener({ zapFeatures: { newValue: { whisper: true } } }, 'local'));
    page.output('<span>[P]有氣質回答你：再來一句</span>\n');
    assert.ok(await waitFor(() => items() === 1, 1500));
  } finally {
    page.close();
  }
});

ui('the real tell line (名稱(英文ID)告訴你：…) shows in the panel', async () => {
  const { boot: bootGame, waitFor } = gamePage;
  const page = await bootGame({ scale: 10 });
  try {
    const shadow = page.hosts()[0].shadowRoot;
    page.output('<span>[P]山本由伸(yamamoto)告訴你：你好</span>\n');
    assert.ok(await waitFor(() => shadow.querySelectorAll('.whisper-item').length === 1, 1500));
    assert.equal(shadow.querySelector('.whisper-item').textContent, '山本由伸(yamamoto)：你好');
  } finally {
    page.close();
  }
});

ui('the colour: a preset sets the panel variables, an unknown or missing key falls back to orange', () => {
  const { w, block, $ } = boot();
  const accent = () => $('.whisper').style.getPropertyValue('--w-accent');
  block.setColor('red');
  assert.equal(accent(), w.CatworldWhisperBlock.COLORS.red.accent);
  assert.equal($('.whisper').style.getPropertyValue('--w-bg'), w.CatworldWhisperBlock.COLORS.red.bg);
  block.setColor('nonsense');
  assert.equal(accent(), w.CatworldWhisperBlock.COLORS.orange.accent);
  block.setColor('blue');
  block.setColor(undefined);
  assert.equal(accent(), w.CatworldWhisperBlock.COLORS.orange.accent);
  block.setColor('toString');
  assert.equal(accent(), w.CatworldWhisperBlock.COLORS.orange.accent, 'inherited object keys are not colours');
});

ui('the colour in storage reaches the real panel at start and when the settings page changes it', async () => {
  const { boot: bootGame, waitFor } = gamePage;
  const page = await bootGame({ scale: 10, initialStore: { whisperColor: 'green' } });
  try {
    const section = () => page.hosts()[0].shadowRoot.querySelector('.whisper');
    const accent = () => section().style.getPropertyValue('--w-accent');
    assert.ok(await waitFor(() => accent() === '#4ddc7a', 1500), 'read at start');
    page.changeListeners.forEach(listener => listener({ whisperColor: { newValue: 'pink' } }, 'local'));
    assert.equal(accent(), '#ff7ac0', 'follows a change from the settings page');
  } finally {
    page.close();
  }
});

test('wiring: every colour in the block is in the settings dropdown and the other way round', () => {
  const html = ext('popup.html');
  const options = [...html.match(/<select id="whisperColor">([\s\S]*?)<\/select>/)[1].matchAll(/value="(\w+)"/g)].map(match => match[1]).sort();
  const sandbox = { globalThis: {} };
  new Function('globalThis', source)(sandbox.globalThis);
  assert.deepEqual(options, Object.keys(sandbox.globalThis.CatworldWhisperBlock.COLORS).sort());
});

// 置頂浮窗控制（Document Picture-in-Picture）的測試：jsdom，浮窗 API 用假的（回傳第二個 jsdom 視窗）。
// 真正的 Chrome 行為（要使用者點擊才能開、真的置頂、焦點）只能手動驗證。需要 jsdom（devDependency）；沒裝就跳過。
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
const source = fs.readFileSync(process.env.PIP_SOURCE_PATH || path.join(root, 'pip-panel.js'), 'utf8');

// 主頁面（有面板宿主，前後各有一個鄰居，才看得出「放回原位」）加上假的 documentPictureInPicture
function boot({ requestWindow, sizeStore, hostHeight, openAs } = {}) {
  const main = new JSDOM('<html><body><div id="before"></div><div id="host" style="position:fixed;top:12px;right:12px;"></div><div id="after"></div></body></html>', { runScripts: 'outside-only' });
  const mw = main.window;
  const host = mw.document.getElementById('host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button id="inner">開始</button>';
  const clicks = [];
  shadow.getElementById('inner').addEventListener('click', () => clicks.push('start'));

  const pip = new JSDOM('<html><body></body></html>');
  const pw = pip.window;
  // 真的浮窗 close() 會觸發 pagehide
  pw.close = () => pw.dispatchEvent(new pw.Event('pagehide'));
  const calls = [];
  const pipApi = requestWindow === undefined
    ? { requestWindow: async options => { calls.push(options); const actual = openAs ? openAs(options) : options; pw.innerWidth = actual.width; pw.innerHeight = actual.height; return pw; } }
    : requestWindow === null ? undefined : { requestWindow };
  // jsdom 不做排版：用假的高度模擬「收合時矮、展開（data-pip）時高」
  if (hostHeight) host.getBoundingClientRect = () => ({ height: host.hasAttribute('data-pip') ? hostHeight.expanded : hostHeight.collapsed });
  mw.eval(source);
  const notes = [];
  const changes = [];
  const wins = [];
  const controller = pipApi || requestWindow === null
    ? mw.CatworldPip.create({ host, pipApi, sizeStore, notify: text => notes.push(text), onChange: (open, win) => { changes.push(open); wins.push(win); } })
    : null;
  return { mw, pw, host, shadow, clicks, calls, notes, changes, wins, controller, doc: mw.document };
}

const order = doc => [...doc.body.children].map(node => node.id);

ui('opening moves the panel into the floating window, and its buttons still work there', async () => {
  const { host, pw, doc, shadow, clicks, controller } = boot();
  assert.equal(await controller.open(), true);
  assert.equal(host.ownerDocument, pw.document, 'the same node now lives in the floating window');
  assert.ok(pw.document.body.contains(host));
  assert.equal(doc.body.contains(host), false);
  shadow.getElementById('inner').click();
  assert.deepEqual(clicks, ['start'], 'the handler attached before the move still fires');
  assert.equal(controller.isOpen(), true);
});

ui('when the floating window is closed the panel goes back to exactly where it was, with its original inline style and no leftovers', async () => {
  const { host, pw, doc, controller, changes } = boot();
  const original = host.style.cssText;
  await controller.open();
  assert.notEqual(host.style.cssText, original, 'it is positioned for the floating window while it is there');
  pw.close(); // 使用者關掉浮窗：瀏覽器會觸發 pagehide
  assert.equal(host.ownerDocument, doc);
  assert.deepEqual(order(doc), ['before', 'host', 'after'], 'same place among its neighbours');
  assert.equal(host.style.cssText, original);
  assert.equal(doc.body.innerHTML.includes('catworld-panel'), false, 'the marker comment is gone');
  assert.equal(controller.isOpen(), false);
  assert.deepEqual(changes, [true, false]);
});

ui('closing from our own side puts the panel back and closes the window, and it can be opened again', async () => {
  const { host, pw, doc, controller } = boot();
  await controller.open();
  controller.close();
  assert.deepEqual(order(doc), ['before', 'host', 'after']);
  assert.equal(controller.isOpen(), false);
  assert.equal(await controller.open(), true);
  assert.equal(host.ownerDocument, pw.document);
});

ui('toggle opens when closed and closes when open', async () => {
  const { doc, pw, host, controller } = boot();
  await controller.toggle();
  assert.equal(host.ownerDocument, pw.document);
  await controller.toggle();
  assert.equal(host.ownerDocument, doc);
});

ui('the floating window opens 360 wide with a height that fits the panel', async () => {
  const { calls, controller } = boot();
  await controller.open();
  assert.equal(calls[0].width, 360);
  assert.ok(calls[0].height >= 200);
});

ui('without the API the controller says so, the panel stays put, and opening is refused with a reason', async () => {
  const { host, doc, controller, notes } = boot({ requestWindow: null });
  assert.equal(controller.supported, false);
  assert.equal(await controller.open(), false);
  assert.equal(host.ownerDocument, doc);
  assert.match(notes[0], /不支援/);
});

ui('when the browser refuses (or throws) the panel stays where it is and the reason is shown; it can be tried again', async () => {
  let refuse = true;
  const probe = boot();
  const { host, doc, notes, controller } = boot({
    requestWindow: async () => {
      if (refuse) throw Object.assign(new Error('Document PiP requires user activation'), { name: 'NotAllowedError' });
      return probe.pw;
    },
  });
  assert.equal(await controller.open(), false);
  assert.equal(host.ownerDocument, doc);
  assert.deepEqual(order(doc), ['before', 'host', 'after']);
  assert.match(notes[0], /無法開啟置頂視窗/);
  assert.match(notes[0], /user activation/);
  assert.equal(controller.isOpen(), false);
  refuse = false;
  assert.equal(await controller.open(), true, 'a later click works');
});

ui('clicking twice quickly asks the browser for one window only', async () => {
  let asked = 0;
  let release;
  const probe = boot();
  const gate = new Promise(resolve => { release = resolve; });
  const { controller } = boot({ requestWindow: async () => { asked += 1; await gate; return probe.pw; } });
  const first = controller.open();
  const second = controller.open();
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.equal(asked, 1);
});

ui('if moving the panel into the window fails, the window is closed and the panel is back, with a reason', async () => {
  const probe = boot();
  let closed = 0;
  const bad = { addEventListener() {}, close() { closed += 1; }, document: { get body() { throw new Error('cannot adopt'); } } };
  const { host, doc, notes, controller } = boot({ requestWindow: async () => bad });
  assert.equal(await controller.open(), false);
  assert.equal(host.ownerDocument, doc);
  assert.deepEqual(order(doc), ['before', 'host', 'after']);
  assert.equal(closed, 1, 'the half-opened window does not stay around');
  assert.equal(doc.body.innerHTML.includes('catworld-panel'), false, 'and no marker is left in the page');
  assert.match(notes[0], /cannot adopt/);
  assert.equal(probe.controller.isOpen(), false);
});

// ---- 串接檢查：漏掉就整個功能無聲失效的接線（不依賴 jsdom）----
const ext = file => fs.readFileSync(path.join(root, file), 'utf8');

test('wiring: the controller is loaded in the manifest and in the popup fallback, before content.js', () => {
  const manifest = JSON.parse(ext('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(entry => entry.js);
  assert.ok(scripts.includes('pip-panel.js'), 'in the manifest');
  assert.ok(scripts.indexOf('pip-panel.js') < scripts.indexOf('content.js'));
  const popup = ext('popup.js');
  const files = popup.match(/files: \[('trigger-engine\.js'[^\]]*)\]/)?.[1] ?? '';
  assert.ok(files.includes("'pip-panel.js'"), 'in the popup fallback list');
  assert.ok(files.indexOf("'pip-panel.js'") < files.indexOf("'content.js'"));
});

test('wiring: the panel header has the pin button, wired to the controller, and dragging ignores it', () => {
  const content = ext('content.js');
  assert.match(content, /<button class="pip"/);
  assert.match(content, /CatworldPip\.create\(/);
  assert.match(content, /e\.target\.closest\('[^']*\.pip[^']*'\)/, 'pressing the button must not start a drag');
});

test('wiring: while the panel lives in the floating window, the main page layout code leaves it alone', () => {
  const content = ext('content.js');
  const guards = content.match(/host\.ownerDocument !== document/g) ?? [];
  assert.ok(guards.length >= 3, `replace, avoidMap and the drag start all need the guard, found ${guards.length}`);
});

test('wiring: after the panel comes back the main page lays it out again, so a window resized meanwhile cannot leave it off-screen', () => {
  const content = ext('content.js');
  const handler = content.slice(content.indexOf('CatworldPip.create({'), content.indexOf("$('.pip').hidden"));
  assert.match(handler, /replace\(\)/);
  assert.match(handler, /avoidMap\(\)/);
});

ui('if the page removed our marker while the window was open, closing still brings the panel back to the main page', async () => {
  const { host, pw, doc, controller } = boot();
  await controller.open();
  // 遊戲或別的程式把提示條（原位置的標記）刪掉了
  doc.getElementById('catworld-panel-placeholder').remove();
  pw.close();
  assert.equal(host.ownerDocument, doc, 'not stranded in the dead floating window');
  assert.ok(doc.documentElement.contains(host));
  assert.equal(controller.isOpen(), false);
});

ui('if the panel is not attached to the page when opening, the window is closed again and the reason is shown', async () => {
  const { host, pw, notes, controller } = boot();
  let closes = 0;
  const realClose = pw.close;
  pw.close = () => { closes += 1; realClose(); };
  host.remove();
  assert.equal(await controller.open(), false);
  assert.equal(closes, 1, 'no window is left floating around');
  assert.match(notes[0], /無法開啟置頂視窗/);
  assert.equal(controller.isOpen(), false);
});

ui('the floating window scrolls when the panel grows taller than the window', async () => {
  const { pw, controller } = boot();
  await controller.open();
  assert.match(pw.document.body.style.cssText, /overflow:\s*auto/);
});

// ---- 提示條 ----
const placeholderOf = doc => doc.getElementById('catworld-panel-placeholder');

ui('while the panel is in the floating window a strip stays at its old spot, saying so, with a way back', async () => {
  const { doc, host, controller } = boot();
  await controller.open();
  const strip = placeholderOf(doc);
  assert.ok(strip, 'a strip is left in the page');
  assert.deepEqual(order(doc), ['before', 'catworld-panel-placeholder', 'after'], 'exactly where the panel was');
  assert.match(strip.textContent, /面板在置頂視窗/);
  assert.ok([...strip.querySelectorAll('button')].some(button => button.textContent === '收回'));
  assert.match(strip.style.cssText, /top:\s*12px/, 'it sits where the panel sat, so it is easy to find');
  assert.equal(doc.body.contains(host), false);
});

ui('pressing back on the strip closes the floating window and brings the panel home, strip gone', async () => {
  const { doc, host, pw, controller, changes } = boot();
  await controller.open();
  let windowClosed = 0;
  pw.addEventListener('pagehide', () => { windowClosed += 1; });
  [...placeholderOf(doc).querySelectorAll('button')].find(button => button.textContent === '收回').click();
  assert.equal(host.ownerDocument, doc);
  assert.deepEqual(order(doc), ['before', 'host', 'after']);
  assert.equal(placeholderOf(doc), null);
  assert.equal(windowClosed, 1, 'the floating window was closed too');
  assert.deepEqual(changes, [true, false]);
});

ui('closing the floating window directly also removes the strip', async () => {
  const { doc, pw, controller } = boot();
  await controller.open();
  pw.close();
  assert.equal(placeholderOf(doc), null);
  assert.deepEqual(order(doc), ['before', 'host', 'after']);
});

ui('the strip is gone after a failed opening too, and never exists when the API is missing', async () => {
  const failing = boot({ requestWindow: async () => { throw new Error('nope'); } });
  await failing.controller.open();
  assert.equal(placeholderOf(failing.doc), null);
  const missing = boot({ requestWindow: null });
  await missing.controller.open();
  assert.equal(placeholderOf(missing.doc), null);
});

ui('the panel host carries a data-pip attribute exactly while it lives in the floating window', async () => {
  const { host, pw, controller } = boot();
  assert.equal(host.hasAttribute('data-pip'), false);
  await controller.open();
  assert.equal(host.hasAttribute('data-pip'), true, 'the panel styles use it to hide dragging and collapsing');
  pw.close();
  assert.equal(host.hasAttribute('data-pip'), false);
  await controller.open();
  controller.close();
  assert.equal(host.hasAttribute('data-pip'), false);
});

ui('a failed opening never leaves the attribute behind', async () => {
  const bad = { addEventListener() {}, close() {}, document: { get body() { throw new Error('cannot adopt'); } } };
  const { host, controller } = boot({ requestWindow: async () => bad });
  await controller.open();
  assert.equal(host.hasAttribute('data-pip'), false);
});

ui('the change callback hands over the floating window when it opens, so the page can listen to it', async () => {
  const { pw, wins, controller } = boot();
  await controller.open();
  // 用布林比對：斷言失敗時 node 會把整個 jsdom 視窗印出來比對，會卡很久
  assert.ok(wins[0] === pw);
  controller.close();
  assert.ok(wins[1] === undefined);
});

// ---- 浮窗裡的互動也算互動（警報提示靠它停止）----
ui('the interaction hub reports events from the page window, and from the floating window once it is added', () => {
  const { mw, pw } = boot();
  const hub = mw.CatworldPip.createInteractionHub(mw);
  const seen = [];
  hub.watch(['pointerdown', 'keydown'], event => seen.push(`${event.type}`));
  mw.dispatchEvent(new mw.Event('pointerdown'));
  pw.dispatchEvent(new pw.Event('keydown'));
  assert.deepEqual(seen, ['pointerdown'], 'the floating window is not listened to until it is added');
  hub.addWindow(pw);
  pw.dispatchEvent(new pw.Event('keydown'));
  pw.dispatchEvent(new pw.Event('focus'));
  assert.deepEqual(seen, ['pointerdown', 'keydown'], 'only the watched event types');
});

ui('stopping a watch silences both windows, and a window added later does not revive it', () => {
  const { mw, pw } = boot();
  const hub = mw.CatworldPip.createInteractionHub(mw);
  hub.addWindow(pw);
  const seen = [];
  const stop = hub.watch(['pointerdown'], () => seen.push('x'));
  stop();
  stop();
  mw.dispatchEvent(new mw.Event('pointerdown'));
  pw.dispatchEvent(new pw.Event('pointerdown'));
  const other = new JSDOM('').window;
  hub.addWindow(other);
  other.dispatchEvent(new other.Event('pointerdown'));
  assert.deepEqual(seen, []);
});

ui('a window added while a watch is running gets listened to, a removed one stops being listened to, and none fires twice', () => {
  const { mw, pw } = boot();
  const hub = mw.CatworldPip.createInteractionHub(mw);
  const seen = [];
  hub.watch(['pointerdown'], () => seen.push('hit'));
  hub.addWindow(pw);
  hub.addWindow(pw);
  pw.dispatchEvent(new pw.Event('pointerdown'));
  assert.deepEqual(seen, ['hit'], 'adding twice does not double the listener');
  hub.removeWindow(pw);
  pw.dispatchEvent(new pw.Event('pointerdown'));
  assert.deepEqual(seen, ['hit']);
  mw.dispatchEvent(new mw.Event('pointerdown'));
  assert.deepEqual(seen, ['hit', 'hit'], 'the page window keeps working');
  hub.removeWindow(mw);
  mw.dispatchEvent(new mw.Event('pointerdown'));
  assert.deepEqual(seen, ['hit', 'hit', 'hit'], 'the page window can never be removed');
});

ui('two independent watches do not interfere with each other', () => {
  const { mw } = boot();
  const hub = mw.CatworldPip.createInteractionHub(mw);
  const a = [];
  const b = [];
  const stopA = hub.watch(['focus'], () => a.push(1));
  hub.watch(['focus'], () => b.push(1));
  stopA();
  mw.dispatchEvent(new mw.Event('focus'));
  assert.deepEqual([a.length, b.length], [0, 1]);
});

test('wiring: the panel styles hide dragging and collapsing while it lives in the floating window', () => {
  const content = ext('content.js');
  assert.match(content, /:host\(\[data-pip\]\)\s+\.toggle\s*\{\s*display:\s*none/);
  assert.match(content, /:host\(\[data-pip\]\)\s+\.collapsed\s+\.body\s*\{\s*display:\s*block/, 'a panel that was collapsed must not be stuck collapsed with no toggle');
  assert.match(content, /:host\(\[data-pip\]\)\s+\.head\s*\{\s*cursor:\s*default/);
});

test('wiring: the alert that stops on interaction listens through the hub, so the floating window counts too', () => {
  const content = ext('content.js');
  assert.match(content, /createInteractionHub\(window\)/);
  const flash = content.slice(content.indexOf('function flashTitle'), content.indexOf('// 驗證碼警報響鈴中'));
  assert.match(flash, /interactionHub\.watch\(\[/);
  assert.doesNotMatch(flash, /window\.addEventListener\(name, clear\)/, 'no direct listener on the page window any more');
  const handler = content.slice(content.indexOf('CatworldPip.create({'), content.indexOf("$('.pip').hidden"));
  assert.match(handler, /interactionHub\.addWindow\(/);
  assert.match(handler, /interactionHub\.removeWindow\(/);
});

// ---- 視窗大小 ----
const memoryStore = initial => {
  const store = { value: initial, saved: [], load: async () => store.value, save: async size => { store.saved.push(JSON.parse(JSON.stringify(size))); store.value = size; } };
  return store;
};
const resize = (pw, width, height) => {
  pw.innerWidth = width;
  pw.innerHeight = height;
  pw.dispatchEvent(new pw.Event('resize'));
};

ui('the first opening is 360 wide and as tall as the EXPANDED panel, even if the panel is collapsed in the page', async () => {
  const { calls, controller } = boot({ hostHeight: { collapsed: 100, expanded: 500 } });
  await controller.open();
  assert.equal(calls[0].width, 360);
  assert.equal(calls[0].height, 516, 'expanded height plus a little margin, not the 100px collapsed one');
});

ui('opening measures the panel as it will look in the window and does not leave the mark behind when it fails', async () => {
  const { host, controller } = boot({ hostHeight: { collapsed: 100, expanded: 500 }, requestWindow: async () => { throw new Error('nope'); } });
  await controller.open();
  assert.equal(host.hasAttribute('data-pip'), false);
});

ui('a size the user chose is remembered when the window closes and used by the next opening', async () => {
  const store = memoryStore(undefined);
  const first = boot({ sizeStore: store });
  await first.controller.ready;
  await first.controller.open();
  resize(first.pw, 420, 610);
  first.pw.close();
  await first.controller.ready;
  assert.deepEqual(store.saved, [{ width: 420, height: 610 }]);
  const second = boot({ sizeStore: store });
  await second.controller.ready;
  await second.controller.open();
  assert.equal(second.calls[0].width, 420);
  assert.equal(second.calls[0].height, 610);
});

ui('closing remembers the last size even when the window reports nothing at that point', async () => {
  const store = memoryStore(undefined);
  const { pw, controller } = boot({ sizeStore: store });
  await controller.ready;
  await controller.open();
  resize(pw, 500, 700);
  pw.innerWidth = 0;
  pw.innerHeight = 0;
  controller.close();
  assert.deepEqual(store.saved, [{ width: 500, height: 700 }]);
});

ui('nothing is saved when the user never resized the window', async () => {
  const store = memoryStore({ width: 380, height: 520 });
  const { controller } = boot({ sizeStore: store });
  await controller.ready;
  await controller.open();
  controller.close();
  assert.deepEqual(store.saved, []);
});

ui('a remembered size that is broken, missing a field, zero, negative, not a number or absurdly big is ignored', async () => {
  const bad = [null, undefined, 'abc', [], {}, { width: 0, height: 500 }, { width: 400, height: 0 }, { width: -5, height: 300 },
    { width: 360 }, { height: 400 }, { width: '360', height: '500' }, { width: NaN, height: 400 }, { width: Infinity, height: 400 },
    { width: 1e9, height: 400 }, { width: 400, height: 1e9 }, { width: 10, height: 400 }, { width: 400, height: 10 }];
  for (const value of bad) {
    const { calls, controller } = boot({ sizeStore: memoryStore(value), hostHeight: { collapsed: 100, expanded: 300 } });
    await controller.ready;
    assert.equal(await controller.open(), true, `opens anyway with ${JSON.stringify(value)}`);
    assert.equal(calls[0].width, 360, `default width for ${JSON.stringify(value)}`);
    assert.equal(calls[0].height, 316);
  }
});

ui('a sensible remembered size is used as it is, even smaller than the default, and decimals are rounded', async () => {
  const small = boot({ sizeStore: memoryStore({ width: 300, height: 250 }) });
  await small.controller.ready;
  await small.controller.open();
  assert.deepEqual([small.calls[0].width, small.calls[0].height], [300, 250]);
  const decimal = boot({ sizeStore: memoryStore({ width: 400.4, height: 500.6 }) });
  await decimal.controller.ready;
  await decimal.controller.open();
  assert.deepEqual([decimal.calls[0].width, decimal.calls[0].height], [400, 501]);
});

ui('a size storage that fails to read still lets the window open at the default size', async () => {
  const store = { load: async () => { throw new Error('storage down'); }, save: async () => {} };
  const { calls, controller } = boot({ sizeStore: store });
  await controller.ready;
  assert.equal(await controller.open(), true);
  assert.equal(calls[0].width, 360);
});

ui('a size storage that fails to write never stops the panel from coming back', async () => {
  for (const save of [async () => { throw new Error('quota'); }, () => { throw new Error('sync throw'); }]) {
    const { pw, host, doc, controller } = boot({ sizeStore: { load: async () => undefined, save } });
    await controller.ready;
    await controller.open();
    resize(pw, 450, 600);
    pw.close();
    assert.equal(host.ownerDocument, doc);
    assert.equal(controller.isOpen(), false);
    await controller.ready;
  }
});

ui('works without any size storage at all', async () => {
  const { pw, host, doc, controller } = boot();
  await controller.open();
  resize(pw, 450, 600);
  pw.close();
  assert.equal(host.ownerDocument, doc);
});

ui('sizes that fall outside the allowed range are never saved', async () => {
  const store = memoryStore(undefined);
  const { pw, controller } = boot({ sizeStore: store });
  await controller.ready;
  await controller.open();
  resize(pw, 0, 0);
  resize(pw, 5000, 5000);
  controller.close();
  assert.deepEqual(store.saved, []);
});

test('wiring: the floating window size is remembered in local storage through the controller', () => {
  const content = ext('content.js');
  const create = content.slice(content.indexOf('CatworldPip.create({'), content.indexOf("$('.pip').hidden"));
  assert.match(create, /sizeStore:/);
  assert.match(create, /chrome\.storage\.local\.get\(PIP_SIZE_KEY\)/);
  assert.match(create, /chrome\.storage\.local\.set\(\{ \[PIP_SIZE_KEY\]/);
  assert.match(content, /const PIP_SIZE_KEY = 'pipSize'/);
  assert.doesNotMatch(content, /chrome\.storage\.sync/);
});

// ---- 視窗大小的邊界情況 ----
ui('dragging the window back to the size it opened with does not remember the size in between', async () => {
  const store = memoryStore({ width: 380, height: 520 });
  const { pw, controller } = boot({ sizeStore: store });
  await controller.ready;
  await controller.open();
  resize(pw, 600, 700);
  resize(pw, 380, 520);
  controller.close();
  assert.deepEqual(store.saved, [], 'what was remembered before is still right');
});

ui('the panel only looks expanded while it is measured, not while the browser is still creating the window', async () => {
  const ctx = {};
  const seen = [];
  const b = boot({ hostHeight: { collapsed: 100, expanded: 500 }, requestWindow: async options => { seen.push({ marked: ctx.host.hasAttribute('data-pip'), options }); return ctx.pw; } });
  ctx.host = b.host;
  ctx.pw = b.pw;
  await b.controller.open();
  assert.equal(seen[0].marked, false, 'the page shows the panel unchanged while the window is being created');
  assert.equal(seen[0].options.height, 516, 'but the height was still measured as expanded');
  assert.equal(b.host.hasAttribute('data-pip'), true, 'and the mark is there once the panel is in the window');
});

ui('a remembered size bigger than the screen is cut down to what the screen can show', async () => {
  const { mw, calls, controller } = boot({ sizeStore: memoryStore({ width: 1500, height: 1500 }) });
  await controller.ready;
  Object.defineProperty(mw.screen, 'availWidth', { value: 1000, configurable: true });
  Object.defineProperty(mw.screen, 'availHeight', { value: 700, configurable: true });
  await controller.open();
  assert.deepEqual([calls[0].width, calls[0].height], [1000, 700]);
});

ui('a slow size read that finishes after a save does not overwrite what was just saved', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = memoryStore(undefined);
  store.load = async () => { await gate; return { width: 300, height: 300 }; };
  const { pw, calls, controller } = boot({ sizeStore: store });
  await controller.open();
  resize(pw, 450, 600);
  controller.close();
  release();
  await controller.ready;
  await controller.open();
  assert.deepEqual([calls[1].width, calls[1].height], [450, 600], 'the size from this session wins over the late read');
});

// Chrome 開置頂視窗時會把請求的大小縮小（保持長寬比），但拖拉可以更大：基準是「開起來之後的實際大小」
ui('when the browser opens the window smaller than requested and the user does nothing, the remembered size stays as it was', async () => {
  const store = memoryStore({ width: 1437, height: 830 });
  const { pw, calls, controller } = boot({ sizeStore: store, openAs: () => ({ width: 947, height: 547 }) });
  await controller.ready;
  await controller.open();
  assert.deepEqual([calls[0].width, calls[0].height], [1437, 830], 'we still ask for what the user chose');
  pw.dispatchEvent(new pw.Event('resize')); // 瀏覽器開窗時自己觸發的 resize
  controller.close();
  assert.deepEqual(store.saved, [], 'the browser shrinking it is not the user changing it');
});

ui('after the browser shrank the window, a real drag is remembered, and dragging back to the opened size is not', async () => {
  const store = memoryStore({ width: 1437, height: 830 });
  const { pw, controller } = boot({ sizeStore: store, openAs: () => ({ width: 947, height: 547 }) });
  await controller.ready;
  await controller.open();
  resize(pw, 1100, 650);
  controller.close();
  assert.deepEqual(store.saved, [{ width: 1100, height: 650 }]);
  const againStore = memoryStore({ width: 1437, height: 830 });
  const again = boot({ sizeStore: againStore, openAs: () => ({ width: 947, height: 547 }) });
  await again.controller.ready;
  await again.controller.open();
  resize(again.pw, 1100, 650);
  resize(again.pw, 947, 547);
  again.controller.close();
  assert.deepEqual(againStore.saved, [], 'back at the opened size: nothing new to remember');
});

ui('a window that reports no size at all right after opening falls back to the requested size as the baseline', async () => {
  const store = memoryStore(undefined);
  const { pw, controller } = boot({ sizeStore: store, openAs: () => ({ width: 0, height: 0 }) });
  await controller.ready;
  await controller.open();
  resize(pw, 500, 600);
  controller.close();
  assert.deepEqual(store.saved, [{ width: 500, height: 600 }]);
});

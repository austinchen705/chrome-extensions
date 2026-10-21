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
function boot({ requestWindow } = {}) {
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
    ? { requestWindow: async options => { calls.push(options); return pw; } }
    : requestWindow === null ? undefined : { requestWindow };
  mw.eval(source);
  const notes = [];
  const changes = [];
  const controller = pipApi || requestWindow === null
    ? mw.CatworldPip.create({ host, pipApi, notify: text => notes.push(text), onChange: open => changes.push(open) })
    : null;
  return { mw, pw, host, shadow, clicks, calls, notes, changes, controller, doc: mw.document };
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
  const handler = content.slice(content.indexOf('onChange: open =>'), content.indexOf('onChange: open =>') + 400);
  assert.match(handler, /replace\(\)/);
  assert.match(handler, /avoidMap\(\)/);
});

ui('if the page removed our marker while the window was open, closing still brings the panel back to the main page', async () => {
  const { host, pw, doc, controller } = boot();
  await controller.open();
  // 遊戲或別的程式把標記刪掉了
  const walker = doc.createTreeWalker(doc.body, 128);
  let comment = walker.nextNode();
  while (comment && !comment.data.includes('catworld-panel')) comment = walker.nextNode();
  comment.remove();
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

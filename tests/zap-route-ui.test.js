// 怪物清單上的「走過去」按鈕（jsdom）。需要 jsdom（devDependency）；沒裝就跳過。
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

const mobWith = (route, exact = true) => ({
  mob: { name: '華山弟子(a)', id: 'a', exp: 250000, location: '華山', note: '' },
  q: 1.2, grade: 'green', idOnly: false, route: route && { route, exact },
});

function boot({ startResult = true, items, calls = [], changeListeners = [] }) {
  const dom = new JSDOM('<html><body><div id="exp">414748</div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: fn => changeListeners.push(fn) } },
    runtime: { sendMessage: async message => { calls.push(message.type); return { ok: true, items, total: items.length }; } },
  };
  ['zap-mobs.js', 'zap-items.js', 'zap-equipment.js', 'zap-panel.js'].forEach(file => w.eval(fs.readFileSync(path.join(root, file), 'utf8')));
  const host = w.document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div class="panel"><div class="head"></div><div class="body"></div></div>';
  w.document.documentElement.append(host);
  const started = [];
  const panel = w.CatworldZapPanel.attach(shadow, { readExp: () => 414748, startSteps: text => { started.push(text); return startResult; } });
  shadow.querySelector('.zap-open').click();
  return { shadow, started, panel, w };
}

ui('the suitable list shows the route and the button sends it from the inn', async () => {
  const { shadow, started } = boot({ items: [mobWith({ name: '華山', path: 't 2s nw w t' })] });
  assert.ok(await waitFor(() => shadow.querySelector('.zap-walk')));
  assert.match(shadow.querySelector('.zap-route').textContent, /t 2s nw w t/);
  assert.doesNotMatch(shadow.querySelector('.zap-route').textContent, /約略/);
  shadow.querySelector('.zap-walk').click();
  assert.deepEqual(started, ['run e 5n 2o t 2s nw w t']);
  assert.equal(shadow.querySelector('.zap-walk').disabled, true, 'disabled briefly so a double click does not send twice');
});

ui('a partial match is labelled, a mob without a route has no button', async () => {
  const partial = boot({ items: [mobWith({ name: '天魔塔', path: 't 9n' }, false)] });
  assert.ok(await waitFor(() => partial.shadow.querySelector('.zap-route')));
  assert.match(partial.shadow.querySelector('.zap-route').textContent, /約略對應「天魔塔」/);
  const none = boot({ items: [mobWith(null)] });
  assert.ok(await waitFor(() => none.shadow.querySelector('.zap-item')));
  assert.equal(none.shadow.querySelector('.zap-walk'), null);
});

ui('a shared route is labelled with who wrote it and the note, and the button sends its command', async () => {
  const shared = { route: { name: '華山弟子(a)', path: '', command: 'run n;push stone' }, exact: true, shared: { by: '小明', note: '要先買貂皮衣' } };
  const { shadow, started } = boot({ items: [{ ...mobWith(null), route: shared }] });
  assert.ok(await waitFor(() => shadow.querySelector('.zap-walk')));
  assert.match(shadow.querySelector('.zap-route').textContent, /共用（小明）：要先買貂皮衣/);
  shadow.querySelector('.zap-walk').click();
  assert.deepEqual(started, ['run n;push stone']);
  const noNote = boot({ items: [{ ...mobWith(null), route: { ...shared, shared: { by: '小華', note: '' } } }] });
  assert.ok(await waitFor(() => noNote.shadow.querySelector('.zap-route')));
  assert.match(noNote.shadow.querySelector('.zap-route').textContent, /共用（小華）　/);
  assert.doesNotMatch(noNote.shadow.querySelector('.zap-route').textContent, /：/);
});

ui('a personal route beats a shared one in the list', async () => {
  const shared = { route: { name: '華山弟子(a)', path: '', command: 'run shared' }, exact: true, shared: { by: '小明', note: '' } };
  const dom = boot({ items: [{ ...mobWith(null), route: shared }] });
  assert.ok(await waitFor(() => dom.shadow.querySelector('.zap-walk')));
  dom.shadow.querySelector('.zap-routebox .zap-edit').click();
  dom.shadow.querySelector('.zap-routeedit textarea').value = 'run mine';
  [...dom.shadow.querySelectorAll('.zap-routeedit .zap-edit')].find(button => button.textContent === '儲存').click();
  assert.ok(await waitFor(() => /已自訂/.test(dom.shadow.querySelector('.zap-route')?.textContent ?? '')));
  assert.doesNotMatch(dom.shadow.querySelector('.zap-route').textContent, /共用/);
  dom.shadow.querySelector('.zap-walk').click();
  assert.deepEqual(dom.started, ['run mine']);
});

ui('a route the shared sheet turned off shows who did it and has no walk button', async () => {
  const off = { ...mobWith(null), sharedDisabled: { by: '小明', note: '路線是錯的' } };
  const list = boot({ items: [off] });
  assert.ok(await waitFor(() => list.shadow.querySelector('.zap-route')));
  assert.match(list.shadow.querySelector('.zap-route').textContent, /共用（小明）已停用路線：路線是錯的/);
  assert.equal(list.shadow.querySelector('.zap-walk'), null);
  assert.ok(list.shadow.querySelector('.zap-routebox .zap-edit'), 'the list still lets you add your own route');
});

ui('your own route still beats a shared 停用 in the list', async () => {
  const off = { ...mobWith(null), sharedDisabled: { by: '小明', note: '' } };
  const dom = boot({ items: [off] });
  assert.ok(await waitFor(() => dom.shadow.querySelector('.zap-routebox .zap-edit')));
  dom.shadow.querySelector('.zap-routebox .zap-edit').click();
  dom.shadow.querySelector('.zap-routeedit textarea').value = 'run mine';
  [...dom.shadow.querySelectorAll('.zap-routeedit .zap-edit')].find(button => button.textContent === '儲存').click();
  assert.ok(await waitFor(() => dom.shadow.querySelector('.zap-walk')));
  dom.shadow.querySelector('.zap-walk').click();
  assert.deepEqual(dom.started, ['run mine']);
});

ui('an open list asks again when the shared sheet cache changes in another tab', async () => {
  const calls = [];
  const changeListeners = [];
  boot({ items: [mobWith({ name: '華山', path: 't' })], calls, changeListeners });
  assert.ok(await waitFor(() => calls.filter(type => type === 'ZAP_SUITABLE').length === 1));
  changeListeners.forEach(listener => listener({ sharedCache: { newValue: {} } }, 'local'));
  assert.ok(await waitFor(() => calls.filter(type => type === 'ZAP_SUITABLE').length === 2));
  changeListeners.forEach(listener => listener({ somethingElse: {} }, 'local'));
  changeListeners.forEach(listener => listener({ sharedCache: {} }, 'sync'));
  await sleep(50);
  assert.equal(calls.filter(type => type === 'ZAP_SUITABLE').length, 2, 'other keys and other storage areas do not trigger a query');
});

ui('the button says so when the queue refused the commands', async () => {
  const { shadow } = boot({ startResult: false, items: [mobWith({ name: '華山', path: 't' })] });
  assert.ok(await waitFor(() => shadow.querySelector('.zap-walk')));
  shadow.querySelector('.zap-walk').click();
  assert.equal(shadow.querySelector('.zap-walk').textContent, '送不出去');
});

ui('turning the monster and item features off hides the row and stops lookups', async () => {
  const calls = [];
  const { shadow, panel, w } = boot({ items: [], calls });
  w.document.body.insertAdjacentHTML('beforeend', '<div id="content"><span id="message"></span></div>');
  const say = text => w.document.querySelector('#message').append(w.document.createTextNode(text));
  panel.setEnabled({ mobs: false, items: false });
  assert.equal(shadow.querySelector('.line').hidden, true);
  say('  ※華山弟子(a) [fight][kill]\n衰老頭給你一隻奶茶兔吊飾。');
  await sleep(100);
  assert.deepEqual(calls.filter(type => type !== 'ZAP_SUITABLE'), []);
  panel.setEnabled({ mobs: true, items: false });
  assert.equal(shadow.querySelector('.line').hidden, false);
  say('\n  ※華山弟子(a) [fight][kill]');
  assert.ok(await waitFor(() => calls.includes('ZAP_LOOKUP')));
});

ui('clicking the search box does not reach the game window.onclick that steals focus back', async () => {
  const { shadow, w } = boot({ items: [] });
  let reached = 0;
  w.addEventListener('click', () => { reached += 1; });
  shadow.querySelector('input[type="search"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true }));
  assert.equal(reached, 0);
  shadow.querySelector('.zap-open').dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true }));
  assert.equal(reached, 1, 'other buttons are unaffected');
});

ui('text in the monster list can be selected: mousedown there is not cancelled by the panel, buttons still are', async () => {
  const { shadow, w } = boot({ items: [mobWith({ name: '華山', path: 't' })] });
  assert.ok(await waitFor(() => shadow.querySelector('.zap-walk')));
  // 面板（content.js）對整個 shadow root 擋 mousedown，不讓遊戲輸入框失去游標
  shadow.addEventListener('mousedown', event => event.preventDefault());
  const press = node => {
    const event = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(press(shadow.querySelector('.zap-item .meta')), false, 'text can start a selection');
  assert.equal(press(shadow.querySelector('.zap-walk')), true, 'buttons still keep the game input focused');
  assert.equal(press(shadow.querySelector('.zap-open')), true);
});

const noRoute = () => mobWith(null);

ui('a mob without a route can get one added in the list, stored by name, and the walk button then sends it', async () => {
  const { shadow, started, w } = boot({ items: [noRoute()] });
  const saved = [];
  w.chrome.storage.local.set = async values => { saved.push(values); };
  assert.ok(await waitFor(() => shadow.querySelector('.zap-routebox .zap-edit')));
  assert.equal(shadow.querySelector('.zap-walk'), null);
  shadow.querySelector('.zap-routebox .zap-edit').click();
  shadow.querySelector('.zap-routeedit textarea').value = 'run e 5n 2o t;enter crack';
  [...shadow.querySelectorAll('.zap-routeedit .zap-edit')].find(button => button.textContent === '儲存').click();
  assert.ok(await waitFor(() => shadow.querySelector('.zap-walk')));
  assert.equal(JSON.stringify(saved), JSON.stringify([{ mobRoutes: { '華山弟子(a)': 'run e 5n 2o t;enter crack' } }]));
  assert.match(shadow.querySelector('.zap-route').textContent, /已自訂/);
  shadow.querySelector('.zap-walk').click();
  assert.deepEqual(started, ['run e 5n 2o t;enter crack']);
});

ui('restoring the built-in route removes the custom one', async () => {
  const { shadow, w } = boot({ items: [mobWith({ name: '華山', path: 't 2s' })] });
  const saved = [];
  w.chrome.storage.local.set = async values => { saved.push(values); };
  assert.ok(await waitFor(() => shadow.querySelector('.zap-routebox .zap-edit')));
  shadow.querySelector('.zap-routebox .zap-edit').click();
  assert.equal(shadow.querySelector('.zap-routeedit textarea').value, 'run e 5n 2o t 2s', 'starts from the built-in command');
  shadow.querySelector('.zap-routeedit textarea').value = 'look';
  [...shadow.querySelectorAll('.zap-routeedit .zap-edit')].find(button => button.textContent === '儲存').click();
  assert.ok(await waitFor(() => /已自訂/.test(shadow.querySelector('.zap-route')?.textContent || '')));
  shadow.querySelector('.zap-routebox .zap-edit').click();
  [...shadow.querySelectorAll('.zap-routeedit .zap-edit')].find(button => button.textContent === '還原內建').click();
  assert.ok(await waitFor(() => /路線 t 2s/.test(shadow.querySelector('.zap-route')?.textContent || '')));
  assert.equal(JSON.stringify(saved.at(-1)), JSON.stringify({ mobRoutes: {} }));
});

ui('clicking edit does not reach the game window.onclick that would steal the focus from the editor', async () => {
  const { shadow, w } = boot({ items: [noRoute()] });
  let reached = 0;
  w.addEventListener('click', () => { reached += 1; });
  assert.ok(await waitFor(() => shadow.querySelector('.zap-routebox .zap-edit')));
  shadow.querySelector('.zap-routebox .zap-edit').dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true }));
  assert.equal(reached, 0);
});

ui('importing validates first and replaces the custom routes', async () => {
  const { shadow, w } = boot({ items: [noRoute()] });
  const saved = [];
  w.chrome.storage.local.set = async values => { saved.push(values); };
  const imports = [...shadow.querySelectorAll('.zap-tools .zap-edit')].find(button => button.textContent === '匯入路線');
  imports.click();
  shadow.querySelector('.zap-io textarea').value = 'not json';
  shadow.querySelector('.zap-io .zap-edit').click();
  assert.match(shadow.querySelector('.zap-status').textContent, /匯入失敗/);
  assert.deepEqual(saved, []);
  shadow.querySelector('.zap-io textarea').value = '{"華山弟子(a)":"look"}';
  shadow.querySelector('.zap-io .zap-edit').click();
  assert.ok(await waitFor(() => saved.length === 1));
  assert.equal(JSON.stringify(saved[0]), JSON.stringify({ mobRoutes: { '華山弟子(a)': 'look' } }));
});

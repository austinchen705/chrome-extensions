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

function boot({ startResult = true, items }) {
  const dom = new JSDOM('<html><body><div id="exp">414748</div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
    runtime: { sendMessage: async () => ({ ok: true, items, total: items.length }) },
  };
  ['zap-mobs.js', 'zap-items.js', 'zap-equipment.js', 'zap-panel.js'].forEach(file => w.eval(fs.readFileSync(path.join(root, file), 'utf8')));
  const host = w.document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div class="panel"><div class="head"></div><div class="body"></div></div>';
  w.document.documentElement.append(host);
  const started = [];
  w.CatworldZapPanel.attach(shadow, { readExp: () => 414748, startSteps: text => { started.push(text); return startResult; } });
  shadow.querySelector('.zap-open').click();
  return { shadow, started };
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

ui('the button says so when the queue refused the commands', async () => {
  const { shadow } = boot({ startResult: false, items: [mobWith({ name: '華山', path: 't' })] });
  assert.ok(await waitFor(() => shadow.querySelector('.zap-walk')));
  shadow.querySelector('.zap-walk').click();
  assert.equal(shadow.querySelector('.zap-walk').textContent, '送不出去');
});

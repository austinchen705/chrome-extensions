// 遊戲巨集視窗的調整大小把手：整個 content script 在 jsdom 裡跑起來（載入 manifest 列的所有檔案、假的 chrome），
// 頁面放遊戲的 #macro_table。jsdom 算不出排版，這裡只檢查樣式值與儲存；真實手感與排版要在遊戲頁驗證。
// 需要 jsdom（devDependency）；沒裝就跳過。
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
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const SCRIPTS = manifest.content_scripts[0].js;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await condition()) return true;
    await sleep(10);
  }
  return Boolean(await condition());
};

const TABLE = '<div id="macro_table"><div id="macro_header"></div></div>';

// 一個遊戲頁：有（或沒有）巨集視窗；store 是 chrome.storage.local；gate 可以讓讀取晚一點才回來
async function boot({ html = TABLE, saved, gate = null, failSave = false } = {}) {
  const dom = new JSDOM(`<html><body><div id="content"></div><form id="f"><input id="input"></form>${html}</body></html>`, {
    url: 'https://catworld.muds.tw/web',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const timers = [];
  ['setTimeout', 'setInterval'].forEach(name => {
    const original = w[name].bind(w);
    w[name] = (...args) => {
      const id = original(...args);
      timers.push(id);
      return id;
    };
  });
  const store = saved === undefined ? {} : { macroWindowSize: saved };
  const saves = []; // 每一次寫進 storage 的內容
  w.AudioContext = class {
    constructor() { this.state = 'suspended'; }
    resume() { return Promise.resolve(); }
    close() {}
  };
  w.chrome = {
    runtime: { id: 'ext', sendMessage: () => Promise.resolve({}), onMessage: { addListener() {} }, getURL: file => file },
    storage: {
      local: {
        get: async keys => {
          // 先把值讀下來再等 gate：晚回來的是「問的當下」的舊資料，不是現在的
          const found = Object.fromEntries([].concat(keys ?? []).filter(key => key in store).map(key => [key, store[key]]));
          if (gate) await gate;
          return found;
        },
        set: async values => {
          if (failSave) throw new Error('quota');
          saves.push(JSON.parse(JSON.stringify(values)));
          Object.assign(store, JSON.parse(JSON.stringify(values)));
        },
      },
      onChanged: { addListener() {} },
    },
  };
  SCRIPTS.forEach(file => w.eval(fs.readFileSync(path.join(root, file), 'utf8')));
  await sleep(80);
  const table = w.document.getElementById('macro_table');
  const handle = () => w.document.querySelector('#macro_table .macro-resize');
  const mouse = (target, type, x, y) => {
    const event = new w.MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  // 在把手上按下、移動、放開
  const drag = (from, to) => {
    mouse(handle(), 'mousedown', from[0], from[1]);
    mouse(w.document, 'mousemove', to[0], to[1]);
    mouse(w.document, 'mouseup', to[0], to[1]);
  };
  return { w, table, handle, store, saves, mouse, drag, close: () => timers.forEach(id => { w.clearTimeout(id); w.clearInterval(id); }) };
}

ui('the macro window gets a drag handle, and the page without a macro window is left alone', async () => {
  const page = await boot();
  try {
    assert.ok(page.handle(), 'there is a handle inside the macro window');
    assert.equal(page.w.document.querySelectorAll('.macro-resize').length, 1);
  } finally {
    page.close();
  }
  const none = await boot({ html: '' });
  try {
    assert.equal(none.w.document.querySelectorAll('.macro-resize').length, 0, 'nothing to resize, nothing added, nothing thrown');
  } finally {
    none.close();
  }
});

ui('dragging left grows the width and dragging down grows the height, both at once, and the command column takes the extra width', async () => {
  const page = await boot();
  try {
    page.table.style.width = '800px';
    page.table.style.height = '500px';
    page.drag([500, 300], [400, 360]);
    assert.equal(page.table.style.width, '900px', 'moving 100px left adds 100px of width (the window is fixed at its right edge)');
    assert.equal(page.table.style.height, '560px', 'moving 60px down adds 60px of height');
    assert.equal(page.table.style.getPropertyValue('--macro-extra'), '210px', 'the width beyond 690px goes to the command column');
  } finally {
    page.close();
  }
});

ui('when the window has no size of its own yet the drag starts from the smallest size', async () => {
  const page = await boot();
  try {
    page.drag([500, 300], [450, 330]);
    assert.equal(page.table.style.width, '740px');
    assert.equal(page.table.style.height, '493px');
  } finally {
    page.close();
  }
});

ui('the size stays between the smallest window and the screen while dragging', async () => {
  const page = await boot();
  try {
    page.drag([500, 300], [900, 100]);
    assert.deepEqual([page.table.style.width, page.table.style.height], ['690px', '463px'], 'not below the minimum');
    assert.equal(page.table.style.getPropertyValue('--macro-extra'), '0px');
    page.drag([500, 300], [-5000, 5000]);
    assert.deepEqual([page.table.style.width, page.table.style.height], [`${page.w.innerWidth}px`, `${page.w.innerHeight}px`], 'not beyond the screen');
  } finally {
    page.close();
  }
});

ui('letting go saves the size, and a size that was only moved through is not saved before that', async () => {
  const page = await boot();
  try {
    page.mouse(page.handle(), 'mousedown', 500, 300);
    page.mouse(page.w.document, 'mousemove', 400, 360);
    await sleep(20);
    assert.equal(page.store.macroWindowSize, undefined, 'still dragging, nothing saved');
    page.mouse(page.w.document, 'mouseup', 400, 360);
    assert.ok(await waitFor(() => page.store.macroWindowSize));
    assert.deepEqual(page.store.macroWindowSize, { width: 790, height: 523 });
    page.mouse(page.w.document, 'mousemove', 100, 100);
    assert.equal(page.table.style.width, '790px', 'after letting go the window does not follow the mouse any more');
  } finally {
    page.close();
  }
});

ui('a saved size is applied when the page loads, kept inside the screen', async () => {
  const page = await boot({ saved: { width: 800, height: 500 } });
  try {
    assert.ok(await waitFor(() => page.table.style.width === '800px'));
    assert.equal(page.table.style.height, '500px');
    assert.equal(page.table.style.getPropertyValue('--macro-extra'), '110px');
  } finally {
    page.close();
  }
  const big = await boot({ saved: { width: 9000, height: 9000 } });
  try {
    assert.ok(await waitFor(() => big.table.style.width !== ''));
    assert.deepEqual([big.table.style.width, big.table.style.height], [`${big.w.innerWidth}px`, `${big.w.innerHeight}px`]);
  } finally {
    big.close();
  }
});

ui('a saved size that is broken counts as never saved: the window keeps the size the game gives it', async () => {
  for (const saved of ['x', { width: 'a', height: 5 }, { width: 0, height: 500 }, { width: -4, height: 500 }, { width: 20000, height: 500 }, null]) {
    const page = await boot({ saved });
    try {
      await sleep(40);
      assert.equal(page.table.style.width, '', JSON.stringify(saved));
      assert.equal(page.table.style.height, '', JSON.stringify(saved));
    } finally {
      page.close();
    }
  }
});

ui('a saved size that arrives late does not undo a drag the player already made', async () => {
  let open = null;
  const gate = new Promise(resolve => { open = resolve; });
  const page = await boot({ saved: { width: 900, height: 600 }, gate });
  try {
    page.drag([500, 300], [450, 330]);
    assert.equal(page.table.style.width, '740px');
    open();
    await sleep(60);
    assert.equal(page.table.style.width, '740px', 'the old saved size did not win');
  } finally {
    page.close();
  }
});

ui('a storage that cannot save does not break the window', async () => {
  const page = await boot({ failSave: true });
  try {
    page.drag([500, 300], [400, 360]);
    await sleep(30);
    assert.equal(page.table.style.width, '790px');
  } finally {
    page.close();
  }
});

ui('the handle takes the mouse itself: the game window handler (its own title bar drag) does not see it, while the title bar still does', async () => {
  const page = await boot();
  try {
    let reached = 0;
    page.table.onmousedown = () => { reached++; };
    const onHandle = page.mouse(page.handle(), 'mousedown', 500, 300);
    assert.equal(reached, 0, 'the game does not start moving the window');
    assert.equal(onHandle.defaultPrevented, true, 'no text selection while dragging');
    page.mouse(page.w.document, 'mouseup', 500, 300);
    page.mouse(page.w.document.getElementById('macro_header'), 'mousedown', 10, 10);
    assert.equal(reached, 1, 'the title bar drag still reaches the game');
  } finally {
    page.close();
  }
});

ui('an old handle left by a script that lost its extension is replaced, so there is one handle that works', async () => {
  const page = await boot({ html: '<div id="macro_table"><div id="macro_header"></div><div class="macro-resize" data-old="1"></div></div>' });
  try {
    assert.equal(page.w.document.querySelectorAll('.macro-resize').length, 1);
    assert.equal(page.handle().dataset.old, undefined, 'the live one, not the old one');
  } finally {
    page.close();
  }
});

ui('only the main mouse button drags the handle', async () => {
  const page = await boot();
  try {
    const right = new page.w.MouseEvent('mousedown', { clientX: 500, clientY: 300, button: 2, bubbles: true, cancelable: true });
    page.handle().dispatchEvent(right);
    page.mouse(page.w.document, 'mousemove', 400, 360);
    page.mouse(page.w.document, 'mouseup', 400, 360);
    assert.equal(page.table.style.width, '', 'a right click does not resize');
    assert.equal(right.defaultPrevented, false, 'and does not take over the context menu');
    assert.equal(page.store.macroWindowSize, undefined);
  } finally {
    page.close();
  }
});

ui('the window cannot be made bigger than the room left from where it sits: its left edge and bottom edge stay on the screen', async () => {
  const page = await boot({ html: '<div id="macro_table" style="right: 100px; top: 50px"><div id="macro_header"></div></div>' });
  try {
    page.drag([500, 300], [-5000, 5000]);
    assert.deepEqual([page.table.style.width, page.table.style.height], [`${page.w.innerWidth - 100}px`, `${page.w.innerHeight - 50}px`]);
  } finally {
    page.close();
  }
});

ui('a saved size that would put the window off the screen from where it sits now is cut down when it is applied', async () => {
  const page = await boot({ saved: { width: 9000, height: 9000 }, html: '<div id="macro_table" style="right: 200px; top: 80px"><div id="macro_header"></div></div>' });
  try {
    assert.ok(await waitFor(() => page.table.style.width !== ''));
    assert.deepEqual([page.table.style.width, page.table.style.height], [`${page.w.innerWidth - 200}px`, `${page.w.innerHeight - 80}px`]);
  } finally {
    page.close();
  }
});

ui('the drag ends when the mouse button is no longer held even if the button release never arrived, and the size is saved', async () => {
  const page = await boot();
  try {
    page.mouse(page.handle(), 'mousedown', 500, 300);
    page.mouse(page.w.document, 'mousemove', 450, 330);
    assert.equal(page.table.style.width, '740px');
    page.w.document.dispatchEvent(new page.w.MouseEvent('mousemove', { clientX: 300, clientY: 400, buttons: 0, bubbles: true }));
    assert.equal(page.table.style.width, '740px', 'a move without the button held is not a drag');
    assert.ok(await waitFor(() => page.store.macroWindowSize));
    assert.deepEqual(page.store.macroWindowSize, { width: 740, height: 493 });
    page.mouse(page.w.document, 'mousemove', 100, 100);
    assert.equal(page.table.style.width, '740px', 'and it does not come back to life');
  } finally {
    page.close();
  }
});

ui('the drag also ends when the page loses focus', async () => {
  const page = await boot();
  try {
    page.mouse(page.handle(), 'mousedown', 500, 300);
    page.mouse(page.w.document, 'mousemove', 450, 330);
    page.w.dispatchEvent(new page.w.Event('blur'));
    assert.ok(await waitFor(() => page.store.macroWindowSize));
    page.mouse(page.w.document, 'mousemove', 100, 100);
    assert.equal(page.table.style.width, '740px');
  } finally {
    page.close();
  }
});

ui('a click on the handle that moves nothing does not count as the player having set a size', async () => {
  let open = null;
  const gate = new Promise(resolve => { open = resolve; });
  const page = await boot({ saved: { width: 900, height: 600 }, gate });
  try {
    page.mouse(page.handle(), 'mousedown', 500, 300);
    page.mouse(page.w.document, 'mouseup', 500, 300);
    open();
    assert.ok(await waitFor(() => page.table.style.width === '900px'), 'the saved size still applies');
    assert.equal(page.store.macroWindowSize.width, 900, 'and a click saves nothing new');
  } finally {
    page.close();
  }
});

ui('pressing the handle again while an earlier drag never ended first finishes that drag, saving what it had made', async () => {
  const page = await boot();
  try {
    page.mouse(page.handle(), 'mousedown', 500, 300);
    page.mouse(page.w.document, 'mousemove', 450, 330);
    assert.equal(page.store.macroWindowSize, undefined, 'the first drag is still going');
    page.mouse(page.handle(), 'mousedown', 600, 300);
    assert.ok(await waitFor(() => page.store.macroWindowSize), 'the earlier drag was closed off before the new one started');
    assert.deepEqual(page.store.macroWindowSize, { width: 740, height: 493 });
  } finally {
    page.close();
  }
});

ui('once a drag is over nothing from it is left behind: losing focus later or pressing the handle again saves nothing more', async () => {
  const page = await boot();
  try {
    page.drag([500, 300], [450, 330]);
    assert.ok(await waitFor(() => page.saves.length === 1));
    page.w.dispatchEvent(new page.w.Event('blur'));
    page.mouse(page.handle(), 'mousedown', 500, 300);
    page.mouse(page.w.document, 'mouseup', 500, 300);
    await sleep(30);
    assert.equal(page.saves.length, 1, 'no second save from a finished drag, and a click that moved nothing saves nothing');
  } finally {
    page.close();
  }
});

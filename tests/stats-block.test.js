// 面板「數值」區塊的介面測試（jsdom，儲存用假的）。需要 jsdom（devDependency）；沒裝就跳過。
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

const SAMPLE = {
  精: { value: 1452, max: 1452 }, 氣: { value: 35, max: 3654 }, 神: { value: 714, max: 714 },
  靈力: { value: 2080, max: 1040 }, 內力: { value: 6380, max: 3190 }, 法力: { value: 800, max: 400 },
  食物: { value: 805, max: 900 }, 飲水: { value: 532, max: 900 },
};

function boot({ stored = {}, getFails = false, setFails = false, gate = null } = {}) {
  const dom = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  const writes = [];
  w.chrome = {
    storage: {
      local: {
        get: async keys => {
          if (gate) await gate;
          if (getFails) throw new Error('storage down');
          return Object.fromEntries([].concat(keys).filter(key => key in stored).map(key => [key, stored[key]]));
        },
        set: async values => { if (setFails) throw new Error('quota'); writes.push(JSON.parse(JSON.stringify(values))); },
      },
    },
  };
  w.eval(fs.readFileSync(path.join(root, 'stats-view.js'), 'utf8'));
  w.eval(fs.readFileSync(process.env.STATS_BLOCK_SOURCE || path.join(root, 'stats-block.js'), 'utf8'));
  const host = w.document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div class="panel"><div class="head"></div><div class="body"><div class="line" id="timer">定時</div></div></div>';
  w.document.body.append(host);
  const block = w.CatworldStatsBlock.attach(shadow);
  const $ = selector => shadow.querySelector(selector);
  return { w, host, shadow, block, writes, $, rows: () => [...shadow.querySelectorAll('.stat-row')] };
}

const rowText = (rows, label) => rows.find(row => row.querySelector('.stat-label').textContent === label)?.querySelector('.stat-value').textContent;

ui('the block is the first thing in the panel body, titled 數值, with a row for every reading and a dash before any reading arrives', () => {
  const { $, rows, shadow } = boot();
  assert.equal(shadow.querySelector('.body').firstElementChild.className.includes('stats'), true);
  assert.match($('.stats-title').textContent, /數值/);
  assert.deepEqual(rows().map(row => row.querySelector('.stat-label').textContent), ['經驗', '精', '氣', '神', '靈力', '內力', '法力', '食物', '飲水']);
  assert.ok(rows().every(row => row.querySelector('.stat-value').textContent === '—'));
});

ui('rendering fills in the readings as the formatter shows them, and rendering again updates the same rows', () => {
  const { block, rows } = boot();
  block.render(SAMPLE, 414748);
  assert.equal(rowText(rows(), '經驗'), '414748');
  assert.equal(rowText(rows(), '精'), '1452/1452（100%）');
  assert.equal(rowText(rows(), '內力'), '6380/3190（200%）');
  block.render({ ...SAMPLE, 氣: { value: 3000, max: 3654 } }, 414999);
  assert.equal(rows().length, 9, 'no duplicated rows');
  assert.equal(rowText(rows(), '氣'), '3000/3654（82%）');
  assert.equal(rowText(rows(), '經驗'), '414999');
});

ui('an unreadable reading shows a dash and leaves the others alone', () => {
  const { block, rows } = boot();
  block.render({ ...SAMPLE, 氣: null }, NaN);
  assert.equal(rowText(rows(), '氣'), '—');
  assert.equal(rowText(rows(), '經驗'), '—');
  assert.equal(rowText(rows(), '神'), '714/714（100%）');
});

ui('expanded by default; the title folds and unfolds it, and the choice is remembered', async () => {
  const { $, w, writes } = boot();
  const grid = $('.stats-grid');
  assert.equal(grid.hidden, false);
  $('.stats-title').click();
  assert.equal(grid.hidden, true);
  assert.ok(await waitFor(() => writes.length === 1));
  assert.deepEqual(writes[0], { statsCollapsed: true });
  $('.stats-title').click();
  assert.equal(grid.hidden, false);
  assert.ok(await waitFor(() => writes.length === 2));
  assert.deepEqual(writes[1], { statsCollapsed: false });
  assert.ok(w);
});

ui('a remembered fold comes back when the panel is created again', async () => {
  const { $ } = boot({ stored: { statsCollapsed: true } });
  assert.ok(await waitFor(() => $('.stats-grid').hidden === true));
});

ui('a storage that fails to read leaves the block expanded, and one that fails to write does not break folding', async () => {
  const reading = boot({ getFails: true });
  await sleep(30);
  assert.equal(reading.$('.stats-grid').hidden, false);
  const writing = boot({ setFails: true });
  writing.$('.stats-title').click();
  await sleep(30);
  assert.equal(writing.$('.stats-grid').hidden, true, 'folding still works');
});

ui('a click before the saved choice has loaded wins over the late load', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { $ } = boot({ stored: { statsCollapsed: true }, gate });
  $('.stats-title').click(); // 玩家比讀取更早點：展開狀態 → 收合
  assert.equal($('.stats-grid').hidden, true);
  $('.stats-title').click(); // 再點一次：展開
  release();
  await sleep(30);
  assert.equal($('.stats-grid').hidden, false, 'the late read of "collapsed" does not undo what the user just did');
});

ui('folding still works after the whole panel has been moved into another document (the floating window)', async () => {
  const { host, $, writes } = boot();
  const other = new JSDOM('<html><body></body></html>').window;
  other.document.body.append(host);
  assert.ok(host.ownerDocument === other.document, 'the panel really lives in the other document now');
  $('.stats-title').click();
  assert.equal($('.stats-grid').hidden, true);
  assert.ok(await waitFor(() => writes.length === 1));
});

// ---- 串接檢查：漏掉就整個功能無聲失效的接線（不依賴 jsdom）----
const ext = file => fs.readFileSync(path.join(root, file), 'utf8');

test('wiring: both modules are loaded in the manifest and in the popup fallback, the formatter first, all before content.js', () => {
  const manifest = JSON.parse(ext('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(entry => entry.js);
  for (const list of [scripts, ext('popup.js').match(/files: \[('trigger-engine\.js'[^\]]*)\]/)?.[1].split(',').map(item => item.trim().replace(/'/g, '')) ?? []]) {
    assert.ok(list.includes('stats-view.js') && list.includes('stats-block.js'), 'both are loaded');
    assert.ok(list.indexOf('stats-view.js') < list.indexOf('stats-block.js'), 'the formatter before the block');
    assert.ok(list.indexOf('stats-block.js') < list.indexOf('content.js'), 'before content.js');
  }
});

test('wiring: the panel creates the block safely and feeds it every second from the same readings the triggers use', () => {
  const content = ext('content.js');
  assert.match(content, /try \{\s*statsBlock = CatworldStatsBlock\.attach\(root\);\s*\} catch/, 'a broken block must not stop the rest of the panel');
  const render = content.slice(content.indexOf('function renderPanel'));
  assert.match(render, /statsBlock\.render\(readAllStats\(\), readGameNumber\('exp'\)\)/);
  // 觸發規則的讀數來源與 readAllStats 是同一個 readStat
  assert.match(content, /function readAllStats\(\) \{\s*return Object\.fromEntries\(Object\.keys\(CatworldTriggerEngine\.STATS\)\.map\(name => \[name, readStat\(name\)\]\)\);/);
  assert.match(content, /createEngine\(config, \{[\s\S]*?readStat,/);
});

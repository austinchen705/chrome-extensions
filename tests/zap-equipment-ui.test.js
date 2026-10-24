// 裝備比較的介面測試（讀取目前穿著的狀態機、基準的保存、浮層）。需要 jsdom（devDependency）；沒裝就跳過。
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
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'equipment', name), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SCALE = 50; // 把介面裡的等待時間（秒）縮成毫秒，測試才不用真的等
// 浮層的提示只停很短（縮小後不到半秒），所以不能睡固定時間再檢查，要輪詢到條件成立為止
const waitFor = async (condition, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
};

const WORN = [
  ['狩獵腰帶', '腰帶類防具', 12], ['勁衣', '衣物類防具', 8], ['青絲頭巾', '頭盔類防具', 9], ['鐵盾', '盾牌類防具', 15],
  ['金線手套', '手套類防具', 11], ['芙蓉戒指', '戒指類防具', 6], ['吳鉤劍', '劍類武器', 66], ['貓長靴', '鞋子類防具', 10],
  ['貓項圈', '項鍊類防具', 7], ['貓斗篷', '披風類防具', 30], ['貓皮甲', '盔甲類防具', 20],
];
const viewBlock = ([name, category, primary]) => `此物名曰 ：${name}，${category}\n硬    度 ：80\n${category.endsWith('武器') ? '傷 害 力' : '防 禦 力'} ：${primary} / ${primary}\n佩帶條件 ：經驗 0\n`;

function boot({ startResult = true, stored = {}, title = '小貓的世界 WEB' } = {}) {
  const dom = new JSDOM(`<html><head><title>${title}</title></head><body><div id="monitor"><span id="exp">414748</span></div><div id="content"><span id="message"></span></div></body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  // 介面裡的 setTimeout／setInterval 都縮短，Date.now 不動
  const realSet = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => realSet(fn, Math.max(1, Math.round((ms ?? 0) / SCALE)), ...args);
  w.setInterval = () => 0;
  const mem = { ...stored };
  const sent = [];
  w.chrome = {
    storage: {
      local: {
        get: async keys => Object.fromEntries([].concat(keys).map(key => [key, mem[key]]).filter(([, value]) => value !== undefined)),
        set: async values => Object.assign(mem, JSON.parse(JSON.stringify(values))),
      },
      onChanged: { addListener() {} },
    },
    runtime: { sendMessage: async () => ({ ok: false, error: 'unused' }) },
  };
  ['zap-mobs.js', 'zap-items.js', 'zap-equipment.js', 'zap-panel.js', 'zap-equipment-ui.js'].forEach(file => w.eval(fs.readFileSync(path.join(root, file), 'utf8')));
  const host = w.document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div class="panel"><div class="head"></div><div class="body"></div></div>';
  w.document.documentElement.append(host);
  const exp = () => 414748;
  const zap = w.CatworldZapPanel.attach(shadow, { readExp: exp });
  w.CatworldZapEquipmentUI.attach(shadow, {
    overlay: { section: zap.sections.equipment, touchHint: zap.touchHint, el: zap.el },
    readExp: exp,
    startSteps: text => { sent.push(text); if (startResult === 'throw') throw new Error('boom'); return startResult; },
  });
  const add = html => w.document.getElementById('message').appendChild(w.document.createRange().createContextualFragment(html));
  const button = () => shadow.querySelector('.eq-read');
  return {
    w, add, sent, mem,
    button,
    click: () => button().dispatchEvent(new w.Event('click', { bubbles: true })),
    status: () => shadow.querySelector('.eq-status').textContent,
    shadowNotes: () => zap.sections.equipment.querySelectorAll('.zap-more'),
    overlay: () => zap.sections.equipment.textContent.replace(/\s+/g, ' ').trim(),
    rows: () => [...zap.sections.equipment.querySelectorAll('.zap-block')].map(node => node.textContent.replace(/\s+/g, ' ').trim()),
  };
}

const store = page => Object.values(page.mem.wornEquipment ?? {})[0] ?? {};

ui('the button sends i first and is disabled while waiting', async () => {
  const page = boot();
  await sleep(20);
  page.click();
  await sleep(10);
  assert.deepEqual(page.sent, ['i']);
  assert.equal(page.button().disabled, true);
  assert.match(page.status(), /等待背包/);
});

ui('after the inventory arrives it sends one view macro with every worn id', async () => {
  const page = boot();
  await sleep(20);
  page.click();
  page.add(fixture('inventory.html'));
  await sleep(150);
  assert.equal(page.sent.length, 2);
  const views = page.sent[1].split(';');
  assert.equal(views.length, 11);
  assert.ok(views.every(command => /^view #\d+$/.test(command)));
});

ui('a worn line split across two packets is still picked up', async () => {
  const page = boot();
  await sleep(20);
  page.click();
  const html = fixture('inventory.html');
  const cut = html.indexOf('golden hands') + 6; // 切在「金線手套」那一行的中間
  page.add(html.slice(0, cut));
  await sleep(5);
  page.add(html.slice(cut));
  await sleep(150);
  assert.equal(page.sent[1].split(';').length, 11, 'all 11 pieces, including the one that was split');
});

ui('reading every worn piece stores the baseline under the character name', async () => {
  const page = boot({ title: '測試角色 - 小貓的世界 WEB' });
  await sleep(20);
  page.click();
  page.add(fixture('inventory.html'));
  await sleep(150);
  page.add(WORN.map(viewBlock).join(''));
  await sleep(150);
  const stores = page.mem.wornEquipment;
  assert.deepEqual(Object.keys(stores), ['測試角色']);
  assert.equal(Object.values(stores['測試角色']).flat().length, 11);
  assert.match(page.status(), /已讀取 11 件/);
});

ui('an interrupted read keeps the old baseline of the pieces that did not answer', async () => {
  const old = {
    '': {
      '披風類防具': [{ name: '貓斗篷', primary: 30, attrs: [], needExp: 0, readAt: 1000 }],
      '盔甲類防具': [{ name: '貓皮甲', primary: 20, attrs: [], needExp: 0, readAt: 1000 }],
      '帽子類防具': [{ name: '早就脫掉的帽子', primary: 5, attrs: [], needExp: 0, readAt: 1000 }],
    },
  };
  const page = boot({ stored: { wornEquipment: old } });
  await sleep(20);
  page.click();
  page.add(fixture('inventory.html'));
  await sleep(150);
  page.add(viewBlock(['貓斗篷', '披風類防具', 33])); // 只有一件回應，其餘被中斷
  // 讀取閒置逾時（20 秒縮成約 0.4 秒）之後結束，並提示只讀到幾件
  assert.ok(await waitFor(() => /只讀到 1\/11 件/.test(page.overlay())), page.overlay());
  const saved = store(page);
  assert.equal(saved['披風類防具'][0].primary, 33, 'the piece that answered is updated');
  assert.equal(saved['盔甲類防具'][0].name, '貓皮甲', 'a worn piece that did not answer keeps its old entry');
  assert.equal(saved['帽子類防具'], undefined, 'a piece that is no longer worn is dropped');
});

ui('no inventory output means no view is ever sent', async () => {
  const page = boot();
  await sleep(20);
  page.click();
  assert.ok(await waitFor(() => /沒有讀到背包/.test(page.overlay())), '逾時後要提示（10 秒縮成 0.2 秒）');
  assert.deepEqual(page.sent, ['i']);
  assert.equal(page.button().disabled, false, 'the button works again');
});

ui('a refused or throwing send puts the button back to idle', async () => {
  for (const startResult of [false, 'throw']) {
    const page = boot({ startResult });
    await sleep(20);
    page.click();
    await sleep(10);
    assert.equal(page.button().disabled, false, `startResult ${startResult}`);
    assert.match(page.overlay(), /沒有送出|送出失敗/);
  }
});

ui('the button is disabled while an identify run is open', async () => {
  const page = boot();
  await sleep(20);
  page.add('> 你想請馬鑑定師鑑定所有無名物。\n');
  await sleep(20);
  assert.equal(page.button().disabled, true);
  assert.match(page.status(), /鑑定進行中/);
  page.click();
  assert.deepEqual(page.sent, [], 'a disabled button sends nothing');
});

ui('an identify run compares every block with the stored baseline', async () => {
  const stored = { '': {
    '披風類防具': [{ name: '貓斗篷', primary: 30, attrs: [], needExp: 0, readAt: Date.now() }],
    '盔甲類防具': [{ name: '貓皮甲', primary: 20, attrs: [], needExp: 0, readAt: Date.now() }],
  } };
  const page = boot({ stored: { wornEquipment: stored } });
  await sleep(30);
  const sample = fixture('identify-sample.txt');
  const third = Math.floor(sample.length / 3);
  page.add(sample.slice(0, third));
  await sleep(20);
  page.add(sample.slice(third, third * 2));
  await sleep(20);
  page.add(sample.slice(third * 2));
  await sleep(150);
  const rows = page.rows();
  assert.equal(rows.length, 10);
  const row = name => rows.find(text => text.startsWith(name));
  assert.match(row('霧起時'), /比現在差/);
  assert.match(row('鋼盔甲'), /比現在好，建議留下/);
  assert.match(row('銅棒'), /沒有基準可比/);
});

const CLOAK_BASELINE = { '': { '披風類防具': [{ name: '貓斗篷', primary: 30, attrs: [], needExp: 0, readAt: Date.now() }] } };
const identifyRun = blocks => `> 你想請馬鑑定師鑑定所有無名物。\n${blocks.map(([name, category, primary]) => `此物名曰 ：${name}，${category}\n防 禦 力 ：${primary} / ${primary}\n`).join('')}馬鑑定師說道：共鑑定${blocks.length}樣無名物，歡迎再次光臨。\n`;
const names = rows => rows.map(text => text.split('（')[0]);

ui('identify results are listed best first: better, then equal, then no baseline, then worse, each group in the order they came', async () => {
  const page = boot({ stored: { wornEquipment: CLOAK_BASELINE } });
  await sleep(30);
  page.add(identifyRun([
    ['差一', '披風類防具', 20], ['無基準', '戒指類防具', 10], ['好一', '披風類防具', 40], ['相當', '披風類防具', 30], ['差二', '披風類防具', 21], ['好二', '披風類防具', 45],
  ]));
  await sleep(150);
  assert.deepEqual(names(page.rows()), ['好一', '好二', '相當', '無基準', '差一', '差二']);
});

ui('a later identify run slots its results into the same order instead of going to the bottom', async () => {
  const page = boot({ stored: { wornEquipment: CLOAK_BASELINE } });
  await sleep(30);
  page.add(identifyRun([['差一', '披風類防具', 20], ['好一', '披風類防具', 40]]));
  await sleep(150);
  page.add(identifyRun([['差二', '披風類防具', 22], ['好二', '披風類防具', 41]]));
  await sleep(150);
  assert.deepEqual(names(page.rows()), ['好一', '好二', '差一', '差二']);
});

ui('past the limit of 12 results the worst and oldest are dropped first, so a recommended piece is not pushed out by worse ones', async () => {
  const page = boot({ stored: { wornEquipment: CLOAK_BASELINE } });
  await sleep(30);
  const worse = [1, 2, 3, 4, 5, 6].map(n => [`差${n}`, '披風類防具', 20]);
  const better = [1, 2, 3, 4, 5, 6, 7].map(n => [`好${n}`, '披風類防具', 40 + n]);
  page.add(identifyRun([...worse, ...better]));
  await sleep(150);
  assert.deepEqual(names(page.rows()), ['好1', '好2', '好3', '好4', '好5', '好6', '好7', '差2', '差3', '差4', '差5', '差6']);
});

ui('a new worse result does not push out recommended ones when the list is already full', async () => {
  const page = boot({ stored: { wornEquipment: CLOAK_BASELINE } });
  await sleep(30);
  page.add(identifyRun([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => [`好${n}`, '披風類防具', 40 + n])));
  await sleep(150);
  page.add(identifyRun([['差新', '披風類防具', 20]]));
  await sleep(150);
  assert.equal(page.rows().length, 12);
  assert.ok(!names(page.rows()).includes('差新'));
});

ui('an identify end line split across packets does not leave the run open', async () => {
  const page = boot();
  await sleep(20);
  page.add('> 你想請馬鑑定師鑑定所有無名物。\n此物名曰 ：星河，項鍊類防具\n防 禦 力 ：10 / 10\n馬鑑定師說道：共鑑定一');
  await sleep(5);
  page.add('樣無名物，歡迎再次光臨。\n');
  await sleep(150);
  assert.equal(page.button().disabled, false, 'the run is over');
  assert.equal(page.rows().length, 1);
});

ui('the old flat storage format is ignored instead of crashing', async () => {
  const page = boot({ stored: { wornEquipment: { '披風類防具': [{ name: '舊的', primary: 99, attrs: [], needExp: 0, readAt: 1 }] } } });
  await sleep(30);
  assert.match(page.status(), /尚未讀取/);
});

// 驗證、錯誤、警告的訊息：錯誤紅（zap-bad）、警告琥珀（zap-caution）
ui('a refused or throwing send is an error line in the overlay', async () => {
  // 丟例外時會先出「送出失敗」再出「沒有送出」，兩條都要是紅的（各自檢查，不能互相遮住）
  for (const [startResult, expected] of [[false, [/沒有送出/]], ['throw', [/送出失敗/, /沒有送出/]]]) {
    const page = boot({ startResult });
    await sleep(20);
    page.click();
    await sleep(10);
    const notes = [...page.shadowNotes()];
    for (const pattern of expected) {
      const note = notes.find(node => pattern.test(node.textContent));
      assert.ok(note && note.classList.contains('zap-bad'), `startResult ${startResult}: ${pattern}`);
    }
  }
});

ui('no inventory output is a caution line, not an error', async () => {
  const page = boot();
  await sleep(20);
  page.click();
  assert.ok(await waitFor(() => /沒有讀到背包/.test(page.overlay())));
  const note = [...page.shadowNotes()].find(node => /沒有讀到背包/.test(node.textContent));
  assert.ok(note.classList.contains('zap-caution'));
  assert.equal(note.classList.contains('zap-bad'), false);
});

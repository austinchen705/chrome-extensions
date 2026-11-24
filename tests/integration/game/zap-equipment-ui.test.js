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

const root = path.join(__dirname, '..', '..', '..', 'catworld-auto-command');
const fixture = name => fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'equipment', name), 'utf8');
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

function boot({ startResult = true, stored = {}, title = '小貓的世界 WEB', enabled = true } = {}) {
  const dom = new JSDOM(`<html><head><title>${title}</title></head><body><div id="monitor"><span id="exp">414748</span></div><div id="content"><span id="message"></span></div></body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  // 介面裡的 setTimeout／setInterval 都縮短，Date.now 不動
  const realSet = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => realSet(fn, Math.max(1, Math.round((ms ?? 0) / SCALE)), ...args);
  w.setInterval = () => 0;
  const mem = { ...stored };
  const busy = { value: false };
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
  const equipUI = w.CatworldZapEquipmentUI.attach(shadow, {
    overlay: { section: zap.sections.equipment, touchHint: zap.touchHint, el: zap.el },
    readExp: exp,
    startSteps: text => { sent.push(text); if (startResult === 'throw') throw new Error('boom'); return startResult; },
    isBusy: () => busy.value,
  });
  equipUI.setEnabled(enabled);
  const add = html => w.document.getElementById('message').appendChild(w.document.createRange().createContextualFragment(html));
  const button = () => shadow.querySelector('.eq-read');
  return {
    w, add, sent, mem, busy,
    noteSent: command => equipUI.noteSent(command),
    setEnabled: on => equipUI.setEnabled(on),
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

ui('an earlier i still in the buffer does not make every view go out twice', async () => {
  // 玩家幾分鐘前自己打過 i，之後房間裡一直有人說話（3 秒內都有新輸出）讓 HTML 緩衝一直不清；
  // 按下按鈕後新的清單接在舊的後面，以前會變成 18 步的巨集（同樣 9 件、同樣順序送兩輪）
  const page = boot();
  await sleep(20);
  page.add(fixture('inventory.html'));
  await sleep(10);
  page.add('<span class="H6">【閒聊】路人說：有人要組隊嗎</span>\n');
  await sleep(10);
  page.click();
  await sleep(5);
  page.add('&gt; i\n' + fixture('inventory.html'));
  await sleep(150);
  assert.equal(page.sent.length, 2);
  const views = page.sent[1].split(';');
  assert.equal(views.length, 11, 'each worn piece is viewed once, not twice');
  assert.equal(new Set(views).size, 11);
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

const KEEP_RUN = `> 你想請馬鑑定師鑑定所有無名物。\n此物名曰 ：差一，披風類防具\n防 禦 力 ：20 / 20\n此物名曰 ：留著，披風類防具\n防 禦 力 ：20 / 20\n屬    性 ：+10   行動\n此物名曰 ：相當，披風類防具\n防 禦 力 ：30 / 30\n馬鑑定師說道：共鑑定3樣無名物，歡迎再次光臨。\n`;

ui('with the attribute threshold on, a worse piece whose attribute reaches it is marked keep and sorts with the recommended ones', async () => {
  const page = boot({ stored: { wornEquipment: CLOAK_BASELINE, equipmentKeep: { enabled: true, min: 10 } } });
  await sleep(30);
  page.add(KEEP_RUN);
  await sleep(150);
  assert.deepEqual(names(page.rows()), ['留著', '相當', '差一']);
  assert.match(page.rows()[0], /屬性達門檻，建議留下 對象：貓斗篷 行動 \+10 達門檻 10 防禦 -10/);
});

ui('with the attribute threshold off (the default) the same piece is just worse', async () => {
  const page = boot({ stored: { wornEquipment: CLOAK_BASELINE } });
  await sleep(30);
  page.add(KEEP_RUN);
  await sleep(150);
  assert.deepEqual(names(page.rows()), ['相當', '差一', '留著']);
  assert.match(page.rows()[2], /比現在差/);
});

ui('a stored score rule changes the verdict: with the other-attribute weight at 5 the piece with +10 of an ordinary attribute is better instead of worse', async () => {
  const page = boot({ stored: { wornEquipment: CLOAK_BASELINE, equipmentScore: { otherWeight: 5 } } });
  await sleep(30);
  page.add(KEEP_RUN);
  await sleep(150);
  assert.deepEqual(names(page.rows()), ['留著', '相當', '差一']);
  assert.match(page.rows()[0], /比現在好，建議留下/);
});

// ---- 自動讀取穿著（登入或換裝後差異讀取）----
// 介面裡的等待縮小 SCALE 倍：換裝去抖 3 秒→60 毫秒、登入安靜 5 秒→100 毫秒、忙碌重查 2 秒→40 毫秒
const AUTO_ON = { equipAutoRead: { enabled: true, commands: ['wear', 'wield', 'remove', 'unwield', 'we'] } };
const NAMED = '測試角色 - 小貓的世界 WEB';
const baselineOf = readAt => {
  const stores = {};
  WORN.forEach(([name, category, primary]) => (stores[category] ??= []).push({ name, primary, attrs: [], needExp: 0, readAt }));
  return stores;
};
const wornNames = page => Object.values(store(page)).flat().map(item => item.name).sort();
const withoutSword = () => fixture('inventory.html').split('\n').filter(line => !line.includes('吳鉤劍')).join('\n');
const LOGIN = '【注意事項】\n這個ＭＵＤ還處於玩家測試期間，請多包涵。\n';
const autoPage = (extra = {}) => boot({ title: NAMED, stored: { wornEquipment: { 測試角色: baselineOf(1000) }, ...AUTO_ON }, ...extra });

ui('an equip command (including a user alias) restarts a 3 second timer and then reads once', async () => {
  const page = autoPage();
  await sleep(20);
  page.noteSent('wear ring');
  await sleep(30);
  page.noteSent('we sword'); // 別名：清單裡自己加的字，重新計時
  await sleep(40);
  assert.deepEqual(page.sent, [], 'the timer restarted, so nothing is sent yet');
  assert.ok(await waitFor(() => page.sent.length === 1));
  assert.deepEqual(page.sent, ['i']);
  await sleep(150);
  assert.deepEqual(page.sent, ['i'], 'one read, not one per equip command');
});

ui('only the first word of a sent command counts, in any segment of a ; line', async () => {
  const page = autoPage();
  await sleep(20);
  page.noteSent('look');
  page.noteSent('wearing out');
  page.noteSent('say wear');
  await sleep(150);
  assert.deepEqual(page.sent, []);
  page.noteSent('look;remove all');
  assert.ok(await waitFor(() => page.sent.length === 1));
});

ui('a read after a change views only the newly worn piece and drops the one taken off', async () => {
  const page = autoPage();
  await sleep(20);
  page.noteSent('wear ring');
  assert.ok(await waitFor(() => page.sent.length === 1));
  page.add(withoutSword().replace('芙蓉戒指', '光之戒').replace(/view #1790784002139296/g, 'view #777'));
  assert.ok(await waitFor(() => page.sent.length === 2));
  assert.equal(page.sent[1], 'view #777', 'one view, for the new ring only');
  page.add(viewBlock(['光之戒', '戒指類防具', 9]));
  assert.ok(await waitFor(() => wornNames(page).includes('光之戒')));
  assert.equal(wornNames(page).length, 10);
  assert.ok(!wornNames(page).includes('吳鉤劍'), 'the sword taken off is gone from the baseline');
  assert.ok(!wornNames(page).includes('芙蓉戒指'), 'the ring that is no longer worn is gone');
  assert.equal(store(page)['盾牌類防具'][0].readAt, 1000, 'unchanged pieces keep their reading');
});

ui('a piece taken off is dropped from the baseline and no view is sent', async () => {
  const page = autoPage();
  await sleep(20);
  page.noteSent('remove sword');
  assert.ok(await waitFor(() => page.sent.length === 1));
  page.add(withoutSword());
  assert.ok(await waitFor(() => wornNames(page).length === 10));
  await sleep(100);
  assert.deepEqual(page.sent, ['i']);
  assert.ok(!wornNames(page).includes('吳鉤劍'));
});

ui('nothing changed: no view is sent and the baseline is untouched', async () => {
  const page = autoPage();
  await sleep(20);
  page.noteSent('wear all');
  assert.ok(await waitFor(() => page.sent.length === 1));
  page.add(fixture('inventory.html'));
  await sleep(150);
  assert.deepEqual(page.sent, ['i']);
  assert.equal(page.mem.wornEquipment['測試角色']['劍類武器'][0].readAt, 1000);
  assert.equal(page.button().disabled, false, 'back to idle');
});

ui('no worn list in the output never wipes the baseline', async () => {
  const page = autoPage();
  await sleep(20);
  page.noteSent('wear all');
  assert.ok(await waitFor(() => page.sent.length === 1));
  await sleep(300);
  assert.equal(page.sent.length, 1);
  assert.equal(wornNames(page).length, 11);
});

ui('the login screen text triggers one read after the output is quiet', async () => {
  const page = autoPage();
  await sleep(20);
  page.add(LOGIN);
  await sleep(50);
  page.add('<span>更多歡迎文字</span>\n'); // 還有輸出：重新等
  await sleep(70);
  assert.deepEqual(page.sent, [], 'still within the quiet period');
  assert.ok(await waitFor(() => page.sent.length === 1));
  assert.deepEqual(page.sent, ['i']);
});

ui('the login text split across two packets still counts', async () => {
  const page = autoPage();
  await sleep(20);
  page.add('【注意事項】\n');
  await sleep(5);
  page.add('這個ＭＵＤ還處於玩家測試期間\n');
  assert.ok(await waitFor(() => page.sent.length === 1));
});

ui('without the login text (a page refresh) nothing is read, and half of it is not enough', async () => {
  const page = autoPage();
  await sleep(20);
  page.add('<span>你看到一隻貓。</span>\n【注意事項】\n');
  await sleep(250);
  assert.deepEqual(page.sent, []);
});

ui('login text before the character name is in the title waits instead of sending i at the login prompt', async () => {
  const page = autoPage({ title: '小貓的世界 WEB' });
  await sleep(20);
  page.add(LOGIN);
  await sleep(250);
  assert.deepEqual(page.sent, [], 'not logged in yet');
  page.w.document.title = NAMED;
  assert.ok(await waitFor(() => page.sent.length === 1));
});

ui('while busy (hunt, macro, busy status, verification) the read waits, then happens once after', async () => {
  const page = autoPage();
  await sleep(20);
  page.busy.value = true;
  page.noteSent('wield sword');
  await sleep(250);
  assert.deepEqual(page.sent, []);
  page.busy.value = false;
  assert.ok(await waitFor(() => page.sent.length === 1));
  await sleep(150);
  assert.deepEqual(page.sent, ['i']);
});

ui('a manual read in progress defers the auto read', async () => {
  const page = autoPage();
  await sleep(20);
  page.click();
  await sleep(10);
  page.noteSent('wear ring');
  await sleep(120);
  assert.deepEqual(page.sent, ['i'], 'only the manual i so far');
});

ui('the setting off sends nothing for equip commands or the login text', async () => {
  const page = boot({ title: NAMED, stored: { wornEquipment: { 測試角色: baselineOf(1000) }, equipAutoRead: { enabled: false, commands: ['wear'] } } });
  await sleep(20);
  page.noteSent('wear ring');
  page.add(LOGIN);
  await sleep(300);
  assert.deepEqual(page.sent, []);
  const fresh = boot({ title: NAMED });
  await sleep(20);
  fresh.noteSent('wear ring');
  await sleep(150);
  assert.deepEqual(fresh.sent, [], 'default is off');
});

ui('with the equipment feature off nothing is read, and turning it off cancels a pending read', async () => {
  const off = autoPage({ enabled: false });
  await sleep(20);
  off.noteSent('wear ring');
  off.add(LOGIN);
  await sleep(300);
  assert.deepEqual(off.sent, []);
  const page = autoPage();
  await sleep(20);
  page.noteSent('wear ring');
  page.setEnabled(false);
  await sleep(150);
  assert.deepEqual(page.sent, []);
});

ui('the default command list is used when none is stored', async () => {
  const page = boot({ title: NAMED, stored: { equipAutoRead: { enabled: true } } });
  await sleep(20);
  page.noteSent('unwield 1');
  assert.ok(await waitFor(() => page.sent.length === 1));
});

// 地圖怪物蒐集：進房間時遊戲印的怪物行，記給「蓋住 #map_anchor 中心點的房間」，只增不減。jsdom 算不出排版，
// 所以房間與 anchor 的位置用假的 getBoundingClientRect 擺。需要 jsdom
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ui, boot, waitFor } = require('./helpers/game-page');

const load = name => fs.readFileSync(path.join(__dirname, '..', 'catworld-auto-command', name), 'utf8');
const MAP = `<div id="map_table"><span id="map_header">地圖 (<span data-default-grid="□">武當派</span>)</span><div id="map_wrapper">
<div id="m-wudon"><a id="m-wudon-2h">□</a><a id="m-wudon-2i">□</a></div>
<div class="invisible" id="m-godforest"><a id="m-godforest-w6">□</a></div></div><div id="map_anchor"></div></div>`;
const rect = (left, top) => ({ left, top, right: left + 30, bottom: top + 30, width: 30, height: 30 });

// 2h 在 x=0、2i 在 x=30；隱藏區域 godforest 的 w6 也擺在 2i 的位置；anchor 預設在 x=30（中心 45,15 蓋在 2i）
function setup(page, anchorLeft = 30) {
  const doc = page.w.document;
  doc.body.insertAdjacentHTML('beforeend', MAP);
  const at = { 'm-wudon-2h': rect(0, 0), 'm-wudon-2i': rect(30, 0), 'm-godforest-w6': rect(30, 0) };
  Object.entries(at).forEach(([id, r]) => { doc.getElementById(id).getBoundingClientRect = () => r; });
  doc.getElementById('map_anchor').getBoundingClientRect = () => rect(anchorLeft, 0);
}
const saved = async page => (await page.w.chrome.storage.local.get('mapMonsters')).mapMonsters;

ui('currentRoom is the visible room under the anchor center, or null', async () => {
  const page = await boot();
  try {
    setup(page);
    const spot = page.w.CatworldMapCollect.currentRoom(page.w.document);
    assert.equal(spot.key, 'wudon/2i', 'the hidden godforest room at the same spot is ignored');
    assert.equal(spot.areaName, '武當派');
    page.w.document.getElementById('map_anchor').getBoundingClientRect = () => rect(500, 500);
    assert.equal(page.w.CatworldMapCollect.currentRoom(page.w.document), null);
  } finally {
    page.close();
  }
});

ui('merge only adds: monsters are unioned and nothing new means no write', async () => {
  const page = await boot();
  try {
    const { merge } = page.w.CatworldMapCollect;
    const spot = { key: 'wudon/2i', area: 'wudon', room: '2i', areaName: '武當派' };
    const first = merge({}, spot, ['地痞(dipi)'], 1);
    assert.equal(first.changed, true);
    assert.equal(merge(first.store, spot, ['地痞(dipi)'], 2).changed, false);
    const more = merge(first.store, { ...spot, areaName: '' }, ['流氓(liumang)'], 3);
    assert.equal(more.store['wudon/2i'].mobs.join(), '地痞(dipi),流氓(liumang)');
    assert.equal(more.store['wudon/2i'].areaName, '武當派', 'a missing area name keeps the old one');
  } finally {
    page.close();
  }
});

ui('monster lines printed in a room are saved for the room under the anchor', async () => {
  const page = await boot({ scale: 10 });
  try {
    setup(page);
    page.output('<span>※</span><span>地痞(dipi)</span> <span>&lt;戰鬥中&gt;</span>\n<span>※</span><span>流氓(liumang)</span>\n<span>你看到一個房間。</span>');
    assert.ok(await waitFor(async () => (await saved(page))?.['wudon/2i'], 2000), 'saved under the room at the anchor');
    const room = (await saved(page))['wudon/2i'];
    assert.deepEqual([...room.mobs].sort(), ['地痞(dipi)', '流氓(liumang)']);
    assert.equal(room.areaName, '武當派');
  } finally {
    page.close();
  }
});

ui('text without monster lines saves nothing, and walking on records the next room', async () => {
  const page = await boot({ scale: 10 });
  try {
    setup(page);
    page.output('<span>你走了一步。</span>');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await saved(page), undefined);
    page.output('<span>※地痞(dipi)</span>');
    assert.ok(await waitFor(async () => (await saved(page))?.['wudon/2i'], 2000));
    page.w.document.getElementById('map_anchor').getBoundingClientRect = () => rect(0, 0);
    page.output('<span>※高手(gaoshou)</span>');
    assert.ok(await waitFor(async () => (await saved(page))?.['wudon/2h'], 2000));
    assert.equal((await saved(page))['wudon/2h'].mobs.join(), '高手(gaoshou)');
    assert.equal((await saved(page))['wudon/2i'].mobs.join(), '地痞(dipi)');
  } finally {
    page.close();
  }
});

ui('rows keeps only name(ID) monsters, drops rooms left empty, and sorts', async () => {
  const page = await boot();
  try {
    const store = {
      'snow/0q': { area: 'snow', room: '0q', areaName: '長安', mobs: ['mahaha', 'abau'], seen: 1 },
      'snow/0u': { area: 'snow', room: '0u', areaName: '長安', mobs: ['biglp', '腳伕(liu)'], seen: 1 },
      'emei/06': { area: 'emei', room: '06', areaName: '峨嵋派', mobs: ['靜虛師太(Jing Shiu)'], seen: 1 },
    };
    const rows = page.w.CatworldMapCollect.rows(store);
    assert.equal(rows.length, 2, 'the room with only player ids is gone');
    assert.equal(rows[0].room, '06');
    assert.equal(rows[1].mobs.join(), '腳伕(liu)');
    assert.equal(page.w.CatworldMapCollect.rows(undefined).length, 0);
  } finally {
    page.close();
  }
});

const LAYOUT_MAP = `<div id="map_table"><span id="map_header">地圖 (<span data-default-grid="□">武當派</span>)</span><div id="map_wrapper">
<div id="m-wudon">　　<a id="m-wudon-r0">□</a>─<a id="m-wudon-r1">★</a>
　　│
　　<a id="m-wudon-2h">驛</a>
</div><div class="invisible" id="m-oldtomb-pond"><a id="m-oldtomb-pond-p1">□</a>
</div></div><div id="map_anchor"></div></div>`;

ui('snapshotLayouts keeps the text of every loaded area with rooms as markers, and parseLayout turns it back into cells', async () => {
  const page = await boot();
  try {
    page.w.document.body.insertAdjacentHTML('beforeend', LAYOUT_MAP);
    const { snapshotLayouts, parseLayout } = page.w.CatworldMapCollect;
    const layouts = snapshotLayouts(page.w.document);
    assert.deepEqual(Object.keys(layouts).sort(), ['oldtomb-pond', 'wudon'], 'hidden areas are saved too');
    assert.equal(layouts.wudon, '　　⟦r0|□⟧─⟦r1|★⟧\n　　│\n　　⟦2h|驛⟧');
    const lines = parseLayout(layouts.wudon);
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[0].map(cell => cell.ch).join(''), '　　□─★');
    assert.equal(lines[0][2].room, 'r0');
    assert.equal(lines[0][3].room, undefined, 'a connector is not a room');
    assert.equal(lines[2][2].ch, '驛', 'a landmark keeps its symbol');
  } finally {
    page.close();
  }
});

ui('the layouts are saved when monster lines arrive and only the changed areas are written again', async () => {
  const page = await boot({ scale: 10 });
  try {
    setup(page);
    page.output('<span>※地痞(dipi)</span>');
    assert.ok(await waitFor(async () => (await page.w.chrome.storage.local.get('mapLayouts')).mapLayouts?.wudon, 2000));
    const first = (await page.w.chrome.storage.local.get('mapLayouts')).mapLayouts;
    assert.match(first.wudon, /⟦2h\|□⟧⟦2i\|□⟧/);
    let writes = 0;
    const set = page.w.chrome.storage.local.set;
    page.w.chrome.storage.local.set = async values => { if ('mapLayouts' in values) writes += 1; return set(values); };
    page.output('<span>※高手(gaoshou)</span>');
    assert.ok(await waitFor(async () => (await saved(page))?.['wudon/2i']?.mobs.length === 2, 2000));
    assert.equal(writes, 0, 'an unchanged layout is not written again');
  } finally {
    page.close();
  }
});

const pick = (page, value) => {
  const select = page.w.document.getElementById('catworld-mark-select');
  select.value = value;
  select.dispatchEvent(new page.w.Event('change', { bubbles: true }));
};
const marked = page => [...page.w.document.querySelectorAll('[data-catworld-mark]')].map(node => node.id);
const MOBS = {
  'wudon/2h': { area: 'wudon', room: '2h', areaName: '武當派', mobs: ['地痞(dipi)'], seen: 1 },
  'wudon/2i': { area: 'wudon', room: '2i', areaName: '武當派', mobs: ['地痞(dipi)', '高手(gaoshou)'], seen: 1 },
  'godforest/w6': { area: 'godforest', room: 'w6', areaName: '天之叢林', mobs: ['老道(laodao)'], seen: 1 },
};

ui('the map header dropdown lists the mobs collected in the visible area and marks their rooms in red, and the first option clears it', async () => {
  const page = await boot({ scale: 10 });
  try {
    setup(page);
    await page.w.chrome.storage.local.set({ mapMonsters: MOBS });
    assert.ok(await waitFor(() => page.w.document.querySelector('#map_header #catworld-mark-select option:nth-child(3)'), 2000));
    const select = page.w.document.getElementById('catworld-mark-select');
    assert.deepEqual([...select.options].map(option => option.value), ['', '地痞(dipi)', '高手(gaoshou)'], 'only the visible area (wudon) is listed, not the hidden godforest');
    pick(page, '地痞(dipi)');
    assert.ok(await waitFor(() => marked(page).length === 2, 2000));
    assert.deepEqual(marked(page), ['m-wudon-2h', 'm-wudon-2i']);
    assert.equal(page.w.document.getElementById('m-wudon-2h').style.backgroundColor, 'rgb(229, 72, 77)');
    pick(page, '高手(gaoshou)');
    assert.ok(await waitFor(() => marked(page).join() === 'm-wudon-2i', 2000), 'only one mob is marked at a time');
    pick(page, '');
    assert.ok(await waitFor(() => marked(page).length === 0, 2000));
    assert.equal(page.w.document.getElementById('m-wudon-2i').style.backgroundColor, '');
  } finally {
    page.close();
  }
});

ui('the dropdown follows the visible area, re-marks after the game redraws the map, and hides when the area has no collected mobs', async () => {
  const page = await boot({ scale: 10 });
  try {
    setup(page);
    await page.w.chrome.storage.local.set({ mapMonsters: MOBS });
    assert.ok(await waitFor(() => page.w.document.getElementById('catworld-mark-select'), 2000));
    assert.ok(await waitFor(() => page.w.document.getElementById('catworld-mark-select').options.length === 3, 2000));
    pick(page, '地痞(dipi)');
    assert.ok(await waitFor(() => marked(page).length === 2, 2000));
    const doc = page.w.document;
    doc.getElementById('m-wudon-2h').removeAttribute('data-catworld-mark');
    doc.getElementById('m-wudon-2h').style.removeProperty('background-color');
    assert.ok(await waitFor(() => marked(page).includes('m-wudon-2h'), 2000), 'a redrawn room is marked again');
    doc.getElementById('m-wudon').classList.add('invisible');
    doc.getElementById('m-godforest').classList.remove('invisible');
    assert.ok(await waitFor(() => [...doc.getElementById('catworld-mark-select').options].map(option => option.value).join() === ',老道(laodao)', 2000));
    assert.deepEqual(marked(page), [], 'the old marking is dropped when the mob is not in the new area');
    doc.getElementById('m-godforest').classList.add('invisible');
    assert.ok(await waitFor(() => doc.getElementById('catworld-mark-select').style.display === 'none', 2000));
  } finally {
    page.close();
  }
});

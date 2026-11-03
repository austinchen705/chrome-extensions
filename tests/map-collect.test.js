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

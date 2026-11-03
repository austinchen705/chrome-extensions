// 地圖怪物蒐集：掃 #map_wrapper 的 title、合併進儲存（只增不減）。純函式用 jsdom 文件測；整個 content script 載入時也要真的存進 storage。需要 jsdom
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ui, boot, waitFor } = require('./helpers/game-page');

const MAP = `<div id="map_table"><span id="map_header">地圖 (<span data-default-grid="□">長安</span>)</span><div id="map_wrapper">
<div id="m-snow"><a id="m-snow-0q" class="B5" title="mahaha,liquor">□</a><a id="m-snow-0r" title="">□</a><a id="m-snow-0u" title=" biglp ">廟</a></div>
<div class="invisible" id="m-godforest"><a id="m-godforest-w6" title="kulama,evo">□</a><a id="m-godforest-w0">□</a></div></div></div>`;
const load = name => fs.readFileSync(path.join(__dirname, '..', 'catworld-auto-command', name), 'utf8');

ui('scan reads rooms that have monsters and the area name of the visible area only', async () => {
  const page = await boot();
  try {
    page.w.document.body.insertAdjacentHTML('beforeend', MAP);
    page.w.eval(load('map-collect.js'));
    const found = page.w.CatworldMapCollect.scan(page.w.document);
    assert.equal(found.length, 3);
    const by = key => found.find(item => item.key === key);
    assert.equal(by('snow/0q').mobs.join(), 'mahaha,liquor');
    assert.equal(by('snow/0q').areaName, '長安');
    assert.equal(by('snow/0u').mobs.join(), 'biglp', 'spaces around an id are trimmed');
    assert.equal(by('godforest/w6').areaName, '', 'a hidden area has no name to read');
  } finally {
    page.close();
  }
});

ui('merge only adds: ids are unioned and an empty scan never erases', async () => {
  const page = await boot();
  try {
    page.w.eval(load('map-collect.js'));
    const { merge } = page.w.CatworldMapCollect;
    const first = merge({}, [{ key: 'snow/0q', area: 'snow', room: '0q', mobs: ['a', 'b'], areaName: '長安' }], 1);
    assert.equal(first.changed, true);
    const same = merge(first.store, [{ key: 'snow/0q', area: 'snow', room: '0q', mobs: ['b'], areaName: '' }], 2);
    assert.equal(same.changed, false, 'nothing new, nothing written');
    const more = merge(first.store, [{ key: 'snow/0q', area: 'snow', room: '0q', mobs: ['c'], areaName: '' }], 3);
    assert.equal(more.store['snow/0q'].mobs.join(), 'a,b,c');
    assert.equal(more.store['snow/0q'].areaName, '長安', 'a missing area name keeps the old one');
    assert.equal(merge(first.store, [], 4).changed, false);
  } finally {
    page.close();
  }
});

ui('the content script saves the rooms it finds to storage', async () => {
  const page = await boot({ scale: 10 });
  try {
    page.w.document.body.insertAdjacentHTML('beforeend', MAP);
    // 地圖在腳本載入之後才出現的頁面：重新載入一次模組（旗標已存在時要跳過，所以先清掉）
    delete page.w.CatworldMapCollect;
    page.w.eval(load('map-collect.js'));
    assert.ok(await waitFor(async () => (await page.w.chrome.storage.local.get('mapMonsters')).mapMonsters?.['snow/0q'], 2000));
    const saved = (await page.w.chrome.storage.local.get('mapMonsters')).mapMonsters;
    assert.equal(saved['godforest/w6'].mobs.join(), 'kulama,evo');
  } finally {
    page.close();
  }
});

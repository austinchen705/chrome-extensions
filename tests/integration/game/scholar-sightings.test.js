// 書生出沒紀錄（整個 content script 在 jsdom 裡跑）：不管在做什麼，畫面上出現書生的房間行、說話、消失就記到 chrome.storage.local.scholarSightings，不送任何指令。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, boot, waitFor } = require('../../helpers/game-page');

const KEY = 'scholarSightings';
const MAP = `<div id="map_table"><span id="map_header">地圖 (<span data-default-grid="□">平原</span>)</span><div id="map_wrapper">
<div id="m-plain"><a id="m-plain-a1">□</a></div></div><div id="map_anchor"></div></div>`;
const rect = { left: 0, top: 0, right: 30, bottom: 30, width: 30, height: 30 };
const saved = page => page.w.chrome.storage.local.get(KEY).then(data => data[KEY]);
const say = (page, text) => page.output(`<span>${text}\n</span>`);

ui('appear, request, vanish, then appear again: two records with time, seconds since respawn, room and the said sentences; no command is sent', async () => {
  const page = await boot({ scale: 10 });
  try {
    const doc = page.w.document;
    doc.body.insertAdjacentHTML('beforeend', MAP);
    doc.getElementById('m-plain-a1').getBoundingClientRect = () => rect;
    doc.getElementById('map_anchor').getBoundingClientRect = () => rect;
    const clock = doc.getElementById('uptime');
    clock.className = 'H7';
    clock.textContent = '03:21';
    const before = Date.now();

    say(page, '  ※落魄書生(dire scholar)');
    say(page, '落魄書生說道：誰能給我蟹珠玄鐵q石a呢？');
    say(page, '落魄書生說道：誰能給我蟹珠玄鐵q石a呢？');
    assert.ok(await waitFor(async () => (await saved(page))?.[0]?.said.length === 1, 3000), 'one record with the sentence once');
    say(page, '落魄書生突然身形一晃，便漸漸消逸了 ！。');
    say(page, '  ※落魄書生(dire scholar)');
    assert.ok(await waitFor(async () => (await saved(page))?.length === 2, 3000), 'the appearance after the vanish line is a new record');

    const [first, second] = await saved(page);
    assert.ok(first.at >= before && first.at <= Date.now());
    assert.equal(first.sinceSpawnSec, 201);
    assert.deepEqual([first.area, first.areaName, first.room], ['plain', '平原', 'a1']);
    assert.deepEqual([...first.said], ['落魄書生說道：誰能給我蟹珠玄鐵q石a呢？']);
    assert.equal(first.ended, true);
    assert.deepEqual([first.matched, first.result], [null, null]);
    assert.deepEqual([...second.said], []);
    assert.deepEqual(page.sent, []);
  } finally {
    page.close();
  }
});

ui('a request seen before any room line opens a record; an unreadable timer and room stay empty', async () => {
  const page = await boot({ scale: 10 });
  try {
    page.w.document.getElementById('uptime').textContent = '';
    say(page, '落魄書生說道：誰能給我q銀菩d猴靴信呢？');
    assert.ok(await waitFor(async () => (await saved(page))?.length === 1, 3000));
    const [record] = await saved(page);
    assert.equal(record.sinceSpawnSec, null);
    assert.equal(record.room, null);
    assert.deepEqual([...record.said], ['落魄書生說道：誰能給我q銀菩d猴靴信呢？']);
  } finally {
    page.close();
  }
});

ui('other text does not write anything', async () => {
  const page = await boot({ scale: 10 });
  try {
    say(page, '你看到一個房間。');
    say(page, '落魄書生往東北離開。');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await saved(page), undefined);
  } finally {
    page.close();
  }
});

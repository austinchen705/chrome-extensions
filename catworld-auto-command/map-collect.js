// 蒐集遊戲地圖視窗（#map_wrapper）裡每個房間的怪物：房間是 <a id="m-區域-房間代號">，有怪的房間 title 是逗號分隔的怪物英文 ID。
// 玩家手動走一輪，遊戲把看到的怪填進 title；這裡每 2 秒掃一次，把新看到的合併（只增不減）存在 chrome.storage.local.mapMonsters，
// 重新整理遊戲頁或之後 title 被清掉都不會丟。鍵是 `區域代號/房間代號`；區域名稱只有該區域的地圖正在顯示時（沒有 .invisible）才讀得到，讀到才更新。
(() => {
if (globalThis.CatworldMapCollect) return;

const STORAGE_KEY = 'mapMonsters';
const SCAN_MS = 2000;
const ROOM_ID = /^m-(.+)-([^-]+)$/;

// 掃整個地圖：回傳 [{ key, area, room, mobs: [ID…], areaName }]，只含 title 有東西的房間
function scan(doc) {
  const wrapper = doc.getElementById('map_wrapper');
  if (!wrapper) return [];
  const headerName = doc.querySelector('#map_header [data-default-grid]')?.textContent.trim() || '';
  const found = [];
  wrapper.querySelectorAll('a[id][title]').forEach(node => {
    const match = ROOM_ID.exec(node.id);
    const mobs = node.title.split(',').map(mob => mob.trim()).filter(Boolean);
    if (!match || !mobs.length) return;
    const [, area, room] = match;
    const block = node.closest('div[id^="m-"]');
    const visible = Boolean(block) && !block.classList.contains('invisible');
    found.push({ key: `${area}/${room}`, area, room, mobs, areaName: visible ? headerName : '' });
  });
  return found;
}

// 合併進已存的紀錄（回傳 { store, changed }，不改輸入）：怪物 ID 取聯集，區域名稱讀到才更新
function merge(store, found, now) {
  const next = { ...store };
  let changed = false;
  found.forEach(item => {
    const old = next[item.key];
    const mobs = [...new Set([...(old?.mobs || []), ...item.mobs])];
    const areaName = item.areaName || old?.areaName || '';
    if (old && old.mobs.length === mobs.length && old.areaName === areaName) return;
    next[item.key] = { area: item.area, room: item.room, areaName, mobs, seen: now };
    changed = true;
  });
  return { store: next, changed };
}

globalThis.CatworldMapCollect = { scan, merge, STORAGE_KEY };
if (typeof document === 'undefined' || !globalThis.chrome?.storage?.local || !document.getElementById('map_wrapper')) return;

let timer = null;
async function tick() {
  try {
    const found = scan(document);
    if (!found.length) return;
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const result = merge(data[STORAGE_KEY] || {}, found, Date.now());
    if (result.changed) await chrome.storage.local.set({ [STORAGE_KEY]: result.store });
  } catch {
    // 擴充功能重新載入後留在頁面上的舊程式：連不上儲存就停掉，新程式會接手
    clearInterval(timer);
  }
}
timer = setInterval(tick, SCAN_MS);
tick();
})();

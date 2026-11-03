// 蒐集各個房間的怪物：玩家手動走，遊戲進房間時印出怪物行（「※名稱(ID)」，解析共用 zap-mobs.js 的 parseMobLines），
// 這裡把這些怪記給「目前所在的房間」。遊戲的地圖視窗（#map_wrapper）會把玩家所在的房間捲到 #map_anchor（和一格同大的空方塊）的位置，
// 所以蓋住 anchor 中心點的那個 <a id="m-區域-房間代號"> 就是目前的房間（房間格本身沒有任何「你在這裡」的樣式）。
// 紀錄只增不減，存在 chrome.storage.local.mapMonsters，鍵是 `區域代號/房間代號`；區域名稱讀地圖標題（顯示中的那個區域）。
// 怪物行出現後等 SETTLE_MS 再判斷房間：遊戲捲動地圖與印文字不是同一瞬間；這段時間內又走到別間的話會記錯房間（已知限制）。
(() => {
if (globalThis.CatworldMapCollect) return;

const STORAGE_KEY = 'mapMonsters';
const SETTLE_MS = 600;
const ROOM_ID = /^m-(.+)-([^-]+)$/;

// 蓋住 anchor 中心點的房間（只看顯示中的區域）；找不到回 null
function currentRoom(doc) {
  const anchor = doc.getElementById('map_anchor');
  if (!anchor) return null;
  const c = anchor.getBoundingClientRect();
  const x = c.left + c.width / 2;
  const y = c.top + c.height / 2;
  for (const node of doc.querySelectorAll('#map_wrapper a[id]')) {
    const match = ROOM_ID.exec(node.id);
    if (!match || node.closest('.invisible')) continue;
    const r = node.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return { key: `${match[1]}/${match[2]}`, area: match[1], room: match[2], areaName: doc.querySelector('#map_header [data-default-grid]')?.textContent.trim() || '' };
    }
  }
  return null;
}

// 合併進已存的紀錄（回傳 { store, changed }，不改輸入）：怪物取聯集，區域名稱讀到才更新
function merge(store, spot, mobs, now) {
  const old = store[spot.key];
  const all = [...new Set([...(old?.mobs || []), ...mobs])];
  const areaName = spot.areaName || old?.areaName || '';
  if (old && old.mobs.length === all.length && old.areaName === areaName) return { store, changed: false };
  return { store: { ...store, [spot.key]: { area: spot.area, room: spot.room, areaName, mobs: all, seen: now } }, changed: true };
}

globalThis.CatworldMapCollect = { currentRoom, merge, STORAGE_KEY };
const content = typeof document === 'undefined' ? null : document.getElementById('content');
if (!content || !globalThis.chrome?.storage?.local || !globalThis.CatworldZapMobs) return;

let pending = new Set();
let timer = null;
async function flush() {
  const mobs = [...pending];
  pending = new Set();
  timer = null;
  const spot = currentRoom(document);
  if (!spot || !mobs.length) return;
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const result = merge(data[STORAGE_KEY] || {}, spot, mobs, Date.now());
    if (result.changed) await chrome.storage.local.set({ [STORAGE_KEY]: result.store });
  } catch {
    // 擴充功能重新載入後留在頁面上的舊程式連不上儲存：不再收集，新程式會接手
    observer.disconnect();
  }
}
const observer = new MutationObserver(records => {
  const text = CatworldZapMobs.textFromAdded(records.flatMap(record => (record.type === 'characterData'
    ? [record.target.textContent || '']
    : Array.from(record.addedNodes, node => node.textContent || ''))));
  const found = CatworldZapMobs.parseMobLines(text);
  if (!found.length) return;
  found.forEach(mob => pending.add(mob.name));
  if (!timer) timer = setTimeout(flush, SETTLE_MS);
});
observer.observe(content, { subtree: true, childList: true, characterData: true });
})();

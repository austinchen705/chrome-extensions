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

// 怪物一律是「名稱(ID)」。舊版（讀地圖房間 title）記下的是房間裡的玩家，只有英文 ID、沒有括號，不能當怪物複製出去
const isMob = text => /\(.+\)$/.test(text);

// 內建的地圖怪物（map-data.js，由 tools/gen-map-data.js 從 docs/data/map-monsters.tsv 產生）和個人蒐集的紀錄取聯集；
// 只在讀取時合併、不寫回儲存，所以個人的「清除」清不掉內建資料，內建資料更新（升版本）後馬上生效
let builtinCache = null;
function builtinStore() {
  if (builtinCache) return builtinCache;
  builtinCache = {};
  (globalThis.CatworldMapData || []).forEach(([area, areaName, room, mobs]) => { builtinCache[`${area}/${room}`] = { area, room, areaName, mobs }; });
  return builtinCache;
}
function withBuiltin(store) {
  const base = builtinStore();
  const out = { ...base };
  Object.entries(store || {}).forEach(([key, row]) => {
    const built = base[key];
    out[key] = built ? { ...row, areaName: row.areaName || built.areaName, mobs: [...new Set([...built.mobs, ...(row.mobs || [])])] } : row;
  });
  return out;
}

// 設定頁顯示與複製用：濾掉不是怪物的項目、沒怪的房間不列，依區域與房間排序
function rows(store) {
  return Object.values(store || {})
    .map(row => ({ ...row, mobs: (row.mobs || []).filter(isMob) }))
    .filter(row => row.mobs.length)
    .sort((a, b) => `${a.area}/${a.room}`.localeCompare(`${b.area}/${b.room}`));
}

// 蒐集到某隻怪（完整名稱「名稱(ID)」，不分大小寫、忽略多餘空白）的位置：[{ area, label, rooms }]，依區域代號排序；沒蒐集到回空陣列
function locate(store, name) {
  const normalize = globalThis.CatworldZapMobs?.normalizeName;
  if (!normalize) return [];
  const target = normalize(name);
  const byArea = new Map();
  rows(store).filter(row => row.mobs.some(mob => normalize(mob) === target)).forEach(row => {
    const entry = byArea.get(row.area) || { area: row.area, label: row.areaName || row.area, rooms: [] };
    entry.rooms.push(row.room);
    byArea.set(row.area, entry);
  });
  return [...byArea.values()];
}

// 位置文字：「武當派 2c、2e；終南山 c1」。同一區域最多列 perArea 間，其餘寫「…共 N 間」；沒蒐集到回空字串
function whereIs(store, name, perArea = 6) {
  return locate(store, name)
    .map(({ label, rooms }) => `${label} ${rooms.slice(0, perArea).join('、')}${rooms.length > perArea ? `…共 ${rooms.length} 間` : ''}`)
    .join('；');
}

// 在遊戲的地圖視窗直接標出房間（places 是 locate 的結果）：房間格加 inline 樣式（比遊戲樣式表優先）與記號屬性，
// 回傳標到幾間（該區域的地圖沒載入、找不到房間格就不計）。每次先清掉上一次的標記，同時只標一隻怪
const MARK_ATTR = 'data-catworld-mark';
function clearMarks(doc) {
  doc.querySelectorAll(`[${MARK_ATTR}]`).forEach(node => {
    node.style.removeProperty('background-color');
    node.style.removeProperty('color');
    node.removeAttribute(MARK_ATTR);
  });
}
function markRooms(doc, places) {
  clearMarks(doc);
  let count = 0;
  places.forEach(({ area, rooms }) => rooms.forEach(room => {
    const node = doc.getElementById(`m-${area}-${room}`);
    if (!node) return;
    node.style.setProperty('background-color', '#e5484d', 'important');
    node.style.setProperty('color', '#fff', 'important');
    node.setAttribute(MARK_ATTR, '');
    count++;
  }));
  return count;
}

globalThis.CatworldMapCollect = { currentRoom, merge, withBuiltin, builtinStore, rows, isMob, locate, whereIs, markRooms, clearMarks, STORAGE_KEY };
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
  const found = CatworldZapMobs.parseMobLines(text).filter(mob => isMob(mob.name));
  if (!found.length) return;
  found.forEach(mob => pending.add(mob.name));
  if (!timer) timer = setTimeout(flush, SETTLE_MS);
});
observer.observe(content, { subtree: true, childList: true, characterData: true });

// 地圖視窗標題列的「標記怪物」下拉選單：列出目前顯示的區域蒐集到的怪，選一隻就把它蒐集到的房間標紅，選第一項取消。
// 標題列是遊戲的拖曳把手（#map_header：cursor move、絕對定位、寬度整列），所以選單用絕對定位靠右，事件不傳給遊戲
// （否則按下去變成拖曳、click 會把游標搶回輸入框）。區域切換、遊戲重畫地圖、蒐集到新怪都靠定時重讀儲存處理，
// 每次都重新標一遍（重畫掉的標記會補回來）；這個區域沒蒐集到任何怪就把選單藏起來
const SELECT_ID = 'catworld-mark-select';
const MARK_TICK_MS = 1500;
let markedMob = '';
let lastSignature = '';
function ensureSelect(header) {
  let select = header.querySelector(`#${SELECT_ID}`);
  if (select) return select;
  select = document.createElement('select');
  select.id = SELECT_ID;
  select.title = '把這個區域蒐集到的怪標在地圖上';
  // 淺灰底深色字：遊戲視窗的文字色跟著色彩主題走、常常偏淺，沿用它在視窗底色上不夠清楚；colorScheme 讓展開的選項清單也是淺底深字
  Object.assign(select.style, {
    position: 'absolute', right: '4px', top: '5px', height: '22px', maxWidth: '45%', fontSize: '12px',
    background: '#d8d8d8', color: '#1a1a1a', fontFamily: 'inherit', border: '1px solid #888888', borderRadius: '0', colorScheme: 'light',
  });
  ['mousedown', 'click', 'keydown', 'keyup', 'keypress'].forEach(type => select.addEventListener(type, event => event.stopPropagation()));
  select.addEventListener('change', () => { markedMob = select.value; lastSignature = ''; refreshMarkUi(); });
  header.append(select);
  return select;
}
// 標題是置中的（區域名稱會變長變短），選單只佔「區域名稱右邊剩下的空間」，不蓋到標題；量不到（版面還沒算出來）退回標題列的 30%。
// 不去撐大地圖視窗：#map_anchor 是以 400 寬的視窗置中寫死的位置（left 186px），視窗寬度一變，目前房間就不在 anchor 下面了
function fitSelect(header, select) {
  const name = header.querySelector('[data-default-grid]');
  const bar = header.getBoundingClientRect();
  const room = name ? bar.right - name.getBoundingClientRect().right - 28 - 4 : 0;
  select.style.width = room > 40 ? `${Math.min(room, bar.width * 0.45)}px` : '30%';
}
async function refreshMarkUi() {
  const header = document.getElementById('map_header');
  if (!header) return;
  let store;
  try {
    store = withBuiltin((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]);
  } catch {
    clearInterval(markTimer);
    return;
  }
  const visible = document.querySelector('#map_wrapper > div[id^="m-"]:not(.invisible)');
  const area = visible ? visible.id.slice(2) : '';
  const mobs = [...new Set(rows(store).filter(row => row.area === area).flatMap(row => row.mobs))].sort((a, b) => a.localeCompare(b));
  const select = ensureSelect(header);
  select.style.display = mobs.length ? '' : 'none';
  fitSelect(header, select);
  if (!mobs.includes(markedMob)) markedMob = '';
  const signature = `${area}|${mobs.join('\n')}`;
  if (signature !== lastSignature) {
    lastSignature = signature;
    select.replaceChildren(...['', ...mobs].map(name => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name || '標記怪物…';
      return option;
    }));
  }
  select.value = markedMob;
  if (markedMob) markRooms(document, locate(store, markedMob).filter(place => place.area === area));
  else clearMarks(document);
}
const markTimer = setInterval(refreshMarkUi, MARK_TICK_MS);
})();

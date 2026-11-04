// 面板「巡怪」列的「選怪」：展開一份勾選清單，列出地圖目前顯示的區域蒐集到的怪（可以勾多隻），勾選的結果依區域記在
// chrome.storage.local.mapHuntPicks（{ 區域代號: [名稱(ID)…] }），下次同一區域自動帶出。巡怪開始時由 content.js 讀這份勾選。
// 地圖視窗標題列的下拉選單（map-collect.js）維持原樣，只用來在地圖上標紅。
(() => {
if (globalThis.CatworldMapHuntUI) return;

const PICKS_KEY = 'mapHuntPicks';

// 地圖目前顯示的區域代號（沒有 .invisible 的那個 m-區域）；沒有地圖回空字串
const visibleArea = doc => (doc.querySelector('#map_wrapper > div[id^="m-"]:not(.invisible)')?.id || '').slice(2);

// 某區域已勾選的怪（只收字串）
const pickedFor = (picks, area) => (Array.isArray(picks?.[area]) ? picks[area].filter(name => typeof name === 'string') : []);

// 某區域蒐集到的怪（去重、排序）
const mobsOfArea = (store, area) => [...new Set(globalThis.CatworldMapCollect.rows(store).filter(row => row.area === area).flatMap(row => row.mobs))]
  .sort((a, b) => a.localeCompare(b));

// 在「巡怪」列加一顆「選怪」按鈕與它下面的勾選清單。deps：readStore（含內建的蒐集資料）、readPicks、writePicks、relayout
function attach(root, deps) {
  const line = root.querySelector('.hunt-line');
  const mini = line.querySelector('.mini');
  const button = document.createElement('button');
  button.className = 'hpick';
  button.title = '勾選要巡的怪（可以多隻）';
  mini.prepend(button);
  const box = document.createElement('div');
  box.className = 'line hunt-pick';
  box.hidden = true;
  const list = document.createElement('div');
  list.className = 'hunt-pick-list';
  const label = document.createElement('span');
  label.className = 't';
  const body = document.createElement('span');
  body.className = 's';
  body.append(list);
  box.append(label, body);
  line.after(box);
  let area = '';
  let picked = [];
  // 連續勾幾個時，寫入要一個接一個（各自先讀再寫，同時進行會互相蓋掉）
  let saving = Promise.resolve();
  const showCount = () => { button.textContent = picked.length ? `選怪（${picked.length}）` : '選怪'; };
  showCount();

  async function refresh() {
    area = visibleArea(document);
    const store = await deps.readStore();
    const mobs = area ? mobsOfArea(store, area) : [];
    picked = pickedFor(await deps.readPicks(), area).filter(name => mobs.includes(name));
    showCount();
    if (!mobs.length) {
      list.textContent = area ? '這個區域還沒有蒐集到怪（走過去、看到怪物行就會記下來）' : '地圖視窗沒有開，或讀不到目前的區域';
      deps.relayout();
      return;
    }
    list.replaceChildren(...mobs.map(name => {
      const row = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.value = name;
      check.checked = picked.includes(name);
      check.addEventListener('change', async () => {
        picked = mobs.filter(mob => (mob === name ? check.checked : picked.includes(mob)));
        showCount();
        const mine = picked.slice();
        const where = area;
        saving = saving.then(async () => {
          const saved = await deps.readPicks();
          await deps.writePicks({ ...(saved && typeof saved === 'object' ? saved : {}), [where]: mine });
        }).catch(error => console.error('[catworld] 勾選存不進去', error));
      });
      row.append(check, ` ${name}`);
      return row;
    }));
    deps.relayout();
  }
  button.addEventListener('click', () => {
    box.hidden = !box.hidden;
    if (!box.hidden) refresh().catch(() => {});
    else deps.relayout();
  });
  // 清單關著時也要讓按鈕上的數字對：載入時算一次
  refresh().catch(() => {});
  return { refresh };
}

globalThis.CatworldMapHuntUI = { PICKS_KEY, visibleArea, pickedFor, mobsOfArea, attach };
})();

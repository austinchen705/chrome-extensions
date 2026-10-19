// 面板的「裝備」列：讀取目前穿著（當比較的基準），並在鑑定出裝備後把每一件和基準比、標在共用浮層的「鑑定裝備」區段。
//
// 每次鑑定都不送任何指令；只有按「讀取目前穿著」才送：先 i（背包），從穿著的行拿到 view #編號，
// 再把它們組成一個巨集送出（deps.startSteps＝content.js 的 startMacro：共用佇列、間隔、驗證碼時取消）。
// 解析與比較在 zap-equipment.js（不碰 DOM）；這裡負責畫面、觀察器與讀取流程。
(() => {
if (globalThis.CatworldZapEquipmentUI) return;

const E = globalThis.CatworldZapEquipment;
const WORN_KEY = 'wornEquipment';
const WEAPON_KEY = 'mainWeapon';
const GAME_WINDOWS = '#monitor, #map_table, #macro_table, #setting_table';
const FLUSH_MS = 600;
const INVENTORY_WAIT_MS = 10000;
const READ_WAIT_MS = 20000;
const RESULT_MAX = 12;
const VERDICT_COLOR = { better: '#3ecf6e', worse: '#999999', equal: '#e6c029', none: '#7a7a7a' };
const WEAPON_TYPES = ['劍', '刀', '杖', '鞭', '拳套', '暗器'];

function attach(root, { overlay, readExp, startSteps }) {
  const { section, touchHint, el } = overlay;
  const button = el('button', { className: 'eq-read', textContent: '讀取目前穿著' });
  const status = el('span', { className: 's eq-status', textContent: '尚未讀取' });
  const row = el('div', { className: 'line' }, el('span', { className: 't', textContent: '裝備' }), status, el('span', { className: 'mini' }, button));
  root.querySelector('.body').append(row);

  const tracker = E.createTracker();
  let baseline = {};
  let mainWeapon = '';
  let phase = 'idle'; // idle → waitingInventory → reading → idle
  let wornAcc = [];
  let lastWornAt = 0;
  let expected = [];
  let got = [];
  let claimed = new Set();
  let timers = { flush: null, inventory: null, wait: null, read: null };
  let sawRunEnd = false;
  let blocks = [];

  // ---- 儲存 ----
  const validWeapon = value => (WEAPON_TYPES.includes(value) ? value : '');
  const note = text => {
    if (!section.firstChild) section.append(el('div', { className: 'title', textContent: '鑑定裝備' }));
    section.append(el('div', { className: 'zap-more', textContent: text }));
    touchHint();
  };
  const persist = async () => {
    try {
      await chrome.storage.local.set({ [WORN_KEY]: baseline });
    } catch (error) {
      note(`儲存基準失敗：${error.message}`);
    }
  };
  chrome.storage.local.get([WORN_KEY, WEAPON_KEY]).then(data => {
    baseline = data[WORN_KEY] ?? {};
    mainWeapon = validWeapon(data[WEAPON_KEY]);
    updateStatus();
  }).catch(error => note(`讀取已存的基準失敗：${error.message}`));
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[WORN_KEY]) baseline = changes[WORN_KEY].newValue ?? {};
    if (changes[WEAPON_KEY]) mainWeapon = validWeapon(changes[WEAPON_KEY].newValue);
    updateStatus();
  });

  // ---- 狀態列與按鈕 ----
  const allItems = () => Object.values(baseline).flat();
  function updateStatus() {
    const running = tracker.running(Date.now());
    button.disabled = phase !== 'idle' || running;
    if (phase === 'waitingInventory') status.textContent = '等待背包輸出…';
    else if (phase === 'reading') status.textContent = `讀取中 ${got.length}/${expected.length}`;
    else if (running) status.textContent = '鑑定進行中';
    else if (!allItems().length) status.textContent = '尚未讀取';
    else {
      const newest = Math.max(...allItems().map(item => item.readAt));
      status.textContent = `已讀取 ${allItems().length} 件，${Math.max(0, Math.round((Date.now() - newest) / 60000))} 分鐘前`;
    }
  }

  // ---- 讀取目前穿著 ----
  function finishReading() {
    clearTimeout(timers.read);
    if (phase !== 'reading') return;
    phase = 'idle';
    baseline = E.replaceBaseline(got, Date.now());
    persist();
    if (got.length < expected.length) note(`只讀到 ${got.length}/${expected.length} 件，其餘沒有收到輸出`);
    updateStatus();
  }

  function beginReading(list) {
    expected = list;
    got = [];
    claimed = new Set();
    phase = 'reading';
    if (startSteps(list.map(item => `view #${item.id}`).join(';')) === false) {
      phase = 'idle';
      note('沒有送出：指令格式不對，請看面板「巨集」列的提示');
    } else {
      timers.read = setTimeout(finishReading, READ_WAIT_MS);
    }
    updateStatus();
  }

  button.addEventListener('click', () => {
    if (button.disabled) return;
    phase = 'waitingInventory';
    if (startSteps('i') === false) {
      phase = 'idle';
      note('沒有送出：指令格式不對，請看面板「巨集」列的提示');
    } else {
      timers.wait = setTimeout(() => {
        if (phase !== 'waitingInventory') return;
        phase = 'idle';
        note('沒有讀到背包，沒有送出任何 view');
        updateStatus();
      }, INVENTORY_WAIT_MS);
    }
    updateStatus();
  });

  // ---- 鑑定結果的顯示 ----
  const SHORT = category => category.replace(/類(武器|防具)$/, '');
  function candidateNode(block) {
    const list = baseline[block.category] ?? [];
    const result = E.compareEquipment(block, list, { mainWeapon, exp: readExp() });
    const attrs = block.attrs.map(attr => `${attr.name}${attr.value > 0 ? '+' : ''}${attr.value}`).join('　');
    const head = `${block.name}（${SHORT(block.category)}）　${block.kind === 'weapon' ? '傷' : '防'} ${block.primary ?? '?'}${attrs ? `　${attrs}` : ''}　需經驗 ${block.needExp ?? '?'}`;
    const verdict = el('b', { textContent: result.text });
    verdict.style.color = VERDICT_COLOR[result.verdict];
    const against = list.find(item => item.name === result.against);
    const detail = [
      result.against ? `對象：${result.against}` : (allItems().length ? '你現在沒有穿這個類別的裝備可以比' : '還沒有基準，先按「讀取目前穿著」'),
      ...result.reasons,
      result.blocked ? '你還不能穿' : '',
      against ? `基準讀取於 ${Math.max(0, Math.round((Date.now() - against.readAt) / 60000))} 分鐘前` : '',
    ].filter(Boolean).join('　');
    return el('div', { className: 'zap-block zap-item' }, el('div', { textContent: head }), verdict, ' ', el('span', { className: 'meta', textContent: detail }));
  }

  function showCandidates(candidates) {
    if (!section.firstChild) {
      blocks = [];
      section.append(el('div', { className: 'title', textContent: '鑑定裝備' }));
    }
    candidates.forEach(block => {
      const node = candidateNode(block);
      section.append(node);
      blocks.push(node);
    });
    while (blocks.length > RESULT_MAX) blocks.shift().remove();
    touchHint();
  }

  // ---- 新增的遊戲文字 ----
  function doFlush() {
    const now = Date.now();
    const { candidates, passive } = tracker.flush(now);
    passive.forEach(block => {
      if (phase === 'reading') {
        // 同名的兩件各領一次，不會被同一個區塊算兩遍
        const index = expected.findIndex((item, i) => item.name === block.name && !claimed.has(i));
        if (index >= 0) {
          claimed.add(index);
          got.push(block);
        }
      } else if (tracker.isPassiveUpdatable(block.name)) {
        baseline = E.upsertBaseline(baseline, block, now);
        persist();
      }
    });
    if (candidates.length) showCandidates(candidates);
    else if (sawRunEnd) note('鑑定結束，但沒有解析到裝備（格式可能不同）');
    sawRunEnd = false;
    if (phase === 'reading' && got.length >= expected.length) finishReading();
    updateStatus();
  }

  function handle(text, html) {
    const now = Date.now();
    const list = E.parseWornHtml(html);
    if (list.length) {
      // 背包可能分兩批送來：3 秒內的穿著清單合併
      const merged = now - lastWornAt < 3000 ? [...wornAcc, ...list.filter(item => !wornAcc.some(old => old.id === item.id))] : list;
      wornAcc = merged;
      lastWornAt = now;
      tracker.setWorn(wornAcc);
      if (phase === 'waitingInventory') {
        clearTimeout(timers.inventory);
        timers.inventory = setTimeout(() => {
          clearTimeout(timers.wait);
          if (phase === 'waitingInventory') beginReading(wornAcc);
        }, FLUSH_MS);
      }
    }
    if (/共鑑定[^\n，。]{0,8}樣無名物/.test(text)) sawRunEnd = true;
    tracker.feed(text, now);
    clearTimeout(timers.flush);
    timers.flush = setTimeout(doFlush, FLUSH_MS);
    updateStatus();
  }

  const inGameOutput = node => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element?.closest('#content')) && !element.closest(GAME_WINDOWS);
  };
  const observer = new MutationObserver(records => {
    const nodes = records
      .filter(record => inGameOutput(record.target))
      .flatMap(record => (record.type === 'characterData' ? [record.target] : Array.from(record.addedNodes)));
    if (!nodes.length) return;
    handle(nodes.map(node => node.textContent || '').join(''), nodes.map(node => node.outerHTML ?? node.textContent ?? '').join(''));
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
}

globalThis.CatworldZapEquipmentUI = { attach };
})();

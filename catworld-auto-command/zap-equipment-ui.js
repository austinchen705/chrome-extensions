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
const FLUSH_MAX_WAIT_MS = 3000;
const INVENTORY_WAIT_MS = 10000;
const READ_IDLE_MS = 20000;
const HTML_WINDOW_MS = 3000;
const HTML_BUFFER_CHARS = 30000;
const RESULT_MAX = 12;
const VERDICT_COLOR = { better: '#3ecf6e', worse: '#999999', equal: '#e6c029', none: '#7a7a7a' };
const WEAPON_TYPES = ['劍', '刀', '杖', '鞭', '拳套', '暗器'];

// 基準依角色分開存（同一個瀏覽器可能同時開兩個角色）。登入後分頁標題是「角色名 - 小貓的世界 WEB」，沒登入沒有「 - 」
const characterName = () => (/ - /.test(document.title) ? document.title.split(' - ')[0].trim() : '');
// 1.23.0 的舊格式是直接以類別為鍵（「披風類防具」…），沒有角色這一層：不沿用，請使用者重新讀取
const normalizeStores = value => {
  if (!value || typeof value !== 'object') return {};
  return Object.keys(value).some(key => /類(?:武器|防具)$/.test(key)) ? {} : value;
};

function attach(root, { overlay, readExp, startSteps }) {
  const { section, touchHint, el } = overlay;
  const button = el('button', { className: 'eq-read', textContent: '讀取目前穿著' });
  const status = el('span', { className: 's eq-status', textContent: '尚未讀取' });
  const row = el('div', { className: 'line' }, el('span', { className: 't', textContent: '裝備' }), status, el('span', { className: 'mini' }, button));
  root.querySelector('.body').append(row);

  const tracker = E.createTracker();
  let stores = {};
  let mainWeapon = '';
  let phase = 'idle'; // idle → waitingInventory → reading → idle
  let wornAcc = [];
  let expected = [];
  let got = [];
  let claimed = new Set();
  const timers = { flush: null, inventory: null, wait: null, read: null };
  let firstPendingAt = 0;
  let htmlBuf = '';
  let lastHtmlAt = 0;
  let sawRunEnd = false;
  let blocks = [];

  const current = () => stores[characterName()] ?? {};
  const setCurrent = store => { stores = { ...stores, [characterName()]: store }; };

  // ---- 儲存 ----
  const validWeapon = value => (WEAPON_TYPES.includes(value) ? value : '');
  const note = text => {
    if (!section.firstChild) section.append(el('div', { className: 'title', textContent: '鑑定裝備' }));
    section.append(el('div', { className: 'zap-more', textContent: text }));
    touchHint();
  };
  const persist = async () => {
    try {
      await chrome.storage.local.set({ [WORN_KEY]: stores });
    } catch (error) {
      note(`儲存基準失敗：${error.message}`);
    }
  };
  // startSteps 丟例外或回 false 都當作沒送出，不能讓狀態卡在等待
  const send = text => {
    try {
      return startSteps(text) !== false;
    } catch (error) {
      note(`送出失敗：${error.message}`);
      return false;
    }
  };
  chrome.storage.local.get([WORN_KEY, WEAPON_KEY]).then(data => {
    stores = normalizeStores(data[WORN_KEY]);
    mainWeapon = validWeapon(data[WEAPON_KEY]);
    updateStatus();
  }).catch(error => note(`讀取已存的基準失敗：${error.message}`));
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[WORN_KEY]) stores = normalizeStores(changes[WORN_KEY].newValue);
    if (changes[WEAPON_KEY]) mainWeapon = validWeapon(changes[WEAPON_KEY].newValue);
    updateStatus();
  });

  // ---- 狀態列與按鈕 ----
  const allItems = () => Object.values(current()).flat();
  function updateStatus() {
    const running = tracker.running(Date.now());
    button.disabled = phase !== 'idle' || running;
    if (phase === 'waitingInventory') status.textContent = '等待背包輸出…';
    else if (phase === 'reading') status.textContent = `讀取中 ${got.length}/${expected.length}`;
    else if (running) status.textContent = '鑑定進行中';
    else if (!allItems().length) status.textContent = '尚未讀取';
    else {
      // 取最舊的那一件：只要有一件很久沒讀，就不能說基準是新的
      const oldest = Math.min(...allItems().map(item => item.readAt));
      status.textContent = `已讀取 ${allItems().length} 件，最舊的是 ${Math.max(0, Math.round((Date.now() - oldest) / 60000))} 分鐘前`;
    }
  }
  // 安靜的房間裡沒有新輸出也要讓「鑑定進行中」的逾時與分鐘數跟著更新
  setInterval(updateStatus, 5000);

  // ---- 讀取目前穿著 ----
  function finishReading() {
    clearTimeout(timers.read);
    if (phase !== 'reading') return;
    phase = 'idle';
    if (!got.length) {
      note('沒有讀到任何一件穿著的裝備，沿用原來的基準');
    } else {
      // 沒回應的（被中斷、逾時）但還在穿的保留舊基準，不會把整份換成只有幾件
      setCurrent(E.mergeBaseline(current(), got, expected.map(item => item.name), Date.now()));
      persist();
      if (got.length < expected.length) note(`只讀到 ${got.length}/${expected.length} 件，其餘保留原來的基準`);
    }
    updateStatus();
  }

  // 只要還在收到新的區塊就一直等；20 秒沒有任何新區塊才結束（指令間隔調高、中途有別的指令插隊都不會被截斷）
  function armReadTimer() {
    clearTimeout(timers.read);
    timers.read = setTimeout(() => {
      doFlush();
      finishReading();
    }, READ_IDLE_MS);
  }

  function beginReading(list) {
    if (!list.length) {
      phase = 'idle';
      note('沒有讀到穿著的裝備（背包沒有輸出，或身上沒有穿任何東西）');
      updateStatus();
      return;
    }
    expected = list;
    got = [];
    claimed = new Set();
    phase = 'reading';
    if (!send(list.map(item => `view #${item.id}`).join(';'))) {
      phase = 'idle';
      note('沒有送出：指令格式不對，請看面板「巨集」列的提示');
    } else {
      armReadTimer();
    }
    updateStatus();
  }

  button.addEventListener('click', () => {
    if (button.disabled) return;
    phase = 'waitingInventory';
    if (!send('i')) {
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
  const minutesAgo = at => Math.max(0, Math.round((Date.now() - at) / 60000));
  function candidateNode(block) {
    const list = current()[block.category] ?? [];
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
      against ? `基準讀取於 ${minutesAgo(against.readAt)} 分鐘前` : '',
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
    firstPendingAt = 0;
    const { candidates, passive } = tracker.flush(now);
    const before = got.length;
    passive.forEach(block => {
      if (phase === 'reading') {
        // 同名的兩件各領一次，不會被同一個區塊算兩遍
        const index = expected.findIndex((item, i) => item.name === block.name && !claimed.has(i));
        if (index >= 0) {
          claimed.add(index);
          got.push(block);
        }
      } else if (tracker.isPassiveUpdatable(block.name)) {
        setCurrent(E.upsertBaseline(current(), block, now));
        persist();
      }
    });
    if (candidates.length) showCandidates(candidates);
    else if (sawRunEnd) note('鑑定結束，但沒有解析到裝備（格式可能不同）');
    sawRunEnd = false;
    if (phase === 'reading') {
      if (got.length >= expected.length) finishReading();
      else if (got.length > before) armReadTimer();
    }
    updateStatus();
  }

  function handle(text, html) {
    const now = Date.now();
    // 背包輸出可能分好幾批、一行還可能被切在兩批之間：3 秒內的 HTML 接在一起再解析穿著清單
    if (now - lastHtmlAt > HTML_WINDOW_MS) htmlBuf = '';
    lastHtmlAt = now;
    htmlBuf = (htmlBuf + html).slice(-HTML_BUFFER_CHARS);
    const list = htmlBuf.includes('ˇ') ? E.parseWornHtml(htmlBuf) : [];
    if (list.length) {
      wornAcc = list;
      tracker.setWorn(list);
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
    // 連續不斷的輸出（頻道洗版、定時指令）會一直重設去抖，所以設一個最長等待
    if (!firstPendingAt) firstPendingAt = now;
    clearTimeout(timers.flush);
    timers.flush = setTimeout(doFlush, now - firstPendingAt >= FLUSH_MAX_WAIT_MS ? 0 : FLUSH_MS);
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

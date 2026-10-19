// 遊戲頁面板的「怪物」列：讀 #exp 列出適合打的怪，並在遊戲輸出出現怪物時顯示它的強度與分級。
// 查詢都交給 background（資料只在那裡載入），這裡只負責畫面。UI 放在面板的 shadow DOM 內，
// 頁面層級的 MutationObserver 與 body.textContent 看不到，不會被當成遊戲輸出。
(() => {
if (globalThis.CatworldZapPanel) return;

const Z = globalThis.CatworldZapMobs;
const ZI = globalThis.CatworldZapItems;
const THRESHOLDS_KEY = 'zapThresholds';
const WEAPON_KEY = 'mainWeapon';
const GAME_WINDOWS = '#monitor, #map_table, #macro_table, #setting_table';
// 浮層各區段的停留時間：怪物提示常常換所以短；鑑定結果很少出現又要慢慢看，留久一點（也可以按 ✕ 關掉）
const SECTION_MS = { mobs: 5000, items: 15000, equipment: 20000 };
const HINT_MAX = 8;
const ITEM_BLOCK_MAX = 8;
const DEDUPE_MS = 10000;
const CANDIDATE_MAX = 6;
const GRADE = {
  white: { color: '#555555', label: '白' },
  green: { color: '#3ecf6e', label: '綠' },
  yellow: { color: '#e6c029', label: '黃' },
  red: { color: '#ff5c4d', label: '紅' },
  unknown: { color: '#999999', label: '未知' },
};
const ADVICE_COLOR = { sell: '#ff8a7a', keep: '#3ecf6e', fit: '#6ec1ff' };

const STYLE = `
  .zap-box { padding: 4px 0 8px; }
  .zap-box[hidden], .zap-hint[hidden] { display: none; }
  .zap-tools { display: flex; align-items: center; gap: 8px; padding-bottom: 6px; font-size: 14px; color: #bbb; }
  .zap-tools input[type=search] { all: unset; flex: 1; min-width: 0; padding: 3px 8px; border-radius: 6px; background: #3a3a3e; color: #eee; user-select: text; }
  .zap-tools label { white-space: nowrap; cursor: pointer; }
  .zap-list { max-height: 260px; overflow: auto; font-size: 14px; user-select: text; }
  .zap-item { padding: 3px 0; border-top: 1px solid #3a3a3e; overflow-wrap: anywhere; }
  .zap-item .meta { color: #999; font-size: 13px; }
  .zap-more { color: #999; font-size: 13px; padding-top: 4px; }
  .zap-hint { padding: 6px 12px 10px; border-top: 1px solid #3a3a3e; font-size: 14px; user-select: text; max-height: 280px; overflow: auto; }
  .zap-hint { position: relative; }
  .zap-hint .title { color: #999; font-size: 13px; }
  .zap-route { margin-top: 2px; }
  .zap-walk { font-size: 12px; cursor: pointer; }
  .zap-close { all: unset; position: absolute; top: 4px; right: 8px; cursor: pointer; color: #888; font-size: 13px; line-height: 1; padding: 2px 4px; }
  .zap-close:hover { color: #fff; }
`;

const el = (name, props = {}, ...children) => {
  const node = Object.assign(document.createElement(name), props);
  children.flat().forEach(child => node.append(child));
  return node;
};

const gradeTag = grade => {
  const { color, label } = GRADE[grade] || GRADE.unknown;
  const node = el('b', { textContent: label });
  node.style.color = color;
  return node;
};

// 一隻怪的一個候選：顏色、名稱、q、位置、備註
function candidateNode({ mob, q, grade, idOnly, route }, showName, onWalk) {
  const node = el('div', { className: 'zap-item' },
    gradeTag(grade), ' ', showName ? mob.name : '', showName ? el('br') : '',
    el('span', { className: 'meta', textContent: Z.metaText({ mob, q, idOnly }) }));
  if (route && onWalk) node.append(routeNode(route, onWalk));
  return node;
}

// 路徑表的路線：從醉仙樓出發（先 recall）；地名只是約略對應時要標出來，不當成確定
function routeNode({ route, exact }, onWalk) {
  const button = el('button', { className: 'zap-walk', textContent: '走過去' });
  button.addEventListener('click', () => {
    button.disabled = true;
    const sent = onWalk(Z.routeCommand(route));
    button.textContent = sent === false ? '送不出去' : '已送出';
    setTimeout(() => { button.disabled = false; button.textContent = '走過去'; }, 1500);
  });
  return el('div', { className: 'zap-route' },
    el('span', { className: 'meta', textContent: `${exact ? '' : `約略對應「${route.name}」　`}路線 ${route.path}（從醉仙樓出發，先 recall）` }),
    ' ', button);
}

function attach(root, { readExp, startSteps }) {
  const style = el('style', { textContent: STYLE });
  const row = el('div', { className: 'line' },
    el('span', { className: 't', textContent: '怪物' }),
    el('span', { className: 's zap-status' }),
    el('span', { className: 'mini' }, el('button', { className: 'zap-open', textContent: '適合的怪' })));
  const search = el('input', { type: 'search', placeholder: '搜尋名稱或位置' });
  const yellow = el('input', { type: 'checkbox' });
  const list = el('div', { className: 'zap-list' });
  const box = el('div', { className: 'zap-box', hidden: true },
    el('div', { className: 'zap-tools' }, search, el('label', {}, yellow, ' 含黃色')), list);
  const hint = el('div', { className: 'zap-hint', hidden: true });
  // 怪物、雜物鑑定、裝備鑑定共用這個浮層，各占一個區段，各自有自己的停留時間
  const sections = { mobs: el('div'), items: el('div'), equipment: el('div') };
  const close = el('button', { className: 'zap-close', textContent: '✕', title: '關閉這個提示' });
  hint.append(close, sections.mobs, sections.items, sections.equipment);
  root.append(style);
  root.querySelector('.body').append(row, box);
  root.querySelector('.panel').append(hint);

  const status = row.querySelector('.zap-status');
  const send = async message => {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  let thresholds = Z.normalizeThresholds(undefined);
  let mainWeapon = '';
  const validWeapon = value => (ZI.WEAPON_TYPES.includes(value) ? value : '');
  const refresh = () => { if (!box.hidden) runQuery(); };
  chrome.storage.local.get([THRESHOLDS_KEY, WEAPON_KEY]).then(data => {
    thresholds = Z.normalizeThresholds(data[THRESHOLDS_KEY]);
    mainWeapon = validWeapon(data[WEAPON_KEY]);
  });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[WEAPON_KEY]) mainWeapon = validWeapon(changes[WEAPON_KEY].newValue);
    if (!changes[THRESHOLDS_KEY]) return;
    thresholds = Z.normalizeThresholds(changes[THRESHOLDS_KEY].newValue);
    refresh();
  });

  // 搜尋框要能取得游標：面板其他地方為了不搶遊戲輸入框的游標擋掉 mousedown，這裡放行；
  // 打字也不讓遊戲的快捷鍵收到
  search.addEventListener('mousedown', event => event.stopPropagation());
  ['keydown', 'keyup', 'keypress'].forEach(type => search.addEventListener(type, event => event.stopPropagation()));

  // 查詢是非同步的（背景第一次要載入資料），連續操作時只採用最後一次的結果
  let queryId = 0;
  async function runQuery() {
    const exp = readExp();
    const mine = ++queryId;
    if (!(exp > 0)) {
      list.replaceChildren();
      status.textContent = '讀不到經驗';
      return;
    }
    status.textContent = `經驗 ${exp}`;
    const reply = await send({
      type: 'ZAP_SUITABLE', exp, thresholds, grades: yellow.checked ? ['green', 'yellow'] : ['green'], query: search.value,
    });
    if (mine !== queryId) return;
    list.replaceChildren();
    if (!reply?.ok) {
      status.textContent = reply?.error || '查詢失敗';
      return;
    }
    reply.items.forEach(item => list.append(candidateNode(item, true, startSteps)));
    if (!reply.items.length) list.append(el('div', { className: 'zap-more', textContent: '沒有符合的怪' }));
    if (reply.total > reply.items.length) list.append(el('div', { className: 'zap-more', textContent: `共 ${reply.total} 筆，只列前 ${reply.items.length} 筆` }));
  }

  let searchTimer = null;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runQuery, 300); });
  yellow.addEventListener('change', runQuery);
  row.querySelector('.zap-open').addEventListener('click', () => {
    box.hidden = !box.hidden;
    if (box.hidden) status.textContent = '';
    else runQuery();
  });

  // ---- 怪物出現 ----
  const hideTimers = {};
  const itemBlocks = [];
  // 區段更新就顯示浮層並重設「那一個區段」自動消失的計時；全部區段都空了才隱藏整個浮層
  function clearSection(name) {
    clearTimeout(hideTimers[name]);
    sections[name].replaceChildren();
    if (name === 'items') itemBlocks.length = 0;
    if (!Object.values(sections).some(section => section.firstChild)) hint.hidden = true;
  }
  function touchHint(name) {
    hint.hidden = false;
    clearTimeout(hideTimers[name]);
    hideTimers[name] = setTimeout(() => clearSection(name), SECTION_MS[name]);
  }
  close.addEventListener('click', () => Object.keys(sections).forEach(clearSection));
  function showHints(results, hidden, expReadable) {
    const nodes = [el('div', { className: 'title', textContent: expReadable ? '這裡的怪物' : '這裡的怪物（讀不到經驗，無法分級）' })];
    results.forEach(({ name, count, candidates }) => {
      nodes.push(el('div', { className: 'zap-item', textContent: count > 1 ? `${name} ×${count}` : name }));
      if (!candidates.length) nodes.push(el('div', { className: 'zap-more', textContent: '表上無此怪' }));
      const { shown, hidden: more } = Z.limitHints(candidates, CANDIDATE_MAX);
      // 只靠 ID 命中時同一個 ID 可能有幾十隻，要顯示名稱才分得出來
      shown.forEach(candidate => nodes.push(candidateNode(candidate, candidate.idOnly, startSteps)));
      if (more) nodes.push(el('div', { className: 'zap-more', textContent: `…還有 ${more} 筆同名候選` }));
    });
    if (hidden) nodes.push(el('div', { className: 'zap-more', textContent: `…還有 ${hidden} 種` }));
    sections.mobs.replaceChildren(...nodes);
    touchHint('mobs');
  }

  // ---- 鑑定結果（雜物拿給衰老頭鑑定後的真名）----
  function itemNode({ item, advice }) {
    const tag = el('b', { textContent: advice.text });
    tag.style.color = ADVICE_COLOR[advice.action];
    return el('div', { className: 'zap-item' },
      tag, ` LV${item.level} ${item.name}`, item.note ? el('br') : '', item.note ? el('span', { className: 'meta', textContent: item.note }) : '');
  }
  // 鑑定的答案只出現一次、不會重畫，所以新結果接在舊的後面（只留最新 ITEM_BLOCK_MAX 筆），
  // 不像怪物提示每次整個取代；連續鑑定（ti;ti;ti）每件都是獨立的一批新文字
  function addItemResults(results, hidden) {
    const section = sections.items;
    if (!section.firstChild) section.append(el('div', { className: 'title', textContent: '鑑定結果' }));
    section.querySelectorAll('.zap-overflow').forEach(note => note.remove());
    results.forEach(({ sentence, candidates }) => {
      const block = el('div', { className: 'zap-block' }, el('div', { className: 'zap-item', textContent: sentence }));
      if (!candidates.length) block.append(el('div', { className: 'zap-more', textContent: '表上沒有這個物品' }));
      const { shown, hidden: more } = Z.limitHints(candidates, CANDIDATE_MAX);
      shown.forEach(candidate => block.append(itemNode(candidate)));
      if (more) block.append(el('div', { className: 'zap-more', textContent: `…還有 ${more} 筆同名候選` }));
      section.append(block);
      itemBlocks.push(block);
    });
    while (itemBlocks.length > ITEM_BLOCK_MAX) itemBlocks.shift().remove();
    // 超過一批上限的件數只是提示，不算在保留的結果裡
    if (hidden) section.append(el('div', { className: 'zap-more zap-overflow', textContent: `…還有 ${hidden} 件` }));
    touchHint('items');
  }

  // 提示用的小字（偵測到、查詢中、查詢失敗）；不算在保留的鑑定結果裡。pending=true 的會在結果回來時被清掉
  const FAIL_HINT = '（剛重新載入過 extension 的話，請重新整理遊戲頁）';
  function addItemNote(text, pending = true) {
    const section = sections.items;
    if (!section.firstChild) section.append(el('div', { className: 'title', textContent: '鑑定結果' }));
    const note = el('div', { className: `zap-more${pending ? ' zap-pending' : ''}`, textContent: text });
    section.append(note);
    touchHint('items');
    return note;
  }
  function showFailure(section, title, reason) {
    section.replaceChildren(el('div', { className: 'title', textContent: title }),
      el('div', { className: 'zap-more', textContent: `查詢失敗：${reason || '沒有回應'}${FAIL_HINT}` }));
    touchHint('mobs');
  }

  const inGameOutput = node => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element?.closest('#content')) && !element.closest(GAME_WINDOWS);
  };
  const lastShown = {};
  let lookupId = 0;
  function lookupMobs(text) {
    const items = Z.parseMobLines(text);
    if (!items.length) return;
    const fresh = new Set(Z.recentFilter(items.map(item => item.name), Date.now(), lastShown, DEDUPE_MS));
    const { shown, hidden } = Z.limitHints(items.filter(item => fresh.has(item.name)), HINT_MAX);
    if (!shown.length) return;
    const exp = readExp();
    const mine = ++lookupId;
    send({ type: 'ZAP_LOOKUP', exp, thresholds, names: shown }).then(reply => {
      if (mine !== lookupId) return;
      if (reply?.ok) showHints(reply.items, hidden, exp > 0);
      else showFailure(sections.mobs, '這裡的怪物', reply?.error);
    });
  }

  const handState = { handedAt: null };
  const lastItemShown = {};
  function lookupItems(text) {
    const now = Date.now();
    const recent = sentence => sentence in lastItemShown && now - lastItemShown[sentence] < DEDUPE_MS;
    const handedBefore = handState.handedAt;
    const sentences = [...new Set(ZI.findIdentified(text, now, handState))].filter(sentence => !recent(sentence));
    const { shown, hidden } = Z.limitHints(sentences, HINT_MAX);
    if (!shown.length) {
      // 只看到「交給衰老頭看」還沒有結果：先讓使用者知道有偵測到，沒反應時才分得出是哪一步沒動
      if (handState.handedAt !== handedBefore && handState.handedAt === now) addItemNote('偵測到把物品交給衰老頭鑑定，等待結果…');
      return;
    }
    addItemNote(`偵測到鑑定結果：${shown.join('、')}，查詢中…`);
    send({ type: 'ZAP_ITEM', sentences: shown, mainWeapon }).then(reply => {
      sections.items.querySelectorAll('.zap-pending').forEach(note => note.remove());
      if (!reply?.ok) {
        // 查詢失敗就不算「提示過」，下次還能再顯示；失敗要看得到，不能靜默
        addItemNote(`查詢失敗：${reply?.error || '沒有回應'}${FAIL_HINT}`, false);
        return;
      }
      shown.forEach(sentence => { lastItemShown[sentence] = Date.now(); });
      addItemResults(reply.results, hidden);
    });
  }

  // 一批新增文字同時交給怪物與鑑定兩邊，各自判斷，不能因為其中一邊沒東西就跳過另一邊
  const observer = new MutationObserver(records => {
    const text = Z.textFromAdded(records
      .filter(record => inGameOutput(record.target))
      .flatMap(record => (record.type === 'characterData'
        ? [record.target.textContent || '']
        : Array.from(record.addedNodes, node => node.textContent || ''))));
    lookupMobs(text);
    lookupItems(text);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  // 裝備比較的 UI 借用同一個浮層（區段與自動消失的計時）
  return { sections, touchHint: () => touchHint('equipment'), el };
}

globalThis.CatworldZapPanel = { attach };
})();

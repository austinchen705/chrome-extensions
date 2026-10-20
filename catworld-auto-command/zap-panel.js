// 遊戲頁面板的「怪物」列：讀 #exp 列出適合打的怪，並在遊戲輸出出現怪物時顯示它的強度與分級。
// 查詢都交給 background（資料只在那裡載入），這裡只負責畫面。UI 放在面板的 shadow DOM 內，
// 頁面層級的 MutationObserver 與 body.textContent 看不到，不會被當成遊戲輸出。
(() => {
if (globalThis.CatworldZapPanel) return;

const Z = globalThis.CatworldZapMobs;
const ZI = globalThis.CatworldZapItems;
const THRESHOLDS_KEY = 'zapThresholds';
const WEAPON_KEY = 'mainWeapon';
const ROUTES_KEY = 'mobRoutes';
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
  .zap-walk, .zap-edit, .zap-io button { font-size: 12px; cursor: pointer; }
  .zap-routeedit textarea, .zap-io textarea { all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 54px; margin: 4px 0; padding: 4px 6px; border-radius: 6px; background: #3a3a3e; color: #eee; font: 13px ui-monospace, Consolas, monospace; white-space: pre-wrap; user-select: text; }
  .zap-io { padding-bottom: 6px; font-size: 13px; color: #bbb; }
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

// 清單與提示裡的文字要能選取複製：面板其他地方擋掉 mousedown（不搶遊戲輸入框的游標）會讓選取開不了，所以文字區域放行；
// click 也不傳給遊戲（它的 window.onclick 會把游標搶回輸入框、選取跟著消失）。按鈕與輸入框維持原樣
function selectable(node) {
  const plain = event => !event.target.closest?.('button, input, textarea, label, a');
  ['mousedown', 'click'].forEach(type => node.addEventListener(type, event => { if (plain(event)) event.stopPropagation(); }));
  return node;
}

// 輸入框：面板其他地方擋掉 mousedown／click，輸入框要放行（遊戲的 window.onclick 會把游標搶回遊戲輸入框）；打字也不讓遊戲的快捷鍵收到
function typable(node) {
  ['mousedown', 'click'].forEach(type => node.addEventListener(type, event => event.stopPropagation()));
  ['keydown', 'keyup', 'keypress'].forEach(type => node.addEventListener(type, event => event.stopPropagation()));
  return node;
}

// 一隻怪的一個候選：顏色、名稱、q、位置、備註、路線。editor 只有清單才給（浮層只停幾秒，編輯到一半會消失）
function candidateNode(item, showName, onWalk, editor) {
  const { mob, q, grade, idOnly } = item;
  const node = el('div', { className: 'zap-item' },
    gradeTag(grade), ' ', showName ? mob.name : '', showName ? el('br') : '',
    el('span', { className: 'meta', textContent: Z.metaText({ mob, q, idOnly }) }));
  if (onWalk) node.append(routeBlock(item, onWalk, editor));
  return node;
}

// 路線那一行：有路線就顯示路線與「走過去」；清單裡另有「編輯」（沒有路線的怪是「補路線」）。儲存後就地重畫
function routeBlock(base, onWalk, editor) {
  const block = el('div', { className: 'zap-routebox' });
  const render = () => {
    const current = Z.applyCustomRoute(base, editor?.custom());
    const edit = editor && el('button', { className: 'zap-edit', textContent: current.route ? '編輯' : '補路線' });
    block.replaceChildren();
    if (current.route) block.append(routeNode(current.route, onWalk, edit));
    else if (edit) block.append(el('div', { className: 'zap-route' }, el('span', { className: 'meta', textContent: '沒有路線' }), ' ', edit));
    edit?.addEventListener('click', event => {
      // 不讓 click 傳到遊戲的 window.onclick：它會把游標搶回遊戲輸入框，輸入框就打不了字
      event.stopPropagation();
      const area = typable(el('textarea', { value: current.route ? Z.routeCommand(current.route.route) : '', placeholder: '完整指令，用 ; 分隔（從醉仙樓出發）' }));
      const save = el('button', { className: 'zap-edit', textContent: '儲存' });
      const reset = el('button', { className: 'zap-edit', textContent: '還原內建' });
      const cancel = el('button', { className: 'zap-edit', textContent: '取消' });
      save.addEventListener('click', async () => { await editor.save(base.mob.name, area.value); render(); });
      reset.addEventListener('click', async () => { await editor.save(base.mob.name, ''); render(); });
      cancel.addEventListener('click', render);
      block.replaceChildren(el('div', { className: 'zap-routeedit' }, area, save, ' ', reset, ' ', cancel));
      area.focus();
    });
  };
  render();
  return block;
}

// 路徑表的路線：從醉仙樓出發（先 recall）；地名只是約略對應時要標出來，不當成確定
function routeNode({ route, exact, custom }, onWalk, extra) {
  const button = el('button', { className: 'zap-walk', textContent: '走過去' });
  button.addEventListener('click', () => {
    button.disabled = true;
    const sent = onWalk(Z.routeCommand(route));
    button.textContent = sent === false ? '送不出去' : '已送出';
    setTimeout(() => { button.disabled = false; button.textContent = '走過去'; }, 1500);
  });
  const prefix = custom ? '已自訂　' : exact ? '' : `約略對應「${route.name}」　`;
  return el('div', { className: 'zap-route' },
    el('span', { className: 'meta', textContent: `${prefix}路線 ${route.command ?? route.path}（從醉仙樓出發，先 recall）` }),
    ' ', button, extra ? [' ', extra] : []);
}

function attach(root, { readExp, startSteps }) {
  const style = el('style', { textContent: STYLE });
  const row = el('div', { className: 'line' },
    el('span', { className: 't', textContent: '怪物' }),
    el('span', { className: 's zap-status' }),
    el('span', { className: 'mini' }, el('button', { className: 'zap-open', textContent: '適合的怪' })));
  const search = el('input', { type: 'search', placeholder: '搜尋名稱或位置' });
  const yellow = el('input', { type: 'checkbox' });
  const list = selectable(el('div', { className: 'zap-list' }));
  const exportRoutes = el('button', { className: 'zap-edit', textContent: '匯出路線' });
  const importRoutes = el('button', { className: 'zap-edit', textContent: '匯入路線' });
  const ioText = typable(el('textarea', { placeholder: '貼上匯出的路線 JSON' }));
  const ioApply = el('button', { className: 'zap-edit', textContent: '確認匯入' });
  const io = el('div', { className: 'zap-io', hidden: true }, ioText, ioApply);
  const box = el('div', { className: 'zap-box', hidden: true },
    el('div', { className: 'zap-tools' }, search, el('label', {}, yellow, ' 含黃色'), exportRoutes, importRoutes), io, list);
  const hint = selectable(el('div', { className: 'zap-hint', hidden: true }));
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
  // 使用者補的路線（怪物名稱 → 指令）：存本機，浮層也套用（但只有清單能編輯）
  let customRoutes = {};
  const editor = {
    custom: () => customRoutes,
    async save(name, command) {
      customRoutes = Z.setCustomRoute(customRoutes, name, command);
      try {
        await chrome.storage.local.set({ [ROUTES_KEY]: customRoutes });
      } catch (error) {
        status.textContent = `儲存路線失敗：${error.message}`;
      }
    },
  };
  const validWeapon = value => (ZI.WEAPON_TYPES.includes(value) ? value : '');
  const refresh = () => { if (!box.hidden) runQuery(); };
  chrome.storage.local.get([THRESHOLDS_KEY, WEAPON_KEY, ROUTES_KEY]).then(data => {
    customRoutes = Z.parseCustomRoutes(JSON.stringify(data[ROUTES_KEY] ?? {})).routes ?? {};
    thresholds = Z.normalizeThresholds(data[THRESHOLDS_KEY]);
    mainWeapon = validWeapon(data[WEAPON_KEY]);
  });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[WEAPON_KEY]) mainWeapon = validWeapon(changes[WEAPON_KEY].newValue);
    if (changes[ROUTES_KEY]) customRoutes = Z.parseCustomRoutes(JSON.stringify(changes[ROUTES_KEY].newValue ?? {})).routes ?? {};
    if (!changes[THRESHOLDS_KEY]) return;
    thresholds = Z.normalizeThresholds(changes[THRESHOLDS_KEY].newValue);
    refresh();
  });

  // 搜尋框要能取得游標：面板其他地方為了不搶遊戲輸入框的游標擋掉 mousedown，這裡放行；
  // click 也要擋：遊戲的 window.onclick 對 type 不是 text／password 的元素會把游標搶回遊戲輸入框（搜尋框是 type=search）；
  // 打字也不讓遊戲的快捷鍵收到
  typable(search);

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
    reply.items.forEach(item => list.append(candidateNode(item, true, startSteps, editor)));
    if (!reply.items.length) list.append(el('div', { className: 'zap-more', textContent: '沒有符合的怪' }));
    if (reply.total > reply.items.length) list.append(el('div', { className: 'zap-more', textContent: `共 ${reply.total} 筆，只列前 ${reply.items.length} 筆` }));
  }

  // 匯出／匯入自己補的路線（怪物名稱 → 指令）：匯出複製成 JSON 文字，匯入驗證通過才取代既有的
  exportRoutes.addEventListener('click', async event => {
    event.stopPropagation();
    const text = JSON.stringify(customRoutes, null, 1);
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = `已複製 ${Object.keys(customRoutes).length} 筆路線`;
    } catch {
      io.hidden = false;
      ioText.value = text;
      status.textContent = '無法寫入剪貼簿，請從下面的文字框複製';
    }
  });
  importRoutes.addEventListener('click', event => { event.stopPropagation(); io.hidden = !io.hidden; });
  ioApply.addEventListener('click', async event => {
    event.stopPropagation();
    const parsed = Z.parseCustomRoutes(ioText.value);
    if (!parsed.ok) {
      status.textContent = `匯入失敗：${parsed.error}`;
      return;
    }
    customRoutes = parsed.routes;
    try {
      await chrome.storage.local.set({ [ROUTES_KEY]: customRoutes });
      status.textContent = `已匯入 ${Object.keys(customRoutes).length} 筆路線`;
      io.hidden = true;
      ioText.value = '';
      refresh();
    } catch (error) {
      status.textContent = `匯入失敗：${error.message}`;
    }
  });

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
      shown.forEach(candidate => nodes.push(candidateNode(Z.applyCustomRoute(candidate, customRoutes), candidate.idOnly, startSteps)));
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
    if (enabled.mobs) lookupMobs(text);
    if (enabled.items) lookupItems(text);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  // 裝備比較的 UI 借用同一個浮層（區段與自動消失的計時）
  // 開關（popup 設定頁）：關掉的功能不顯示列、不觀察遊戲輸出；怪物與鑑定共用浮層，被關掉的區段要清空
  const enabled = { mobs: true, items: true };
  function setEnabled(next) {
    enabled.mobs = next.mobs === true;
    enabled.items = next.items === true;
    row.hidden = !enabled.mobs;
    if (!enabled.mobs) {
      box.hidden = true;
      status.textContent = '';
      clearSection('mobs');
    }
    if (!enabled.items) { clearSection('items'); clearSection('equipment'); }
  }
  return { sections, touchHint: () => touchHint('equipment'), el, setEnabled };
}

globalThis.CatworldZapPanel = { attach };
})();

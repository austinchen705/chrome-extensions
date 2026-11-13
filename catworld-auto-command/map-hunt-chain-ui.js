// 設定頁巡怪底下的「跨區路線」編輯器（只在 popup.html 載入）：由上往下畫路線，每一區一張卡片（區名、那一區蒐集到的怪可以直接勾、
// 選填這一區的整理回程指令），卡片之間的箭頭是換區指令，最後一個箭頭繞回第一區（回到第一區的指令）。
// 改任何欄位馬上存：路線存進 mapHuntChain（CatworldMapHunt.CHAIN_KEY），勾怪存進面板「選怪」那一份 mapHuntPicks。
// 文字一律用 textContent。
(() => {
if (globalThis.CatworldMapHuntChainUI) return;

const WARN_PICKS = '勾了怪但這一區沒有那些怪的房間紀錄，到了會略過（開補掃就會先掃）';

// 箭頭上另外顯示試跑結果（mapHuntChainTrial，第 i 段是 moves[i]，最後一段是回到第一區）：成功不上色、失敗紅、沒試跑琥珀；
// 指令或前後兩區和試跑當時不同的段當作沒試跑。
// deps：load() 回 { store（mapMonsters 原樣）, picks, chain, trial }；saveChain(chain)；
// savePicks(區域, 名稱陣列)：讀最新的勾選再只換這一區（不蓋掉遊戲頁剛存的別區）
function attach(box, deps) {
  const Hunt = globalThis.CatworldMapHunt;
  const Pick = globalThis.CatworldMapHuntUI;
  const Collect = globalThis.CatworldMapCollect;
  let data = { store: {}, picks: {}, chain: Hunt.normalizeChain(null), trial: [] };
  let stale = false; // 打字時跳過的重畫，離開輸入框後補畫

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // 有蒐集紀錄的區（store 是含內建地圖資料的蒐集資料）：{ 區域代號: 區名 }
  const areaNames = store => {
    const names = {};
    Collect.rows(store).forEach(row => { names[row.area] ||= row.areaName || ''; });
    return names;
  };
  const label = (names, area) => (names[area] ? `${names[area]}（${area}）` : area);
  // 一律從最新的 data.chain 改起（打字期間儲存可能被改過）。改了區（新增、移動、刪除）要重畫；
  // 改文字欄只存不重畫：change 在離開欄位時才觸發，這時重畫會吃掉緊接著的那一下點擊
  const saveChain = (change, { redraw = false } = {}) => {
    data.chain = Hunt.normalizeChain(change(data.chain));
    if (redraw) render();
    return deps.saveChain(data.chain);
  };
  const setAreas = change => saveChain(chain => Hunt.rearrangeChain(chain, change(chain.areas)), { redraw: true });
  // 換區指令改的是「從 from 到 to」那一段（用區找，不用位置）
  const setMove = (from, to) => value => saveChain(chain => ({
    ...chain, moves: chain.moves.map((move, i) => (chain.areas[i].area === from && chain.areas[i + 1].area === to ? value : move)),
  }));
  const textInput = (className, value, onChange, { required = false } = {}) => {
    const input = el('input', className);
    Object.assign(input, { type: 'text', autocomplete: 'off', value });
    if (required) input.classList.toggle('hmissing', !value);
    input.addEventListener('change', () => {
      input.value = input.value.trim();
      if (required) input.classList.toggle('hmissing', !input.value);
      onChange(input.value);
    });
    return input;
  };

  function card(names, store, item, index, count) {
    const node = el('div', 'hcard');
    node.dataset.area = item.area;
    const head = el('div', 'hcard-head');
    head.append(el('b', 'hcard-name', label(names, item.area)));
    [['hup', '↑', '上移', index > 0, -1], ['hdown', '↓', '下移', index < count - 1, 1]].forEach(([className, text, title, enabled, step]) => {
      const button = el('button', className, text);
      Object.assign(button, { type: 'button', title, disabled: !enabled });
      button.addEventListener('click', () => setAreas(list => {
        const areas = [...list];
        const at = areas.findIndex(area => area.area === item.area);
        if (at >= 0 && areas[at + step]) [areas[at], areas[at + step]] = [areas[at + step], areas[at]];
        return areas;
      }));
      head.append(button);
    });
    const remove = el('button', 'hdel', '✕');
    Object.assign(remove, { type: 'button', title: '從路線拿掉這一區' });
    remove.addEventListener('click', () => setAreas(list => list.filter(area => area.area !== item.area)));
    head.append(remove);

    const mobs = Pick.mobsOfArea(store, item.area);
    const picked = Pick.pickedFor(data.picks, item.area);
    // 勾了怪，但勾的怪在這一區都沒有房間紀錄（巡怪算不出目標房間，到了會略過）
    const warn = el('div', 'hint tight hcard-warn msg-warn', WARN_PICKS);
    const showWarn = names => { warn.hidden = !(names.length && !names.some(mob => mobs.includes(mob))); };
    showWarn(picked);
    const list = el('div', 'hcard-mobs');
    // 勾著、但這一區已經沒有那隻怪的紀錄的也列出來，才取消得掉
    [...mobs, ...picked.filter(mob => !mobs.includes(mob))].forEach(mob => {
      const row = el('label', 'check');
      const tick = el('input');
      Object.assign(tick, { type: 'checkbox', checked: picked.includes(mob) });
      tick.dataset.mob = mob;
      tick.addEventListener('change', () => {
        const others = Pick.pickedFor(data.picks, item.area).filter(name => name !== mob);
        const now = tick.checked ? [...others, mob] : others;
        data.picks = { ...data.picks, [item.area]: now };
        showWarn(now);
        deps.savePicks(item.area, now);
      });
      row.append(tick, document.createTextNode(` ${mob}`));
      list.append(row);
    });
    if (!list.children.length) list.append(el('span', 'hint tight', '這一區沒有蒐集到怪'));

    const sort = el('label', 'hcard-sort', '這一區的整理回程指令（選填，沒填用原本的）');
    sort.append(textInput('hsort', item.sortReturn, value => saveChain(chain => ({
      ...chain, areas: chain.areas.map(area => (area.area === item.area ? { ...area, sortReturn: value } : area)),
    }))));
    node.append(head, list, warn, sort);
    return node;
  }

  // 一段的試跑結果文字與等級（error 紅、warn 琥珀、成功沒有等級）
  const trialText = (result, command, from, to) => {
    if (!result || typeof result !== 'object' || result.command !== command || result.from !== from || result.to !== to) return { text: '沒試跑', level: 'warn' };
    if (result.ok) return { text: `試跑成功，${Number.isFinite(result.ms) ? (result.ms / 1000).toFixed(1) : '?'} 秒`, level: '' };
    return { text: `試跑失敗：${result.why || '原因不明'}${result.where ? `（當時在 ${result.where}）` : ''}`, level: 'error' };
  };
  function arrow(className, text, value, onChange, leg, from, to) {
    const node = el('div', `harrow ${className}-row`);
    const result = el('div', 'hint tight htrial-result');
    const showResult = command => {
      const { text: words, level } = trialText(data.trial[leg], command, from, to);
      result.textContent = words;
      result.classList.toggle('msg-error', level === 'error');
      result.classList.toggle('msg-warn', level === 'warn');
    };
    showResult(value);
    node.append(el('span', 'harrow-mark', text), textInput(className, value, command => { showResult(command); onChange(command); }, { required: true }), result);
    return node;
  }

  // 摺疊的標題寫出整條路線（收起來也看得到）：「跨區路線：A → B → ↺ A」
  const showSummary = (names, chain) => {
    const summary = box.closest('details')?.querySelector('summary');
    if (!summary) return;
    const short = area => names[area] || area;
    summary.textContent = chain.areas.length
      ? `跨區路線：${chain.areas.map(item => short(item.area)).join(' → ')}${chain.areas.length > 1 ? ` → ↺ ${short(chain.areas[0].area)}` : '（一區，還不會跨區）'}`
      : '跨區路線（還沒有區）';
  };
  function render() {
    stale = false;
    const store = Collect.withBuiltin(data.store);
    const names = areaNames(store);
    const { chain } = data;
    box.textContent = '';
    showSummary(names, chain);
    // 路線：卡片與換區箭頭由上往下排，兩區以上時左邊一條虛線從底下的「回到第一區」繞回第一張卡片
    const route = el('div', `hchain-route${chain.areas.length > 1 ? ' loop' : ''}`);
    chain.areas.forEach((item, index) => {
      route.append(card(names, store, item, index, chain.areas.length));
      const next = chain.areas[index + 1];
      if (next) route.append(arrow('hmove', `換區到 ${label(names, next.area)}`, chain.moves[index], setMove(item.area, next.area), index, item.area, next.area));
    });
    if (chain.areas.length > 1) route.append(arrow('hback', `↺ 回到第一區 ${label(names, chain.areas[0].area)}`, chain.back, value => saveChain(now => ({ ...now, back: value })), chain.areas.length - 1, chain.areas[chain.areas.length - 1].area, chain.areas[0].area));
    if (chain.areas.length) box.append(route);
    const add = el('div', 'hchain-add');
    const select = el('select');
    select.append(new Option('選一區加到路線最後…', ''));
    Object.keys(names).filter(area => !chain.areas.some(item => item.area === area)).sort((a, b) => a.localeCompare(b))
      .forEach(area => select.append(new Option(label(names, area), area)));
    const button = el('button', '', '新增');
    button.type = 'button';
    button.addEventListener('click', () => { const area = select.value; if (area) setAreas(list => [...list, { area, sortReturn: '' }]); });
    add.append(select, button);
    box.append(add);
  }

  // 讀儲存重畫（設定頁開啟時、路線或勾選或蒐集資料變了時）；正在打字的欄位不重畫，免得打到一半被蓋掉，離開欄位後補畫
  async function refresh() {
    let loaded;
    try { loaded = await deps.load(); } catch (error) { console.warn('[catworld] 跨區路線讀不到儲存', error); return; }
    data = { store: loaded.store || {}, picks: loaded.picks && typeof loaded.picks === 'object' ? loaded.picks : {}, chain: Hunt.normalizeChain(loaded.chain), trial: Array.isArray(loaded.trial) ? loaded.trial : [] };
    if (box.contains(document.activeElement) && document.activeElement.matches('input[type="text"]')) { stale = true; return; }
    render();
  }
  box.addEventListener('focusout', () => setTimeout(() => { if (stale && !box.contains(document.activeElement)) render(); }));
  render();
  return { refresh };
}

globalThis.CatworldMapHuntChainUI = { attach };
})();

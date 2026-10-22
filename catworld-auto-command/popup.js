const $ = id => document.getElementById(id);
$('version').textContent = `v${chrome.runtime.getManifest().version}`;
const Engine = CatworldTriggerEngine;

// 面板的 ⚙ 會把這一頁當成分頁開啟，網址帶 ?tab=遊戲分頁的 id：這時要控制那個遊戲分頁，
// 不是「目前的分頁」（那是設定頁自己）。遊戲分頁被關掉了就找別的遊戲分頁
const GAME_URL = 'https://catworld.muds.tw/web';
const pageTabId = Number(new URLSearchParams(location.search).get('tab')) || null;
if (pageTabId) document.body.classList.add('page');

async function getTab() {
  if (pageTabId) {
    try { return await chrome.tabs.get(pageTabId); } catch { /* 遊戲分頁已關閉，往下找別的 */ }
    const [game] = await chrome.tabs.query({ url: `${GAME_URL}*` });
    return game;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// 隨機指令：每個指令一列（指令、最短、最長秒數）
function randomRow(item) {
  const command = element('input', { type: 'text', value: item.command, placeholder: '例：look', title: '指令' });
  const min = element('input', { type: 'number', min: 1, value: item.minSeconds, title: '最短秒數' });
  const max = element('input', { type: 'number', min: 1, value: item.maxSeconds, title: '最長秒數' });
  const remove = element('button', { type: 'button', className: 'x', textContent: '✕', title: '刪除這個指令' });
  const row = element('div', { className: 'ritem' }, field('command', command), field('min', min), field('max', max), remove);
  remove.addEventListener('click', () => row.remove());
  return row;
}

function renderRandomItems(items) {
  $('randomItems').replaceChildren(...items.map(randomRow));
}

$('addRandom').addEventListener('click', () => {
  $('randomItems').append(randomRow({ command: '', minSeconds: CatworldTimer.DEFAULT_MIN, maxSeconds: CatworldTimer.DEFAULT_MAX }));
});

function readSettings() {
  const lines = id => $(id).value.split('\n').map(x => x.trim()).filter(Boolean);
  const get = (row, name) => row.querySelector(`[data-f="${name}"]`);
  return {
    commands: lines('commands'),
    randomItems: [...$('randomItems').children]
      .map(row => ({ command: get(row, 'command').value.trim(), minSeconds: Number(get(row, 'min').value), maxSeconds: Number(get(row, 'max').value) }))
      .filter(item => item.command),
    minSeconds: Number($('minSeconds').value),
    maxSeconds: Number($('maxSeconds').value),
    commandDelayMs: Number($('commandDelayMs').value)
  };
}

// 驗證、錯誤、警告的訊息一律用同一組顏色：error 紅、warn 琥珀、info 不上色（樣式是 popup.html 的 .msg-error／.msg-warn）
function markLevel(node, level) {
  node.classList.toggle('msg-error', level === 'error');
  node.classList.toggle('msg-warn', level === 'warn');
}
// 一行一行的 { level, text } 放進容器，每行各自上色
function showParts(container, parts) {
  container.replaceChildren(...parts.map(({ level, text }) => element('div', { className: `msg-${level}`, textContent: text })));
}
// 停止原因：空的或單純「已停止」不上色；驗證碼造成的停止是錯誤；其他原因（觸發被停用等）是警告
const stopLevel = reason => (!reason || reason === '已停止' ? 'info' : /驗證/.test(reason) ? 'error' : 'warn');
function setStatus(text, level = 'info') {
  $('status').textContent = `狀態：${text}`;
  markLevel($('status'), level);
}

async function send(message) {
  const tab = await getTab();
  if (!tab?.id || !tab.url?.startsWith(GAME_URL)) {
    throw new Error('請先切到 CatWorld Web 分頁');
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    // If CatWorld was already open when the extension was installed/reloaded,
    // the declared content script is not present yet. Inject it and retry.
    if (String(e?.message || e).includes('Receiving end does not exist')) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['trigger-engine.js', 'timer-settings.js', 'macro-wait.js', 'macro-notes.js', 'macro-io.js', 'macro-io-ui.js', 'captcha-art.js', 'instance-guard.js', 'zap-mobs.js', 'zap-items.js', 'zap-riddles.js', 'zap-equipment.js', 'zap-panel.js', 'zap-riddle-ui.js', 'zap-equipment-ui.js', 'pip-panel.js', 'stats-view.js', 'stats-block.js', 'content.js']
      });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['macro-notes.css'] });
      return await chrome.tabs.sendMessage(tab.id, message);
    }
    throw e;
  }
}

$('start').addEventListener('click', async () => {
  try {
    const settings = readSettings();
    if (!settings.commands.length && !settings.randomItems.length) throw new Error('至少要有一個指令');
    if (settings.maxSeconds < settings.minSeconds) throw new Error('最長秒數不能小於最短秒數');
    const badRandom = settings.randomItems.find(item => item.maxSeconds < item.minSeconds);
    if (badRandom) throw new Error(`隨機指令「${badRandom.command}」的最長秒數不能小於最短秒數`);
    await chrome.storage.local.set({ settings });
    await send({ type: 'START', settings });
    const randomText = settings.randomItems.length ? `；隨機：${settings.randomItems.map(item => item.command).join(' / ')}` : '';
    setStatus(`執行中：${settings.commands.join(' → ')}${randomText}`);
  } catch (e) { setStatus(e.message, 'error'); }
});

$('stop').addEventListener('click', async () => {
  try { await send({ type: 'STOP' }); setStatus('已停止'); }
  catch (e) { setStatus(e.message, 'error'); }
});

$('test').addEventListener('click', async () => {
  try {
    const result = await send({ type: 'TEST', command: 'ps' });
    setStatus(result?.ok ? '測試 ps 已送出' : (result?.error || '測試失敗'), result?.ok ? 'info' : 'error');
  } catch (e) { setStatus(e.message, 'error'); }
});

// 「一直響到確認」開關：存起來，遊戲頁的 content script 監聽 storage 變化，馬上生效
$('persistentAlert').addEventListener('change', () => {
  chrome.storage.local.set({ persistentAlert: $('persistentAlert').checked });
});

// 手機通知（LINE）：憑證只存本機，發送由 background 做（見 line-notify-ui.js）
try {
  CatworldLineNotifyUI.attach(document);
} catch (error) {
  console.error('[catworld] 手機通知區塊初始化失敗', error.name);
}

// 三組輔助功能的開關（預設關閉）：存成一個物件，遊戲頁的面板監聽 storage 變化，馬上生效
const FEATURE_BOXES = { mobs: 'featureMobs', items: 'featureItems', riddles: 'featureRiddles' };
Object.values(FEATURE_BOXES).forEach(id => $(id).addEventListener('change', () => {
  chrome.storage.local.set({ zapFeatures: Object.fromEntries(Object.entries(FEATURE_BOXES).map(([key, box]) => [key, $(box).checked])) });
}));

// 共用資料（Google 試算表）：兩個分頁的連結只存本機（sharedSources：{ mob, riddle }，不進匯出），抓取由 background 做，結果在 sharedCache。
// 結果文字與逐列清單的內容都由 shared-data.js 產生（有測試），這裡只負責放進畫面
const SHARED_FIELDS = {
  mob: { input: 'sharedMobUrl', result: 'sharedMobResult', detail: 'sharedMobDetail' },
  riddle: { input: 'sharedRiddleUrl', result: 'sharedRiddleResult', detail: 'sharedRiddleDetail' },
};
const timeText = at => new Date(at).toLocaleString('zh-TW', { hour12: false });
async function showShared() {
  const data = await chrome.storage.local.get(['sharedSources', 'sharedCache', 'zapFeatures']);
  // 怪物查詢與解謎都關著時 background 不會抓，說明一下，不然看起來像壞掉
  const features = { mobs: data.zapFeatures?.mobs === true, riddles: data.zapFeatures?.riddles === true };
  const enabled = features.mobs || features.riddles;
  $('sharedOff').hidden = enabled;
  Object.entries(SHARED_FIELDS).forEach(([kind, field]) => {
    const url = data.sharedSources?.[kind] ?? '';
    if (document.activeElement !== $(field.input)) $(field.input).value = url;
    const entry = data.sharedCache?.[kind]?.url === url ? data.sharedCache[kind] : null;
    showParts($(field.result), CatworldSharedData.describeSheetParts(kind, url, entry, timeText, features));
    // 被丟掉與對不到的列逐列列出，填錯的人自己看得出要改表上哪一列
    const lines = url && enabled ? CatworldSharedData.reportEntries(entry?.report) : [];
    $(field.detail).hidden = !lines.length;
    showParts($(field.detail), lines);
  });
}
// 更新中或失敗時：每個分頁的結果行換成同一段文字，舊的逐列清單先收起來（不然會和「更新中」並存）
const setAllShared = (text, level = 'info') => Object.entries(SHARED_FIELDS).forEach(([kind, field]) => {
  showParts($(field.result), [{ level, text: `${CatworldSharedData.SHEET_LABELS[kind].title}：${text}` }]);
  $(field.detail).hidden = true;
});
async function refreshShared() {
  setAllShared('更新中…');
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'SHARED_REFRESH' });
    if (!reply?.ok) setAllShared(`更新失敗：${reply?.error || '沒有回應'}`, 'error');
    else await showShared();
  } catch (error) {
    setAllShared(`更新失敗：${error.message}`, 'error');
  }
}
Object.entries(SHARED_FIELDS).forEach(([kind, field]) => {
  $(field.input).addEventListener('change', async () => {
    const text = $(field.input).value.trim();
    if (text) {
      const checked = CatworldSharedData.checkUrl(text);
      if (!checked.ok) {
        // 只收起這個分頁的舊清單，原本存的連結與結果不動
        const saved = (await chrome.storage.local.get('sharedSources')).sharedSources ?? {};
        showParts($(field.result), [{ level: 'error', text: CatworldSharedData.describeRejectedUrl(kind, checked.error, Boolean(saved[kind])) }]);
        $(field.detail).hidden = true;
        return;
      }
    }
    const saved = (await chrome.storage.local.get('sharedSources')).sharedSources ?? {};
    await chrome.storage.local.set({ sharedSources: { ...saved, [kind]: text } });
    if (text) refreshShared();
    else showShared();
  });
});
$('sharedRefresh').addEventListener('click', refreshShared);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.sharedSources || changes.sharedCache || changes.zapFeatures)) showShared();
});
showShared();

// 主要武器類型：存起來，遊戲頁的面板監聽 storage 變化，馬上生效。不合法的值當成未設定
const weaponValue = value => (CatworldZapItems.WEAPON_TYPES.includes(value) ? value : '');
$('mainWeapon').replaceChildren(...['', ...CatworldZapItems.WEAPON_TYPES].map(type => element('option', { value: type, textContent: type || '未設定' })));
$('mainWeapon').addEventListener('change', () => {
  chrome.storage.local.set({ mainWeapon: weaponValue($('mainWeapon').value) });
});

// 怪物分級門檻：存起來，遊戲頁的面板監聽 storage 變化，馬上生效。無效的值（需 1 < 綠上限 < 黃上限）不存，欄位還原
let zapThresholds = CatworldZapMobs.normalizeThresholds(undefined);
function showZapThresholds() {
  $('zapGreenMax').value = zapThresholds.greenMax;
  $('zapYellowMax').value = zapThresholds.yellowMax;
}
['zapGreenMax', 'zapYellowMax'].forEach(id => $(id).addEventListener('change', () => {
  const raw = { greenMax: Number($('zapGreenMax').value), yellowMax: Number($('zapYellowMax').value) };
  const valid = CatworldZapMobs.normalizeThresholds(raw);
  if (valid.greenMax !== raw.greenMax || valid.yellowMax !== raw.yellowMax) {
    showZapThresholds();
    setStatus('門檻需 1 < 綠上限 < 黃上限', 'error');
    return;
  }
  zapThresholds = valid;
  chrome.storage.local.set({ zapThresholds });
}));

$('beep').addEventListener('click', async () => {
  try {
    const result = await send({ type: 'TEST_BEEP' });
    setStatus(result?.played ? '提示音已播放' : '瀏覽器擋住聲音：請先在遊戲分頁點一下或輸入任何內容，再試一次', result?.played ? 'info' : 'warn');
  } catch (e) { setStatus(e.message, 'error'); }
});

// popup 失焦就會關閉，清單改在獨立分頁開啟；已開著就直接切過去，不重複開
$('skills').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('skills.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

// ---- 分頁 ----
function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.tab === name)));
  document.querySelectorAll('[data-pane]').forEach(pane => { pane.hidden = pane.dataset.pane !== name; });
  chrome.storage.local.set({ popupTab: name });
}
document.querySelector('.tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]');
  if (tab) showTab(tab.dataset.tab);
});

// ---- 觸發（戰鬥、練功兩組，各自獨立、功能完全一樣）----
const STAT_NAMES = Object.keys(Engine.STATS);
const D = Engine.DEFAULTS;
const BLANK_RULE = { enabled: true, stat: '飲水', op: 'le', unit: 'abs', value: 200, commands: [], cooldown: D.cooldown, buffer: D.buffer };

function element(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

const field = (name, el) => { el.dataset.f = name; return el; };

// 每組一個分頁：標記來自 popup.html 的 <template id="triggerPaneTemplate">，裡面所有 id 都帶 -__G__，
// 複製時換成組別，所以兩組不會撞 id。每組有自己的規則清單、開始／停止、命中延遲與安全機制，存在 triggerGroupSettings[組別]
function createTriggerPane(group) {
  const $g = name => document.getElementById(`${name}-${group.id}`);
  const root = element('div');
  root.dataset.pane = group.id;
  root.hidden = true;
  root.innerHTML = document.getElementById('triggerPaneTemplate').innerHTML.replaceAll('__G__', group.id);
  document.getElementById('triggerPanes').append(root);
  const tab = element('button', { type: 'button', textContent: `${group.name}觸發` });
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  tab.dataset.tab = group.id;
  document.querySelector('.tabs').append(tab);

  let hold = { until: 0 };
  const holdStatus = text => {
    hold = { until: Date.now() + 4000 };
    $g('trigStatus').textContent = text;
    markLevel($g('trigStatus'), 'error');
  };

  // 每張規則卡片共用：刪除、重新啟用（按卡片在清單中的順序對應引擎裡的規則）
  function wireRuleControls(card, remove, again) {
    remove.addEventListener('click', () => { card.remove(); save(); });
    again.addEventListener('click', async () => {
      const index = [...$g('rules').children].indexOf(card);
      try { await send({ type: 'REARM_RULE', group: group.id, index }); refreshLive(); } catch (e) { holdStatus(e.message); }
    });
  }

  function ruleCard(rule) {
    const stat = field('stat', element('select', { title: '項目' }, ...STAT_NAMES.map(name => element('option', { value: name, textContent: name, selected: name === rule.stat }))));
    const op = field('op', element('select', { title: '方向：≤ 目前值小於等於門檻就觸發，≥ 目前值大於等於門檻就觸發' },
      element('option', { value: 'le', textContent: '≤', selected: rule.op !== 'ge' }),
      element('option', { value: 'ge', textContent: '≥', selected: rule.op === 'ge' })));
    const value = field('value', element('input', { type: 'number', min: 0, value: rule.value, title: '門檻' }));
    const unit = field('unit', element('select', { title: '單位' },
      element('option', { value: 'abs', textContent: '數值', selected: rule.unit !== 'pct' }),
      element('option', { value: 'pct', textContent: '％', selected: rule.unit === 'pct' })));
    const commands = field('commands', element('textarea', { value: (rule.commands || []).join('\n'), placeholder: '例：drink' }));
    const cooldown = field('cooldown', element('input', { type: 'number', min: Engine.MIN_COOLDOWN_SEC, value: rule.cooldown }));
    const buffer = field('buffer', element('input', { type: 'number', min: 0, value: rule.buffer }));
    const enabled = field('enabled', element('input', { type: 'checkbox', checked: rule.enabled !== false, title: '啟用這條規則' }));
    const pill = field('pill', element('span', { className: 'pill', hidden: true }));
    const again = field('again', element('button', { type: 'button', className: 'linkbtn', textContent: '重新啟用', hidden: true }));
    const remove = element('button', { type: 'button', className: 'x', textContent: '✕', title: '刪除這條規則' });
    const rearm = element('p', { className: 'rearm' });

    const card = element('div', { className: 'rule' },
      element('div', { className: 'rule-head' }, enabled, element('span', { className: 'grow' }, pill), again, remove),
      element('div', { className: 'cond' }, stat, op, value, unit),
      element('label', { textContent: '送出的指令（一行一個，依序送出）' }), commands,
      element('div', { className: 'row' },
        element('div', {}, element('label', { textContent: '冷卻（秒，最少 3）' }), cooldown),
        element('div', {}, element('label', { textContent: '回復緩衝（％）' }), buffer)),
      rearm);

    const updateRearm = () => {
      const text = Engine.rearmText({ op: op.value, unit: unit.value, value: Number(value.value) || 0, buffer: Number(buffer.value) || 0 });
      rearm.textContent = `回復條件：${stat.value} ${text} 才會重新武裝`;
    };
    card.addEventListener('input', updateRearm);
    updateRearm();
    card.dataset.kind = 'stat';
    wireRuleControls(card, remove, again);
    return card;
  }

  // 關鍵字規則：遊戲輸出區新出現的文字含關鍵字就送出指令
  function keywordCard(rule) {
    const enabled = field('enabled', element('input', { type: 'checkbox', checked: rule.enabled !== false, title: '啟用這條規則' }));
    const pill = field('pill', element('span', { className: 'pill', hidden: true }));
    const again = field('again', element('button', { type: 'button', className: 'linkbtn', textContent: '重新啟用', hidden: true }));
    const remove = element('button', { type: 'button', className: 'x', textContent: '✕', title: '刪除這條規則' });
    const pattern = field('pattern', element('input', { type: 'text', value: rule.pattern || '', placeholder: '例：你覺得口渴', title: '新出現的遊戲文字含這段字就觸發（不分大小寫）' }));
    const commands = field('commands', element('textarea', { value: (rule.commands || []).join('\n'), placeholder: '例：drink' }));
    const cooldown = field('cooldown', element('input', { type: 'number', min: Engine.MIN_COOLDOWN_SEC, value: rule.cooldown ?? D.cooldown }));
    const card = element('div', { className: 'rule' },
      element('div', { className: 'rule-head' }, enabled, element('span', { className: 'kind', textContent: '關鍵字' }), element('span', { className: 'grow' }, pill), again, remove),
      element('label', { textContent: '關鍵字（遊戲新出現的文字含有就觸發，不分大小寫）' }), pattern,
      element('label', { textContent: '送出的指令（一行一個，依序送出）' }), commands,
      element('label', { textContent: '冷卻（秒，最少 3）' }), cooldown);
    card.dataset.kind = 'keyword';
    wireRuleControls(card, remove, again);
    return card;
  }

  const buildCard = rule => (rule.kind === 'keyword' ? keywordCard(rule) : ruleCard(rule));

  function readSettings() {
    const get = (card, name) => card.querySelector(`[data-f="${name}"]`);
    const lines = (card, name) => get(card, name).value.split('\n').map(x => x.trim()).filter(Boolean);
    return {
      rules: [...$g('rules').children].map(card => (card.dataset.kind === 'keyword'
        ? {
          kind: 'keyword',
          enabled: get(card, 'enabled').checked,
          pattern: get(card, 'pattern').value.trim(),
          commands: lines(card, 'commands'),
          cooldown: Number(get(card, 'cooldown').value),
        }
        : {
          kind: 'stat',
          enabled: get(card, 'enabled').checked,
          stat: get(card, 'stat').value,
          op: get(card, 'op').value,
          unit: get(card, 'unit').value,
          value: Number(get(card, 'value').value),
          commands: lines(card, 'commands'),
          cooldown: Number(get(card, 'cooldown').value),
          buffer: Number(get(card, 'buffer').value),
        })),
      limitFires: $g('limitFires').checked,
      limitIneffective: $g('limitIneffective').checked,
      limitGlobal: $g('limitGlobal').checked,
      maxFires: Number($g('maxFires').value),
      windowMinutes: Number($g('windowMinutes').value),
      maxIneffective: Number($g('maxIneffective').value),
      globalPerMinute: Number($g('globalPerMinute').value),
      delayMax: $g('delayMax').value.trim() === '' ? D.delayMax : Number($g('delayMax').value),
      requireNormal: $g('requireNormal').checked,
    };
  }

  // 兩組存在同一個 storage key，各寫各的那一組，不覆蓋另一組
  async function save() {
    const { triggerGroupSettings } = await chrome.storage.local.get('triggerGroupSettings');
    await chrome.storage.local.set({ triggerGroupSettings: { ...triggerGroupSettings, [group.id]: readSettings() } });
  }

  // 沒勾選的限制，數字欄位反灰
  function syncLimitInputs() {
    [['limitFires', ['maxFires', 'windowMinutes']], ['limitIneffective', ['maxIneffective']], ['limitGlobal', ['globalPerMinute']]]
      .forEach(([switchId, inputs]) => inputs.forEach(id => { $g(id).disabled = !$g(switchId).checked; }));
  }

  function render(saved) {
    const config = saved || { rules: [BLANK_RULE] };
    $g('rules').replaceChildren(...(config.rules.length ? config.rules : [BLANK_RULE]).map(buildCard));
    $g('limitFires').checked = config.limitFires === true;
    $g('limitIneffective').checked = config.limitIneffective === true;
    $g('limitGlobal').checked = config.limitGlobal === true;
    syncLimitInputs();
    $g('maxFires').value = config.maxFires ?? D.maxFires;
    $g('windowMinutes').value = config.windowMinutes ?? D.windowMinutes;
    $g('maxIneffective').value = config.maxIneffective ?? D.maxIneffective;
    $g('globalPerMinute').value = config.globalPerMinute ?? D.globalPerMinute;
    $g('delayMax').value = config.delayMax ?? D.delayMax;
    $g('requireNormal').checked = config.requireNormal !== false;
  }

  root.querySelector('.safety').addEventListener('change', syncLimitInputs);
  $g('addRule').addEventListener('click', () => { $g('rules').append(ruleCard(BLANK_RULE)); save(); });
  $g('addKeyword').addEventListener('click', () => { $g('rules').append(keywordCard({ enabled: true, pattern: '', commands: [], cooldown: D.cooldown })); save(); });
  root.addEventListener('change', save);

  $g('tstart').addEventListener('click', async () => {
    try {
      const config = readSettings();
      if (!Engine.hasActiveRules(config)) throw new Error('至少要有一條完整的規則（數值規則要填項目、門檻、指令；關鍵字規則要填關鍵字、指令）');
      await save();
      const result = await send({ type: 'START_TRIGGER', group: group.id, config });
      if (!result?.ok) throw new Error(result?.error || '啟動觸發失敗');
      refreshLive();
    } catch (e) { holdStatus(e.message); }
  });

  $g('tstop').addEventListener('click', async () => {
    try { await send({ type: 'STOP_TRIGGER', group: group.id }); refreshLive(); }
    catch (e) { holdStatus(e.message); }
  });

  function renderReadings(stats) {
    $g('read').replaceChildren(...STAT_NAMES.map(name => {
      const stat = stats?.[name];
      const max = stat && Number.isFinite(stat.max) ? `/${stat.max}` : '';
      return element('div', { className: stat ? 'chip' : 'chip na' }, element('b', { textContent: name }), stat ? `${stat.value}${max}` : '—');
    }));
  }

  // status 是遊戲頁回的 STATUS（連不上時是 null）。規則數量和遊戲頁正在跑的設定不同（剛改過還沒重新開始）時不顯示規則狀態
  function refresh(status) {
    renderReadings(status?.stats);
    const state = status?.triggerGroups?.[group.id];
    const cards = [...$g('rules').children];
    const states = state?.on && state.rules.length === cards.length ? state.rules : [];
    cards.forEach((card, i) => {
      const pill = card.querySelector('[data-f="pill"]');
      const again = card.querySelector('[data-f="again"]');
      const rule = states[i];
      pill.hidden = !rule || rule.phase === 'off';
      again.hidden = !rule || rule.phase !== 'disabled';
      if (rule) { pill.textContent = rule.text; pill.className = `pill ${rule.phase}`; pill.title = rule.text; }
    });
    if (Date.now() < hold.until) return;
    $g('trigStatus').textContent = state?.on
      ? `${group.name}觸發執行中（${state.rules.filter(rule => rule.phase !== 'off').length} 條規則）`
      : (state?.note || `${group.name}觸發未啟動`);
    markLevel($g('trigStatus'), state?.on ? 'info' : stopLevel(state?.note));
  }

  return { group, root, render, refresh, readSettings };
}

const panes = Object.fromEntries(Engine.GROUPS.map(group => [group.id, createTriggerPane(group)]));

// 定時分頁的倒數：固定指令的下一輪、隨機指令的下一次
function renderCountdown(status) {
  const left = at => `${Math.max(0, Math.ceil((at - Date.now()) / 1000))} 秒後`;
  const parts = [];
  if (status?.running) {
    const settings = status.settings || {};
    if (settings.commands?.length) parts.push(`固定指令（${settings.commands.join(' → ')}）：${status.nextRunAt ? left(status.nextRunAt) : '送出中…'}`);
    if (CatworldTimer.normalizeRandomItems(settings).length) {
      parts.push(`隨機指令：${status.nextRandomAt ? `${status.nextRandomCommand}，${left(status.nextRandomAt)}` : '—'}`);
    }
  }
  $('countdown').textContent = `下一輪：${parts.length ? parts.join('　') : '—'}`;
}

// 每秒向遊戲頁要一次狀態，更新定時倒數與兩組觸發的讀數、規則狀態
// 定時的狀態文字平常只在按這一頁自己的按鈕時才會改；在面板或置頂面板裡開始、停止時，這裡要跟著變（只在開始／停止翻轉時改，不蓋掉錯誤訊息）
let lastTimerRunning = null;
async function refreshLive() {
  let status = null;
  try { status = await send({ type: 'STATUS' }); } catch { /* 連不上遊戲頁：讀數顯示 — */ }
  if (status && lastTimerRunning !== null && Boolean(status.running) !== lastTimerRunning) setStatus(status.running ? '執行中' : (status.stopReason || '已停止'), status.running ? 'info' : stopLevel(status.stopReason));
  if (status) lastTimerRunning = Boolean(status.running);
  renderCountdown(status);
  Object.values(panes).forEach(pane => pane.refresh(status));
}

// 遊戲頁裡的狀態變了（面板、置頂面板按開始／停止）會通知這裡馬上更新；設定頁開在背景分頁時自己的每秒更新會被降頻，不通知就要切回來才會對
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'STATE_CHANGED' && (!pageTabId || sender.tab?.id === pageTabId)) refreshLive();
});

(async () => {
  const data = await chrome.storage.local.get(['settings', 'triggerGroupSettings', 'triggerSettings', 'popupTab', 'persistentAlert', 'zapThresholds', 'mainWeapon', 'zapFeatures']);
  Object.entries(FEATURE_BOXES).forEach(([key, id]) => { $(id).checked = data.zapFeatures?.[key] === true; });
  $('persistentAlert').checked = data.persistentAlert === true;
  $('mainWeapon').value = weaponValue(data.mainWeapon);
  zapThresholds = CatworldZapMobs.normalizeThresholds(data.zapThresholds);
  showZapThresholds();
  if (data.settings) {
    $('commands').value = (data.settings.commands || ['ps','px']).join('\n');
    $('minSeconds').value = data.settings.minSeconds ?? 30;
    $('maxSeconds').value = data.settings.maxSeconds ?? 40;
    $('commandDelayMs').value = data.settings.commandDelayMs ?? 500;
  }
  // 舊格式（一行一個 + 共用秒數）由 normalizeRandomItems 轉成每個指令一列
  renderRandomItems(CatworldTimer.normalizeRandomItems(data.settings));
  // 舊版只有一組觸發設定（triggerSettings），升級時整份放進練功
  const savedGroups = Engine.loadGroupSettings(data);
  Object.values(panes).forEach(pane => pane.render(savedGroups[pane.group.id]));
  // 舊版的分頁名稱是 trigger（現在叫練功）
  const lastTab = data.popupTab === 'trigger' ? 'practice' : data.popupTab;
  showTab(panes[lastTab] ? lastTab : 'timer');
  try {
    const status = await send({ type: 'STATUS' });
    setStatus(status?.running ? '執行中' : (status?.stopReason || '已停止'), status?.running ? 'info' : stopLevel(status?.stopReason));
  } catch { setStatus('請切到 CatWorld Web 分頁', 'warn'); }
  refreshLive();
  setInterval(refreshLive, 1000);
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.stopReason?.newValue) setStatus(changes.stopReason.newValue, stopLevel(changes.stopReason.newValue));
  else if (changes.running) setStatus(changes.running.newValue ? '執行中' : '已停止');
});

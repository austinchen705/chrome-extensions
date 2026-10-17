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

function readSettings() {
  const lines = id => $(id).value.split('\n').map(x => x.trim()).filter(Boolean);
  return {
    commands: lines('commands'),
    randomCommands: lines('randomCommands'),
    randomMinSeconds: Number($('randomMinSeconds').value),
    randomMaxSeconds: Number($('randomMaxSeconds').value),
    minSeconds: Number($('minSeconds').value),
    maxSeconds: Number($('maxSeconds').value),
    commandDelayMs: Number($('commandDelayMs').value)
  };
}

function setStatus(text) { $('status').textContent = `狀態：${text}`; }

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
        files: ['trigger-engine.js', 'content.js']
      });
      return await chrome.tabs.sendMessage(tab.id, message);
    }
    throw e;
  }
}

$('start').addEventListener('click', async () => {
  try {
    const settings = readSettings();
    if (!settings.commands.length && !settings.randomCommands.length) throw new Error('至少要有一個指令');
    if (settings.maxSeconds < settings.minSeconds) throw new Error('最長秒數不能小於最短秒數');
    if (settings.randomMaxSeconds < settings.randomMinSeconds) throw new Error('隨機指令的最長秒數不能小於最短秒數');
    await chrome.storage.local.set({ settings });
    await send({ type: 'START', settings });
    const randomText = settings.randomCommands.length ? `；隨機：${settings.randomCommands.join(' / ')}` : '';
    setStatus(`執行中：${settings.commands.join(' → ')}${randomText}`);
  } catch (e) { setStatus(e.message); }
});

$('stop').addEventListener('click', async () => {
  try { await send({ type: 'STOP' }); setStatus('已停止'); }
  catch (e) { setStatus(e.message); }
});

$('test').addEventListener('click', async () => {
  try {
    const result = await send({ type: 'TEST', command: 'ps' });
    setStatus(result?.ok ? '測試 ps 已送出' : (result?.error || '測試失敗'));
  } catch (e) { setStatus(e.message); }
});

$('beep').addEventListener('click', async () => {
  try {
    const result = await send({ type: 'TEST_BEEP' });
    setStatus(result?.played ? '提示音已播放' : '瀏覽器擋住聲音：請先在遊戲分頁點一下或輸入任何內容，再試一次');
  } catch (e) { setStatus(e.message); }
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
document.querySelectorAll('[data-tab]').forEach(tab => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

// ---- 狀態觸發 ----
const STAT_NAMES = Object.keys(Engine.STATS);
const D = Engine.DEFAULTS;
const BLANK_RULE = { enabled: true, stat: '飲水', op: 'le', unit: 'abs', value: 200, commands: [], cooldown: D.cooldown, buffer: D.buffer };

function element(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

const field = (name, el) => { el.dataset.f = name; return el; };

// 每張規則卡片共用：刪除、重新啟用（按卡片在清單中的順序對應引擎裡的規則）
function wireRuleControls(card, remove, again) {
  remove.addEventListener('click', () => { card.remove(); saveTriggerUi(); });
  again.addEventListener('click', async () => {
    const index = [...$('rules').children].indexOf(card);
    try { await send({ type: 'REARM_RULE', index }); refreshLive(); } catch (e) { holdTrigStatus(e.message); }
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

function readTriggerSettings() {
  const get = (card, name) => card.querySelector(`[data-f="${name}"]`);
  const lines = (card, name) => get(card, name).value.split('\n').map(x => x.trim()).filter(Boolean);
  return {
    rules: [...$('rules').children].map(card => (card.dataset.kind === 'keyword'
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
    limitFires: $('limitFires').checked,
    limitIneffective: $('limitIneffective').checked,
    limitGlobal: $('limitGlobal').checked,
    maxFires: Number($('maxFires').value),
    windowMinutes: Number($('windowMinutes').value),
    maxIneffective: Number($('maxIneffective').value),
    globalPerMinute: Number($('globalPerMinute').value),
    delayMax: $('delayMax').value.trim() === '' ? D.delayMax : Number($('delayMax').value),
    requireNormal: $('requireNormal').checked,
  };
}

function saveTriggerUi() {
  chrome.storage.local.set({ triggerSettings: readTriggerSettings() });
}

function renderTriggerSettings(saved) {
  const config = saved || { rules: [BLANK_RULE] };
  $('rules').replaceChildren(...(config.rules.length ? config.rules : [BLANK_RULE]).map(buildCard));
  $('limitFires').checked = config.limitFires === true;
  $('limitIneffective').checked = config.limitIneffective === true;
  $('limitGlobal').checked = config.limitGlobal === true;
  syncLimitInputs();
  $('maxFires').value = config.maxFires ?? D.maxFires;
  $('windowMinutes').value = config.windowMinutes ?? D.windowMinutes;
  $('maxIneffective').value = config.maxIneffective ?? D.maxIneffective;
  $('globalPerMinute').value = config.globalPerMinute ?? D.globalPerMinute;
  $('delayMax').value = config.delayMax ?? D.delayMax;
  $('requireNormal').checked = config.requireNormal !== false;
}

// 沒勾選的限制，數字欄位反灰
function syncLimitInputs() {
  [['limitFires', ['maxFires', 'windowMinutes']], ['limitIneffective', ['maxIneffective']], ['limitGlobal', ['globalPerMinute']]]
    .forEach(([switchId, inputs]) => inputs.forEach(id => { $(id).disabled = !$(switchId).checked; }));
}
document.querySelector('.safety').addEventListener('change', syncLimitInputs);

$('addRule').addEventListener('click', () => { $('rules').append(ruleCard(BLANK_RULE)); saveTriggerUi(); });
$('addKeyword').addEventListener('click', () => { $('rules').append(keywordCard({ enabled: true, pattern: '', commands: [], cooldown: D.cooldown })); saveTriggerUi(); });
document.querySelector('[data-pane="trigger"]').addEventListener('change', saveTriggerUi);

let trigHold = { text: '', until: 0 };
function holdTrigStatus(text) {
  trigHold = { text, until: Date.now() + 4000 };
  $('trigStatus').textContent = text;
}

$('tstart').addEventListener('click', async () => {
  try {
    const config = readTriggerSettings();
    if (!Engine.hasActiveRules(config)) throw new Error('至少要有一條完整的規則（數值規則要填項目、門檻、指令；關鍵字規則要填關鍵字、指令）');
    await chrome.storage.local.set({ triggerSettings: config });
    const result = await send({ type: 'START_TRIGGER', config });
    if (!result?.ok) throw new Error(result?.error || '啟動觸發失敗');
    refreshLive();
  } catch (e) { holdTrigStatus(e.message); }
});

$('tstop').addEventListener('click', async () => {
  try { await send({ type: 'STOP_TRIGGER' }); refreshLive(); }
  catch (e) { holdTrigStatus(e.message); }
});

function renderReadings(stats) {
  $('read').replaceChildren(...STAT_NAMES.map(name => {
    const stat = stats?.[name];
    const max = stat && Number.isFinite(stat.max) ? `/${stat.max}` : '';
    return element('div', { className: stat ? 'chip' : 'chip na' }, element('b', { textContent: name }), stat ? `${stat.value}${max}` : '—');
  }));
}

// 定時分頁的倒數：固定指令的下一輪、隨機指令的下一次
function renderCountdown(status) {
  const left = at => `${Math.max(0, Math.ceil((at - Date.now()) / 1000))} 秒後`;
  const parts = [];
  if (status?.running) {
    const settings = status.settings || {};
    if (settings.commands?.length) parts.push(`固定指令：${status.nextRunAt ? left(status.nextRunAt) : '送出中…'}`);
    if (settings.randomCommands?.length) parts.push(`隨機指令：${status.nextRandomAt ? left(status.nextRandomAt) : '—'}`);
  }
  $('countdown').textContent = `下一輪：${parts.length ? parts.join('　') : '—'}`;
}

// 每秒向遊戲頁要一次狀態，更新定時倒數、觸發的讀數與各規則的狀態；
// 規則數量和遊戲頁正在跑的設定不同（剛改過還沒重新開始）時不顯示規則狀態
async function refreshLive() {
  let status;
  try { status = await send({ type: 'STATUS' }); } catch { renderReadings(null); renderCountdown(null); return; }
  renderCountdown(status);
  const triggers = status?.triggers;
  renderReadings(triggers?.stats);
  const cards = [...$('rules').children];
  const states = triggers?.on && triggers.rules.length === cards.length ? triggers.rules : [];
  cards.forEach((card, i) => {
    const pill = card.querySelector('[data-f="pill"]');
    const again = card.querySelector('[data-f="again"]');
    const state = states[i];
    pill.hidden = !state || state.phase === 'off';
    again.hidden = !state || state.phase !== 'disabled';
    if (state) { pill.textContent = state.text; pill.className = `pill ${state.phase}`; pill.title = state.text; }
  });
  if (Date.now() < trigHold.until) return;
  $('trigStatus').textContent = triggers?.on
    ? `觸發執行中（${triggers.rules.filter(rule => rule.phase !== 'off').length} 條規則）`
    : (triggers?.note || '觸發未啟動');
}

(async () => {
  const data = await chrome.storage.local.get(['settings', 'triggerSettings', 'popupTab']);
  if (data.settings) {
    $('commands').value = (data.settings.commands || ['ps','px']).join('\n');
    $('minSeconds').value = data.settings.minSeconds ?? 30;
    $('maxSeconds').value = data.settings.maxSeconds ?? 40;
    $('commandDelayMs').value = data.settings.commandDelayMs ?? 500;
    $('randomCommands').value = (data.settings.randomCommands || []).join('\n');
    $('randomMinSeconds').value = data.settings.randomMinSeconds ?? 30;
    $('randomMaxSeconds').value = data.settings.randomMaxSeconds ?? 40;
  }
  renderTriggerSettings(data.triggerSettings);
  showTab(data.popupTab === 'trigger' ? 'trigger' : 'timer');
  try {
    const status = await send({ type: 'STATUS' });
    setStatus(status?.running ? '執行中' : (status?.stopReason || '已停止'));
  } catch { setStatus('請切到 CatWorld Web 分頁'); }
  refreshLive();
  setInterval(refreshLive, 1000);
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.stopReason?.newValue) setStatus(changes.stopReason.newValue);
  else if (changes.running) setStatus(changes.running.newValue ? '執行中' : '已停止');
});

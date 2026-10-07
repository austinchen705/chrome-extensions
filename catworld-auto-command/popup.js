const $ = id => document.getElementById(id);
$('version').textContent = `v${chrome.runtime.getManifest().version}`;

async function getTab() {
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
  if (!tab?.id || !tab.url?.startsWith('https://catworld.muds.tw/web')) {
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
        files: ['content.js']
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

(async () => {
  const data = await chrome.storage.local.get(['settings']);
  if (data.settings) {
    $('commands').value = (data.settings.commands || ['ps','px']).join('\n');
    $('minSeconds').value = data.settings.minSeconds ?? 30;
    $('maxSeconds').value = data.settings.maxSeconds ?? 40;
    $('commandDelayMs').value = data.settings.commandDelayMs ?? 500;
    $('randomCommands').value = (data.settings.randomCommands || []).join('\n');
    $('randomMinSeconds').value = data.settings.randomMinSeconds ?? 30;
    $('randomMaxSeconds').value = data.settings.randomMaxSeconds ?? 40;
  }
  try {
    const status = await send({ type: 'STATUS' });
    setStatus(status?.running ? '執行中' : (status?.stopReason || '已停止'));
  } catch { setStatus('請切到 CatWorld Web 分頁'); }
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.stopReason?.newValue) setStatus(changes.stopReason.newValue);
  else if (changes.running) setStatus(changes.running.newValue ? '執行中' : '已停止');
});

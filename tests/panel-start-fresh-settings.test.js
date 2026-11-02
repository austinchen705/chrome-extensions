// 遊戲頁面板的「開始」（定時、各組觸發）要用設定頁最新存進 storage 的設定，不是頁面載入時讀到的那份：
// 設定頁每改一個欄位就存，使用者改完直接回遊戲頁按面板的「開始」，跑的要是新設定。
// 整個 content script 在 jsdom 裡跑，底座在 tests/helpers/game-page.js；需要 jsdom，沒裝就跳過
const test = require('node:test');
const assert = require('node:assert/strict');

const { ui, boot, waitFor } = require('./helpers/game-page');

const SCALE = 10;
const panel = page => page.hosts()[0].shadowRoot;
const keyword = (pattern, commands) => ({ kind: 'keyword', enabled: true, pattern, commands, cooldown: 3 });

ui('panel timer start uses the settings saved after the page loaded', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.w.chrome.storage.local.set({ settings: { fixedItems: [{ command: 'px', minSeconds: 1, maxSeconds: 1 }], commandDelayMs: 0 } });
    panel(page).querySelector('.start').click();
    assert.ok(await waitFor(() => page.sent.includes('px'), 1000), 'the newly saved fixed command is sent');
    assert.ok(!page.sent.includes('ps'), 'the default command from page load is not used');
  } finally {
    page.close();
  }
});

ui('panel trigger start uses the rules saved after the page loaded', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.w.chrome.storage.local.set({ triggerGroupSettings: { practice: { rules: [keyword('口渴', ['drink'])], delayMax: 0, requireNormal: false } } });
    panel(page).querySelector('[data-group="practice"] .tstart').click();
    assert.ok(await waitFor(async () => (await page.ask({ type: 'STATUS' })).triggerGroups.practice.on, 1000), 'the group starts from the saved rules');
    page.output('<span>你覺得口渴。</span>');
    assert.ok(await waitFor(() => page.sent.includes('drink'), 1000), 'the saved rule fires');
  } finally {
    page.close();
  }
});

ui('panel trigger start picks up rules changed while the page is open', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.w.chrome.storage.local.set({ triggerGroupSettings: { practice: { rules: [keyword('口渴', ['drink'])], delayMax: 0, requireNormal: false } } });
    panel(page).querySelector('[data-group="practice"] .tstart').click();
    assert.ok(await waitFor(async () => (await page.ask({ type: 'STATUS' })).triggerGroups.practice.on, 1000));
    await page.ask({ type: 'STOP_TRIGGER', group: 'practice' });
    // 設定頁把規則改成另一個關鍵字
    await page.w.chrome.storage.local.set({ triggerGroupSettings: { practice: { rules: [keyword('口渴', ['eat'])], delayMax: 0, requireNormal: false } } });
    panel(page).querySelector('[data-group="practice"] .tstart').click();
    assert.ok(await waitFor(async () => (await page.ask({ type: 'STATUS' })).triggerGroups.practice.on, 1000));
    page.output('<span>你覺得口渴。</span>');
    assert.ok(await waitFor(() => page.sent.includes('eat'), 1000), 'the changed rule fires');
    assert.ok(!page.sent.includes('drink'), 'the old rule does not');
  } finally {
    page.close();
  }
});

// 遊戲的「真人驗證」（點選和左側範例相同的圖形）：伺服器推 presence.challenge 後，遊戲把 #presence 的 invisible 拿掉、倒數 60 秒。
// 圖不在 #content 的文字輸出裡，也不能由程式代點，所以擴充功能只做一件事：它一出現就全部停下並警報，解除後不自動恢復，要玩家手動再按開始。
// 整個 content script 在 jsdom 裡跑；計時器縮小 SCALE 倍。
const assert = require('node:assert/strict');
const { ui, boot, sleep, waitFor, START } = require('./helpers/game-page');

const SCALE = 20;
const alerts = page => page.messages.filter(message => message.type === 'ALERT');
const presence = page => page.w.document.getElementById('presence');
const show = page => presence(page).classList.remove('invisible');
const hide = page => presence(page).classList.add('invisible');

ui('when the presence check appears everything stops, an alert goes out, and sending stays stopped', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000), 'it is sending');
    show(page);
    assert.ok(await waitFor(() => alerts(page).length === 1, 2000), 'one alert');
    assert.match(alerts(page)[0].reason, /驗證/, 'the reason says verification, so sending stays stopped until start is pressed again');
    assert.equal(await page.running(), false, 'stopped');
    const after = page.sent.length;
    await sleep(1500 / SCALE * 3);
    assert.equal(page.sent.length, after, 'nothing is sent after it appeared');
  } finally {
    page.close();
  }
});

ui('after the check is gone nothing resumes by itself, and the player can start again by hand', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    show(page);
    assert.ok(await waitFor(() => alerts(page).length === 1, 2000));
    hide(page);
    const after = page.sent.length;
    await sleep(1500 / SCALE * 3);
    assert.equal(page.sent.length, after, 'still stopped after the check closed');
    assert.equal(await page.running(), false);
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length > after, 4000), 'start by hand works again');
    assert.equal(alerts(page).length, 1, 'no new alert');
  } finally {
    page.close();
  }
});

ui('a second check alerts again, but other class changes on the element and a repeated show do not', async () => {
  const page = await boot({ scale: SCALE });
  try {
    show(page);
    assert.ok(await waitFor(() => alerts(page).length === 1, 2000), 'it alerts even when nothing is running');
    presence(page).classList.add('other');
    presence(page).classList.remove('other');
    await sleep(100);
    assert.equal(alerts(page).length, 1, 'no repeat while it stays shown');
    hide(page);
    await sleep(100);
    show(page);
    assert.ok(await waitFor(() => alerts(page).length === 2, 2000), 'a new check alerts again');
  } finally {
    page.close();
  }
});

ui('a page that has no presence element at all still works', async () => {
  const page = await boot({ scale: SCALE, preload: "document.getElementById('presence').remove()" });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('a check already open when the page loads is not announced, but nothing is sent while it is open, and sending works once it is closed', async () => {
  const page = await boot({ scale: SCALE, preload: "document.getElementById('presence').classList.remove('invisible')" });
  try {
    await sleep(100);
    assert.equal(alerts(page).length, 0, 'not a new appearance');
    await page.ask(START);
    await sleep(1500 / SCALE * 3);
    assert.equal(page.sent.length, 0, 'nothing is sent while the check is open');
    assert.equal(await page.running(), false, 'start is refused');
    hide(page);
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000), 'start works once the check is closed');
  } finally {
    page.close();
  }
});

ui('an orphaned page that sees the check does not alert', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.w.chrome.runtime.id = undefined; // 擴充功能重新載入後，舊頁面裡的 chrome.runtime.id 會失效
    show(page);
    await sleep(100);
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

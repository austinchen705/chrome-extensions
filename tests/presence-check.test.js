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

// 樣本收集：圖的真實格式沒有樣本，jsdom 也不載入圖，所以用假的圖尺寸與 canvas 輸出
const stubImage = url => `
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { get() { return 4; } });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { get() { return 3; } });
  Object.defineProperty(HTMLImageElement.prototype, 'complete', { get() { return true; } });
  HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  HTMLCanvasElement.prototype.toDataURL = () => ${url};
`;
const samples = page => page.messages.filter(message => message.type === 'CAPTCHA_SAMPLE');

ui('when the presence check appears its content is sent as a presence sample with the image embedded, and the alert still goes out', async () => {
  const page = await boot({ scale: SCALE, preload: stubImage(`'data:image/png;base64,AAAA'`) });
  try {
    page.w.document.getElementById('presence_image').setAttribute('src', '/presence?x=1');
    show(page);
    assert.ok(await waitFor(() => samples(page).length === 1, 2000), 'one sample');
    assert.equal(alerts(page).length, 1, 'the alert is not affected');
    const { sample } = samples(page)[0];
    assert.equal(sample.outcome, 'presence');
    assert.equal(sample.answer, '');
    assert.match(sample.html, /presence_header/, 'the whole block is included');
    assert.match(sample.html, /src="data:image\/png;base64,AAAA"/, 'the picture is embedded');
    assert.match(sample.html, /data-catworld-src="\/presence\?x=1"/, 'the original address is kept');
    assert.doesNotMatch(sample.html, /class="invisible"/, 'it was captured while shown');
  } finally {
    page.close();
  }
});

ui('a picture too big for one spreadsheet cell is left out and the original address is kept', async () => {
  const page = await boot({ scale: SCALE, preload: stubImage(`'data:image/png;base64,' + 'A'.repeat(50000)`) });
  try {
    page.w.document.getElementById('presence_image').setAttribute('src', '/presence?x=2');
    show(page);
    assert.ok(await waitFor(() => samples(page).length === 1, 2000), 'one sample');
    const { sample } = samples(page)[0];
    assert.ok(sample.html.length < 45000, 'fits in a cell');
    assert.match(sample.html, /src="\/presence\?x=2"/, 'original address, no embedded picture');
  } finally {
    page.close();
  }
});

ui('a picture that cannot be turned into a data URL still gives a sample with the original address', async () => {
  const page = await boot({ scale: SCALE, preload: stubImage(`(() => { throw new Error('tainted'); })()`) });
  try {
    page.w.document.getElementById('presence_image').setAttribute('src', '/presence?x=3');
    show(page);
    assert.ok(await waitFor(() => samples(page).length === 1, 2000), 'one sample');
    assert.match(samples(page)[0].sample.html, /src="\/presence\?x=3"/);
    assert.equal(alerts(page).length, 1);
  } finally {
    page.close();
  }
});

ui('no sample is sent when the check was already open at load, or by an orphaned page', async () => {
  const open = await boot({ scale: SCALE, preload: "document.getElementById('presence').classList.remove('invisible')" });
  try {
    await sleep(200);
    assert.equal(samples(open).length, 0);
  } finally {
    open.close();
  }
  const orphan = await boot({ scale: SCALE });
  try {
    orphan.w.chrome.runtime.id = undefined;
    show(orphan);
    await sleep(200);
    assert.equal(samples(orphan).length, 0);
  } finally {
    orphan.close();
  }
});

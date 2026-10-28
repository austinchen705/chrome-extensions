// 驗證碼自動辨識（整個 content script 在 jsdom 裡跑，用 tests/fixtures/captcha/ 的真實樣本）：
// 偵測到圖後暫停送出、等圖印完再解出數字、隨機等 3～10 秒才送出（等的期間又有輸出就接上去重新等）；遊戲有回應就通過並恢復送出；答錯遊戲不會回應，所以沒回應就重送、
// 滿 3 次才停止並警報（通知送不出去也要停）；解不出來直接停。每一回合結束都把樣本（結果、答案、次數、HTML）送給 background（CAPTCHA_SAMPLE）。
// 頁面的計時器縮小 SCALE 倍（8 秒無回應變 400 毫秒）。
const assert = require('node:assert/strict');
const { ui, boot, sleep, waitFor, START, fixture } = require('./helpers/game-page');
const cg = require('../catworld-auto-command/captcha-grid');

const SCALE = 20;
const NO_REPLY = 8000 / SCALE;
const QUIET = 1000 / SCALE;
const SEND_MIN = 3000 / SCALE;
const SEND_MAX = 10000 / SCALE;
const SPRITE = fixture('sprite-62044.html');
const INVERTED = fixture('grid-inverted-3608.html');
const NOISE = fixture('grid-noise-663.html');

const answers = (page, digits) => page.sent.filter(command => command === digits).length;
const alerts = page => page.messages.filter(message => message.type === 'ALERT');
const samples = page => page.messages.filter(message => message.type === 'CAPTCHA_SAMPLE').map(message => message.sample);
const outcomes = page => samples(page).map(sample => [sample.outcome, sample.answer, sample.attempts]);

ui('a captcha image pauses sending, the decoded digits are sent once the image is complete, and a reply resumes sending', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    page.output(SPRITE);
    assert.ok(await waitFor(() => answers(page, '62044') === 1, 2000), 'the answer is sent');
    const afterAnswer = page.sent.length;
    assert.ok(await page.running(), 'still running');
    await sleep(NO_REPLY / 2);
    assert.equal(page.sent.length, afterAnswer, 'nothing else is sent while waiting for the game');
    page.output('<span class="H3">驗證成功。\n</span>&gt; ');
    assert.ok(await waitFor(() => page.sent.length > afterAnswer, 2000), 'commands resume after the game replies');
    assert.equal(answers(page, '62044'), 1, 'the answer is not sent again');
    assert.equal(alerts(page).length, 0);
    assert.ok(await page.running());
    assert.deepEqual(outcomes(page), [['passed', '62044', 1]], 'one sample for the round, sent when the game replied');
    assert.equal(cg.decodeHtml(samples(page)[0].html).text, '62044', 'the html in the sample is what the decoder saw');
  } finally {
    page.close();
  }
});

ui('the answer is sent a random 3 to 10 seconds after the image is read, not the moment it is read', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    page.output(SPRITE);
    await sleep(QUIET + SEND_MIN / 2);
    assert.equal(answers(page, '62044'), 0, 'read but not sent yet');
    assert.ok(await waitFor(() => answers(page, '62044') === 1, SEND_MAX * 2), 'sent after the delay');
    assert.ok(await page.running());
  } finally {
    page.close();
  }
});

ui('output arriving while waiting to send (the reward prompt) joins the round: still one answer, and the round ends normally', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    page.output(INVERTED);
    await sleep(QUIET + SEND_MIN / 2);
    assert.equal(answers(page, '3608'), 0);
    page.output('請輸入上方的數字，以便完成領取手續。\n');
    assert.ok(await waitFor(() => answers(page, '3608') === 1, SEND_MAX * 2), 'the answer is sent once');
    page.output('&gt; 3608\n恭喜你獲得一個在線獎勵禮盒。\n');
    const afterAnswer = page.sent.length;
    assert.ok(await waitFor(() => page.sent.length > afterAnswer, 2000), 'commands resume');
    assert.equal(answers(page, '3608'), 1);
    assert.equal(alerts(page).length, 0);
    assert.deepEqual(outcomes(page), [['passed', '3608', 1]]);
  } finally {
    page.close();
  }
});

ui('no reply means a wrong answer: the same answer is resent, and after 3 tries everything stops with an alert', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    page.output(SPRITE);
    assert.ok(await waitFor(() => answers(page, '62044') === 3, NO_REPLY * 4), 'resent until the third try');
    assert.ok(await waitFor(async () => !(await page.running()), NO_REPLY * 2), 'then the timer stops');
    assert.equal(answers(page, '62044'), 3, 'no fourth try');
    assert.deepEqual(outcomes(page), [['silent', '62044', 3]], 'the sample says the answer was never accepted');
    const before = page.sent.length;
    await sleep(NO_REPLY);
    assert.equal(page.sent.length, before, 'and nothing more is sent');
    const alert = alerts(page);
    assert.equal(alert.length, 1);
    assert.match(alert[0].reason, /驗證碼自動辨識送出 62044 3 次/);
  } finally {
    page.close();
  }
});

ui('the ticking clock outside the output area is not a reply: the answer is still resent and the game-window text never leaks into the captcha', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    page.startClock(20);
    page.output(SPRITE);
    assert.ok(await waitFor(() => answers(page, '62044') === 2, NO_REPLY * 3), 'resent despite the clock ticking every 20 ms');
    assert.ok(await page.running(), 'the clock did not count as a reply');
  } finally {
    page.close();
  }
});

ui('the stop after 3 silent tries does not depend on the notification being sent', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    page.w.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
    page.output(SPRITE);
    assert.ok(await waitFor(async () => !(await page.running()), NO_REPLY * 6), 'the timer is stopped');
    assert.equal(answers(page, '62044'), 3);
  } finally {
    page.close();
  }
});

ui('the reward prompt after an inverted image joins the same round: one answer, resumed by the reward text', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    page.output(INVERTED);
    page.output('請輸入上方的數字，以便完成領取手續。\n');
    assert.ok(await waitFor(() => answers(page, '3608') === 1, 2000), 'the answer is sent');
    page.output('&gt; 3608\n恭喜你獲得一個在線獎勵禮盒。\n');
    const afterAnswer = page.sent.length;
    assert.ok(await waitFor(() => page.sent.length > afterAnswer, 2000), 'commands resume');
    assert.equal(answers(page, '3608'), 1);
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('the reward captcha whose blocks are scrambled text (digits are the holes) is decoded from the raw HTML', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    page.output(fixture('grid-reward-text.html'));
    assert.ok(await waitFor(() => answers(page, '306') === 1, 2000), 'the answer is sent');
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('with nothing running, a captcha is still answered (manual reward), and a reply does not start anything', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.output(fixture('grid-reward-text.html'));
    assert.ok(await waitFor(() => answers(page, '306') === 1, 2000), 'the answer is sent while idle');
    page.output('&gt; 306\n恭喜你獲得一個在線獎勵禮盒。\n');
    await sleep(NO_REPLY);
    assert.deepEqual(page.sent, ['306'], 'nothing else is sent');
    assert.equal(alerts(page).length, 0);
    assert.equal(await page.running(), false);
  } finally {
    page.close();
  }
});

ui('a captcha drawn with @ symbols (no spans at all) is answered while idle', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.output(fixture('symbol-306.html'));
    assert.ok(await waitFor(() => answers(page, '306') === 1, 2000));
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('with nothing running, 3 silent tries still end in an alert', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.output(SPRITE);
    assert.ok(await waitFor(() => answers(page, '62044') === 3, NO_REPLY * 4));
    assert.ok(await waitFor(() => alerts(page).length === 1, NO_REPLY * 2));
    assert.match(alerts(page)[0].reason, /3 次/);
  } finally {
    page.close();
  }
});

ui('the anti-bot captcha made of highlighted characters inside scrambled text is answered', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    page.output(fixture('noise-highlight-85410.html'));
    assert.ok(await waitFor(() => answers(page, '85410') === 1, 2000));
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('a second real sprite (italic 9, narrow 2) with clock text and ordinary output around it is answered', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    page.output(fixture('sprite-921.html'));
    assert.ok(await waitFor(() => answers(page, '921') === 1, 2000));
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('an inverted reward image right after a whole status card (box drawing, percentages, coloured spans) is answered', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    page.output(fixture('grid-inverted-after-status.html'));
    assert.ok(await waitFor(() => answers(page, '53046') === 1, 2000));
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('the reward captcha made of highlighted characters, preceded by coloured announcements, is answered while idle', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.output(fixture('noise-highlight-reward-53046.html'));
    assert.ok(await waitFor(() => answers(page, '53046') === 1, 2000));
    assert.equal(alerts(page).length, 0);
  } finally {
    page.close();
  }
});

ui('the noise-text captcha is decoded like the others', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    page.output(NOISE);
    assert.ok(await waitFor(() => answers(page, '663') === 1, 2000));
  } finally {
    page.close();
  }
});

ui('an image with a glyph the library and fuzzy match cannot read stops at once, sends nothing, and the alert says so', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    const block = n => `<span class="H7 B3">${' '.repeat(n)}</span>`;
    // 一個實心 3x7 長方形：不像任何數字
    page.output(Array.from({ length: 7 }, () => `   ${block(3)}   \n`).join(''));
    assert.ok(await waitFor(async () => !(await page.running()), 2000), 'stopped');
    assert.equal(page.sent.filter(command => /^\d+$/.test(command)).length, 0, 'no digits were sent');
    const alert = alerts(page);
    assert.equal(alert.length, 1);
    assert.match(alert[0].reason, /驗證碼自動辨識失敗/);
    assert.deepEqual(outcomes(page), [['unknown', '', 0]], 'the sample carries the unreadable result (a solid block has no glyphs at all)');
    assert.ok(samples(page)[0].html.includes('B3'), 'with the raw html of the image');
  } finally {
    page.close();
  }
});

ui('after a captcha stop, an image that arrives later (the player typing reward by hand) is still read and its answer sent', async () => {
  const page = await boot({ scale: SCALE });
  try {
    await page.ask(START);
    assert.ok(await waitFor(() => page.sent.length >= 1, 4000));
    const block = n => `<span class="H7 B3">${' '.repeat(n)}</span>`;
    page.output(Array.from({ length: 7 }, () => `   ${block(3)}   \n`).join(''));
    assert.ok(await waitFor(async () => !(await page.running()), 2000), 'stopped by the unreadable image');
    assert.equal(alerts(page).length, 1);
    page.output(SPRITE);
    assert.ok(await waitFor(() => answers(page, '62044') === 1, QUIET + SEND_MAX * 2), 'the answer is sent although the timer is stopped');
    page.output('<span class="H3">驗證成功。\n</span>&gt; ');
    assert.ok(await waitFor(() => outcomes(page).length === 2, 2000), 'the round ends');
    assert.deepEqual(outcomes(page)[1], ['passed', '62044', 1]);
    assert.equal(alerts(page).length, 1, 'no second alert');
    assert.equal(await page.running(), false, 'the timer stays stopped: the player presses start');
  } finally {
    page.close();
  }
});

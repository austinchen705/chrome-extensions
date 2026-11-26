// 書生助手開關（整個 content script 在 jsdom 裡跑）：打開時先送 sc、sk（分頁就送 Enter 讀到最後一頁）做開始前檢查，不符合就保持關閉並警告。樣本是遊戲的真實輸出（tests/fixtures/scholar/）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ui, boot, waitFor } = require('../../helpers/game-page');

const sample = name => fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'scholar', `${name}.txt`), 'utf8');
const panelRoot = page => page.hosts()[0].shadowRoot;
const button = page => panelRoot(page).querySelector('.sbtn');
const text = page => panelRoot(page).querySelector('.scholar-text');

// 假遊戲：sc 回固定樣本；sk 是分頁的，第一頁回 sk，之後每個 Enter（送出空白）回 more 的下一頁
function fakeGame(page, { sc, sk, more = [] }) {
  const pages = [...more];
  const say = name => page.output(`<span>${sample(name)}\n</span>`);
  page.w.document.getElementById('f').addEventListener('submit', () => {
    const command = page.w.document.getElementById('input').value;
    if (command === 'sc' && sc) say(sc);
    if (command === 'sk' && sk) say(sk);
    if (command === '' && pages.length) say(pages.shift());
  });
}

ui('turning the helper on sends sc, sk, then Enter for the next page (the last page ends the pager by itself); spirit 31 with 28 skills passes and it shows the success count', async () => {
  const page = await boot({ initialStore: { scholarSuccess: { 山本由伸: 2 } } });
  try {
    page.w.document.title = '山本由伸 - 小貓的世界';
    fakeGame(page, { sc: 'sc-spirit-31', sk: 'sk-28', more: ['sk-page2'] });
    button(page).click();
    assert.ok(await waitFor(() => button(page).classList.contains('on'), 6000), text(page).textContent);
    assert.deepEqual(page.sent, ['sc', 'sk', '']);
    assert.equal(text(page).textContent, '已成功 2／3');
    assert.ok(!text(page).classList.contains('warn'));
  } finally {
    page.close();
  }
});

ui('over the skill limit: warning in the warn colour, the helper stays off and nothing is abandoned', async () => {
  const page = await boot();
  try {
    fakeGame(page, { sc: 'sc-spirit-20', sk: 'sk-28', more: ['sk-page2'] });
    button(page).click();
    assert.ok(await waitFor(() => /abandon/.test(text(page).textContent), 6000), text(page).textContent);
    assert.equal(text(page).textContent, '技能數 28、靈性 20，要先 abandon 8 個技能');
    assert.ok(text(page).classList.contains('warn'));
    assert.ok(!button(page).classList.contains('on'));
    assert.deepEqual(page.sent, ['sc', 'sk', '']);
  } finally {
    page.close();
  }
});

ui('already has six-vein: the limit is spirit + 1', async () => {
  const page = await boot();
  try {
    fakeGame(page, { sc: 'sc-spirit-20', sk: 'sk-29-has-six-vein' });
    button(page).click();
    assert.ok(await waitFor(() => /abandon/.test(text(page).textContent), 6000), text(page).textContent);
    assert.equal(text(page).textContent, '技能數 29、靈性 20，要先 abandon 8 個技能');
    assert.deepEqual(page.sent, ['sc', 'sk']);
  } finally {
    page.close();
  }
});

ui('six-vein-sword is on the second page of sk: it is still counted (limit spirit + 1)', async () => {
  const page = await boot();
  try {
    fakeGame(page, { sc: 'sc-spirit-20', sk: 'sk-28', more: ['sk-page2-six-vein'] });
    button(page).click();
    assert.ok(await waitFor(() => /abandon/.test(text(page).textContent), 6000), text(page).textContent);
    assert.equal(text(page).textContent, '技能數 28、靈性 20，要先 abandon 7 個技能');
    assert.deepEqual(page.sent, ['sc', 'sk', '']);
  } finally {
    page.close();
  }
});

ui('sc gets no reply: stays off with the reason and does not send sk', async () => {
  const page = await boot({ scale: 20 });
  try {
    fakeGame(page, {});
    button(page).click();
    assert.ok(await waitFor(() => /讀不到 sc/.test(text(page).textContent), 6000), text(page).textContent);
    assert.ok(!button(page).classList.contains('on'));
    assert.deepEqual(page.sent, ['sc']);
  } finally {
    page.close();
  }
});

ui('turning it off and on again checks again', async () => {
  const page = await boot();
  try {
    fakeGame(page, { sc: 'sc-spirit-31', sk: 'sk-29-has-six-vein' });
    button(page).click();
    assert.ok(await waitFor(() => button(page).classList.contains('on'), 6000));
    button(page).click();
    assert.ok(await waitFor(() => !button(page).classList.contains('on')));
    button(page).click();
    assert.ok(await waitFor(() => page.sent.length === 4 && button(page).classList.contains('on'), 6000), page.sent.join());
    assert.deepEqual(page.sent, ['sc', 'sk', 'sc', 'sk']);
  } finally {
    page.close();
  }
});

// ---- 自動給：書生助手開著時遇到書生 ----
const BODY = items => `你身上帶著下列這些東西( 載重 28% ):\n${items.map(([name, id]) => `    ${name}(${id}) [view]`).join('\n')}\n`;
const STONE = [['紙皮水袋', 'waterskin'], ['一顆玄鐵石', 'stone']];
const FOLLOWED = '你決定開始跟隨落魄書生一起行動。';
const REQ_STONE = '落魄書生說道：誰能給我蟹珠玄鐵q石a呢？';
const SUCCESS = '你給落魄書生一顆玄鐵石。\n恭喜你對六脈神劍有所領悟了。';
const FAILED = '你給落魄書生一顆玄鐵石。\n落魄書生向你打聽有關『可惜啊！看來我們有緣無份了。』的消息。';
const ALREADY = '你給落魄書生一顆玄鐵石。\n落魄書生說道：你已經對六脈有相當的領悟了，我不能再教你什麼了。';
const say = (page, line) => page.output(`<span>${line}\n</span>`);

// 假遊戲：follow dire → 跟隨、i → 背包、give → 回 give 的回應（給 null 就不回）
function flowGame(page, { body = STONE, follow = FOLLOWED, give = SUCCESS } = {}) {
  page.w.document.getElementById('f').addEventListener('submit', () => {
    const command = page.w.document.getElementById('input').value;
    if (command === 'follow dire' && follow) say(page, follow);
    if (command === 'i') say(page, BODY(body));
    if (command.startsWith('give dire') && give) say(page, give);
  });
}
async function helperOn(page, opts = {}) {
  page.w.document.title = '山本由伸 - 小貓的世界';
  fakeGame(page, { sc: 'sc-spirit-31', sk: 'sk-28', more: ['sk-page2'] });
  button(page).click();
  assert.ok(await waitFor(() => button(page).classList.contains('on'), 6000), text(page).textContent);
  page.sent.length = 0;
  flowGame(page, opts);
}
const alerts = page => page.messages.filter(message => message.type === 'ALERT');
const sightings = page => page.store.scholarSightings ?? [];
const appear = page => say(page, '  ※落魄書生(dire scholar)');
const quiet = () => new Promise(resolve => setTimeout(resolve, 1200));

ui('auto give: appears -> follow dire, request -> i -> give dire <id>, success counts per character and notifies', async () => {
  const page = await boot({ initialStore: { scholarSuccess: { 山本由伸: 1 } } });
  try {
    await helperOn(page);
    appear(page);
    assert.ok(await waitFor(() => page.sent.includes('follow dire'), 6000), page.sent.join());
    say(page, REQ_STONE);
    assert.ok(await waitFor(() => page.sent.includes('give dire stone'), 6000), page.sent.join());
    assert.deepEqual(page.sent, ['follow dire', 'i', 'give dire stone']);
    assert.ok(await waitFor(() => text(page).textContent === '已成功 2／3', 6000), text(page).textContent);
    assert.equal(page.store.scholarSuccess['山本由伸'], 2);
    assert.ok(alerts(page).length >= 2, JSON.stringify(page.messages));
    assert.ok(await waitFor(() => sightings(page)[0]?.result === 'success', 6000), JSON.stringify(sightings(page)));
    assert.equal(sightings(page)[0].matched, '玄鐵石');
  } finally {
    page.close();
  }
});

ui('auto give: two items share an id -> gives with the ref (armor 2)', async () => {
  const page = await boot();
  try {
    await helperOn(page, { body: [['銀戒指', 'armor'], ['一件白金盔甲', 'armor']] });
    appear(page);
    assert.ok(await waitFor(() => page.sent.includes('follow dire'), 6000));
    say(page, '落魄書生說道：誰能給我化棍白u金盔唐銹甲呢？');
    assert.ok(await waitFor(() => page.sent.includes('give dire armor 2'), 6000), page.sent.join());
  } finally {
    page.close();
  }
});

ui('auto give: failed counts nothing and notifies; the sighting gets result failed; a fresh i is not read again', async () => {
  const page = await boot({ initialStore: { scholarSuccess: { 山本由伸: 1 } } });
  try {
    await helperOn(page, { give: FAILED });
    appear(page);
    assert.ok(await waitFor(() => page.sent.includes('follow dire'), 6000));
    say(page, REQ_STONE);
    assert.ok(await waitFor(() => sightings(page)[0]?.result === 'failed', 6000), JSON.stringify(sightings(page)));
    assert.equal(page.store.scholarSuccess['山本由伸'], 1);
    assert.ok(alerts(page).some(message => /沒解成/.test(message.reason)));
    assert.ok(button(page).classList.contains('on'));
  } finally {
    page.close();
  }
});

ui('auto give: the third success turns the helper off, says it is full and sends follow none', async () => {
  const page = await boot({ initialStore: { scholarSuccess: { 山本由伸: 2 } } });
  try {
    await helperOn(page);
    appear(page);
    assert.ok(await waitFor(() => page.sent.includes('follow dire'), 6000));
    say(page, REQ_STONE);
    assert.ok(await waitFor(() => !button(page).classList.contains('on'), 6000));
    assert.equal(page.store.scholarSuccess['山本由伸'], 3);
    assert.equal(text(page).textContent, '已成功 3／3');
    assert.ok(alerts(page).some(message => /解滿/.test(message.reason)));
    assert.ok(await waitFor(() => page.sent.includes('follow none'), 6000), page.sent.join());
  } finally {
    page.close();
  }
});

ui('auto give: unrecognised request -> nothing given, warn alert, keeps following', async () => {
  const page = await boot();
  try {
    await helperOn(page);
    appear(page);
    assert.ok(await waitFor(() => page.sent.includes('follow dire'), 6000));
    say(page, '落魄書生說道：誰能給我zzz呢？');
    assert.ok(await waitFor(() => alerts(page).some(message => /認不出/.test(message.reason)), 6000), JSON.stringify(page.messages));
    assert.ok(text(page).classList.contains('warn'));
    assert.ok(await waitFor(() => sightings(page)[0]?.result === 'unrecognised', 6000));
    assert.deepEqual(page.sent, ['follow dire']);
  } finally {
    page.close();
  }
});

ui('auto give: item not on the body -> nothing given, warn alert, sighting result missing', async () => {
  const page = await boot();
  try {
    await helperOn(page, { body: [['紙皮水袋', 'waterskin']] });
    appear(page);
    assert.ok(await waitFor(() => page.sent.includes('follow dire'), 6000));
    say(page, REQ_STONE);
    assert.ok(await waitFor(() => alerts(page).some(message => /身上沒有/.test(message.reason)), 6000), JSON.stringify(page.messages));
    assert.ok(await waitFor(() => sightings(page)[0]?.result === 'missing', 6000));
    assert.equal(sightings(page)[0].matched, '玄鐵石');
    assert.deepEqual(page.sent, ['follow dire', 'i']);
  } finally {
    page.close();
  }
});

ui('auto give: "already" turns the helper off', async () => {
  const page = await boot();
  try {
    await helperOn(page, { give: ALREADY });
    appear(page);
    assert.ok(await waitFor(() => page.sent.includes('follow dire'), 6000));
    say(page, REQ_STONE);
    assert.ok(await waitFor(() => !button(page).classList.contains('on'), 6000));
    assert.equal(text(page).textContent, '已解滿');
    assert.ok(await waitFor(() => sightings(page)[0]?.result === 'already', 6000));
  } finally {
    page.close();
  }
});

ui('auto give: the scholar vanishing sends follow none', async () => {
  const page = await boot();
  try {
    await helperOn(page);
    appear(page);
    assert.ok(await waitFor(() => page.sent.includes('follow dire'), 6000));
    say(page, '落魄書生突然身形一晃，便漸漸消逸了 ！。');
    assert.ok(await waitFor(() => page.sent.includes('follow none'), 6000), page.sent.join());
  } finally {
    page.close();
  }
});

ui('auto give: helper OFF -> nothing is sent when the scholar appears or asks', async () => {
  const page = await boot();
  try {
    flowGame(page);
    appear(page);
    say(page, REQ_STONE);
    await quiet();
    assert.deepEqual(page.sent, []);
  } finally {
    page.close();
  }
});

ui('auto give: a channel relay of the scholar lines sends nothing', async () => {
  const page = await boot();
  try {
    await helperOn(page);
    say(page, '【臥龍谷】某人：落魄書生說道：誰能給我蟹珠玄鐵q石a呢？');
    say(page, '【臥龍谷】某人：※落魄書生(dire scholar)');
    await quiet();
    assert.deepEqual(page.sent, []);
  } finally {
    page.close();
  }
});

ui('auto give: no reply to follow dire -> timeout record, warn alert, follow none', async () => {
  const page = await boot({ scale: 20 });
  try {
    await helperOn(page, { follow: null });
    appear(page);
    assert.ok(await waitFor(() => sightings(page)[0]?.result === 'timeout', 6000), JSON.stringify(sightings(page)));
    assert.ok(alerts(page).some(message => /沒看到跟隨/.test(message.reason)));
    assert.ok(await waitFor(() => page.sent.includes('follow none'), 6000), page.sent.join());
  } finally {
    page.close();
  }
});

ui('auto give: no result after give -> timeout record and warn alert', async () => {
  const page = await boot({ scale: 20 });
  try {
    await helperOn(page, { give: null });
    appear(page);
    assert.ok(await waitFor(() => page.sent.includes('follow dire'), 6000));
    say(page, REQ_STONE);
    assert.ok(await waitFor(() => alerts(page).some(message => /沒有結果/.test(message.reason)), 6000), JSON.stringify(page.messages));
    assert.ok(await waitFor(() => sightings(page)[0]?.result === 'timeout', 6000));
    assert.ok(page.sent.includes('give dire stone'));
  } finally {
    page.close();
  }
});

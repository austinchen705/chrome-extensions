// 劇本對話：兩個遊戲頁（A 開場、B 接話）只靠 tell 的內容同步，照一份劇本一人一輪地聊完。
// 整個 content script 在 jsdom 裡跑；中繼把一頁送出的 tell 變成另一頁的私聊來訊（和我方的回印行），假的 background 回劇本。
const assert = require('node:assert/strict');
const { ui, boot, waitFor, sleep } = require('./helpers/game-page');

const SCRIPT = {
  id: 't1',
  lines: [
    { who: 'A', text: '欸{對方} 你今天有上線喔' },
    { who: 'B', text: '有啊 剛下班' },
    { who: 'A', text: '這週天氣也太熱了吧' },
    { who: 'B', text: '對啊 我都不想出門' },
    { who: 'A', text: '那等等一起練功嗎' },
    { who: 'B', text: '好啊 十分鐘後' },
  ],
};
const OTHER = { id: 't2', lines: [{ who: 'A', text: '晚餐吃什麼好呢' }, { who: 'B', text: '我想吃牛肉麵' }] };

const A = { nick: '阿凱', id: 'akai' };
const B = { nick: '緋爾', id: 'fenrir' };

// 兩個頁面：A（角色 A、對方是 B）與 B（角色 B、對方是 A）；overrides 可改各自的設定
async function pair({ scripts = [SCRIPT, OTHER], a = {}, b = {}, storeA = {}, storeB = {}, scale = 20 } = {}) {
  const respond = message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts } : {});
  const setting = (role, partner, partnerName, extra) => ({ chatScript: { enabled: true, typoRate: 0, role, partner, partnerName, ...extra } });
  const pageA = await boot({ scale, respond, initialStore: { ...setting('A', B.id, B.nick, a), ...storeA } });
  const pageB = await boot({ scale, respond, initialStore: { ...setting('B', A.id, A.nick, b), ...storeB } });
  pageA.w.document.title = `${A.nick} - CatWorld`;
  pageB.w.document.title = `${B.nick} - CatWorld`;
  const told = [];
  const seen = new Map([[pageA, 0], [pageB, 0]]);
  const relay = (from, me, to, other) => {
    while (seen.get(from) < from.sent.length) {
      const match = /^tell (\S+) (.*)$/.exec(from.sent[seen.get(from)]);
      seen.set(from, seen.get(from) + 1);
      if (!match) continue;
      told.push({ from: me.nick, to: match[1], text: match[2] });
      to.output(`<span>[P]${me.nick}(${me.id})告訴你：${match[2]}\n</span>`);
      from.output(`<span>[P]你告訴${other.nick}：${match[2]}\n</span>`);
    }
  };
  const timer = setInterval(() => { relay(pageA, A, pageB, B); relay(pageB, B, pageA, A); }, 5);
  return { pageA, pageB, told, close: () => { clearInterval(timer); pageA.close(); pageB.close(); } };
}

const start = page => page.ask({ type: 'START_CHAT_SCRIPT' });

ui('A opens a script and B answers each round by recognising what A said, until the script is done', async () => {
  const both = await pair({ scripts: [SCRIPT] });
  try {
    const opened = await start(both.pageA); // 回覆是 jsdom 視窗裡的物件，不能直接 deepEqual
    assert.equal(opened.ok, true);
    assert.equal(opened.scriptId, 't1');
    assert.ok(await waitFor(() => both.told.length === 6, 8000), `told so far: ${JSON.stringify(both.told)}`);
    assert.deepEqual(both.told.map(item => [item.from, item.to, item.text]), [
      ['阿凱', 'fenrir', '欸緋爾 你今天有上線喔'],
      ['緋爾', 'akai', '有啊 剛下班'],
      ['阿凱', 'fenrir', '這週天氣也太熱了吧'],
      ['緋爾', 'akai', '對啊 我都不想出門'],
      ['阿凱', 'fenrir', '那等等一起練功嗎'],
      ['緋爾', 'akai', '好啊 十分鐘後'],
    ]);
    assert.ok(await waitFor(async () => (await both.pageA.ask({ type: 'STATUS' })).chatScript === null && (await both.pageB.ask({ type: 'STATUS' })).chatScript === null), 'both sides end the session');
    await sleep(300);
    assert.equal(both.told.length, 6, 'nothing is sent after the script is done');
  } finally {
    both.close();
  }
});

ui('B picks the script by what A opens with', async () => {
  const both = await pair({ scripts: [OTHER, SCRIPT] });
  try {
    both.pageB.output('<span>[P]阿凱(akai)告訴你：晚餐吃什麼好呢\n</span>');
    assert.ok(await waitFor(() => both.told.length === 1, 5000));
    assert.deepEqual(both.told[0], { from: '緋爾', to: 'akai', text: '我想吃牛肉麵' });
  } finally {
    both.close();
  }
});

ui('B stays quiet for a line that matches no script, or that comes from someone else', async () => {
  const both = await pair();
  try {
    both.pageB.output('<span>[P]阿凱(akai)告訴你：完全不相干的話題\n</span>');
    both.pageB.output('<span>[P]路人(stranger)告訴你：欸緋爾 你今天有上線喔\n</span>');
    await sleep(600);
    assert.equal(both.pageB.sent.length, 0);
    assert.equal((await both.pageB.ask({ type: 'STATUS' })).chatScript, null);
  } finally {
    both.close();
  }
});

ui('nothing happens while the feature is off, and A refuses to open without a partner or in the wrong role', async () => {
  const off = await pair({ a: { enabled: false }, b: { enabled: false } });
  try {
    assert.equal((await start(off.pageA)).ok, false);
    off.pageB.output('<span>[P]阿凱(akai)告訴你：晚餐吃什麼好呢\n</span>');
    await sleep(600);
    assert.equal(off.told.length, 0);
  } finally {
    off.close();
  }
  const mixed = await pair({ a: { partner: '' }, b: {} });
  try {
    const noPartner = await start(mixed.pageA);
    assert.equal(noPartner.ok, false);
    assert.match(noPartner.error, /對方/);
    const wrongRole = await start(mixed.pageB);
    assert.equal(wrongRole.ok, false);
    assert.match(wrongRole.error, /A/);
  } finally {
    mixed.close();
  }
});

ui('A cannot start a second script while one is going, and a message from a page is not accepted', async () => {
  const both = await pair();
  try {
    assert.equal((await start(both.pageA)).ok, true);
    const again = await start(both.pageA);
    assert.equal(again.ok, false);
    const fromPage = await new Promise(resolve => both.pageB.messageListeners.forEach(listener => listener({ type: 'START_CHAT_SCRIPT' }, { id: 'someone-else' }, resolve)));
    assert.equal(fromPage.ok, false);
    const noUrl = await new Promise(resolve => both.pageB.messageListeners.forEach(listener => listener({ type: 'START_CHAT_SCRIPT' }, { id: 'ext' }, resolve)));
    assert.equal(noUrl.ok, false, 'the extension id alone is not enough, the sender has to be one of its pages');
  } finally {
    both.close();
  }
});

ui('the session lasts until the last round has actually gone out: the status still shows it and a second script cannot start in the gap', async () => {
  const lastIsA = { id: 't3', lines: [{ who: 'A', text: '今天要不要去吃飯' }, { who: 'B', text: '好啊去哪裡吃' }, { who: 'A', text: '那就吃拉麵吧' }] };
  const respond = message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts: [lastIsA] } : {});
  const page = await boot({ scale: 5, respond, initialStore: { chatScript: { enabled: true, typoRate: 0, role: 'A', partner: B.id, partnerName: B.nick } } });
  try {
    assert.equal((await start(page)).ok, true);
    assert.ok(await waitFor(() => page.sent.length === 1, 5000));
    page.output('<span>[P]緋爾(fenrir)告訴你：好啊去哪裡吃\n</span>');
    assert.ok(await waitFor(async () => (await page.ask({ type: 'STATUS' })).chatScript?.done === true, 3000), 'while my last round waits to be sent the status still shows the session');
    assert.equal((await start(page)).ok, false, 'no second script in the gap');
    assert.ok(await waitFor(() => page.sent.length === 2, 5000));
    assert.equal(page.sent[1], 'tell fenrir 那就吃拉麵吧');
    assert.ok(await waitFor(async () => (await page.ask({ type: 'STATUS' })).chatScript === null));
    assert.equal((await start(page)).ok, true, 'a new script can start once the last round has gone out');
  } finally {
    page.close();
  }
});

ui('an expired script cache is refreshed once however many lines arrive meanwhile, and the old scripts keep working', async () => {
  const asked = [];
  const respond = async message => {
    if (message.type !== 'CHAT_SCRIPTS') return {};
    asked.push(message);
    await sleep(150);
    return { ok: true, scripts: [OTHER] };
  };
  const page = await boot({ scale: 20, respond, initialStore: { chatScript: { enabled: true, typoRate: 0, role: 'B', partner: A.id, partnerName: A.nick } } });
  try {
    assert.ok(await waitFor(() => asked.length === 1));
    await sleep(300);
    const realNow = page.w.Date.now.bind(page.w.Date);
    page.w.Date.now = () => realNow() + 6 * 60 * 1000;
    page.output('<span>[P]阿凱(akai)告訴你：完全不相干的話題一\n</span>');
    page.output('<span>[P]阿凱(akai)告訴你：完全不相干的話題二\n</span>');
    page.output('<span>[P]阿凱(akai)告訴你：晚餐吃什麼好呢\n</span>');
    assert.ok(await waitFor(() => page.sent.length === 1, 5000), 'the stale cache still answers the opener');
    assert.equal(page.sent[0], 'tell akai 我想吃牛肉麵');
    await sleep(400);
    assert.equal(asked.length, 2, 'one refresh, not one per line');
  } finally {
    page.close();
  }
});

ui('turning the feature off while A waits for the scripts cancels the start', async () => {
  let calls = 0;
  const respond = async message => {
    if (message.type !== 'CHAT_SCRIPTS') return {};
    calls += 1;
    if (calls === 1) return { ok: true, scripts: [] };
    await sleep(150);
    return { ok: true, scripts: [SCRIPT] };
  };
  const page = await boot({ scale: 20, respond, initialStore: { chatScript: { enabled: true, typoRate: 0, role: 'A', partner: B.id, partnerName: B.nick } } });
  try {
    const pending = start(page);
    await sleep(30);
    page.changeListeners.forEach(listener => listener({ chatScript: { newValue: { enabled: false, role: 'A', partner: B.id, partnerName: B.nick } } }, 'local'));
    const result = await pending;
    assert.equal(result.ok, false);
    await sleep(300);
    assert.equal(page.sent.length, 0);
  } finally {
    page.close();
  }
});

// ---- 與聊天回覆隔離 ----
const PLAIN = {
  id: 't4',
  lines: [
    { who: 'A', text: '今天要不要去吃飯' },
    { who: 'B', text: '好啊去哪裡吃' },
    { who: 'A', text: '那就吃拉麵吧' },
    { who: 'B', text: '好喔我也想吃' },
  ],
};
const AUTO_REPLY = { enabled: true, threshold: 0.5, cooldownSec: 600, perHour: 1, delayMin: 0, delayMax: 0 };
const HISTORY = [{ said: '吃飯了嗎你', reply: '還沒啦', at: 1 }];
const whisperTexts = page => [...page.hosts()[0].shadowRoot.querySelectorAll('.whisper-item')].map(item => item.textContent);

ui('a full play puts nothing in chatPairs and nothing in the whisper block, even when the partner had said something real just before', async () => {
  const both = await pair({ scripts: [SCRIPT] });
  try {
    both.pageB.output('<span>[P]阿凱(akai)告訴你：最近好嗎\n</span>');
    assert.ok(await waitFor(() => whisperTexts(both.pageB).length === 1), 'a real message is still shown');
    assert.equal((await start(both.pageA)).ok, true);
    assert.ok(await waitFor(() => both.told.length === 6, 8000));
    await sleep(600);
    [both.pageA, both.pageB].forEach(page => assert.equal((page.store.chatPairs ?? []).length, 0, JSON.stringify(page.store.chatPairs)));
    assert.equal(whisperTexts(both.pageA).length, 0, 'the script lines never reach A whisper block');
    assert.equal(whisperTexts(both.pageB).length, 1, 'and B only has the real message from before');
    // 劇本送出的台詞回印時，那則還沒回的真人來訊也算處理過了：之後我手動回的話不會和它配成一筆
    both.pageB.output('<span>[P]你告訴阿凱：還好啦\n</span>');
    await sleep(600);
    assert.equal((both.pageB.store.chatPairs ?? []).length, 0, 'no pending real message is left to pair with a later manual reply');
  } finally {
    both.close();
  }
});

ui('with auto reply on, a script adds no extra command and does not use up the reply cooldown or hourly quota', async () => {
  const both = await pair({ scripts: [SCRIPT], storeB: { chatReply: AUTO_REPLY, chatPairs: [...HISTORY, { said: '欸緋爾 你今天有上線喔', reply: '嗯嗯', at: 2 }] } });
  try {
    assert.equal((await start(both.pageA)).ok, true);
    assert.ok(await waitFor(() => both.told.length === 6, 8000));
    await sleep(300);
    assert.ok(both.pageB.sent.every(command => command.startsWith('tell ')), `B sent only script lines: ${JSON.stringify(both.pageB.sent)}`);
    both.pageB.output('<span>[P]阿凱(akai)告訴你：吃飯了嗎你\n</span>');
    assert.ok(await waitFor(() => both.pageB.sent.includes('reply 還沒啦'), 5000), 'the one allowed auto reply is still available');
  } finally {
    both.close();
  }
});

ui('a real message from the partner that matches no script line is handled as usual in the middle of a session, and the script carries on', async () => {
  const respond = message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts: [PLAIN] } : {});
  const page = await boot({ scale: 20, respond, initialStore: { chatScript: { enabled: true, typoRate: 0, role: 'B', partner: A.id, partnerName: A.nick }, chatReply: AUTO_REPLY, chatPairs: HISTORY } });
  try {
    page.output('<span>[P]阿凱(akai)告訴你：今天要不要去吃飯\n</span>');
    assert.ok(await waitFor(() => page.sent.includes('tell akai 好啊去哪裡吃'), 5000));
    page.output('<span>[P]阿凱(akai)告訴你：吃飯了嗎你\n</span>');
    assert.ok(await waitFor(() => page.sent.includes('reply 還沒啦'), 5000), 'answered by the normal chat reply');
    assert.ok(await waitFor(() => whisperTexts(page).length === 1), 'and shown in the whisper block');
    page.output('<span>[P]阿凱(akai)告訴你：那就吃拉麵吧\n</span>');
    assert.ok(await waitFor(() => page.sent.includes('tell akai 好喔我也想吃'), 5000), 'the script went on');
  } finally {
    page.close();
  }
});

// ---- 中止條件 ----
const SPRITE = require('./helpers/game-page').fixture('sprite-62044.html');
const soloPage = (role, extra = {}) => boot({
  scale: 20,
  respond: message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts: [PLAIN] } : {}),
  initialStore: { chatScript: { enabled: true, typoRate: 0, role, partner: role === 'A' ? B.id : A.id, partnerName: role === 'A' ? B.nick : A.nick }, ...extra },
});
const status = page => page.ask({ type: 'STATUS' });
const tells = page => page.sent.filter(command => command.startsWith('tell '));

ui('A gives up when B does not answer within 3 minutes, sends nothing more, and can start again', async () => {
  const page = await boot({ scale: 200, respond: message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts: [PLAIN] } : {}), initialStore: { chatScript: { enabled: true, typoRate: 0, role: 'A', partner: B.id, partnerName: B.nick } } });
  try {
    assert.equal((await start(page)).ok, true);
    assert.ok(await waitFor(() => tells(page).length === 1, 5000));
    assert.notEqual((await status(page)).chatScript, null, 'the session is still alive right after the round went out, long before the timeout');
    assert.ok(await waitFor(async () => (await status(page)).chatScript === null, 5000), 'the session ends by itself');
    page.output('<span>[P]緋爾(fenrir)告訴你：好啊去哪裡吃\n</span>');
    await sleep(300);
    assert.equal(tells(page).length, 1, 'a late answer is not continued, and no closing line is sent');
    assert.equal((await start(page)).ok, true, 'the next start is not affected');
  } finally {
    page.close();
  }
});

ui('B gives up when A does not carry on within 3 minutes, and a late line from A does not revive the session', async () => {
  const page = await boot({ scale: 200, respond: message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts: [PLAIN] } : {}), initialStore: { chatScript: { enabled: true, typoRate: 0, role: 'B', partner: A.id, partnerName: A.nick } } });
  try {
    page.output('<span>[P]阿凱(akai)告訴你：今天要不要去吃飯\n</span>');
    assert.ok(await waitFor(() => tells(page).length === 1, 5000));
    assert.ok(await waitFor(async () => (await status(page)).chatScript === null, 5000));
    page.output('<span>[P]阿凱(akai)告訴你：那就吃拉麵吧\n</span>');
    await sleep(300);
    assert.equal(tells(page).length, 1);
  } finally {
    page.close();
  }
});

ui('stopping everything cancels a round that is waiting to be sent', async () => {
  const page = await soloPage('A');
  try {
    assert.equal((await start(page)).ok, true);
    page.output('<span>jrealm 出現了\n</span>');
    await sleep(600);
    assert.equal(tells(page).length, 0);
    assert.equal((await status(page)).chatScript, null);
    assert.equal((await start(page)).ok, true, 'a new script can start afterwards');
  } finally {
    page.close();
  }
});

ui('a captcha cancels the script, including a round already queued, and nothing is sent after the captcha is passed', async () => {
  const page = await soloPage('A');
  let keepAlive = null;
  try {
    // 沒有遊戲輸出的話，無回應看門狗會在 sc 送出後約 8 秒（這裡縮小後 400 毫秒）停掉所有功能：持續餵一點輸出
    keepAlive = setInterval(() => page.output('<span>遊戲輸出\n</span>'), 80);
    // 別的功能一直在送指令，間隔很長：劇本這一輪排進佇列後要排在它們後面，過一陣子才會送出
    await page.ask({ type: 'START', settings: { commands: ['ps'], minSeconds: 1, maxSeconds: 1, commandDelayMs: 20000 } });
    assert.ok(await waitFor(() => page.sent.includes('sc'), 4000), 'starting sends sc first, the following commands wait for the long gap');
    assert.equal((await start(page)).ok, true);
    assert.ok(await waitFor(async () => (await status(page)).macros === 1, 4000), 'the round is queued behind the other commands');
    page.output(SPRITE);
    await sleep(100);
    const during = await status(page);
    assert.equal(during.chatScript, null, 'the captcha ends the session at once');
    assert.equal(during.macros, 0, 'and takes the queued round out of the queue');
    assert.ok(await waitFor(() => page.sent.includes('62044'), 4000), 'the captcha answer is sent');
    page.output('<span class="H3">驗證成功。\n</span>&gt; ');
    await sleep(2800);
    assert.equal(tells(page).length, 0, 'the queued round was cancelled, not sent after the captcha');
    assert.equal((await status(page)).chatScript, null);
  } finally {
    clearInterval(keepAlive);
    page.close();
  }
});

for (const [name, next] of [
  ['the switch is turned off', { enabled: false, role: 'A', partner: B.id, partnerName: B.nick }],
  ['the role is changed', { enabled: true, role: 'B', partner: B.id, partnerName: B.nick }],
  ['the partner ID is changed', { enabled: true, role: 'A', partner: 'someoneelse', partnerName: B.nick }],
]) {
  ui(`the session is cancelled when ${name}`, async () => {
    const page = await soloPage('A');
    try {
      assert.equal((await start(page)).ok, true);
      assert.ok(await waitFor(() => tells(page).length === 1, 5000));
      page.changeListeners.forEach(listener => listener({ chatScript: { newValue: next } }, 'local'));
      assert.equal((await status(page)).chatScript, null);
      page.output('<span>[P]緋爾(fenrir)告訴你：好啊去哪裡吃\n</span>');
      await sleep(400);
      assert.equal(tells(page).length, 1, 'nothing carries on');
    } finally {
      page.close();
    }
  });
}

ui('an orphaned page (the extension was reloaded) sends nothing more', async () => {
  const page = await soloPage('A');
  try {
    assert.equal((await start(page)).ok, true);
    page.w.chrome.runtime.id = undefined;
    page.output('<span>有東西出現了\n</span>');
    await sleep(600);
    assert.equal(tells(page).length, 0);
    assert.equal((await status(page)).chatScript, null, 'the retired page has no session left');
  } finally {
    page.close();
  }
});

ui('an answer inside the 3 minutes restarts the wait, so a live session is not cut off by the first timer', async () => {
  const page = await boot({ scale: 200, respond: message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts: [PLAIN] } : {}), initialStore: { chatScript: { enabled: true, typoRate: 0, role: 'A', partner: B.id, partnerName: B.nick } } });
  try {
    assert.equal((await start(page)).ok, true);
    assert.ok(await waitFor(() => tells(page).length === 1, 5000));
    await sleep(500); // 等待 900 毫秒的一半
    page.output('<span>[P]緋爾(fenrir)告訴你：好啊去哪裡吃\n</span>');
    assert.ok(await waitFor(() => tells(page).length === 2, 5000), 'the answer is recognised in time and the next round goes out');
    await sleep(600); // 距離第一個計時器的期限已經過了，但新的計時從這一輪送出才開始
    assert.notEqual((await status(page)).chatScript, null, 'the first timer did not cut the session off');
    assert.ok(await waitFor(async () => (await status(page)).chatScript === null, 5000), 'it still ends when the other side stays silent');
  } finally {
    page.close();
  }
});

// ---- 擬真計時與拆兩則 ----
// 記下頁面裡之後每個 setTimeout 的毫秒數（縮小之前的）；隨機數用頁面自己的 Math.random 換成固定值
function recordDelays(page) {
  const delays = [];
  const inner = page.w.setTimeout;
  page.w.setTimeout = (fn, ms, ...args) => { delays.push(ms); return inner(fn, ms, ...args); };
  return delays;
}

ui('the wait before a round is a thinking time plus typing time per character, kept between 3 and 45 seconds', async () => {
  // random 0：思考 1 秒，每字 0.3 秒；random 趨近 1：思考 4 秒，每字 0.6 秒
  const cases = [
    { text: '在嗎在嗎', random: 0, expected: 3000, unclamped: 2200 }, // 1000 + 4 × 300 = 2200，不到下限
    { text: '好'.repeat(20), random: 0, expected: 7000 }, // 1000 + 20 × 300
    { text: '好'.repeat(20), random: 0.999999, expected: 16000 }, // 4000 + 20 × 600
    { text: '好'.repeat(100), random: 0.999999, expected: 45000, unclamped: 64000 }, // 4000 + 100 × 600 = 64000，超過上限
  ];
  for (const { text, random, expected, unclamped } of cases) {
    const script = { id: 'len', lines: [{ who: 'A', text }, { who: 'B', text: '好' }] };
    const page = await boot({ scale: 20, respond: message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts: [script] } : {}), initialStore: { chatScript: { enabled: true, typoRate: 0, role: 'A', partner: B.id, partnerName: B.nick } } });
    try {
      page.w.Math.random = () => random;
      const delays = recordDelays(page);
      assert.equal((await start(page)).ok, true);
      assert.ok(delays.includes(expected), `${text.length} characters with random ${random} should wait ${expected} ms, timers set: ${JSON.stringify(delays)}`);
      if (unclamped) assert.ok(!delays.includes(unclamped), `the unclamped ${unclamped} ms must not be used`);
    } finally {
      page.close();
    }
  }
});

ui('a line with ／ goes out as separate tells a random 1 to 3 seconds apart, and B takes the earlier parts in without answering until the last one', async () => {
  const split = { id: 't5', lines: [{ who: 'A', text: '欸你看到新聞沒／那個真的很扯' }, { who: 'B', text: '有啊我看到了' }] };
  const both = await pair({ scripts: [split], scale: 5 });
  try {
    both.pageA.w.Math.random = () => 0.999; // 兩則之間間隔 1000 + 2000 × 0.999 = 2998 毫秒
    const delays = recordDelays(both.pageA);
    assert.equal((await start(both.pageA)).ok, true);
    assert.ok(delays.some((delay, index) => delays[index + 1] - delay === 2998), `the two parts are scheduled 2998 ms apart: ${JSON.stringify(delays)}`);
    assert.ok(await waitFor(() => both.told.length === 1, 12000), 'the first part goes out alone');
    const during = await status(both.pageB);
    assert.notEqual(during.chatScript, null, 'B recognised the first part as the start of the script');
    assert.equal(during.chatScript.turn, 0, 'but it is still waiting for the rest of the round');
    assert.equal(both.pageB.sent.length, 0, 'and has not answered');
    assert.ok(await waitFor(() => both.told.length === 3, 20000));
    assert.deepEqual(both.told.map(item => item.text), ['欸你看到新聞沒', '那個真的很扯', '有啊我看到了']);
    await sleep(600);
    assert.equal(whisperTexts(both.pageB).length, 0, 'the parts are not shown as ordinary whispers');
    assert.equal((both.pageB.store.chatPairs ?? []).length, 0, 'nor recorded as chat data');
  } finally {
    both.close();
  }
});

const soloWith = (script, role, scale = 20, settings = {}) => boot({
  scale,
  respond: message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts: [script] } : {}),
  initialStore: { chatScript: { enabled: true, typoRate: 0, role, partner: role === 'A' ? B.id : A.id, partnerName: role === 'A' ? B.nick : A.nick, ...settings } },
});

ui('the gap between two parts is 1 second at the lowest, and the first part waits thinking plus typing time', async () => {
  const split = { id: 't5', lines: [{ who: 'A', text: '欸你看到新聞沒／那個真的很扯' }, { who: 'B', text: '有啊我看到了' }] };
  const page = await soloWith(split, 'A');
  try {
    page.w.Math.random = () => 0;
    const delays = recordDelays(page);
    assert.equal((await start(page)).ok, true);
    // 第一則 7 個字：1000 + 7 × 300 = 3100；第二則再隔 1000
    const first = delays.indexOf(3100);
    assert.ok(first >= 0 && delays[first + 1] === 4100, `parts are scheduled at 3100 and 4100 ms: ${JSON.stringify(delays)}`);
  } finally {
    page.close();
  }
});

ui('when the other side splits its round, the waiting side takes the first part in and carries on only after the last one', async () => {
  const split = { id: 't6', lines: [{ who: 'A', text: '今天要不要去吃飯' }, { who: 'B', text: '好啊／去哪裡吃' }, { who: 'A', text: '拉麵吧好不好' }] };
  const both = await pair({ scripts: [split], scale: 5 });
  try {
    assert.equal((await start(both.pageA)).ok, true);
    assert.ok(await waitFor(() => both.told.length === 2, 20000), 'A said its round and B answered with the first part');
    const during = await status(both.pageA);
    assert.notEqual(during.chatScript, null);
    assert.equal(during.chatScript.turn, 1, 'A is still waiting for the rest of B round');
    assert.equal(both.pageA.sent.length, 1, 'and has not carried on');
    assert.ok(await waitFor(() => both.told.length === 4, 30000));
    assert.deepEqual(both.told.map(item => item.text), ['今天要不要去吃飯', '好啊', '去哪裡吃', '拉麵吧好不好']);
  } finally {
    both.close();
  }
});

ui('two parts that look alike are taken in one after the other, the second one being the last', async () => {
  const twins = { id: 't7', lines: [{ who: 'A', text: '哈哈哈哈／哈哈哈哈' }, { who: 'B', text: '好喔' }] };
  const page = await soloWith(twins, 'B');
  try {
    page.output('<span>[P]阿凱(akai)告訴你：哈哈哈哈\n</span>');
    assert.ok(await waitFor(async () => (await status(page)).chatScript !== null, 3000));
    await sleep(400);
    assert.equal(tells(page).length, 0, 'the first part alone is not answered');
    page.output('<span>[P]阿凱(akai)告訴你：哈哈哈哈\n</span>');
    assert.ok(await waitFor(() => tells(page).length === 1, 5000), 'the second one completes the round');
    assert.equal(tells(page)[0], 'tell akai 好喔');
  } finally {
    page.close();
  }
});

ui('a session that only got the first part of a round gives up when the rest never comes', async () => {
  const split = { id: 't5', lines: [{ who: 'A', text: '欸你看到新聞沒／那個真的很扯' }, { who: 'B', text: '有啊我看到了' }] };
  const page = await soloWith(split, 'B', 200);
  try {
    page.output('<span>[P]阿凱(akai)告訴你：欸你看到新聞沒\n</span>');
    assert.ok(await waitFor(async () => (await status(page)).chatScript !== null, 3000));
    assert.ok(await waitFor(async () => (await status(page)).chatScript === null, 5000), 'the wait for the other parts ends');
    assert.equal(tells(page).length, 0);
  } finally {
    page.close();
  }
});

ui('a script whose line has nothing but a slash is not usable', async () => {
  const page = await soloWith({ id: 'bad', lines: [{ who: 'A', text: '／' }, { who: 'B', text: '好' }] }, 'A');
  try {
    const result = await start(page);
    assert.equal(result.ok, false);
    assert.match(result.error, /沒有可用的劇本/);
  } finally {
    page.close();
  }
});

// ---- 錯字與更正 ----
const LONG = {
  id: 'long',
  lines: [
    { who: 'A', text: '欸你看到這週的新聞了沒有啊' },
    { who: 'B', text: '有啊我早上就看到了真的很扯' },
    { who: 'A', text: '對啊我整個傻眼不知道怎麼說' },
    { who: 'B', text: '我也是啦不過還是要上班啊' },
  ],
};
const differences = (original, typed) => [...original].map((char, at) => [char, [...typed][at]]).filter(([a, b]) => a !== b);

ui('with a typo rate of 0 nothing is ever misspelled', async () => {
  const both = await pair({ scripts: [LONG], a: { typoRate: 0 }, b: { typoRate: 0 } });
  try {
    assert.equal((await start(both.pageA)).ok, true);
    assert.ok(await waitFor(() => both.told.length === 4, 15000));
    await sleep(300);
    assert.deepEqual(both.told.map(item => item.text), LONG.lines.map(line => line.text));
  } finally {
    both.close();
  }
});

ui('with a typo rate of 100 every round has one misspelled character followed right away by a correction, and the other side still follows the script', async () => {
  const both = await pair({ scripts: [LONG], a: { typoRate: 100 }, b: { typoRate: 100 } });
  try {
    assert.equal((await start(both.pageA)).ok, true);
    assert.ok(await waitFor(() => both.told.length === 8, 30000), `told so far: ${JSON.stringify(both.told.map(item => item.text))}`);
    await sleep(300);
    LONG.lines.forEach((line, round) => {
      const typed = both.told[round * 2].text;
      const correction = both.told[round * 2 + 1].text;
      const changed = differences(line.text, typed);
      assert.equal([...typed].length, [...line.text].length, `round ${round} keeps its length`);
      assert.equal(changed.length, 1, `round ${round} has exactly one wrong character: ${typed}`);
      assert.equal(correction, `*${changed[0][0]}`, `round ${round} is corrected with the right character`);
      assert.equal(both.told[round * 2 + 1].from, both.told[round * 2].from);
    });
    for (const page of [both.pageA, both.pageB]) {
      assert.equal(whisperTexts(page).length, 0, 'neither the typos nor the corrections show as ordinary whispers');
      assert.equal((page.store.chatPairs ?? []).length, 0, 'nor are they recorded as chat data');
      assert.equal(tells(page).length, 4, 'and nobody answered a correction');
    }
    assert.equal((await status(both.pageA)).chatScript, null, 'the session ended normally');
  } finally {
    both.close();
  }
});

ui('a line under 6 characters is never misspelled, even at a rate of 100', async () => {
  const shortScript = { id: 'short', lines: [{ who: 'A', text: '在嗎在嗎好' }, { who: 'B', text: '在啊怎麼了' }] };
  const both = await pair({ scripts: [shortScript], a: { typoRate: 100 }, b: { typoRate: 100 } });
  try {
    assert.equal((await start(both.pageA)).ok, true);
    assert.ok(await waitFor(() => both.told.length === 2, 10000));
    await sleep(500);
    assert.deepEqual(both.told.map(item => item.text), ['在嗎在嗎好', '在啊怎麼了']);
  } finally {
    both.close();
  }
});

ui('a 6 character line can be misspelled only where the other side still recognises it', async () => {
  const sixes = { id: 'six', lines: [{ who: 'A', text: '你吃飯了沒有' }, { who: 'B', text: '還沒啦你呢啊' }] };
  const both = await pair({ scripts: [sixes], a: { typoRate: 100 }, b: { typoRate: 100 } });
  try {
    both.pageA.w.Math.random = () => 0.5;
    both.pageB.w.Math.random = () => 0.5;
    assert.equal((await start(both.pageA)).ok, true);
    assert.ok(await waitFor(() => both.told.length === 4, 15000), `told so far: ${JSON.stringify(both.told.map(item => item.text))}`);
    const changed = differences('你吃飯了沒有', both.told[0].text);
    assert.equal(changed.length, 1);
    assert.ok([0, 5].includes([...'你吃飯了沒有'].indexOf(changed[0][0])), 'only an end character, the only places a 6 character line stays similar enough');
    assert.equal(both.told[1].text, `*${changed[0][0]}`);
    assert.match(both.told[2].text, /^.{6}$/u, 'B answered, so it recognised the misspelled line');
  } finally {
    both.close();
  }
});

ui('the typo rate is a probability per round: no typo when the draw is at or above it, one when below', async () => {
  const cases = [{ random: 0.6, expected: 1 }, { random: 0.4, expected: 2 }];
  for (const { random, expected } of cases) {
    const script = { id: 'p', lines: [{ who: 'A', text: '欸你看到這週的新聞了沒有啊' }, { who: 'B', text: '好' }] };
    const page = await soloWith(script, 'A', 20, { typoRate: 50 });
    try {
      page.w.Math.random = () => random;
      assert.equal((await start(page)).ok, true);
      assert.ok(await waitFor(() => tells(page).length >= 1, 8000));
      await sleep(600);
      assert.equal(tells(page).length, expected, `random ${random} at a rate of 50`);
      if (expected === 2) assert.match(tells(page)[1], /^tell fenrir \*.$/u);
    } finally {
      page.close();
    }
  }
});

ui('a line starting with * from the partner is an ordinary whisper when no script is going', async () => {
  const page = await soloPage('B');
  try {
    page.output('<span>[P]阿凱(akai)告訴你：*的\n</span>');
    await sleep(400);
    assert.equal(whisperTexts(page).length, 1, 'with no script going, a line starting with * is an ordinary whisper');
  } finally {
    page.close();
  }
});

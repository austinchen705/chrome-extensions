// 劇本對話：兩個遊戲頁（A 開場、B 接話）只靠 tell 的內容同步，照一份劇本一人一輪地聊完。
// 整個 content script 在 jsdom 裡跑；中繼把一頁送出的 tell 變成另一頁的私聊來訊（和我方的回印行），假的 background 回劇本。
const test = require('node:test');
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

ui('every message waits about one second per character, with a little randomness, and between 3 and 30 seconds at the extremes', async () => {
  // random 0.5：剛好每字 1 秒；random 0：少 20%；random 趨近 1：多 20%；太短的至少 3 秒、太長的最多 30 秒
  const cases = [
    { length: 5, random: 0.5, expected: 5000 },
    { length: 10, random: 0.5, expected: 10000 },
    { length: 20, random: 0.5, expected: 20000 },
    { length: 10, random: 0, expected: 8000 },
    { length: 10, random: 0.999999, expected: 12000 },
    { length: 1, random: 0.5, expected: 3000 },
    { length: 100, random: 0.5, expected: 30000 },
  ];
  for (const { length, random, expected } of cases) {
    const script = { id: 'len', lines: [{ who: 'A', text: '好'.repeat(length) }, { who: 'B', text: '好' }] };
    const page = await boot({ scale: 20, respond: message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts: [script] } : {}), initialStore: { chatScript: { enabled: true, typoRate: 0, role: 'A', partner: B.id, partnerName: B.nick } } });
    try {
      page.w.Math.random = () => random;
      const delays = recordDelays(page);
      assert.equal((await start(page)).ok, true);
      assert.ok(delays.includes(expected), `${length} characters with random ${random} should wait ${expected} ms, timers set: ${JSON.stringify(delays)}`);
    } finally {
      page.close();
    }
  }
});

test('the wait of one message is worked out from its length by the module, and a correction is always shorter than the shortest wait', () => {
  require('../catworld-auto-command/chat-script.js');
  const C = globalThis.CatworldChatScript;
  assert.deepEqual([5, 10, 20].map(length => C.sendDelayMs('好'.repeat(length), () => 0.5)), [5000, 10000, 20000]);
  assert.deepEqual([0, 0.5, 1].map(random => C.sendDelayMs('好'.repeat(10), () => random)), [8000, 10000, 12000], 'plus or minus 20 percent');
  assert.deepEqual([C.sendDelayMs('', () => 0.5), C.sendDelayMs('好', () => 0), C.sendDelayMs('好'.repeat(500), () => 1)], [3000, 3000, 30000], 'bounded to 3 and 30 seconds');
  assert.equal(C.sendDelayMs('😀'.repeat(10), () => 0.5), 10000, 'characters are counted, not UTF-16 units');
  assert.ok(C.CORRECTION_DELAY_MS[1] < C.SEND_DELAY_BOUNDS[0], 'the other side cannot answer between a typo and its correction');
});

ui('a line with ／ goes out as separate tells, each waiting for its own length after the one before, and B takes the earlier parts in without answering until the last one', async () => {
  const split = { id: 't5', lines: [{ who: 'A', text: '欸你看到新聞沒／那個真的很扯' }, { who: 'B', text: '有啊我看到了' }] };
  const both = await pair({ scripts: [split], scale: 5 });
  try {
    both.pageA.w.Math.random = () => 0.5; // 剛好每字 1 秒：第一則 7 個字等 7000 毫秒，第二則 6 個字再等 6000 毫秒
    const delays = recordDelays(both.pageA);
    assert.equal((await start(both.pageA)).ok, true);
    assert.ok(delays.some((delay, index) => delay === 7000 && delays[index + 1] === 13000), `the two parts are scheduled 7000 and 13000 ms after the start: ${JSON.stringify(delays)}`);
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

ui('the first part waits 20 percent less than its length at the lowest and the next part its own length again after it', async () => {
  const split = { id: 't5', lines: [{ who: 'A', text: '欸你看到新聞沒／那個真的很扯' }, { who: 'B', text: '有啊我看到了' }] };
  const page = await soloWith(split, 'A');
  try {
    page.w.Math.random = () => 0;
    const delays = recordDelays(page);
    assert.equal((await start(page)).ok, true);
    const first = delays.indexOf(5600); // 7 個字 × 1000 × 0.8
    assert.ok(first >= 0 && delays[first + 1] === 10400, `parts are scheduled at 5600 and 10400 ms (the second is 6 characters × 800 ms later): ${JSON.stringify(delays)}`);
  } finally {
    page.close();
  }
});

ui('a correction comes 1 to 2.5 seconds after its typo, not another wait of its own, so the other side cannot answer in between', async () => {
  const line = { id: 't7', lines: [{ who: 'A', text: '今天天氣真的很不錯啊' }, { who: 'B', text: '對啊' }] };
  for (const { random, typoAt, correctionAt } of [{ random: 0, typoAt: 8000, correctionAt: 9000 }, { random: 0.999, typoAt: 11996, correctionAt: 14495 }]) {
    const page = await soloWith(line, 'A', 20, { typoRate: 100 });
    try {
      page.w.Math.random = () => random;
      const delays = recordDelays(page);
      assert.equal((await start(page)).ok, true);
      const typo = delays.indexOf(typoAt);
      assert.ok(typo >= 0 && delays[typo + 1] === correctionAt, `the typo is scheduled at ${typoAt} and its correction at ${correctionAt} ms: ${JSON.stringify(delays)}`);
    } finally {
      page.close();
    }
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

// ---- 錯字設定與更正視窗的邊界 ----
test('the typo rate is clamped to 0-100, and a blank or non-numeric value falls back to 3', () => {
  require('../catworld-auto-command/chat-script.js');
  const rate = typoRate => globalThis.CatworldChatScript.normalizeSettings({ typoRate }).typoRate;
  assert.deepEqual([-5, 0, 7, '7', 100, 250].map(rate), [0, 0, 7, 7, 100, 100]);
  assert.deepEqual(['abc', '', null, undefined, NaN, Infinity].map(rate), [3, 3, 3, 3, 3, 3]);
  assert.equal(globalThis.CatworldChatScript.normalizeSettings(undefined).typoRate, 3);
});

// A 走完整份劇本（最後一輪是 B 的），回傳頁面；此時這一場已經結束
async function finishedAsA() {
  const page = await soloPage('A');
  page.w.document.title = `${A.nick} - CatWorld`;
  const hear = text => page.output(`<span>[P]${B.nick}(${B.id})告訴你：${text}\n</span>`);
  assert.equal((await start(page)).ok, true);
  assert.ok(await waitFor(() => tells(page).length === 1, 5000));
  hear('好啊去哪裡吃');
  assert.ok(await waitFor(() => tells(page).length === 2, 5000));
  hear('好喔我也想吃');
  assert.ok(await waitFor(async () => (await status(page)).chatScript === null, 3000), 'the script is finished');
  return { page, hear };
}

ui('a correction that arrives right after the script has ended is still taken in, not shown as a whisper', async () => {
  const { page, hear } = await finishedAsA();
  try {
    hear('*的');
    await sleep(400);
    assert.equal(whisperTexts(page).length, 0);
    assert.equal(tells(page).length, 2, 'and nothing was answered');
  } finally {
    page.close();
  }
});

ui('a line starting with * long after the script has ended is an ordinary whisper again', async () => {
  const { page, hear } = await finishedAsA();
  try {
    const realNow = page.w.Date.now.bind(page.w.Date);
    page.w.Date.now = () => realNow() + 16000; // 過了 15 秒的視窗
    hear('*的');
    assert.ok(await waitFor(() => whisperTexts(page).length === 1, 3000));
  } finally {
    page.close();
  }
});

// ---- 每日場數、避開重複、狀態 ----
const todayKey = (offsetMs = 0) => {
  require('../catworld-auto-command/chat-script.js');
  return globalThis.CatworldChatScript.dayKey(Date.now() + offsetMs);
};
const DAY_MS = 24 * 60 * 60 * 1000;
const soloMany = (scripts, role, state, settings = {}) => boot({
  scale: 20,
  respond: message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts } : {}),
  initialStore: {
    chatScript: { enabled: true, typoRate: 0, role, partner: role === 'A' ? B.id : A.id, partnerName: role === 'A' ? B.nick : A.nick, ...settings },
    ...(state ? { chatScriptState: state } : {}),
  },
});
const opener = (id, text) => ({ id, lines: [{ who: 'A', text }, { who: 'B', text: '好啊沒問題' }] });

ui('A refuses to open once today is at the daily cap, says why, and sends nothing', async () => {
  const page = await soloMany([PLAIN], 'A', { date: todayKey(), count: 3 });
  try {
    const reply = await start(page);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /今天已經開了 3 場.*每天 3 場/);
    await sleep(300);
    assert.equal(tells(page).length, 0);
  } finally {
    page.close();
  }
});

ui('below the cap A opens and the day count and the script used are stored; a changed local date starts the count over', async () => {
  const page = await soloMany([PLAIN], 'A', { date: todayKey(), count: 2 });
  try {
    assert.equal((await start(page)).ok, true);
    assert.ok(await waitFor(() => page.store.chatScriptState?.count === 3));
    assert.equal(page.store.chatScriptState.date, todayKey());
    assert.equal(JSON.stringify(page.store.chatScriptState.recent), '["t4"]');
  } finally {
    page.close();
  }
  const nextDay = await soloMany([PLAIN], 'A', { date: todayKey(-2 * DAY_MS), count: 3 });
  try {
    assert.equal((await start(nextDay)).ok, true, 'yesterday\'s full count does not carry over');
    assert.ok(await waitFor(() => nextDay.store.chatScriptState?.date === todayKey()));
    assert.equal(nextDay.store.chatScriptState.count, 1);
  } finally {
    nextDay.close();
  }
});

ui('the cap follows the perDay setting, and a perDay of 0 allows no opening at all', async () => {
  const one = await soloMany([PLAIN], 'A', { date: todayKey(), count: 1 }, { perDay: 1 });
  try {
    const reply = await start(one);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /每天 1 場/);
  } finally {
    one.close();
  }
  const none = await soloMany([PLAIN], 'A', undefined, { perDay: 0 });
  try {
    assert.equal((await start(none)).ok, false);
  } finally {
    none.close();
  }
});

ui('B counts a script when it starts one, and at the cap it no longer takes a new one: the opener is an ordinary whisper', async () => {
  const both = await pair({ scripts: [PLAIN] });
  try {
    assert.equal((await start(both.pageA)).ok, true);
    assert.ok(await waitFor(() => both.told.length === 4, 15000));
    assert.equal(both.pageA.store.chatScriptState.count, 1);
    assert.equal(both.pageB.store.chatScriptState.count, 1, 'B was counted once for the whole script');
  } finally {
    both.close();
  }
  const full = await pair({ scripts: [PLAIN], storeB: { chatScriptState: { date: todayKey(), count: 3 } } });
  try {
    assert.equal((await start(full.pageA)).ok, true);
    assert.ok(await waitFor(() => full.told.length >= 1, 8000));
    await sleep(800);
    assert.equal(tells(full.pageB).length, 0, 'B did not answer');
    assert.equal(whisperTexts(full.pageB).length, 1, 'the opener went through the ordinary chat flow');
    assert.equal(full.pageB.store.chatScriptState.count, 3);
  } finally {
    full.close();
  }
});

ui('A picks a script that is not among the last 5 used, and when every script was used recently it takes the one used longest ago', async () => {
  const six = ['s1', 's2', 's3', 's4', 's5', 's6'].map(id => opener(id, `今天${id}想聊聊天好不好`));
  const fresh = await soloMany(six, 'A', { date: todayKey(), count: 0, recent: ['s1', 's2', 's3', 's4', 's5'] });
  try {
    assert.equal((await start(fresh)).scriptId, 's6');
  } finally {
    fresh.close();
  }
  const used = await soloMany(six.slice(0, 3), 'A', { date: todayKey(), count: 0, recent: ['s3', 's1', 's2'] });
  try {
    const reply = await start(used);
    assert.equal(reply.ok, true, 'it does not give up when everything was used recently');
    assert.equal(reply.scriptId, 's3');
  } finally {
    used.close();
  }
});

ui('status says whether the round is being said or waiting for the other side, with the script and the round', async () => {
  const page = await soloPage('A');
  try {
    assert.equal((await status(page)).chatScript, null, 'nothing going before the start');
    assert.equal((await start(page)).ok, true);
    const saying = (await status(page)).chatScript;
    assert.deepEqual([saying.scriptId, saying.turn, saying.total, saying.phase], ['t4', 1, 4, 'say']);
    assert.ok(await waitFor(() => tells(page).length === 1, 5000));
    assert.equal((await status(page)).chatScript.phase, 'wait');
  } finally {
    page.close();
  }
});

test('the daily count, the recent list and the status text are worked out by the module', () => {
  require('../catworld-auto-command/chat-script.js');
  const C = globalThis.CatworldChatScript;
  assert.equal(C.normalizeSettings(undefined).perDay, 3);
  assert.deepEqual([-1, 0, 5, '7', 250, 2.9].map(perDay => C.normalizeSettings({ perDay }).perDay), [0, 0, 5, 7, 99, 2]);
  assert.deepEqual(['abc', '', null, NaN].map(perDay => C.normalizeSettings({ perDay }).perDay), [3, 3, 3, 3]);
  // 平均每幾分鐘自動開一場：預設 0（不啟用）、整數、上限一天，留白或不是數字退回 0
  assert.equal(C.normalizeSettings(undefined).autoEveryMin, 0);
  assert.deepEqual([-5, 0, 60, '100', 99999, 2.9].map(autoEveryMin => C.normalizeSettings({ autoEveryMin }).autoEveryMin), [0, 0, 60, 100, 1440, 2]);
  assert.deepEqual(['abc', '', null, NaN].map(autoEveryMin => C.normalizeSettings({ autoEveryMin }).autoEveryMin), [0, 0, 0, 0]);
  assert.equal(C.todayCount({ date: '2026-11-07', count: 2, recent: [] }, '2026-11-07'), 2);
  assert.equal(C.todayCount({ date: '2026-11-06', count: 2, recent: [] }, '2026-11-07'), 0);
  assert.equal(C.todayCount(C.normalizeState({ date: 5, count: 'x', recent: 'y' }), '2026-11-07'), 0, 'damaged data counts as nothing');
  const after = ['a', 'b', 'c', 'd', 'e', 'f', 'a'].reduce((state, id) => C.recordStart(state, '2026-11-07', id), C.normalizeState(undefined));
  assert.deepEqual(after.recent, ['c', 'd', 'e', 'f', 'a'], 'only the last 5, and a repeat moves to the end');
  assert.equal(after.count, 7);
  assert.equal(C.describeStatus({ session: null, state: { date: '2026-11-07', count: 1, recent: [] }, perDay: 3, today: '2026-11-07' }), '今天 1/3 場；目前沒有進行中的一場');
  assert.equal(C.describeStatus({ session: { scriptId: 'x', turn: 2, total: 6, phase: 'wait' }, state: C.normalizeState(undefined), perDay: 3, today: '2026-11-07' }), '今天 0/3 場；進行中：劇本 x，已演 2/6 輪，等對方回');
  assert.equal(C.describeStatus({ session: { scriptId: 'x', turn: 1, total: 6, phase: 'say' }, state: C.normalizeState(undefined), perDay: 3, today: '2026-11-07' }), '今天 0/3 場；進行中：劇本 x，已演 1/6 輪，正在說');
  assert.equal(C.describeStatus({ session: undefined, state: C.normalizeState(undefined), perDay: 3, today: '2026-11-07' }), '今天 0/3 場；遊戲頁沒有回應');
  // 自動開場：沒有排程（null 或沒給）時文字和以前完全一樣；暖機中寫還要幾分鐘（進位），擲骰中寫平均幾分鐘一場
  const none = { session: null, state: C.normalizeState(undefined), perDay: 3, today: '2026-11-07' };
  assert.equal(C.describeStatus({ ...none, auto: null, everyMin: 100 }), '今天 0/3 場；目前沒有進行中的一場');
  assert.equal(C.describeStatus({ ...none, auto: { phase: 'warmup', secondsLeft: 125 }, everyMin: 100 }), '今天 0/3 場；目前沒有進行中的一場；自動開場：暖機中，約 3 分鐘後開始擲骰');
  assert.equal(C.describeStatus({ ...none, auto: { phase: 'warmup', secondsLeft: 0 }, everyMin: 100 }), '今天 0/3 場；目前沒有進行中的一場；自動開場：暖機中，約 1 分鐘後開始擲骰', 'never says 0 minutes');
  assert.equal(C.describeStatus({ ...none, auto: { phase: 'rolling' }, everyMin: 100 }), '今天 0/3 場；目前沒有進行中的一場；自動開場：擲骰中，平均每 100 分鐘一場');
});

ui('when the background cannot be reached A does not open and B does not answer', async () => {
  const respond = message => {
    if (message.type === 'CHAT_SCRIPTS') throw new Error('Extension context invalidated');
    return {};
  };
  const settings = (role, partner, partnerName) => ({ chatScript: { enabled: true, typoRate: 0, role, partner, partnerName } });
  const a = await boot({ scale: 20, respond, initialStore: settings('A', B.id, B.nick) });
  const b = await boot({ scale: 20, respond, initialStore: settings('B', A.id, A.nick) });
  try {
    assert.equal((await start(a)).ok, false);
    b.output('<span>[P]阿凱(akai)告訴你：欸緋爾 你今天有上線喔\n</span>');
    await sleep(400);
    assert.equal(tells(a).length + tells(b).length, 0);
  } finally {
    a.close();
    b.close();
  }
});

ui('a background that answers badly is asked again on the next message, not remembered as having no scripts', async () => {
  let calls = 0;
  const respond = message => {
    if (message.type !== 'CHAT_SCRIPTS') return {};
    calls += 1;
    return calls === 1 ? { ok: false, error: 'busy' } : { ok: true, scripts: [PLAIN] };
  };
  const page = await boot({ scale: 20, respond, initialStore: { chatScript: { enabled: true, typoRate: 0, role: 'B', partner: A.id, partnerName: A.nick } } });
  try {
    page.output('<span>[P]阿凱(akai)告訴你：今天要不要去吃飯\n</span>');
    await sleep(150);
    page.output('<span>[P]阿凱(akai)告訴你：今天要不要去吃飯\n</span>');
    assert.ok(await waitFor(() => tells(page).length === 1, 5000), 'the scripts were fetched again and the opener was recognised');
    assert.ok(calls >= 2);
  } finally {
    page.close();
  }
});

ui('B still stuck in an earlier script answers when A opens a new one', async () => {
  // A 重新開了一場時，B 可能還停在上一場（最久等 SCRIPT_WAIT_MS）：新的開場句不是舊那場的下一句，B 要當作新場的開頭
  const both = await pair({ scripts: [SCRIPT, OTHER] });
  try {
    both.pageB.output('<span>[P]阿凱(akai)告訴你：欸緋爾 你今天有上線喔\n</span>');
    assert.ok(await waitFor(() => both.told.length === 1, 5000), 'B answers the first script');
    assert.equal(both.told[0].text, '有啊 剛下班');
    assert.equal((await both.pageB.ask({ type: 'STATUS' })).chatScript.scriptId, 't1', 'B now waits for round 3 of the first script');
    both.pageB.output('<span>[P]阿凱(akai)告訴你：晚餐吃什麼好呢\n</span>');
    assert.ok(await waitFor(() => both.told.length === 2, 5000), `B answers the new opener: ${JSON.stringify(both.told)}`);
    assert.equal(both.told[1].text, '我想吃牛肉麵');
    assert.ok(await waitFor(async () => (await both.pageB.ask({ type: 'STATUS' })).chatScript === null), 'the new two-round script is over');
  } finally {
    both.close();
  }
});

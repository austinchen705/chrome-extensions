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
async function pair({ scripts = [SCRIPT, OTHER], a = {}, b = {} } = {}) {
  const respond = message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts } : {});
  const setting = (role, partner, partnerName, extra) => ({ chatScript: { enabled: true, role, partner, partnerName, ...extra } });
  const pageA = await boot({ scale: 20, respond, initialStore: setting('A', B.id, B.nick, a) });
  const pageB = await boot({ scale: 20, respond, initialStore: setting('B', A.id, A.nick, b) });
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
  } finally {
    both.close();
  }
});

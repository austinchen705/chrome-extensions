// 聊天指令（自動回覆的 reply、劇本的 tell）與其他指令之間，送出佇列要隔一段較長的隨機時間（1.5～4 秒），
// 不是只隔「指令間隔」（這裡設 0）；聊天與聊天、其他與其他之間維持原本的間隔。
// 整個 content script 在 jsdom 裡跑，頁面計時器縮小 SCALE 倍，所以真實時間裡的間隔是 150～400 毫秒。需要 jsdom；沒裝就跳過
const assert = require('node:assert/strict');

const { ui, boot, sleep, waitFor } = require('./helpers/game-page');

const SCALE = 10;
const SWITCH_MIN_MS = 1500 / SCALE;
const SWITCH_MAX_MS = 4000 / SCALE;
const TOLERANCE_MS = 40; // 輪詢（2 ms）與計時器的誤差：頁面計時器已縮小，jsdom 的計時器誤差大約在這個量級
const NO_GAP_MS = 60; // 指令間隔設成 0：沒有切換間隔時，兩個指令幾乎同時送出

const keyword = (pattern, commands, extra) => ({ kind: 'keyword', enabled: true, pattern, commands, cooldown: 0, ...extra });
const PAIRS = [{ said: '今天天氣真好', reply: '對啊出去走走', at: 1 }, { said: '今天天氣真好', reply: '對啊出去走走', at: 2 }];
const CHAT_ON = { enabled: true, threshold: 0.4, cooldownSec: 0, perHour: 100, delayMin: 0, delayMax: 0 };

// 劇本對話：角色 A 開場（對方 fenrir），第一句 tell 由劇本自己的打字等待決定何時送出
const SCRIPT = { id: 't1', lines: [{ who: 'A', text: '欸{對方} 你今天有上線喔' }, { who: 'B', text: '有啊 剛下班' }] };
const SCRIPT_ON = { enabled: true, typoRate: 0, role: 'A', partner: 'fenrir', partnerName: '緋爾' };

// 一個頁面：練功組的關鍵字規則（口渴 → p1、肚子餓 → p2）、自動回覆開著（沒有等待）、指令間隔 0；
// times 記下每個指令送出的真實時間（遊戲每收到一個指令就回一行輸出，免得 8 秒無回應看門狗停掉整組）
async function setup({ scripted = false } = {}) {
  const page = await boot({
    scale: SCALE,
    respond: message => (message.type === 'CHAT_SCRIPTS' ? { ok: true, scripts: [SCRIPT] } : {}),
    initialStore: { autoReward: false, settings: { commandDelayMs: 0 }, chatReply: CHAT_ON, chatPairs: PAIRS, ...(scripted ? { chatScript: SCRIPT_ON } : {}) },
  });
  page.w.document.title = '阿凱 - CatWorld';
  const times = [];
  const watcher = setInterval(() => {
    while (times.length < page.sent.length) {
      times.push({ command: page.sent[times.length], at: Date.now() });
      page.output('<span>好。\n</span>');
    }
  }, 2);
  await page.ask({ type: 'START_TRIGGER', group: 'practice', config: { rules: [keyword('口渴', ['p1']), keyword('肚子餓', ['p2']), keyword('要休息', ['m1;@等待 3;m2']), keyword('急事', ['q1;@等待 3;q2'], { priority: true })], delayMax: 0, requireNormal: false } });
  return { page, times, close: () => { clearInterval(watcher); page.close(); } };
}
const sentAt = (times, command) => times.find(item => item.command === command)?.at;
// 切換間隔：不比下限短、不比上限長太多（上限的容差只有輪詢與計時器的誤差，間隔超過 4 秒的話這裡會失敗）
const assertSwitchGap = (gap, label) => {
  assert.ok(gap >= SWITCH_MIN_MS - TOLERANCE_MS, `${label} waited for the switch gap (${gap} ms)`);
  assert.ok(gap <= SWITCH_MAX_MS + 2 * TOLERANCE_MS, `${label} did not wait much longer than the upper bound (${gap} ms)`);
};
const tellMe = (page, who, text) => page.output(`<span>[P]${who}回答你：${text}\n</span>`);

ui('a trigger command and then a chat reply are sent a switch gap apart, not just the command gap', async () => {
  const { page, times, close } = await setup();
  try {
    page.output('<span>你覺得口渴。\n</span>');
    assert.ok(await waitFor(() => sentAt(times, 'p1'), 1000), 'the trigger command goes out first');
    tellMe(page, '有氣質', '今天天氣不錯');
    assert.ok(await waitFor(() => sentAt(times, 'reply 對啊出去走走'), 2000), 'the reply follows');
    assertSwitchGap(sentAt(times, 'reply 對啊出去走走') - sentAt(times, 'p1'), 'the reply');
  } finally {
    close();
  }
});

ui('a chat reply and then a trigger command are sent a switch gap apart too', async () => {
  const { page, times, close } = await setup();
  try {
    tellMe(page, '有氣質', '今天天氣不錯');
    assert.ok(await waitFor(() => sentAt(times, 'reply 對啊出去走走'), 2000));
    page.output('<span>你覺得口渴。\n</span>');
    assert.ok(await waitFor(() => sentAt(times, 'p1'), 2000), 'the trigger command is sent after the chat reply');
    assertSwitchGap(sentAt(times, 'p1') - sentAt(times, 'reply 對啊出去走走'), 'the trigger command');
  } finally {
    close();
  }
});

ui('a scripted-chat tell counts as a chat command too: the trigger command after it waits for the switch gap', async () => {
  const { page, times, close } = await setup({ scripted: true });
  try {
    const opened = await page.ask({ type: 'START_CHAT_SCRIPT' });
    assert.equal(opened.ok, true);
    assert.ok(await waitFor(() => times.some(item => item.command.startsWith('tell fenrir')), 4000), `the first line is told (${JSON.stringify(page.sent)})`);
    const tell = times.find(item => item.command.startsWith('tell fenrir')).command;
    page.output('<span>你覺得口渴。\n</span>');
    assert.ok(await waitFor(() => sentAt(times, 'p1'), 2000), 'the trigger command is sent after the tell');
    assertSwitchGap(sentAt(times, 'p1') - sentAt(times, tell), 'the trigger command');
  } finally {
    close();
  }
});

ui('without any chat command, two trigger commands keep the plain command gap', async () => {
  const { page, times, close } = await setup();
  try {
    page.output('<span>你覺得口渴。肚子餓。\n</span>');
    assert.ok(await waitFor(() => sentAt(times, 'p1') && sentAt(times, 'p2'), 2000));
    assert.ok(Math.abs(sentAt(times, 'p2') - sentAt(times, 'p1')) < NO_GAP_MS, `no switch gap between two trigger commands (${sentAt(times, 'p2') - sentAt(times, 'p1')} ms)`);
  } finally {
    close();
  }
});

ui('two chat replies in a row keep the plain command gap', async () => {
  const { page, times, close } = await setup();
  try {
    tellMe(page, '有氣質', '今天天氣不錯');
    tellMe(page, '小明', '今天天氣不錯');
    assert.ok(await waitFor(() => times.length >= 2, 2000), `both replies are sent (${JSON.stringify(page.sent)})`);
    assert.ok(times[1].at - times[0].at < NO_GAP_MS, `chat after chat is not stretched (${times[1].at - times[0].at} ms)`);
  } finally {
    close();
  }
});

// 一則聊天指令前後各一個相鄰的指令：和它們都隔著切換間隔（只比下限，上限已在前面的測試量過）
const REPLY = 'reply 對啊出去走走';
const assertAroundChat = (times, label) => {
  const i = times.findIndex(item => item.command === REPLY);
  assert.ok(i > 0 && i < times.length - 1, `${label}: the reply has a command before and after it (${JSON.stringify(times.map(item => item.command))})`);
  assert.ok(times[i].at - times[i - 1].at >= SWITCH_MIN_MS - TOLERANCE_MS, `${label}: before the reply (${times[i].at - times[i - 1].at} ms)`);
  assert.ok(times[i + 1].at - times[i].at >= SWITCH_MIN_MS - TOLERANCE_MS, `${label}: after the reply (${times[i + 1].at - times[i].at} ms)`);
};
const START_FIXED = { type: 'START', settings: { fixedItems: [{ command: 't1', minSeconds: 600, maxSeconds: 600 }], randomItems: [], commandDelayMs: 0 } };

ui('a fixed timer command is separated from a chat reply in both directions', async () => {
  const first = await setup();
  try {
    await first.page.ask(START_FIXED);
    assert.ok(await waitFor(() => sentAt(first.times, 't1'), 1000), 'the timer command goes out at start');
    tellMe(first.page, '有氣質', '今天天氣不錯');
    assert.ok(await waitFor(() => sentAt(first.times, REPLY), 2000));
    assertSwitchGap(sentAt(first.times, REPLY) - sentAt(first.times, 't1'), 'the reply after the timer command');
  } finally {
    first.close();
  }
  const second = await setup();
  try {
    tellMe(second.page, '有氣質', '今天天氣不錯');
    assert.ok(await waitFor(() => sentAt(second.times, REPLY), 2000));
    await second.page.ask(START_FIXED);
    assert.ok(await waitFor(() => sentAt(second.times, 't1'), 2000), 'the timer command follows the reply');
    assertSwitchGap(sentAt(second.times, 't1') - sentAt(second.times, REPLY), 'the timer command after the reply');
  } finally {
    second.close();
  }
});

ui('a random timer command that keeps coming is separated from a chat reply on both sides', async () => {
  const { page, times, close } = await setup();
  try {
    await page.ask({ type: 'START_RANDOM', settings: { fixedItems: [], randomItems: [{ command: 'r1', minSeconds: 1, maxSeconds: 1 }], commandDelayMs: 0 } });
    assert.ok(await waitFor(() => sentAt(times, 'r1'), 2000), 'the random command goes out');
    tellMe(page, '有氣質', '今天天氣不錯');
    assert.ok(await waitFor(() => { const i = times.findIndex(item => item.command === REPLY); return i >= 0 && i < times.length - 1; }, 3000), 'the reply goes out and a random command follows');
    assertAroundChat(times, 'random');
  } finally {
    close();
  }
});

ui('a chat reply that lands in the middle of a trigger macro with @等待 has the gap before it and the next step has the gap after it, in first-in-first-out order', async () => {
  const { page, times, close } = await setup();
  try {
    page.output('<span>你要休息了。\n</span>');
    assert.ok(await waitFor(() => sentAt(times, 'm1'), 1000), 'the first step goes out and the macro is waiting');
    tellMe(page, '有氣質', '今天天氣不錯');
    assert.ok(await waitFor(() => sentAt(times, 'm2') && sentAt(times, REPLY), 3000), 'both the reply and the last step go out');
    assert.deepEqual(times.map(item => item.command), ['m1', REPLY, 'm2'], 'the reply was queued first, so it goes before the last step');
    assertAroundChat(times, 'macro');
  } finally {
    close();
  }
});

ui('the queue stays first in, first out around a chat reply', async () => {
  const { page, times, close } = await setup();
  try {
    page.output('<span>你覺得口渴。\n</span>');
    assert.ok(await waitFor(() => sentAt(times, 'p1'), 1000));
    tellMe(page, '有氣質', '今天天氣不錯');
    await sleep(20);
    page.output('<span>你覺得肚子餓。\n</span>');
    assert.ok(await waitFor(() => times.length >= 3, 4000), `all three go out (${JSON.stringify(page.sent)})`);
    assert.deepEqual(times.map(item => item.command), ['p1', REPLY, 'p2']);
    assertAroundChat(times, 'first in first out');
  } finally {
    close();
  }
});

ui('a priority macro still keeps a chat reply back until it is done, its own steps are not stretched, and the reply then waits the switch gap', async () => {
  const { page, times, close } = await setup();
  try {
    page.output('<span>有急事。\n</span>');
    assert.ok(await waitFor(() => sentAt(times, 'q1'), 1000));
    tellMe(page, '有氣質', '今天天氣不錯');
    assert.ok(await waitFor(() => sentAt(times, REPLY), 4000), 'the reply goes out in the end');
    assert.deepEqual(times.map(item => item.command), ['q1', 'q2', REPLY], 'the reply waited for the whole priority macro');
    const wait = sentAt(times, 'q2') - sentAt(times, 'q1');
    assert.ok(wait >= 300 - TOLERANCE_MS && wait <= 300 + 2 * TOLERANCE_MS, `the two steps of the priority macro keep their own 3 s wait (${wait} ms)`);
    assertSwitchGap(sentAt(times, REPLY) - sentAt(times, 'q2'), 'the reply after the priority macro');
  } finally {
    close();
  }
});

ui('stop-everything (a stop keyword) while a chat reply waits out its gap sends nothing more', async () => {
  const { page, times, close } = await setup();
  try {
    page.output('<span>你覺得口渴。\n</span>');
    assert.ok(await waitFor(() => sentAt(times, 'p1'), 1000));
    tellMe(page, '有氣質', '今天天氣不錯');
    await sleep(20);
    page.output('<span>jrealm 出現了\n</span>');
    await sleep(600);
    assert.deepEqual(times.map(item => item.command), ['p1'], 'the waiting reply was cancelled');
  } finally {
    close();
  }
});

ui('the human verification appearing while a chat reply waits out its gap sends nothing more', async () => {
  const { page, times, close } = await setup();
  try {
    page.output('<span>你覺得口渴。\n</span>');
    assert.ok(await waitFor(() => sentAt(times, 'p1'), 1000));
    tellMe(page, '有氣質', '今天天氣不錯');
    await sleep(20);
    page.w.document.getElementById('presence').classList.remove('invisible');
    await sleep(600);
    assert.deepEqual(times.map(item => item.command), ['p1'], 'nothing goes out while the check is open');
  } finally {
    close();
  }
});

ui('a run that mixes trigger and chat commands is never stopped by the no-reply watchdog', async () => {
  const { page, times, close } = await setup();
  try {
    page.output('<span>你覺得口渴。\n</span>');
    assert.ok(await waitFor(() => sentAt(times, 'p1'), 1000));
    tellMe(page, '有氣質', '今天天氣不錯');
    assert.ok(await waitFor(() => sentAt(times, 'reply 對啊出去走走'), 2000));
    page.output('<span>肚子餓。\n</span>');
    assert.ok(await waitFor(() => sentAt(times, 'p2'), 2000));
    await sleep(100);
    assert.deepEqual(page.messages.filter(message => message.type === 'ALERT'), [], 'no alert was raised');
    assert.equal((await page.ask({ type: 'STATUS' })).triggerGroups.practice.on, true, 'the trigger group is still running');
  } finally {
    close();
  }
});

// 隨機表情在遊戲頁的行為：整個 content script 在 jsdom 裡跑，計時器縮小 SCALE 倍（組內 2～10 秒＝20～100 毫秒），
// 頁面的 Math.random 換成固定值，抽出來的組合就是確定的；只看實際送給遊戲的指令與 STATUS。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, boot, waitFor, sleep } = require('./helpers/game-page');

const SCALE = 100;

async function page({ random = 0.5, extra = {} } = {}) {
  const p = await boot({ scale: SCALE, initialStore: { autoReward: false, ...extra } });
  p.w.Math.random = () => random;
  // 遊戲對每個指令都回一行，免得「送出 8 秒沒回應」的看門狗停掉一切
  p.w.document.getElementById('f').addEventListener('submit', () => setTimeout(() => p.output('<span>遊戲的回應\n</span>'), 1));
  return p;
}
// 這個亂數下會抽到的一組（和頁面用同一個模組算）
const expected = (p, random) => [...p.w.CatworldEmote.pick({ random: () => random }).commands];
// 頁面裡的陣列和測試的陣列原型不同，比之前先轉成一般的值
const plain = value => JSON.parse(JSON.stringify(value));

ui('試做一組 does one related group right away, in order, without the practice group running, and STATUS tells what it did', async () => {
  const p = await page();
  try {
    assert.equal((await p.ask({ type: 'STATUS' })).emote, null, 'nothing yet');
    const group = expected(p, 0.5);
    assert.ok(group.length >= 2, `this random gives a group of several: ${group}`);
    const reply = await p.ask({ type: 'EMOTE_TRY' });
    assert.deepEqual(plain(reply), { ok: true, commands: group });
    await waitFor(() => group.every(command => p.sent.includes(command)), 3000);
    assert.deepEqual(p.sent.filter(command => group.includes(command)), group, 'sent in order, one each');
    const status = (await p.ask({ type: 'STATUS' })).emote;
    assert.deepEqual(plain(status.commands), group);
    assert.ok(Math.abs(status.at - Date.now()) < 5000);
  } finally {
    p.close();
  }
});

ui('the emotes of a group are spaced by the waits of the group (2 to 10 seconds each)', async () => {
  const p = await page();
  try {
    const times = {};
    p.w.document.getElementById('f').addEventListener('submit', () => { times[p.w.document.getElementById('input').value] = Date.now(); });
    const group = (await p.ask({ type: 'EMOTE_TRY' })).commands;
    await waitFor(() => group.every(command => times[command]), 3000);
    // 0.5 的亂數：每段等 6 秒＝縮小後 60 毫秒
    for (let i = 1; i < group.length; i++) assert.ok(times[group[i]] - times[group[i - 1]] >= 50, `${group[i - 1]} → ${group[i]}`);
  } finally {
    p.close();
  }
});

ui('the next try leaves out what the last two groups did', async () => {
  const p = await page();
  try {
    const first = (await p.ask({ type: 'EMOTE_TRY' })).commands;
    await waitFor(() => first.every(command => p.sent.includes(command)), 3000);
    const second = (await p.ask({ type: 'EMOTE_TRY' })).commands;
    assert.ok(second.every(command => !first.includes(command)), `${first} then ${second}`);
  } finally {
    p.close();
  }
});

ui('試做一組 refuses while the presence check is open, and sends nothing', async () => {
  const p = await page();
  try {
    p.w.document.getElementById('presence').classList.remove('invisible');
    await sleep(30);
    const sentBefore = p.sent.length;
    const reply = await p.ask({ type: 'EMOTE_TRY' });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /驗證/);
    await sleep(200);
    assert.equal(p.sent.length, sentBefore);
  } finally {
    p.close();
  }
});

ui('a group halfway through is cancelled when everything stops (a stop keyword)', async () => {
  const p = await page();
  try {
    const group = (await p.ask({ type: 'EMOTE_TRY' })).commands;
    await waitFor(() => p.sent.includes(group[0]), 3000);
    p.output('<span>jrealm\n</span>');
    await sleep(1500);
    assert.ok(!p.sent.includes(group[group.length - 1]), `the rest of ${group} was not sent: ${p.sent}`);
  } finally {
    p.close();
  }
});

ui('a group halfway through is cancelled when a captcha shows up', async () => {
  const p = await page();
  try {
    const group = (await p.ask({ type: 'EMOTE_TRY' })).commands;
    await waitFor(() => p.sent.includes(group[0]), 3000);
    p.output('<span>請輸入上方的數字\n</span>');
    await sleep(1500);
    assert.ok(!p.sent.includes(group[group.length - 1]), `the rest of ${group} was not sent: ${p.sent}`);
  } finally {
    p.close();
  }
});

ui('試做一組 refuses while a captcha is being handled', async () => {
  const p = await page();
  try {
    p.output('<span>請輸入上方的數字\n</span>');
    await sleep(30);
    const sentBefore = p.sent.length;
    const reply = await p.ask({ type: 'EMOTE_TRY' });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /驗證/);
    await sleep(200);
    assert.equal(p.sent.length, sentBefore);
  } finally {
    p.close();
  }
});

ui('試做一組 from anything other than an extension page is refused', async () => {
  const p = await page();
  try {
    const reply = await new Promise(resolve => p.messageListeners.forEach(listener => listener({ type: 'EMOTE_TRY' }, { id: 'someone-else', url: 'https://example.com/' }, resolve)));
    assert.equal(reply.ok, false);
    await sleep(200);
    assert.equal(p.sent.length, 0);
  } finally {
    p.close();
  }
});

ui('a group halfway through stops when the extension is reloaded under the page (the old script retires)', async () => {
  const p = await page();
  try {
    const group = (await p.ask({ type: 'EMOTE_TRY' })).commands;
    await waitFor(() => p.sent.includes(group[0]), 3000);
    p.w.chrome.runtime.id = undefined; // 擴充功能重新載入後，舊的 content script 連不上
    await sleep(1500);
    assert.ok(!p.sent.includes(group[group.length - 1]), `the rest of ${group} was not sent: ${p.sent}`);
  } finally {
    p.close();
  }
});

test('the module is loaded on the game page before content.js', () => {
  const manifest = require('../catworld-auto-command/manifest.json');
  const files = manifest.content_scripts[0].js;
  assert.ok(files.indexOf('emote-data.js') < files.indexOf('emote-pick.js') && files.indexOf('emote-pick.js') < files.indexOf('content.js'));
});

// ── 練功時自動做（票 02）：計時器縮小 AUTO 倍（暖機 5 分鐘＝150 毫秒、每分鐘擲一次＝30 毫秒、組內 2～10 秒＝1～5 毫秒）──
const AUTO = 2000;
const keyword = (pattern, commands) => ({ kind: 'keyword', enabled: true, pattern, commands, cooldown: 1 });
// requireNormal: false＝不看角色狀態（底座的頁面沒有 #status，看的話一律擋）
const PRACTICE = (extra = {}) => ({ type: 'START_TRIGGER', group: 'practice', config: { rules: [keyword('口渴', ['drink'])], delayMax: 0, requireNormal: false, ...extra } });
const COMBAT = { type: 'START_TRIGGER', group: 'combat', config: { rules: [keyword('口渴', ['drink'])], delayMax: 0, requireNormal: false } };
const ON = { emoteSettings: { enabled: true, chance: 100 } };
// fastClock：頁面的 Date.now 也快 AUTO 倍，「兩組至少隔 10 分鐘」才測得到
async function practice({ random = 0, extra = ON, fastClock = false, scale = AUTO } = {}) {
  const p = await boot({ scale, initialStore: { autoReward: false, ...extra } });
  p.w.Math.random = () => random;
  if (fastClock) {
    const realNow = p.w.Date.now.bind(p.w.Date);
    const base = realNow();
    p.w.Date.now = () => base + (realNow() - base) * scale;
  }
  p.w.document.getElementById('f').addEventListener('submit', () => setTimeout(() => p.output('<span>遊戲的回應\n</span>'), 1));
  return p;
}
const EMOTES = new Set(require('../catworld-auto-command/emote-data.js') && globalThis.CatworldEmoteData.map(([command]) => command));
const emotesSent = p => p.sent.filter(command => EMOTES.has(command) && command !== 'drink');
const setEmote = (p, value) => p.changeListeners.forEach(listener => listener({ emoteSettings: { newValue: value } }, 'local'));

ui('with nothing stored nothing happens, even with the practice group running and a sure hit', async () => {
  const p = await practice({ extra: {} });
  try {
    await p.ask(PRACTICE());
    await sleep(600);
    assert.deepEqual(emotesSent(p), []);
  } finally {
    p.close();
  }
});

ui('switched on, the practice group running does a group after the 5-minute warm-up, not before', async () => {
  const p = await practice();
  try {
    await p.ask(PRACTICE());
    await sleep(60);
    assert.deepEqual(emotesSent(p), [], 'still warming up');
    assert.ok(await waitFor(() => emotesSent(p).length >= 1, 2000), 'a group after the warm-up');
    const status = (await p.ask({ type: 'STATUS' })).emote;
    assert.ok(status?.commands?.length >= 1);
  } finally {
    p.close();
  }
});

ui('a chance of 0, the practice group not running (only the combat group), or the switch off means no emotes', async () => {
  const zero = await practice({ extra: { emoteSettings: { enabled: true, chance: 0 } } });
  const combat = await practice();
  const off = await practice({ extra: { emoteSettings: { enabled: false, chance: 100 } } });
  try {
    await zero.ask(PRACTICE());
    await combat.ask(COMBAT);
    await off.ask(PRACTICE());
    await sleep(600);
    assert.deepEqual(emotesSent(zero), [], 'chance 0');
    assert.deepEqual(emotesSent(combat), [], 'combat group only');
    assert.deepEqual(emotesSent(off), [], 'switched off');
  } finally {
    zero.close();
    combat.close();
    off.close();
  }
});

ui('a roll that misses does nothing (the chance is per minute, in percent)', async () => {
  const p = await practice({ random: 0.06, extra: { emoteSettings: { enabled: true, chance: 5 } } });
  try {
    await p.ask(PRACTICE());
    await sleep(600);
    assert.deepEqual(emotesSent(p), [], '0.06 × 100 = 6 is not under 5');
  } finally {
    p.close();
  }
});

ui('idle, an open presence check, or a character status the practice group does not allow means no emotes', async () => {
  const idle = await practice();
  const presence = await practice();
  const status = await practice();
  try {
    await idle.ask(PRACTICE());
    await idle.ask({ type: 'START_IDLE', settings: { everyMin: 60, everyMax: 60, durMin: 60, durMax: 60 } });
    await presence.ask(PRACTICE());
    presence.w.document.getElementById('presence').classList.remove('invisible');
    await status.ask(PRACTICE({ requireNormal: true })); // 底座的頁面讀不到角色狀態＝不允許
    await sleep(600);
    assert.deepEqual(emotesSent(idle), [], 'idle');
    assert.deepEqual(emotesSent(presence), [], 'presence check');
    assert.deepEqual(emotesSent(status), [], 'status not allowed');
    await idle.ask({ type: 'STOP_IDLE' });
    assert.ok(await waitFor(() => emotesSent(idle).length >= 1, 2000), 'after idle ends the next roll does a group');
  } finally {
    idle.close();
    presence.close();
    status.close();
  }
});

ui('two groups are at least 10 minutes apart', async () => {
  const p = await practice({ fastClock: true });
  try {
    await p.ask(PRACTICE());
    const times = [];
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      const at = (await p.ask({ type: 'STATUS' })).emote?.at;
      if (at && at !== times[times.length - 1]) times.push(at);
      await sleep(5);
    }
    assert.ok(times.length >= 2, `several groups in 1.5 s (≈ 50 fake minutes): ${times.length}`);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 10 * 60 * 1000, `gap ${(times[i] - times[i - 1]) / 60000} min`);
  } finally {
    p.close();
  }
});

ui('switching it off while warming up means no group comes', async () => {
  const p = await practice();
  try {
    await p.ask(PRACTICE());
    await sleep(30);
    setEmote(p, { enabled: false, chance: 100 });
    await sleep(600);
    assert.deepEqual(emotesSent(p), []);
  } finally {
    p.close();
  }
});

ui('stopping the practice group cancels a group halfway through', async () => {
  const p = await practice({ random: 0.5, scale: 100 });
  try {
    await p.ask(PRACTICE());
    const group = (await p.ask({ type: 'EMOTE_TRY' })).commands;
    assert.ok(group.length >= 2);
    await waitFor(() => p.sent.includes(group[0]), 3000);
    await p.ask({ type: 'STOP_TRIGGER', group: 'practice' });
    await sleep(1500);
    assert.ok(!p.sent.includes(group[group.length - 1]), `the rest of ${group} was not sent: ${p.sent}`);
  } finally {
    p.close();
  }
});

ui('only the timer running (no practice group) means no emotes', async () => {
  const p = await practice();
  try {
    await p.ask({ type: 'START', settings: { fixedItems: [{ command: 'fx', minSeconds: 1, maxSeconds: 1 }], commandDelayMs: 0 } });
    await sleep(600);
    assert.deepEqual(emotesSent(p), []);
    assert.ok(p.sent.includes('fx'), 'the timer itself runs');
  } finally {
    p.close();
  }
});

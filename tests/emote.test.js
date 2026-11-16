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

test('the module is loaded on the game page before content.js', () => {
  const manifest = require('../catworld-auto-command/manifest.json');
  const files = manifest.content_scripts[0].js;
  assert.ok(files.indexOf('emote-data.js') < files.indexOf('emote-pick.js') && files.indexOf('emote-pick.js') < files.indexOf('content.js'));
});

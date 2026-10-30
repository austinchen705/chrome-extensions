// 規則的「命中送出後停止這組觸發」（整個 content script 在 jsdom 裡跑，底座在 tests/helpers/game-page.js）：
// 勾了的規則指令送出後，只停那一組的觸發（指令照常送出），定時（固定、隨機）與另一組不受影響；沒勾的規則命中照舊繼續跑。
// 底座的頁面沒有 #status，所以規則都要 requireNormal: false。需要 jsdom；沒裝就跳過
const test = require('node:test');
const assert = require('node:assert/strict');

const { ui, boot, sleep, waitFor } = require('./helpers/game-page');

const SCALE = 10;
const count = (page, command) => page.sent.filter(sent => sent === command).length;
const practice = async page => (await page.ask({ type: 'STATUS' })).triggerGroups.practice;
const keyword = (pattern, commands, extra) => ({ kind: 'keyword', enabled: true, pattern, commands, cooldown: 3, ...extra });
const config = (rules, extra) => ({ rules, delayMax: 0, requireNormal: false, ...extra });

ui('the group stops after the flagged rule\'s commands are sent; the timer keeps running', async () => {
  const page = await boot({ scale: SCALE });
  try {
  await page.ask({ type: 'START', settings: { fixedItems: [{ command: 'ps', minSeconds: 1, maxSeconds: 1 }], commandDelayMs: 0 } });
  assert.equal((await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['drink'], { stopGroup: true })]) })).ok, true);
  assert.equal((await practice(page)).on, true);
  page.output('<span>你覺得口渴。</span>');
  assert.ok(await waitFor(() => count(page, 'drink') === 1, 1000), 'the rule command is still sent');
  const state = await practice(page);
  assert.equal(state.on, false, 'the practice group is stopped');
  assert.match(state.note, /口渴/, 'the note names the rule that stopped it');
  assert.equal((await page.ask({ type: 'STATUS' })).running, true, 'the timer is untouched');
  const before = count(page, 'ps');
  await sleep(1500 / SCALE);
  assert.ok(count(page, 'ps') > before, 'the fixed command keeps going');
  page.output('<span>你覺得口渴。</span>');
  await sleep(500 / SCALE);
  assert.equal(count(page, 'drink'), 1, 'the stopped group does not fire again');
  } finally {
    page.close();
  }
});

ui('trigger only: the single command still goes out after the group stops', async () => {
  const page = await boot({ scale: SCALE });
  try {
  await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['drink'], { stopGroup: true })]) });
  page.output('<span>你覺得口渴。</span>');
  assert.ok(await waitFor(() => count(page, 'drink') === 1, 1000), 'nothing else is active, the command is still sent');
  assert.equal((await practice(page)).on, false);
  assert.equal((await page.ask({ type: 'STATUS' })).running, false, 'the timer was never started');
  } finally {
    page.close();
  }
});

ui('with a hit delay the group stops only once the delayed commands are sent', async () => {
  const page = await boot({ scale: SCALE });
  try {
  await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([keyword('口渴', ['drink', 'eat'], { stopGroup: true })], { delayMax: 1 }) });
  page.output('<span>你覺得口渴。</span>');
  assert.ok(await waitFor(() => count(page, 'eat') === 1, 3000), 'both commands are sent after the delay');
  assert.equal(count(page, 'drink'), 1);
  assert.equal((await practice(page)).on, false);
  } finally {
    page.close();
  }
});

ui('only the flagged rule stops the group; an unflagged rule keeps it running', async () => {
  const page = await boot({ scale: SCALE });
  try {
  await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([
    keyword('口渴', ['drink']),
    keyword('悟到', ['stop'], { stopGroup: true }),
  ]) });
  page.output('<span>你覺得口渴。</span>');
  assert.ok(await waitFor(() => count(page, 'drink') === 1, 1000));
  await sleep(200 / SCALE);
  assert.equal((await practice(page)).on, true, 'the unflagged rule leaves the group running');
  page.output('<span>你悟到了什麼。</span>');
  assert.ok(await waitFor(() => count(page, 'stop') === 1, 1000));
  const state = await practice(page);
  assert.equal(state.on, false, 'the flagged rule stops the group');
  assert.match(state.note, /悟到/);
  } finally {
    page.close();
  }
});

ui('two rules hit by the same text: both commands are sent, the group stops once', async () => {
  const page = await boot({ scale: SCALE });
  try {
  await page.ask({ type: 'START_TRIGGER', group: 'practice', config: config([
    keyword('口渴', ['drink'], { stopGroup: true }),
    keyword('覺得', ['eat']),
  ]) });
  page.output('<span>你覺得口渴。</span>');
  assert.ok(await waitFor(() => count(page, 'drink') === 1 && count(page, 'eat') === 1, 1000), 'the rule that fired in the same pass still sends');
  const state = await practice(page);
  assert.equal(state.on, false);
  assert.match(state.note, /口渴/, 'the note names the rule that stopped the group');
  } finally {
    page.close();
  }
});

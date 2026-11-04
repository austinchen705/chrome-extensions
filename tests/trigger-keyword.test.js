// 關鍵字規則（trigger-engine.js 的 onText）：遊戲輸出分批到、關鍵字可以有好幾行，所以每條規則看「最近幾秒、自己還沒用過的新文字」接起來的結果。
// 防迴圈的三件事（只看新文字、冷卻中的丟掉不補送、> 開頭的回聲略過）要保留，這裡一併檢查。直接測引擎，不需要 jsdom。
const test = require('node:test');
const assert = require('node:assert/strict');

require('../catworld-auto-command/trigger-engine.js');
const Engine = globalThis.CatworldTriggerEngine;

function setup(pattern, { cooldown = 3 } = {}) {
  let clock = 1000000;
  const sent = [];
  const engine = Engine.createEngine(
    { rules: [{ kind: 'keyword', enabled: true, pattern, commands: ['drink'], cooldown }], delayMax: 0, requireNormal: false },
    { now: () => clock, readStat: () => null, isNormal: () => true, send: commands => sent.push(commands), onDisable() {}, random: () => 0 },
  );
  return { engine, sent, advance: ms => { clock += ms; engine.tick(); } };
}

test('a single batch with the keyword fires once', () => {
  const { engine, sent } = setup('口渴');
  engine.onText('你覺得口渴。\n');
  assert.equal(sent.length, 1);
});

test('a keyword split across two batches fires when the second one arrives', () => {
  const { engine, sent, advance } = setup('你覺得口渴');
  engine.onText('你覺');
  assert.equal(sent.length, 0);
  advance(800);
  engine.onText('得口渴。');
  assert.equal(sent.length, 1);
});

test('a multi-line keyword matches whether the output comes in one batch, with the line break gone, or in two batches', () => {
  const pattern = '老虎用爪子往你的頸部一抓！\n結果只是勉強造成一處輕微傷口。';
  const a = setup(pattern);
  a.engine.onText('老虎用爪子往你的頸部一抓！\n結果只是勉強造成一處輕微傷口。\n');
  assert.equal(a.sent.length, 1, 'one batch');
  const b = setup('老虎用爪子往你的頸部一抓！結果只是勉強造成一處輕微傷口。');
  b.engine.onText('老虎用爪子往你的頸部一抓！\n結果只是勉強造成一處輕微傷口。\n');
  assert.equal(b.sent.length, 1, 'a keyword that was flattened to one line');
  const c = setup(pattern);
  c.engine.onText('老虎用爪子往你的頸部一抓！\n');
  assert.equal(c.sent.length, 0, 'the first line alone is not enough');
  c.advance(700);
  c.engine.onText('結果只是勉強造成一處輕微傷口。\n');
  assert.equal(c.sent.length, 1, 'two batches');
});

test('halves that are more than the window apart do not join up', () => {
  const { engine, sent, advance } = setup('你覺得口渴');
  engine.onText('你覺');
  advance(6000);
  engine.onText('得口渴。');
  assert.equal(sent.length, 0);
});

test('the same text does not fire again after the cooldown, only new text does', () => {
  const { engine, sent, advance } = setup('口渴', { cooldown: 3 });
  engine.onText('你覺得口渴。\n');
  assert.equal(sent.length, 1);
  advance(3500);
  engine.onText('別的訊息。\n');
  assert.equal(sent.length, 1, 'the old text is used up');
  engine.onText('你又覺得口渴。\n');
  assert.equal(sent.length, 2);
});

test('text that arrives during the cooldown is dropped, not replayed afterwards, and half of a word from then does not join with the other half', () => {
  const { engine, sent, advance } = setup('你覺得口渴', { cooldown: 3 });
  engine.onText('你覺得口渴。\n');
  advance(1000);
  engine.onText('你覺得口渴。\n');
  advance(2500);
  engine.onText('別的訊息。\n');
  assert.equal(sent.length, 1, 'what came during the cooldown does not fire later');
  const second = setup('你覺得口渴', { cooldown: 3 });
  second.engine.onText('你覺得口渴。\n');
  second.advance(1000);
  second.engine.onText('你覺');
  second.advance(2500);
  second.engine.onText('得口渴。');
  assert.equal(second.sent.length, 1, 'the first half came while it was cooling down and does not count');
});

test('echoes of typed commands (lines starting with >) never count, and never join up with the next batch', () => {
  const { engine, sent } = setup('口渴');
  engine.onText('> say 口渴\n');
  assert.equal(sent.length, 0);
  const split = setup('你覺得口渴');
  split.engine.onText('> say 你覺\n');
  split.engine.onText('得口渴。\n');
  assert.equal(split.sent.length, 0);
});

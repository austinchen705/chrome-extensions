const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractCommands, parseRiddlePage } = require('../tools/zap-parse.js');

const page = file => parseRiddlePage(fs.readFileSync(path.join(__dirname, 'fixtures', 'riddles', file), 'utf8'));

test('extractCommands accepts a command followed by an annotation', () => {
  assert.equal(extractCommands('run e 5n 2o 2se t 7e se 2s e 等[啞僕(YaBa man)]'), 'run e 5n 2o 2se t 7e se 2s e');
  assert.equal(extractCommands('pay上船到桃花島'), 'pay');
  assert.equal(extractCommands('run ne n-->可設點'), 'run ne n');
});

test('extractCommands keeps Chinese arguments of text verbs', () => {
  const ask = 'run e 5n o 2s nw w t w 2n 4w 3u;ask yueh about 令狐沖';
  assert.equal(extractCommands(ask), ask);
  const buy = 'run e 5n 2o se t 2e s e t 2s 4w s;buy 牛皮酒袋;s;give pants to master;give skin to master';
  assert.equal(extractCommands(buy), buy);
  assert.equal(extractCommands('say 是'), 'say 是');
});

test('extractCommands is conservative', () => {
  assert.equal(extractCommands('殺了葉二娘取得小孩'), '');
  assert.equal(extractCommands('發呆看洪七公表演黃狗撒尿，然後就有機會領悟'), '');
  assert.equal(extractCommands('到[楊蓮亭]，ask ting about 自宮;nod ting;ask ting about 手術刀'), '');
  assert.equal(extractCommands('ask thief about 鴛鴦五珍膾、give fish to thief'), '');
  assert.equal(extractCommands('run s 2sw w到[九宮花海青龍界碑] <3>run 2se到[九宮花海白虎界碑]'), '');
  assert.equal(extractCommands('PS.去之前要先找黃蓉ask master about 家書'), '');
  assert.equal(extractCommands(''), '');
});

test('parseRiddlePage reads numbered steps and joins hard-wrapped lines', () => {
  const simple = page('qu4-1.htm');
  assert.equal(simple.steps.length, 5);
  assert.deepEqual(simple.steps[0], { no: 1, text: 'run 2e u;apprentice founder', commands: 'run 2e u;apprentice founder' });
  assert.equal(simple.steps[4].commands, '');
  const sword = page('qu1-1.htm');
  assert.match(sword.steps[1].commands, /give wrapper to master/);
  assert.equal(sword.steps[0].commands, 'run e 5n o 2s nw w t w 2n 4w 3u;ask yueh about 令狐沖');
  assert.equal(sword.steps[7].commands, '');
});

test('parseRiddlePage returns no steps for an unnumbered page but keeps the text', () => {
  const dragon = page('qu2-1.htm');
  assert.deepEqual(dragon.steps, []);
  assert.match(dragon.text, /屠龍刀/);
  assert.match(dragon.text, /run e 5n 2o 2ne/);
});

test('parseRiddlePage ignores the back link and BOM', () => {
  const { text } = page('qu1-1.htm');
  assert.doesNotMatch(text, /回上頁/);
  assert.doesNotMatch(text, /﻿/);
});

test('parseRiddlePage handles a table page', () => {
  const masters = page('qu6-1.htm');
  assert.match(masters.text, /王重陽/);
  assert.deepEqual(masters.steps, []);
});

test('parseRiddlePage keeps same-numbered sections in order', () => {
  const { steps } = page('qu6-3.htm');
  const numbers = steps.map(step => step.no);
  assert.ok(numbers.filter(no => no === 1).length >= 2, `numbers: ${numbers}`);
  assert.match(steps[0].text, /洪凌波/);
});

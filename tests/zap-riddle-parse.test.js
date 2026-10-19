const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractCommands, parseRiddlePage, parseRiddleIndex, parseRiddleMenu, buildRiddles } = require('../tools/zap-parse.js');

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

const read = file => fs.readFileSync(path.join(__dirname, 'fixtures', 'riddles', file), 'utf8');

test('parseRiddleIndex reads every riddle with its category', () => {
  const index = parseRiddleIndex(read('qu1.htm'));
  assert.equal(index.length, 46);
  const sword = index.find(entry => entry.name === '獨孤九劍');
  assert.deepEqual(sword, { category: '技能類', name: '獨孤九劍', condition: '內力 300 [天賦]', hint: '如何得到風清揚前輩認同？', difficulty: '極易', reward: '學會此技能' });
  assert.equal(index.find(entry => entry.name === '混元魔刀').condition, '150 萬 EXP [註]');
  assert.equal(index.find(entry => entry.name === '拜師').difficulty, '????');
  const counts = {};
  index.forEach(entry => { counts[entry.category] = (counts[entry.category] || 0) + 1; });
  assert.deepEqual(counts, { 技能類: 9, 治裝類: 18, 道具類: 7, 寵物類: 2, 其他類: 10 });
});

test('parseRiddleMenu reads the menu without the list page', () => {
  const menu = parseRiddleMenu(read('list.html'));
  assert.equal(menu.length, 46);
  assert.ok(menu.some(entry => entry.category === '技能類' && entry.file === 'qu1-1.htm' && entry.name === '獨孤九劍'));
  assert.ok(!menu.some(entry => entry.file === 'qu1.htm'));
  assert.equal(menu.filter(entry => entry.file === 'qu1-5.htm').length, 3);
});

const fixturePages = () => Object.fromEntries(['qu1-1.htm', 'qu1-4.htm', 'qu1-5.htm', 'qu2-1.htm', 'qu4-1.htm', 'qu6-1.htm', 'qu6-3.htm'].map(file => [file, read(file)]));

test('buildRiddles joins the index to the menu pages with aliases', () => {
  const { riddles, pages, report } = buildRiddles({ indexHtml: read('qu1.htm'), menuHtml: read('list.html'), pageHtml: fixturePages() });
  const byName = name => riddles.find(riddle => riddle.name === name);
  assert.equal(riddles.length, 46);
  assert.equal(byName('獨孤九劍').page, 'qu1-1.htm');
  assert.equal(byName('獨孤九劍').id, '技能類/獨孤九劍');
  assert.equal(byName('習得凌波微步').page, 'qu1-4.htm');
  assert.equal(byName('燕子鄔').page, 'qu3-3.htm');
  assert.equal(byName('唐伯虎的困擾').page, 'qu3-7.htm');
  assert.equal(byName('靈鷲宮的委託').page, 'qu2-10.htm');
  assert.deepEqual(byName('玉蕭劍法').shared, ['彈指神通', '糖果']);
  assert.equal(pages['qu4-1.htm'].steps.length, 5);
  assert.ok(riddles.every(riddle => riddle.page !== null));
  assert.ok(report.some(line => line.includes('沒有 HTML') && line.includes('qu3-3.htm')));
  assert.ok(!report.some(line => line.startsWith('總表有、選單沒有') || line.startsWith('選單有、沒被使用')));
});

test('buildRiddles reports an index riddle with no menu entry', () => {
  const menuHtml = read('list.html').replace('獨孤九劍', '完全不同的名字');
  const { riddles, report } = buildRiddles({ indexHtml: read('qu1.htm'), menuHtml, pageHtml: fixturePages() });
  assert.equal(riddles.find(riddle => riddle.name === '獨孤九劍').page, null);
  assert.ok(report.some(line => line.startsWith('總表有、選單沒有') && line.includes('獨孤九劍')));
  assert.ok(report.some(line => line.startsWith('選單有、沒被使用') && line.includes('完全不同的名字')));
});

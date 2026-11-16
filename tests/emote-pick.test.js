// 隨機表情的抽組合（emote-pick.js）與內建資料（emote-data.js）：用真實資料、固定或可重現的亂數，檢查每一條抽法規則。
// 抽出來的組合「自然不自然」只能人看（.scratch/semote/samples-d.txt 是使用者看過的範例），這裡只擋客觀規則。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'catworld-auto-command');
require(path.join(dir, 'emote-data.js'));
require(path.join(dir, 'emote-pick.js'));
const DATA = globalThis.CatworldEmoteData;
const M = globalThis.CatworldEmote;
const info = new Map(DATA.map(([command, category, order, alone]) => [command, { category, order, alone }]));

// 可重現的亂數
const seeded = seed => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const many = (count, fn) => { const random = seeded(7); return Array.from({ length: count }, () => fn(random)); };

test('emote-data.js has exactly the emotes of docs/data/semotes.tsv (run node tools/gen-emote-data.js after editing the TSV)', () => {
  const rows = fs.readFileSync(path.join(__dirname, '..', 'docs', 'data', 'semotes.tsv'), 'utf8').replace(/\r\n/g, '\n').split('\n').filter(Boolean).slice(1).map(line => line.split('\t'));
  assert.equal(DATA.length, rows.length);
  assert.deepEqual(DATA.map(([command, category, order, alone]) => [command, category, order === null ? '' : String(order), alone ? '是' : '']), rows.map(([command, , category, order, alone]) => [command, category, order, alone]));
  ['what', 'wait', 'sorry', 'comfort', 'nothx'].forEach(command => assert.equal(info.get(command).category, '不用', command));
  ['sleep', 'home', 'hit', 'flee'].forEach(command => assert.ok(!info.has(command), `${command} may be a real command`));
});

test('a group never has an unusable emote, one that needs a target, or a greeting / cheering one (nobody is around)', () => {
  many(3000, random => M.pick({ random })).forEach(({ commands }) => commands.forEach(command => {
    assert.ok(info.has(command), command);
    assert.ok(!['不用', '要對象', '招呼', '加油'].includes(info.get(command).category), `${command} is ${info.get(command).category}`);
  }));
});

test('a dramatic or scene-bound emote only comes alone, and only when the first roll is under 5%', () => {
  const groups = many(3000, random => M.pick({ random }));
  groups.forEach(({ commands }) => {
    if (commands.some(command => info.get(command).alone)) assert.equal(commands.length, 1, commands.join(','));
  });
  const alone = groups.filter(({ commands }) => info.get(commands[0]).alone).length;
  assert.ok(alone > 60 && alone < 250, `${alone} of 3000 groups were a rare emote`);
  const sequence = values => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
  const rare = M.pick({ random: sequence([0.01, 0.3]) });
  assert.equal(rare.commands.length, 1);
  assert.ok(info.get(rare.commands[0]).alone, 'a first roll under 0.05 picks a rare one');
  assert.ok(!M.pick({ random: () => 0.06 }).commands.some(command => info.get(command).alone), 'not at 0.06');
});

test('a group is 1 to 3 emotes close together on the order list, sorted by it; clowning is one at a time', () => {
  const sizes = new Set();
  many(3000, random => M.pick({ random })).forEach(({ category, commands }) => {
    sizes.add(commands.length);
    assert.ok(commands.length >= 1 && commands.length <= 3);
    assert.equal(new Set(commands).size, commands.length, 'no repeats inside a group');
    if (category === '耍寶') return assert.equal(commands.length, 1);
    const orders = commands.map(command => info.get(command).order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b), `sorted: ${commands}`);
    assert.ok(Math.max(...orders) - Math.min(...orders) <= 2 * M.WINDOW, `close: ${commands}`);
  });
  assert.deepEqual([...sizes].sort(), [1, 2, 3]);
});

test('every emote in a group is within WINDOW of the first one picked, and from its category or a near one', () => {
  const NEAR = { 累: ['累', '動作'], 動作: ['動作', '累'], 開心: ['開心', '大笑'], 大笑: ['大笑', '開心'], 無奈: ['無奈'], 耍寶: ['耍寶'] };
  const LIGHT = ['sigh', 'shrug', 'shake', 'headshake'];
  many(3000, random => M.pick({ random })).forEach(({ category, commands }) => {
    if (commands.length === 1 && info.get(commands[0]).alone) return;
    assert.ok(commands.some(command => info.get(command).category === category), `${category}: ${commands}`);
    commands.forEach(command => {
      const own = info.get(command).category;
      if (category === '思考') assert.ok(own === '思考' || LIGHT.includes(command), `thinking only takes the light sighs: ${commands}`);
      else assert.ok(NEAR[category].includes(own), `${category} takes ${command} (${own})`);
    });
  });
});

test('the emotes of the last two groups are left out, unless nothing else is left in that category', () => {
  const recent = ['yawn', 'zzz', 'lazy', 'smile', 'think'];
  many(2000, random => M.pick({ random, recent })).forEach(({ commands }) => commands.forEach(command => assert.ok(!recent.includes(command), command)));
  const thinking = DATA.filter(([, category]) => category === '思考').map(([command]) => command);
  const sequence = values => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
  // 0.5＝不是罕見；第二個數抽到思考類（權重表裡累 4、動作 3 之後就是思考 3：(7 + 1.5) / 16）
  const fallback = M.pick({ random: sequence([0.5, 8.5 / 16, 0.5, 0.5]), recent: thinking });
  assert.equal(fallback.category, '思考');
  assert.ok(fallback.commands.length >= 1, 'with every thinking emote recent it still picks one');
});

test('the gap inside a group is a whole number of seconds from 2 to 10, and the macro text waits that long', () => {
  assert.equal(M.gapSec(() => 0), 2);
  assert.equal(M.gapSec(() => 0.999999), 10);
  const seen = new Set(many(2000, random => M.gapSec(random)));
  assert.deepEqual([...seen].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(M.macroText(['yawn'], () => 0), 'yawn');
  assert.equal(M.macroText(['lazy', 'yawn', 'zzz'], () => 0.5), 'lazy;@等待 6;yawn;@等待 6;zzz');
});

test('the settings are off with a 5% chance unless stored otherwise, and a bad chance falls back', () => {
  assert.deepEqual(M.normalizeSettings(undefined), { enabled: false, chance: 5 });
  assert.deepEqual(M.normalizeSettings({ enabled: 'yes', chance: '7' }), { enabled: false, chance: 7 });
  assert.deepEqual(M.normalizeSettings({ enabled: true, chance: 0 }), { enabled: true, chance: 0 });
  assert.deepEqual(M.normalizeSettings({ enabled: true, chance: 100 }), { enabled: true, chance: 100 });
  [-1, 101, '', 'abc', null, NaN].forEach(chance => assert.equal(M.normalizeSettings({ chance }).chance, 5, String(chance)));
  assert.equal(M.normalizeSettings({ chance: 2.5 }).chance, 2.5);
  assert.ok(M.MIN_GAP_MS >= 10 * 60 * 1000 && M.WARMUP_MS >= 5 * 60 * 1000 && M.ROLL_MS === 60 * 1000);
});

const test = require('node:test');
const assert = require('node:assert/strict');
require('../catworld-auto-command/zap-items.js');

const I = globalThis.CatworldZapItems;
const item = (name, level, extra = {}) => ({ name, level, note: '', weapon: '', ...extra });

test('findIdentified reads the sentences after the hand-over line', () => {
  const state = { handedAt: null };
  const text = '你拿著奇形怪狀的物品給衰老頭看了一下...\n衰老頭給你一隻奶茶兔吊飾。\n';
  assert.deepEqual(I.findIdentified(text, 1000, state), ['一隻奶茶兔吊飾']);
  assert.equal(state.handedAt, 1000);
});

test('findIdentified ignores the sentence without the hand-over line', () => {
  assert.deepEqual(I.findIdentified('衰老頭給你一尊明朝古董木雕。', 1000, { handedAt: null }), []);
});

test('findIdentified remembers the hand-over across batches and expires after 60s', () => {
  const state = { handedAt: null };
  assert.deepEqual(I.findIdentified('你拿著老舊物品給衰老頭看了一下...', 0, state), []);
  assert.deepEqual(I.findIdentified('衰老頭給你一尊明朝古董木雕。', 30000, state), ['一尊明朝古董木雕']);
  assert.deepEqual(I.findIdentified('衰老頭給你一尊明朝古董木雕。', 70000, state), []);
});

test('findIdentified handles several sentences in one batch', () => {
  const text = '你拿著奇形怪狀的物品給衰老頭看了一下...\n衰老頭給你一隻奶茶兔吊飾。\n衰老頭給你一尊明朝古董木雕。\n';
  assert.deepEqual(I.findIdentified(text, 5, { handedAt: null }), ['一隻奶茶兔吊飾', '一尊明朝古董木雕']);
});

test('itemKey drops parentheses and whitespace', () => {
  assert.equal(I.itemKey('劍鑄模 (二洞)'), I.itemKey('劍鑄模'));
  assert.equal(I.itemKey('劍鑄模（二洞）'), I.itemKey('劍鑄模'));
  assert.equal(I.itemKey('千年 雪蛛 岩'), '千年雪蛛岩');
});

test('matchItems picks the longest contained name', () => {
  const items = [item('木雕', 1), item('明朝古董木雕', 1)];
  assert.deepEqual(I.matchItems(items, '一尊明朝古董木雕').map(x => x.name), ['明朝古董木雕']);
});

test('matchItems lists every variant when the game omits the hole count', () => {
  const items = [item('劍鑄模 (一洞)', 2), item('劍鑄模 (二洞)', 3), item('劍鑄模 (三洞)', 4)];
  assert.equal(I.matchItems(items, '一個劍鑄模').length, 3);
});

test('matchItems returns nothing for an unknown item', () => {
  assert.deepEqual(I.matchItems([item('木雕', 1)], '一個不存在的東西'), []);
});

test('advise by level', () => {
  [1, 2].forEach(level => assert.equal(I.advise(item('x', level), '').action, 'sell'));
  [3, 5].forEach(level => assert.equal(I.advise(item('x', level), '').action, 'keep'));
});

test('advise fit beats level', () => {
  const sword = item('劍鑄模 (一洞)', 2, { weapon: '劍' });
  const fit = I.advise(sword, '劍');
  assert.equal(fit.action, 'fit');
  assert.equal(fit.text, '適合你，建議留著');
  assert.equal(I.advise(sword, '刀').action, 'sell');
});

test('advise ignores an unset or invalid mainWeapon', () => {
  const sword = item('劍鑄模 (一洞)', 2, { weapon: '劍' });
  ['', undefined, '法師'].forEach(weapon => assert.equal(I.advise(sword, weapon).action, 'sell'));
  assert.equal(I.advise(item('x', 4), '拳套').action, 'keep');
});

test('describeIdentified marks an unknown item with no candidates', () => {
  const [result] = I.describeIdentified([item('木雕', 1)], ['一個不存在的東西'], '');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.sentence, '一個不存在的東西');
});

test('handleMessage answers ZAP_ITEM and ignores other types', () => {
  const items = [item('明朝古董木雕', 1)];
  const reply = I.handleMessage(items, { type: 'ZAP_ITEM', sentences: ['一尊明朝古董木雕'], mainWeapon: '劍' });
  assert.equal(reply.ok, true);
  assert.equal(reply.results[0].candidates[0].advice.action, 'sell');
  assert.equal(I.handleMessage(items, { type: 'ZAP_SUITABLE' }), null);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseZapMobHtml, parseNewstartHtml, parseUnknownObjectHtml, applyItemOverrides, mergeSources, applyOverrides, parseRoutesHtml } = require('../tools/zap-parse.js');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const zap = () => parseZapMobHtml(fixture('ot1-sample.html'));
const newstart = () => parseNewstartHtml(fixture('newstart3-sample.html'));
const byName = (mobs, name) => mobs.filter(mob => mob.name === name);

test('parseZapMobHtml reads rows, skips the header and decodes entities', () => {
  const mobs = zap();
  assert.equal(mobs.length, 8);
  const king = byName(mobs, '橫霸四方 忽必烈(king)')[0];
  assert.equal(king.exp, 250000);
  assert.equal(king.location, '蒙古');
  assert.equal(king.id, 'king');
  assert.equal(king.note, '');
  assert.equal(king.source, 'zap');
  const weird = byName(mobs, '怪異(weird)')[0];
  assert.equal(weird.exp, null);
  assert.equal(weird.note, 'A & B');
});

test('parseNewstartHtml reads name, value and ranges', () => {
  const mobs = newstart();
  assert.equal(mobs.length, 7);
  const taoist = byName(mobs, '第四代全真弟子(Alltruth taoist)')[0];
  assert.equal(taoist.exp, 2000);
  assert.equal(taoist.note, '肉腳，練好玩的');
  assert.equal(taoist.location, '');
  assert.equal(taoist.source, 'newstart');
  const turtle = byName(mobs, '火龜(fire turtle)')[0];
  assert.deepEqual([turtle.expMin, turtle.expMax, turtle.exp], [40000, 50000, 50000]);
  const bandit = byName(mobs, '土匪(bandit)')[0];
  assert.deepEqual([bandit.expMin, bandit.expMax], [3000, 6000]);
});

test('mergeSources keeps newstart-only mobs and resolves conflicts to the larger value', () => {
  const { mobs, conflicts } = mergeSources(zap(), newstart());
  const taoist = byName(mobs, '第四代全真弟子(Alltruth taoist)');
  assert.equal(taoist.length, 1);
  assert.equal(taoist[0].location, '');
  const tiger = byName(mobs, '老虎(tiger)');
  assert.equal(tiger.length, 1);
  assert.equal(tiger[0].exp, 105000);
  assert.deepEqual(tiger[0].otherExp, [500]);
  assert.ok(conflicts.some(line => line.includes('老虎')));
  assert.equal(byName(mobs, '後宮之最 貴夫人(lady)')[0].exp, 100000);
  assert.equal(byName(mobs, '虎頭人(tiger man)')[0].exp, 45000);
  assert.equal(byName(mobs, '火龜(fire turtle)').length, 1);
});

test('mergeSources keeps every zap row when the name has several and logs the difference', () => {
  const { mobs, conflicts } = mergeSources(zap(), newstart());
  const ghosts = byName(mobs, '食魂獸(eat ghost)');
  assert.deepEqual(ghosts.map(mob => mob.exp).sort(), [70000, 75000]);
  assert.ok(conflicts.some(line => line.includes('食魂獸')));
});

test('mergeSources matches names case-insensitively', () => {
  const upper = { ...zap()[0], name: 'Alltruth taoist(Alltruth taoist)', id: 'alltruth taoist', exp: 3000 };
  const lower = { ...newstart()[0], name: 'alltruth taoist(alltruth taoist)', id: 'alltruth taoist' };
  const { mobs } = mergeSources([upper], [lower]);
  assert.equal(mobs.length, 1);
});

test('applyOverrides adds a same-name mob at another location', () => {
  const { mobs } = mergeSources(zap(), newstart());
  const result = applyOverrides(mobs, [{ name: '老虎(tiger)', location: '長安城', exp: 500 }]);
  assert.deepEqual(result.problems, []);
  const tigers = byName(result.mobs, '老虎(tiger)');
  assert.equal(tigers.length, 2);
  assert.equal(tigers.find(mob => mob.location === '桃花島').exp, 105000);
  const added = tigers.find(mob => mob.location === '長安城');
  assert.equal(added.exp, 500);
  assert.equal(added.source, 'override');
});

test('applyOverrides overrides the only mob with that name', () => {
  const { mobs } = mergeSources(zap(), newstart());
  const result = applyOverrides(mobs, [{ name: '虎頭人(tiger man)', exp: 46000 }]);
  assert.deepEqual(result.problems, []);
  assert.equal(byName(result.mobs, '虎頭人(tiger man)')[0].exp, 46000);
});

test('applyOverrides reports ambiguous names without changing anything', () => {
  const { mobs } = mergeSources(zap(), newstart());
  const before = JSON.stringify(mobs);
  const result = applyOverrides(mobs, [{ name: '食魂獸(eat ghost)', exp: 1 }]);
  assert.equal(result.problems.length, 1);
  assert.equal(JSON.stringify(result.mobs), before);
});

test('applyOverrides adds a mob that neither source has and notes it', () => {
  const { mobs } = mergeSources(zap(), newstart());
  const result = applyOverrides(mobs, [{ name: '新怪(newbie)', exp: 123, note: '手動' }]);
  assert.deepEqual(result.problems, []);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /新怪\(newbie\)/);
  const added = byName(result.mobs, '新怪(newbie)');
  assert.equal(added.length, 1);
  assert.deepEqual([added[0].exp, added[0].location, added[0].source], [123, '', 'override']);
});

const items = () => parseUnknownObjectHtml(fixture('ub-sample.html'));
const itemNamed = name => items().find(entry => entry.name === name);

test('parseUnknownObjectHtml reads junk names from the first table', () => {
  assert.deepEqual(itemNamed('明朝古董木雕'), { name: '明朝古董木雕', level: 1, note: '', weapon: '' });
  assert.equal(itemNamed('奶茶兔吊飾').level, 1);
});

test('parseUnknownObjectHtml reads moulds with their function', () => {
  assert.deepEqual(itemNamed('劍鑄模 (二洞)'), { name: '劍鑄模 (二洞)', level: 3, note: '鑄造所需使用的模子', weapon: '劍' });
  assert.deepEqual([itemNamed('杖鑄模 (四洞)').level, itemNamed('杖鑄模 (四洞)').weapon], [4, '杖']);
  assert.equal(itemNamed('鏢鑄模 (一洞)').weapon, '暗器');
  assert.equal(itemNamed('指環鑄模 (一洞)').weapon, '');
});

test('parseUnknownObjectHtml maps whip materials by name or function', () => {
  const skin = itemNamed('海龍皮');
  assert.equal(skin.level, 2);
  assert.equal(skin.weapon, '鞭');
  assert.match(skin.note, /鞭子/);
  assert.equal(itemNamed('獸骨鞭柄 (二洞)').weapon, '鞭');
});

test('parseUnknownObjectHtml reads gems with their effects', () => {
  const relic = itemNamed('龍宮舍利');
  assert.equal(relic.level, 5);
  assert.match(relic.note, /內功 \+12/);
  assert.match(itemNamed('瑪瑙皇').note, /會心 \+1/);
});

test('parseUnknownObjectHtml has no fist items and joins names split by spans', () => {
  const all = items();
  assert.ok(!all.some(entry => entry.weapon === '拳套'));
  const spider = all.find(entry => entry.name.includes('雪蛛'));
  assert.ok(spider);
  assert.doesNotMatch(spider.name, /[|\n]/);
});

test('parseUnknownObjectHtml covers all five levels', () => {
  const all = items();
  assert.deepEqual([...new Set(all.map(entry => entry.level))].sort(), [1, 2, 3, 4, 5]);
  assert.equal(all.length, 94);
});

test('applyItemOverrides patches an existing item and adds a new one', () => {
  const base = items();
  const spider = base.find(entry => entry.name.includes('雪蛛'));
  const result = applyItemOverrides(base, [
    { item: spider.name, weapon: '劍' },
    { item: '新物(brand new)', level: 3, note: '手動' },
  ]);
  assert.deepEqual(result.problems, []);
  assert.equal(result.items.find(entry => entry.name === spider.name).weapon, '劍');
  assert.equal(result.items.find(entry => entry.name === spider.name).level, spider.level);
  assert.deepEqual(result.items.find(entry => entry.name === '新物(brand new)'), { name: '新物(brand new)', level: 3, note: '手動', weapon: '' });
  assert.equal(result.items.length, base.length + 1);
  assert.equal(base.find(entry => entry.name === spider.name).weapon === '劍', false, 'the input list is not mutated');
});

test('applyItemOverrides reports an unknown item without a level and an invalid weapon', () => {
  const base = items();
  const result = applyItemOverrides(base, [{ item: '不存在的東西' }, { item: '明朝古董木雕', weapon: '法師' }]);
  assert.equal(result.problems.length, 2);
  assert.equal(result.items.length, base.length);
  assert.equal(result.items.find(entry => entry.name === '明朝古董木雕').weapon, '');
});

const routesHtml = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'routes', 'map.15.html'), 'utf8');

test('parseRoutesHtml reads every place with its run path', () => {
  const routes = parseRoutesHtml(routesHtml());
  assert.equal(routes.length, 64);
  const byName = name => routes.find(route => route.name === name);
  assert.equal(byName('長安').path, '2t');
  assert.equal(byName('蒙古').path, 't 4n 2w t');
  assert.equal(byName('華山').path, 't 2s nw w t');
  assert.equal(byName('終南山').path, 't 2s e s t 3sw 2su wu 2su wu w');
});

test('parseRoutesHtml drops the riddle marker from the path and keeps it as a flag', () => {
  const grave = parseRoutesHtml(routesHtml()).find(route => route.name === '古墓派');
  assert.equal(grave.path, 't s e 2s t 3sw 2su wu s 2w');
  assert.equal(grave.riddle, true);
  assert.equal(parseRoutesHtml(routesHtml()).find(route => route.name === '華山').riddle, false);
});

test('parseRoutesHtml never returns a state heading or an empty path', () => {
  const routes = parseRoutesHtml(routesHtml());
  assert.ok(routes.every(route => !route.name.includes('﹕') && !route.name.includes('map.')));
  assert.ok(routes.every(route => /^[0-9a-z ]+$/i.test(route.path) && route.path.length > 0));
});

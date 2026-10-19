const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseZapMobHtml, parseNewstartHtml, mergeSources, applyOverrides } = require('../tools/zap-parse.js');

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

test('applyOverrides reports ambiguous and missing names without changing anything', () => {
  const { mobs } = mergeSources(zap(), newstart());
  const before = JSON.stringify(mobs);
  const result = applyOverrides(mobs, [
    { name: '食魂獸(eat ghost)', exp: 1 },
    { name: '不存在(nobody)', exp: 1 },
  ]);
  assert.equal(result.problems.length, 2);
  assert.equal(JSON.stringify(result.mobs), before);
});

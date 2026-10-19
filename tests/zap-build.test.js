const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildData } = require('../tools/zap-parse.js');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const input = overrides => ({
  zapHtml: fixture('ot1-sample.html'),
  newstartHtml: fixture('newstart3-sample.html'),
  overrides,
});

test('buildData rejects a source that parses to suspiciously few rows', () => {
  assert.throws(() => buildData(input([])), /來源解析異常/);
});

test('buildData rejects an empty source', () => {
  assert.throws(() => buildData({ ...input([]), zapHtml: '<html></html>' }, { minZap: 1, minNewstart: 1 }), /來源解析異常/);
});

test('buildData merges both sources and applies overrides', () => {
  const overrides = [{ name: '老虎(tiger)', location: '長安城', exp: 500 }];
  const { data, report, problems } = buildData(input(overrides), { minZap: 1, minNewstart: 1 });
  assert.deepEqual(problems, []);
  assert.ok(data.mobs.some(mob => mob.name === '第四代全真弟子(Alltruth taoist)' && mob.exp === 2000));
  const tigers = data.mobs.filter(mob => mob.name === '老虎(tiger)');
  assert.deepEqual(tigers.map(mob => [mob.location, mob.exp]).sort(), [['桃花島', 105000], ['長安城', 500]]);
  assert.ok(Array.isArray(data.sources) && data.sources.length === 2);
  assert.ok(report.some(line => line.includes('老虎')));
});

test('buildData includes items when ubHtml is given', () => {
  const ubHtml = fixture('ub-sample.html');
  const { data } = buildData({ ...input([]), ubHtml }, { minZap: 1, minNewstart: 1 });
  assert.equal(data.items.length, 94);
  assert.equal(data.sources.length, 3);
});

test('buildData rejects an ub page that parses to too few items', () => {
  assert.throws(() => buildData({ ...input([]), ubHtml: '<html></html>' }, { minZap: 1, minNewstart: 1 }), /來源解析異常/);
});

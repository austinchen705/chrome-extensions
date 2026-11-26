// 六脈神劍（落魄書生）的判讀（純函式）。樣本是遊戲的真實輸出（tests/fixtures/scholar/）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require(path.join(__dirname, '..', '..', 'catworld-auto-command', 'scholar.js'));
const S = globalThis.CatworldScholar;

const sample = name => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'scholar', `${name}.txt`), 'utf8');

test('parseSpirit reads the spirit number from sc', () => {
  assert.equal(S.parseSpirit(sample('sc-spirit-31')), 31);
  assert.equal(S.parseSpirit(sample('sc-spirit-20')), 20);
  assert.equal(S.parseSpirit('沒有這一行'), null);
});

test('parseSkillCount reads the count on the first line and whether six-vein-sword is listed', () => {
  assert.deepEqual(S.parseSkillCount(sample('sk-28')), { count: 28, hasSixVein: false });
  assert.deepEqual(S.parseSkillCount(sample('sk-29-has-six-vein')), { count: 29, hasSixVein: true });
  assert.equal(S.parseSkillCount(''), null);
});

test('without six-vein the skill count may be at most the spirit; over by one means abandon 1', () => {
  assert.deepEqual(S.canStart({ spirit: 28, skills: 28, hasSixVein: false }), { ok: true, limit: 28, abandon: 0 });
  assert.deepEqual(S.canStart({ spirit: 28, skills: 29, hasSixVein: false }), { ok: false, limit: 28, abandon: 1 });
  assert.deepEqual(S.canStart({ spirit: 20, skills: 28, hasSixVein: false }), { ok: false, limit: 20, abandon: 8 });
});

test('with six-vein the limit is spirit + 1', () => {
  assert.deepEqual(S.canStart({ spirit: 28, skills: 29, hasSixVein: true }), { ok: true, limit: 29, abandon: 0 });
  assert.deepEqual(S.canStart({ spirit: 28, skills: 30, hasSixVein: true }), { ok: false, limit: 29, abandon: 1 });
});

test('real samples: spirit 31 with 28 skills and spirit 20 with 29 skills', () => {
  const sk28 = S.parseSkillCount(sample('sk-28'));
  const sk29 = S.parseSkillCount(sample('sk-29-has-six-vein'));
  assert.equal(S.canStart({ spirit: S.parseSpirit(sample('sc-spirit-31')), skills: sk28.count, hasSixVein: sk28.hasSixVein }).ok, true);
  assert.deepEqual(S.canStart({ spirit: S.parseSpirit(sample('sc-spirit-20')), skills: sk29.count, hasSixVein: sk29.hasSixVein }), { ok: false, limit: 21, abandon: 8 });
});

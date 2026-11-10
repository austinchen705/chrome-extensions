// 設定備份（匯出）：區塊定義與 exportData 的外部行為，以及「每個儲存鍵都要被分類」的守門。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'catworld-auto-command');
require('../catworld-auto-command/settings-backup.js');
const B = globalThis.CatworldSettingsBackup;

const FIXED_NOW = Date.UTC(2026, 10, 10, 1, 2, 3);
const store = {
  settings: { fixedItems: [{ command: 'ps', minSeconds: 5, maxSeconds: 9 }] },
  idleSettings: { everyMin: 1 },
  triggerGroupSettings: { combat: { rules: [] } },
  zapFeatures: { mobs: true },
  mapMonsters: { 'a/1': { mobs: ['x(1)'] } },
  lineNotify: { enabled: true, token: 'SECRET-TOKEN', userId: 'U123' },
  captchaSampleUrl: 'https://script.google.com/macros/s/abc/exec',
  running: true,
  sharedCache: { mob: {} },
  popupFolds: { 'sec-chat': true },
  settingsBackup: { old: 1 },
  somethingUnknown: 1,
};

test('the export has the format marker, version and only classified keys', () => {
  const data = B.exportData(store, { version: '1.2.3', now: FIXED_NOW });
  assert.equal(data.format, 'catworld-settings');
  assert.equal(data.version, 1);
  assert.equal(data.exportedWith, '1.2.3');
  assert.equal(data.exportedAt, new Date(FIXED_NOW).toISOString());
  const keys = Object.values(data.blocks).flatMap(block => Object.keys(block));
  assert.ok(keys.includes('settings') && keys.includes('mapMonsters'));
  for (const never of ['running', 'sharedCache', 'popupFolds', 'settingsBackup', 'somethingUnknown', 'lineNotify', 'captchaSampleUrl']) {
    assert.ok(!keys.includes(never), `${never} must not be exported by default`);
  }
  assert.equal(data.secrets, undefined);
  assert.ok(!JSON.stringify(data).includes('SECRET-TOKEN'));
});

test('values are copied as they are and absent keys are left out', () => {
  const data = B.exportData(store, { version: '1', now: FIXED_NOW });
  const all = Object.assign({}, ...Object.values(data.blocks));
  assert.deepEqual(all.settings, store.settings);
  assert.ok(!('chatReply' in all), 'a key that was never saved is not invented');
  all.settings.fixedItems.length = 0;
  assert.equal(store.settings.fixedItems.length, 1, 'the export is a copy, not the stored object');
});

test('blocks can be picked; an unknown id is ignored', () => {
  const data = B.exportData(store, { blocks: ['trigger', 'nope'], version: '1', now: FIXED_NOW });
  assert.deepEqual(Object.keys(data.blocks), ['trigger']);
  assert.deepEqual(Object.keys(data.blocks.trigger), ['triggerGroupSettings']);
  assert.deepEqual(Object.keys(B.exportData(store, { blocks: [], version: '1', now: FIXED_NOW }).blocks), []);
});

test('secrets are only written when asked for', () => {
  const data = B.exportData(store, { secrets: true, version: '1', now: FIXED_NOW });
  assert.equal(data.secrets.lineNotify.token, 'SECRET-TOKEN');
  assert.equal(data.secrets.captchaSampleUrl, store.captchaSampleUrl);
  const none = B.exportData({ settings: {} }, { secrets: true, version: '1', now: FIXED_NOW });
  assert.deepEqual(none.secrets, {}, 'asked for, nothing saved → empty object');
});

test('exportText is pretty JSON that parses back to the same data', () => {
  const text = B.exportText(store, { version: '1', now: FIXED_NOW });
  assert.match(text, /\n {2}"format": "catworld-settings"/);
  assert.deepEqual(JSON.parse(text), B.exportData(store, { version: '1', now: FIXED_NOW }));
});

test('block ids are unique, every key belongs to one place, and the lists do not overlap', () => {
  const ids = B.BLOCKS.map(block => block.id);
  assert.equal(new Set(ids).size, ids.length);
  const all = [...B.BLOCKS.flatMap(block => block.keys), ...B.SECRET_KEYS, ...B.EXCLUDED_KEYS];
  assert.equal(new Set(all).size, all.length, 'a key is in exactly one list');
  assert.ok(B.BLOCKS.every(block => block.label && block.keys.length > 0));
});

// 守門：原始碼裡用到的 chrome.storage 鍵，一定要在「區塊」、「機密」或「排除」其中一份；新增鍵時會被迫決定。
function usedKeys() {
  const found = new Map();
  const add = (key, file) => { if (/^[A-Za-z][A-Za-z0-9]*$/.test(key)) found.set(key, file); };
  for (const file of fs.readdirSync(root).filter(name => name.endsWith('.js') && name !== 'skills-data.js' && name !== 'settings-backup.js')) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/const\s+[A-Z_]*KEY[A-Z_]*\s*=\s*'([A-Za-z0-9]+)'/g)) add(match[1], file);
    for (const match of source.matchAll(/storage\.(?:local|session)\.(?:get|remove)\(\s*'([A-Za-z0-9]+)'/g)) add(match[1], file);
    for (const match of source.matchAll(/storage\.(?:local|session)\.(?:get|remove)\(\s*\[([^\]]*)\]/g)) {
      for (const item of match[1].matchAll(/'([A-Za-z0-9]+)'/g)) add(item[1], file);
    }
    for (const match of source.matchAll(/storage\.(?:local|session)\.set\(\s*\{/g)) {
      // 只取物件最外層的鍵（巢狀的 { enabled, words } 不算）
      let depth = 1;
      let top = '';
      for (let i = match.index + match[0].length; i < source.length && depth > 0; i += 1) {
        const char = source[i];
        if (char === '{' || char === '[' || char === '(') depth += 1;
        else if (char === '}' || char === ']' || char === ')') depth -= 1;
        else if (depth === 1) top += char;
      }
      for (const item of top.matchAll(/(?:^|,)\s*([A-Za-z][A-Za-z0-9]*)\s*:/g)) add(item[1], file);
    }
  }
  return found;
}

test('every storage key the source uses is classified (block, secret or excluded)', () => {
  const known = new Set([...B.BLOCKS.flatMap(block => block.keys), ...B.SECRET_KEYS, ...B.EXCLUDED_KEYS]);
  const missing = [...usedKeys()].filter(([key]) => !known.has(key)).map(([key, file]) => `${key} (${file})`);
  assert.deepEqual(missing, [], '新增的儲存鍵要放進 settings-backup.js 的區塊、機密或排除清單');
});

// ---- 匯入：整份檢查與覆蓋計畫 ----
const exported = (extra = {}) => ({ format: 'catworld-settings', version: 1, exportedWith: '1.0.0', exportedAt: '2026-11-10T00:00:00.000Z', blocks: {}, ...extra });
const check = value => B.checkImport(typeof value === 'string' ? value : JSON.stringify(value));

test('checkImport rejects text that is not a settings backup, saying what is wrong', () => {
  assert.match(check('not json').error, /JSON/);
  assert.match(check('[]').error, /物件/);
  assert.match(check('null').error, /物件/);
  assert.match(check({ version: 1, blocks: {} }).error, /不是設定備份/);
  assert.match(check({ format: 'catworld-macros', version: 1, blocks: {} }).error, /不是設定備份/);
  assert.match(check(exported({ version: 2 })).error, /更新擴充功能/);
  assert.match(check(exported({ version: 0 })).error, /version/);
  assert.match(check(exported({ blocks: [] })).error, /blocks/);
  assert.match(check(exported({ blocks: 'x' })).error, /blocks/);
  assert.equal(check('x'.repeat(B.MAX_TEXT + 1)).ok, false);
});

test('checkImport rejects the whole file when any known block or key is malformed, naming the block and key', () => {
  const bad = check(exported({ blocks: { timer: { settings: {} }, trigger: [] } }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /觸發/);
  const nullValue = check(exported({ blocks: { timer: { settings: null } } }));
  assert.equal(nullValue.ok, false);
  assert.match(nullValue.error, /定時與隨機.*settings/);
  const badSecrets = check(exported({ secrets: 'x' }));
  assert.equal(badSecrets.ok, false);
  assert.match(badSecrets.error, /secrets/);
});

test('checkImport ignores unknown blocks and keys, and refuses a file with nothing to import', () => {
  const result = check(exported({ blocks: { timer: { settings: { a: 1 }, evil: 1, running: true }, nope: { x: 1 } } }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocks, ['timer']);
  assert.deepEqual(result.data.blocks.timer, { settings: { a: 1 } }, 'only the keys the block owns survive');
  assert.equal(result.hasSecrets, false);
  assert.equal(check(exported({ blocks: { nope: { x: 1 } } })).ok, false);
  assert.match(check(exported()).error, /沒有任何/);
  assert.equal(check(exported({ secrets: { lineNotify: { token: 't' } } })).ok, true, 'a secrets section alone is something to import');
  assert.equal(check(exported({ secrets: {} })).ok, false, 'an empty secrets section is nothing to import');
  const withEmptySecrets = check(exported({ blocks: { timer: { settings: { a: 1 } } }, secrets: {} }));
  assert.equal(withEmptySecrets.hasSecrets, false, 'and it does not offer the secrets tick');
});

test('checkImport keeps only the secret keys from the secrets section', () => {
  const result = check(exported({ blocks: { timer: { settings: {} } }, secrets: { lineNotify: { token: 't' }, settings: { sneaky: 1 } } }));
  assert.equal(result.hasSecrets, true);
  assert.deepEqual(Object.keys(result.data.secrets), ['lineNotify']);
});

test('planImport replaces a whole block: keys in the file are written, the block\'s other keys are removed, other blocks are untouched', () => {
  const current = { settings: { old: 1 }, idleSettings: { old: 1 }, triggerGroupSettings: { keep: 1 }, running: true };
  const parsed = check(exported({ blocks: { timer: { settings: { fresh: 1 } }, trigger: { triggerGroupSettings: { fresh: 2 } } } }));
  const plan = B.planImport(current, parsed.data, { blocks: ['timer'] });
  assert.deepEqual(plan.set, { settings: { fresh: 1 } });
  assert.deepEqual(plan.remove, ['idleSettings'], 'in the block, absent from the file, present now');
  assert.deepEqual(plan.blocks, ['timer']);
  assert.ok(!('triggerGroupSettings' in plan.set), 'an unticked block is left alone');
  assert.ok(!plan.remove.includes('running'), 'excluded keys are never touched');
});

test('planImport only offers blocks that are in the file, and secrets only when asked for', () => {
  const parsed = check(exported({ blocks: { timer: { settings: { a: 1 } } }, secrets: { lineNotify: { token: 'new' } } }));
  const current = { lineNotify: { token: 'old' }, captchaSampleUrl: 'u' };
  const without = B.planImport(current, parsed.data, { blocks: ['timer', 'trigger'] });
  assert.deepEqual(without.blocks, ['timer'], 'trigger is not in the file');
  assert.ok(!('lineNotify' in without.set) && !without.remove.includes('lineNotify'));
  const withSecrets = B.planImport(current, parsed.data, { blocks: [], secrets: true });
  assert.deepEqual(withSecrets.set, { lineNotify: { token: 'new' } });
  assert.deepEqual(withSecrets.remove, ['captchaSampleUrl'], 'the secrets section replaces both secret keys');
  assert.equal(withSecrets.secrets, true);
});

test('planImport copies the values so the plan cannot alias the parsed file', () => {
  const parsed = check(exported({ blocks: { timer: { settings: { n: [1] } } } }));
  const plan = B.planImport({}, parsed.data, { blocks: ['timer'] });
  plan.set.settings.n.push(2);
  assert.deepEqual(parsed.data.blocks.timer.settings.n, [1]);
});

test('round trip: exporting a store and importing it into an empty one gives the same classified keys', () => {
  const full = {
    settings: { a: 1 }, idleSettings: { b: 2 }, triggerGroupSettings: { c: 3 }, zapFeatures: { mobs: true },
    mapMonsters: { 'a/1': { mobs: ['x(1)'] } }, chatPairs: [{ said: 'a', reply: 'b' }], extraGameUrls: ['https://x.test/*'],
    lineNotify: { token: 't' }, captchaSampleUrl: 'https://script.google.com/macros/s/a/exec', running: true,
  };
  const text = B.exportText(full, { version: '1', secrets: true, now: FIXED_NOW });
  const parsed = B.checkImport(text);
  assert.equal(parsed.ok, true);
  const plan = B.planImport({}, parsed.data, { blocks: parsed.blocks, secrets: true });
  const { running, ...expected } = full;
  assert.deepEqual(plan.set, expected);
  assert.deepEqual(plan.remove, []);
});

// ---- 匯入前的備份與還原 ----
test('makeBackup keeps the current values of the keys the plan touches, and names the ones that are absent now', () => {
  const current = { settings: { old: 1 }, idleSettings: { old: 2 }, chatReply: { keep: 1 } };
  const plan = { set: { settings: { fresh: 1 }, zapFeatures: { mobs: true } }, remove: ['idleSettings', 'mapMonsters'] };
  const backup = B.makeBackup(current, plan, FIXED_NOW);
  assert.deepEqual(backup.values, { settings: { old: 1 }, idleSettings: { old: 2 } });
  assert.deepEqual(backup.absent.sort(), ['mapMonsters', 'zapFeatures']);
  assert.equal(backup.at, '2026-11-10T01:02:03.000Z');
  assert.ok(!('chatReply' in backup.values), 'keys the import does not touch are not backed up');
  current.settings.old = 99;
  assert.equal(backup.values.settings.old, 1, 'the backup is a copy');
});

test('planRestore writes the saved values back and removes what was absent, so a restore returns to the state before the import', () => {
  const current = { settings: { old: 1 }, idleSettings: { old: 2 } };
  const plan = { set: { settings: { fresh: 1 }, zapFeatures: { mobs: true } }, remove: ['idleSettings'] };
  const checked = B.checkBackup(B.makeBackup(current, plan, FIXED_NOW));
  assert.equal(checked.ok, true);
  const restore = B.planRestore(checked.backup);
  assert.deepEqual(restore.set, { settings: { old: 1 }, idleSettings: { old: 2 } });
  assert.deepEqual(restore.remove, ['zapFeatures']);
});

test('checkBackup refuses a damaged backup and says why', () => {
  const good = { at: 'x', values: { settings: {} }, absent: ['idleSettings'] };
  assert.equal(B.checkBackup(good).ok, true);
  assert.equal(B.checkBackup(good).keys, 2);
  [null, 'x', [], {}, { values: {}, absent: 'x' }, { values: [], absent: [] }, { values: {}, absent: [1] }].forEach(bad => {
    assert.equal(B.checkBackup(bad).ok, false, JSON.stringify(bad));
  });
  assert.match(B.checkBackup({ values: { running: true }, absent: [] }).error, /running/);
  assert.match(B.checkBackup({ values: {}, absent: ['evil'] }).error, /evil/);
  assert.match(B.checkBackup({ values: { settings: null }, absent: [] }).error, /矛盾/);
  assert.match(B.checkBackup({ values: { settings: {} }, absent: ['settings'] }).error, /矛盾/);
});

test('the backup key is never exported', () => {
  assert.ok(B.EXCLUDED_KEYS.includes('settingsBackup'));
  const text = B.exportText({ ...store, settingsBackup: { at: 'x', values: { lineNotify: { token: 'SECRET-TOKEN' } }, absent: [] } }, { version: '1', secrets: true, now: FIXED_NOW });
  assert.ok(!text.includes('settingsBackup'));
});

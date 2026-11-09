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

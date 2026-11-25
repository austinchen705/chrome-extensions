'use strict';
// 設定雲端同步：Apps Script（在 vm 裡用假的 DriveApp／PropertiesService／Utilities／LockService／ContentService 執行）
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const GS = fs.readFileSync(path.join(root, 'tools', 'apps-script', 'settings-sync.gs'), 'utf8');

const plain = value => JSON.parse(JSON.stringify(value));

// 假的 Drive：資料夾有 id、名字、子檔案；檔案有名字與內容；inRoot 的資料夾才找得到
function drive() {
  let seq = 0;
  const folders = new Map();
  const makeFolder = name => {
    const folder = {
      id: `folder-${++seq}`, name, files: [], trashed: false, inRoot: false,
      getId: () => folder.id,
      isTrashed: () => folder.trashed,
      getFilesByName(fileName) {
        const hits = folder.files.filter(f => f.name === fileName);
        let i = 0;
        return { hasNext: () => i < hits.length, next: () => hits[i++] };
      },
      createFile(fileName, content, mime) {
        const file = {
          name: fileName, content, mime,
          setContent(text) { file.content = text; return file; },
          getBlob: () => ({ getDataAsString: () => file.content })
        };
        folder.files.push(file);
        return file;
      }
    };
    folders.set(folder.id, folder);
    return folder;
  };
  const rootFolder = {
    getFoldersByName(name) {
      const hits = [...folders.values()].filter(f => f.name === name && f.inRoot);
      let i = 0;
      return { hasNext: () => i < hits.length, next: () => hits[i++] };
    }
  };
  return {
    folders, makeFolder,
    getRootFolder: () => rootFolder,
    getFolderById(id) {
      const folder = folders.get(id);
      if (!folder) throw new Error('No item with the given ID could be found.');
      return folder;
    },
    createFolder(name) {
      const folder = makeFolder(name);
      folder.inRoot = true;
      return folder;
    }
  };
}

function server({ props = {}, fakeDrive = drive() } = {}) {
  const properties = { ...props };
  const locks = { held: 0, waited: 0 };
  const context = {
    DriveApp: fakeDrive,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => (key in properties ? properties[key] : null),
      setProperty(key, value) { properties[key] = value; }
    }) },
    LockService: { getScriptLock: () => ({
      waitLock() { locks.waited += 1; locks.held += 1; },
      releaseLock() { locks.held -= 1; }
    }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      // Apps Script 回的是有號位元組
      computeDigest: (algorithm, text) => [...crypto.createHash('sha256').update(text, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID()
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) }
  };
  vm.createContext(context);
  vm.runInContext(GS, context);
  const raw = text => plain(context.doPost({ postData: { contents: text } }));
  const post = body => raw(JSON.stringify(body));
  const files = () => [...fakeDrive.folders.values()].flatMap(f => f.files);
  return { post, raw, properties, locks, files };
}

const settings = (version = '1.0.0') => ({ format: 'catworld-settings', version: 1, exportedWith: version, exportedAt: 'x', blocks: { timer: { a: 1 } } });
const payload = version => ({ settings: settings(version), macros: { MACROS: ['a'], notes: {} } });
const req = (action, extra = {}) => ({ action, account: 'Hero', password: 'pw-1', ...extra });

test('upload: the first upload claims the character, later uploads need the same password', () => {
  const s = server();
  const first = s.post(req('upload', { payload: payload('1.0.0') }));
  assert.equal(first.ok, true);
  assert.equal(first.claimed, true);
  assert.match(first.updatedAt, /^\d{4}-\d\d-\d\dT/);
  const second = s.post(req('upload', { payload: payload('1.1.0') }));
  assert.equal(second.ok, true);
  assert.equal(second.claimed, false);
  assert.deepEqual(s.post(req('upload', { password: 'other', payload: payload('9') })), { ok: false, error: 'bad-password' });
  assert.equal(s.post(req('info')).exportedWith, '1.1.0');
  assert.equal(s.files().length, 1);
});

test('download and info: right password returns the data, wrong password is bad-password, unknown character is not-found', () => {
  const s = server();
  s.post(req('upload', { payload: payload('2.3.4') }));
  const info = s.post(req('info'));
  assert.deepEqual(Object.keys(info).sort(), ['exportedWith', 'ok', 'updatedAt']);
  assert.equal(info.exportedWith, '2.3.4');
  const down = s.post(req('download'));
  assert.deepEqual(down.payload, payload('2.3.4'));
  assert.equal(down.updatedAt, info.updatedAt);
  assert.equal(down.exportedWith, '2.3.4');
  assert.deepEqual(s.post(req('download', { password: 'nope' })), { ok: false, error: 'bad-password' });
  assert.deepEqual(s.post(req('info', { password: 'nope' })), { ok: false, error: 'bad-password' });
  assert.deepEqual(s.post(req('download', { account: 'nobody' })), { ok: false, error: 'not-found' });
  assert.deepEqual(s.post(req('info', { account: 'nobody' })), { ok: false, error: 'not-found' });
  assert.equal(s.files().length, 1, 'download/info of an unknown character creates no file');
});

test('stored file keeps a salted SHA-256 hash and never the password', () => {
  const s = server();
  s.post(req('upload', { password: 'my secret pw', payload: payload() }));
  const [file] = s.files();
  assert.equal(file.name, 'hero.json');
  const record = JSON.parse(file.content);
  assert.deepEqual(Object.keys(record).sort(), ['account', 'exportedWith', 'hash', 'payload', 'salt', 'updatedAt']);
  assert.equal(record.account, 'hero');
  assert.equal(record.hash, crypto.createHash('sha256').update(record.salt + 'my secret pw').digest('hex'));
  assert.ok(!file.content.includes('my secret pw'));
  // 另一個角色同一組密碼：鹽不同，雜湊也不同
  s.post(req('upload', { account: 'hero2', password: 'my secret pw', payload: payload() }));
  const other = JSON.parse(s.files()[1].content);
  assert.notEqual(other.salt, record.salt);
  assert.notEqual(other.hash, record.hash);
});

test('account names: trimmed, ASCII lowercased, CJK kept, one file per normalized name; unsafe names are bad-request', () => {
  const s = server();
  assert.equal(s.post(req('upload', { account: '  HeRo_1-x  ', payload: payload() })).claimed, true);
  assert.equal(s.post(req('upload', { account: 'hero_1-x', payload: payload() })).claimed, false);
  assert.equal(s.post(req('upload', { account: '貓小明', payload: payload() })).claimed, true);
  assert.deepEqual(s.files().map(f => f.name), ['hero_1-x.json', '貓小明.json']);
  const bad = ['', '   ', 'a/b', '..', 'a.b', 'a b', 'a\\b', 'x'.repeat(41), 5, null, undefined, ['a']];
  for (const account of bad) {
    assert.deepEqual(s.post(req('info', { account })), { ok: false, error: 'bad-request' }, JSON.stringify(account));
  }
  assert.equal(s.post(req('info', { account: 'x'.repeat(40) })).error, 'not-found');
  assert.equal(s.files().length, 2);
});

test('bad requests: not JSON, unknown action, missing or empty password, bad payload shapes', () => {
  const s = server();
  const bad = { ok: false, error: 'bad-request' };
  assert.deepEqual(s.raw('not json'), bad);
  assert.deepEqual(s.raw('[]'), bad);
  assert.deepEqual(s.raw('null'), bad);
  assert.deepEqual(s.post(req('delete')), bad);
  assert.deepEqual(s.post({ account: 'hero', password: 'x' }), bad);
  assert.deepEqual(s.post(req('info', { password: '' })), bad);
  assert.deepEqual(s.post(req('info', { password: 7 })), bad);
  const shapes = [undefined, null, 'text', [], {}, { macros: {} }, { settings: 'x' }, { settings: [] },
    { settings: { format: 'other' } }, { settings: { version: 1 } },
    { settings: settings(), macros: 'x' }, { settings: settings(), macros: [] }, { settings: settings(), macros: null }];
  for (const shape of shapes) {
    assert.deepEqual(s.post(req('upload', { payload: shape })), bad, JSON.stringify(shape));
  }
  assert.equal(s.files().length, 0, 'rejected requests write nothing and create no claim');
  assert.equal(s.post(req('upload', { payload: { settings: settings() } })).ok, true, 'macros is optional');
});

test('a bad payload does not overwrite an existing upload', () => {
  const s = server();
  s.post(req('upload', { payload: payload('1.0.0') }));
  assert.equal(s.post(req('upload', { payload: { settings: {} } })).error, 'bad-request');
  assert.equal(s.post(req('download')).exportedWith, '1.0.0');
});

test('size cap: a request body over 1 MB is too-large (checked before parsing), exactly 1 MB passes', () => {
  const s = server();
  assert.deepEqual(s.raw('x'.repeat(1024 * 1024 + 1)), { ok: false, error: 'too-large' });
  const big = payload();
  big.macros = { filler: '' };
  const overhead = JSON.stringify(req('upload', { payload: big })).length;
  big.macros.filler = 'y'.repeat(1024 * 1024 - overhead);
  assert.equal(JSON.stringify(req('upload', { payload: big })).length, 1024 * 1024);
  assert.equal(s.post(req('upload', { payload: big })).ok, true);
  big.macros.filler += 'y';
  assert.deepEqual(s.post(req('upload', { payload: big })), { ok: false, error: 'too-large' });
  assert.equal(s.files().length, 1);
});

test('folder: FOLDER_ID property is used when set', () => {
  const fakeDrive = drive();
  const mine = fakeDrive.makeFolder('whatever');
  const s = server({ props: { FOLDER_ID: mine.id }, fakeDrive });
  s.post(req('upload', { payload: payload() }));
  assert.deepEqual(mine.files.map(f => f.name), ['hero.json']);
  assert.equal(fakeDrive.folders.size, 1, 'no extra folder is created');
  assert.equal(s.properties.FOLDER_ID, mine.id);
});

test('folder: without FOLDER_ID a catworld-settings-sync folder is created once, its ID saved, and still found after a rename or move', () => {
  const fakeDrive = drive();
  const s = server({ fakeDrive });
  s.post(req('upload', { payload: payload('3.0.0') }));
  const created = [...fakeDrive.folders.values()];
  assert.equal(created.length, 1);
  assert.equal(created[0].name, 'catworld-settings-sync');
  assert.equal(s.properties.FOLDER_ID, created[0].id);
  created[0].name = '改過名字';
  created[0].inRoot = false;
  assert.equal(s.post(req('download')).exportedWith, '3.0.0');
  assert.equal(fakeDrive.folders.size, 1);
});

test('folder: an existing catworld-settings-sync folder in the root is reused, and its ID saved', () => {
  const fakeDrive = drive();
  const existing = fakeDrive.makeFolder('catworld-settings-sync');
  existing.inRoot = true;
  const s = server({ fakeDrive });
  s.post(req('upload', { payload: payload() }));
  assert.equal(fakeDrive.folders.size, 1);
  assert.equal(existing.files.length, 1);
  assert.equal(s.properties.FOLDER_ID, existing.id);
});

test('folder: an invalid or trashed FOLDER_ID falls back to find-or-create and replaces the saved ID', () => {
  const fakeDrive = drive();
  const trashed = fakeDrive.makeFolder('old');
  trashed.trashed = true;
  for (const id of ['no-such-id', trashed.id]) {
    const s = server({ props: { FOLDER_ID: id }, fakeDrive });
    s.post(req('upload', { payload: payload() }));
    assert.notEqual(s.properties.FOLDER_ID, id);
    assert.equal(fakeDrive.getFolderById(s.properties.FOLDER_ID).name, 'catworld-settings-sync');
  }
  assert.equal(trashed.files.length, 0);
});

test('valid requests run under the script lock, which is always released; rejected requests never take it', () => {
  const s = server();
  s.post(req('upload', { payload: payload() }));
  s.post(req('upload', { password: 'wrong', payload: payload() }));
  s.post(req('download', { account: 'nobody' }));
  assert.equal(s.locks.waited, 3);
  assert.equal(s.locks.held, 0);
  s.post(req('upload', { payload: { settings: {} } }));
  assert.equal(s.locks.waited, 3);
});

test('a corrupt stored file is a server-error, not a crash, and the lock is released', () => {
  const s = server();
  s.post(req('upload', { payload: payload() }));
  s.files()[0].content = '{broken';
  assert.deepEqual(s.post(req('download')), { ok: false, error: 'server-error' });
  assert.equal(s.locks.held, 0);
});
